import { loadLeague, setTransport, PRO_ABBR, SLOT } from './api.js';
import { makeDemo } from './demo.js';
import * as A from './analysis.js';

const isExt = typeof chrome !== 'undefined' && !!chrome.storage?.local;
const store = {
  async get(k) {
    if (isExt) return (await chrome.storage.local.get(k))[k];
    try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
  },
  async set(k, v) {
    if (isExt) return chrome.storage.local.set({ [k]: v });
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
  },
};

const full = new URLSearchParams(location.search).has('full') || !isExt;
document.body.classList.toggle('full', full);

const defaultSeason = () => { const d = new Date(); return d.getMonth() >= 7 ? d.getFullYear() + 1 : d.getFullYear(); };
const CACHE_MS = 10 * 60 * 1000;
const TABS = [['overview', 'Overview'], ['roster', 'Roster'], ['waivers', 'Waivers'], ['playoffs', 'Playoffs'], ['league', 'League'], ['settings', 'Settings']];

const state = {
  settings: { leagueId: '', season: defaultSeason(), teamId: null, basis: 'smart', demo: false },
  model: null, an: null, tab: 'overview', loading: false, error: null, signedIn: null,
  wv: { pos: 'ALL', sort: 'score', showInjured: false },
};

// ---------- helpers
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f0 = n => Math.round(n ?? 0).toLocaleString();
const f1 = n => (n == null ? '–' : (+n).toFixed(1));
const val = p => A.value(p, state.settings.basis);
const abbr = p => state.model.proTeams[p.proTeamId]?.abbrev || PRO_ABBR[p.proTeamId] || 'FA';
const teamName = id => state.model.teams.find(t => t.id === id)?.name || `Team ${id}`;

function badge(p) {
  const map = { OUT: ['O', 'b-out'], INJURY_RESERVE: ['IR', 'b-out'], SUSPENSION: ['SSPD', 'b-out'], DAY_TO_DAY: ['DTD', 'b-dtd'], QUESTIONABLE: ['Q', 'b-dtd'] };
  const b = map[p.injury];
  return b ? `<span class="badge ${b[1]}">${b[0]}</span>` : '';
}
function pCell(p, extra = '') {
  const pos = p.eligible?.length ? p.eligible.join('/') : p.pos;
  return `<div class="pl"><span class="pn">${esc(p.name)}${badge(p)}${extra}</span><span class="pm">${esc(abbr(p))} · ${esc(pos)}</span></div>`;
}
const trendCell = t => (t == null ? '<td class="num muted">–</td>' : `<td class="num ${t >= 1.5 ? 'up' : t <= -1.5 ? 'down' : 'muted'}">${t > 0 ? '+' : ''}${t.toFixed(1)}</td>`);

// ---------- data
// Reads ESPN's login cookies straight from Chrome (any espn.com subdomain).
// Searches every cookie store (normal + incognito) and partitioned cookies; manual values win.
async function espnCookie(name) {
  const manual = name === 'espn_s2' ? state.settings.espnS2 : name === 'SWID' ? state.settings.swid : null;
  if (manual) return manual.trim();
  if (!isExt || !chrome.cookies) return null;
  const isEspn = c => c.value && /(^|\.)espn\.com$/.test(c.domain.replace(/^\./, ''));
  const queries = [{ name }, { name, partitionKey: {} }];
  try {
    for (const store of await chrome.cookies.getAllCookieStores()) {
      for (const q of queries) {
        try {
          const hit = (await chrome.cookies.getAll({ ...q, storeId: store.id })).find(isEspn);
          if (hit) return hit.value;
        } catch { /* partitionKey unsupported on older Chrome */ }
      }
    }
  } catch { /* ignore */ }
  return null;
}
const swid = () => espnCookie('SWID');
async function checkSignedIn() {
  if (!isExt || !chrome.cookies) return null;
  return !!(await espnCookie('espn_s2'));
}
// Chrome often won't attach espn.com cookies to an extension's requests (third-party
// cookie rules), so we attach them ourselves to calls to ESPN's fantasy API.
async function attachEspnAuth() {
  const [s2, sw] = await Promise.all([espnCookie('espn_s2'), espnCookie('SWID')]);
  state.authDiag = { s2: !!s2, swid: !!sw, rules: !!(isExt && chrome.declarativeNetRequest) };
  if (!isExt || !chrome.declarativeNetRequest) return false;
  const rule = s2 && sw && {
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'set', value: `espn_s2=${s2}; SWID=${sw}` }] },
    condition: { urlFilter: '||lm-api-reads.fantasy.espn.com/apis/', resourceTypes: ['xmlhttprequest'] },
  };
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: rule ? [rule] : [] });
  return !!rule;
}
// Preferred path: run ESPN requests inside a fantasy.espn.com tab. To ESPN that looks
// like its own site asking, so the user's login just works with zero setup.
async function getEspnTab() {
  const tabs = await chrome.tabs.query({ url: 'https://fantasy.espn.com/*' });
  const tab = tabs.find(t => !t.discarded && t.status === 'complete') || tabs.find(t => !t.discarded);
  if (tab) return { id: tab.id, opened: false };
  const t = await chrome.tabs.create({ url: 'https://fantasy.espn.com/basketball/', active: false });
  await new Promise(done => {
    const timer = setTimeout(finish, 15000);
    function finish() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); done(); }
    function onUpd(id, info) { if (id === t.id && info.status === 'complete') finish(); }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
  return { id: t.id, opened: true };
}
const tabTransport = tabId => async (url, headers) => {
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (u, h) => {
      const r = await fetch(u, { credentials: 'include', headers: h });
      return { status: r.status, text: await r.text() };
    },
    args: [url, headers],
  });
  if (!inj?.result) throw new Error('ESPN tab did not respond');
  return inj.result;
};

async function detectFromTab() {
  if (!isExt || !chrome.tabs) return null;
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(t?.url || '');
    if (!u.hostname.endsWith('espn.com') || !u.pathname.includes('basketball')) return null;
    const leagueId = u.searchParams.get('leagueId');
    if (!leagueId) return null;
    return { leagueId, season: u.searchParams.get('seasonId'), teamId: u.searchParams.get('teamId') };
  } catch { return null; }
}

async function load(force = false) {
  const s = state.settings;
  if (!s.demo && !s.leagueId) { state.tab = 'settings'; render(); return; }
  state.loading = true; state.error = null; render();
  try {
    let model;
    if (s.demo) model = makeDemo();
    else {
      const key = `cache:${s.leagueId}:${s.season}`;
      const c = force ? null : await store.get(key);
      if (c && Date.now() - c.at < CACHE_MS) model = c.model;
      else {
        let espnTab = null;
        if (isExt && chrome.scripting && !s.espnS2) {
          try { espnTab = await getEspnTab(); } catch (e) { console.warn('No ESPN tab', e); }
        }
        try {
          if (espnTab) {
            setTransport(tabTransport(espnTab.id));
            try {
              model = await loadLeague(s);
            } catch (e) {
              if (e.kind === 'auth') {
                e.message = "ESPN says you're not signed in, or this account isn't in the league. Sign in on fantasy.espn.com with the account that's in the league, then refresh.";
                throw e;
              }
              if (e.kind === 'notfound') throw e;
              console.warn('Tab route failed, trying direct', e);
            }
          }
        } finally {
          setTransport(null);
          if (espnTab?.opened) chrome.tabs.remove(espnTab.id).catch(() => {});
        }
        const authed = model ? true : await attachEspnAuth();
        if (!model) try {
          model = await loadLeague(s);
        } catch (e) {
          if (e.kind === 'auth' && !authed) {
            const d = state.authDiag || {};
            e.message = `Private league, and the extension couldn't read your ESPN login (espn_s2 ${d.s2 ? 'found' : 'missing'}, SWID ${d.swid ? 'found' : 'missing'}${d.rules ? '' : ', header permission missing — reload the extension'}). Paste them in Settings → Private league login.`;
          }
          else if (e.kind === 'auth') e.message = 'Found your ESPN login, but ESPN still refused. Make sure the account you signed in with is in this league, or sign out and back in at espn.com to refresh it.';
          throw e;
        }
        model.fetchedAt = Date.now();
        await store.set(key, { at: Date.now(), model });
      }
    }
    let tid = s.demo ? model.myTeamId : s.teamId;
    if (!model.teams.some(t => t.id === +tid)) {
      const sw = (await swid())?.toLowerCase();
      tid = (sw && model.teams.find(t => t.owners?.some(o => String(o).toLowerCase() === sw))?.id) ?? model.teams[0]?.id;
    }
    model.myTeamId = +tid;
    state.model = model;
    reanalyze();
    if (state.tab === 'settings' && !state.stayOnSettings) state.tab = 'overview';
  } catch (e) {
    console.error(e);
    state.error = e.message || String(e);
    state.model = null;
  }
  state.stayOnSettings = false;
  state.loading = false;
  render();
}
function reanalyze() { state.an = state.model ? A.analyze(state.model, state.settings.basis) : null; }
async function saveSettings() { await store.set('settings', state.settings); }

// ---------- views
function vHeader() {
  const m = state.model;
  const opts = Object.entries(A.BASIS).map(([k, v]) => `<option value="${k}" ${k === state.settings.basis ? 'selected' : ''}>${v}</option>`).join('');
  return `<header>
    <div class="brand"><span class="mark" aria-hidden="true"></span><span class="wm">LinedUp<em>Better</em></span></div>
    ${m ? `<div class="ctx"><span>${esc(state.an.my.name)}</span><span class="sep">/</span><span class="muted">${esc(m.name)}</span>${m.demo ? '<span class="pill" data-tab="settings" title="Connect your league in Settings">Sample data</span>' : ''}</div>` : ''}
    <div class="spacer"></div>
    ${m ? `<label class="basis"><span>FP/G</span><select data-act="basis" title="How player value is calculated">${opts}</select></label>` : ''}
    <button class="ghost" data-act="refresh" title="Refresh from ESPN" aria-label="Refresh">${ICON.refresh}</button>
    ${isExt && !full ? `<button class="ghost" data-act="expand" title="Open in a full tab" aria-label="Open full view">${ICON.expand}</button>` : ''}
  </header>
  <nav>${TABS.map(([k, v]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${v}</button>`).join('')}</nav>`;
}

const ICON = {
  refresh: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  expand: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="M20 4l-7 7"/><path d="M4 20l7-7"/></svg>',
};

function vOverview() {
  const { an, model: m } = state;
  const my = an.my;
  const x = an.matchup;
  const sorted = standings();
  const rank = sorted.findIndex(t => t.id === my.id) + 1;
  const gp = my.wins + my.losses + my.ties;
  const strip = `<div class="strip">
    <div><span class="k">Record</span><span class="v">${my.wins}-${my.losses}${my.ties ? '-' + my.ties : ''}</span></div>
    <div><span class="k">Standing</span><span class="v">${rank}<small>/${m.teams.length}</small></span></div>
    <div><span class="k">Avg / week</span><span class="v">${gp ? f0(my.pf / gp) : '–'}</span></div>
    <div><span class="k">Games left</span><span class="v">${an.base.games}</span></div>
  </div>`;
  let h = '';
  if (x && !x.bye) {
    const wp = Math.min(99, Math.max(1, Math.round(x.winProb * 100)));
    h += `<section class="board">
      <div class="board-top"><span>Week ${m.currentPeriod}</span><span>${A.periodRange(m, m.currentPeriod)}</span></div>
      <div class="score">
        <div class="side me"><div class="tn">${esc(my.name)}</div><div class="pts">${f0(x.myPts)}</div><div class="proj">proj <b>${f0(x.myProj)}</b> · ${x.myGames} games left</div></div>
        <div class="vs">vs</div>
        <div class="side them"><div class="tn">${esc(x.opp.name)}</div><div class="pts">${f0(x.oppPts)}</div><div class="proj">proj <b>${f0(x.oppProj)}</b> · ${x.oppGames} games left</div></div>
      </div>
      <div class="odds"><span class="a">${wp}%</span><div class="bar"><i style="width:${wp}%"></i></div><span class="b">${100 - wp}%</span></div>
      ${strip}
    </section>`;
  } else h += `<section class="board">${strip}</section>`;

  const picks = an.waivers.filter(w => !A.isOut(w.p)).sort((a, b) => b.weekGain - a.weekGain).slice(0, 6);
  h += `<div class="grid2">
    <section class="card"><h3>The rundown</h3><ul class="notes">
      ${an.feedback.map(n => `<li class="note t-${n.type}"><span class="tag">${esc(n.tag)}</span><div><b>${esc(n.title)}</b>${n.detail ? `<span>${esc(n.detail)}</span>` : ''}</div></li>`).join('')}
    </ul></section>
    <section class="card"><h3>Pickups this week <span class="r">${an.drop ? `for ${esc(an.drop.name)}` : ''}</span></h3>
      ${picks.map((w, i) => `<div class="pick"><span class="rk">${String(i + 1).padStart(2, '0')}</span>${pCell(w.p)}<div class="meta">${f1(w.v)}<small> FP/G</small><br>${w.gl}<small> games</small></div><div class="gain">${w.weekGain > 0 ? '+' : ''}${f0(w.weekGain)}</div></div>`).join('') || '<p class="muted">No free agents loaded.</p>'}
      <button class="link" data-tab="waivers">Full waiver wire →</button>
    </section>
  </div>`;
  return h;
}

function vRoster() {
  const { an, model: m } = state;
  // Long matchups (opening week, All-Star, playoffs) span 2 weeks: show today's Mon–Sun.
  const all = m.periods[m.currentPeriod] || [];
  const monday = sp => { const d = A.spDate(m, sp); return sp - ((d.getDay() + 6) % 7); };
  const today = Math.min(Math.max(m.currentSP, all[0] ?? 1), all[all.length - 1] ?? 1);
  const sps = all.length > 7 ? all.filter(sp => monday(sp) === monday(today)) : all;
  const order = s => (s === 13 ? 99 : s === 12 ? 50 : s ?? 40);
  const roster = an.my.roster.slice().sort((a, b) => order(a.slot) - order(b.slot) || val(b) - val(a));
  const dayHead = sps.map(sp => {
    const d = A.spDate(m, sp);
    const cls = sp === m.currentSP ? 'today' : sp < m.currentSP ? 'past' : '';
    return `<th class="day ${cls}">${A.fmtDow(d)}<br>${d.getDate()}</th>`;
  }).join('');
  const rows = roster.map(p => {
    const s = p.stats;
    const cells = sps.map(sp => {
      const g = A.gameOn(m, p, sp);
      const cls = sp < m.currentSP ? 'past' : '';
      return `<td class="day ${cls}">${g ? `<span class="gm ${g.home ? 'home' : ''}">${g.home ? '' : '@'}${esc(m.proTeams[g.opp]?.abbrev || PRO_ABBR[g.opp] || '')}</span>` : ''}</td>`;
    }).join('');
    return `<tr class="${p.slot === 13 ? 'ir' : ''}">
      <td class="slot">${SLOT[p.slot] ?? ''}</td><td>${pCell(p)}</td>
      <td class="num"><b>${f1(val(p))}</b></td><td class="num">${f1(s.season?.avg)}</td><td class="num">${f1(s.l15?.avg)}</td>
      ${trendCell(s.l15 && s.season && s.season.gp >= 8 ? s.l15.avg - s.season.avg : null)}
      <td class="num">${A.gamesIn(m, p, an.rem)}</td>${cells}</tr>`;
  }).join('');
  const dayIdx = Object.fromEntries(an.base.days.map(d => [d.sp, d]));
  const foot = sps.map(sp => {
    const d = dayIdx[sp];
    if (!d) return '<td class="day"></td>';
    const cls = d.open ? 'under' : d.benched ? 'over' : '';
    return `<td class="day"><span class="cnt ${cls}" title="${d.playing} playing / ${m.starters} slots">${d.playing}/${m.starters}</span></td>`;
  }).join('');
  return `<section class="card"><h3>My roster · week ${m.currentPeriod} <span class="r muted small">${A.periodRange(m, m.currentPeriod)}${all.length > 7 ? ` · showing ${A.fmtMD(A.spDate(m, sps[0]))} – ${A.fmtMD(A.spDate(m, sps[sps.length - 1]))}` : ''}</span></h3>
    <div class="scrollx"><table>
      <thead><tr><th>Slot</th><th>Player</th><th class="num" title="${A.BASIS[state.settings.basis]}">FP/G</th><th class="num">Season</th><th class="num">L15</th><th class="num">Δ</th><th class="num" title="Games left in this matchup">GL</th>${dayHead}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="7" class="num">Healthy players with a game / starting slots →</td>${foot}</tr></tfoot>
    </table></div>
    <p class="muted small">Red counts = empty lineup slots (stream someone). Amber = more players than slots (games left on your bench). “@” = road game.</p>
  </section>`;
}

function vWaivers() {
  const { an, model: m } = state;
  const w = state.wv;
  let list = an.waivers.filter(x => (w.showInjured || !A.isOut(x.p)) && (w.pos === 'ALL' || x.p.eligible.includes(w.pos) || x.p.pos === w.pos));
  const key = { score: x => x.score, v: x => x.v, week: x => x.weekGain, gl: x => x.gl, po: x => x.poGames, trend: x => x.trend ?? -99, own: x => x.p.ownedChange ?? -99 }[w.sort];
  list = list.sort((a, b) => key(b) - key(a)).slice(0, 60);
  const th = (k, label, title = '') => `<th class="num sort ${w.sort === k ? 'on' : ''}" data-sort="${k}" title="${title}">${label}</th>`;
  const rows = list.map(x => {
    const up = an.drop && x.rosGain >= 1 ? '<span class="badge b-up">UPGRADE</span>' : '';
    const wv = x.p.status === 'WAIVERS' ? '<span class="badge b-wv">W</span>' : '';
    const oc = x.p.ownedChange;
    return `<tr><td>${pCell(x.p, up + wv)}</td>
      <td class="num"><b>${f1(x.score)}</b></td><td class="num">${f1(x.v)}</td>
      <td class="num">${x.gl}</td><td class="num ${x.weekGain > 0 ? 'up' : 'muted'}">${x.weekGain > 0 ? '+' : ''}${f0(x.weekGain)}</td>
      ${trendCell(x.trend)}<td class="num">${x.poGames}</td>
      <td class="num">${x.p.owned != null ? x.p.owned.toFixed(0) + '%' : '–'} <span class="small ${oc > 0 ? 'up' : oc < 0 ? 'down' : 'muted'}">${oc ? (oc > 0 ? '+' : '') + oc.toFixed(1) : ''}</span></td></tr>`;
  }).join('');
  return `<section class="card">
    <h3>Waiver wire <span class="r muted small">${an.drop ? `Drop candidate: <b>${esc(an.drop.name)}</b> (${f1(an.dropV)} FP/G, ${A.gamesIn(m, an.drop, an.rem)} GL)` : ''}</span></h3>
    <div class="chips">
      ${['ALL', 'PG', 'SG', 'SF', 'PF', 'C'].map(p => `<button class="chip ${w.pos === p ? 'on' : ''}" data-pos="${p}">${p}</button>`).join('')}
      <label><input type="checkbox" data-act="inj" ${w.showInjured ? 'checked' : ''}> Show injured</label>
    </div>
    <div class="scrollx"><table>
      <thead><tr><th>Player</th>
        ${th('score', 'Score', 'FP/G adjusted for games left this week and injury')}
        ${th('v', 'FP/G', A.BASIS[state.settings.basis])}
        ${th('gl', 'GL', 'Games left this week')}
        ${th('week', 'Wk +FP', 'Projected points gained this week if you swap in for your drop candidate (accounts for open lineup slots)')}
        ${th('trend', 'Δ L15', 'Last 15 days avg minus season avg')}
        ${th('po', 'PO G', 'Games during fantasy playoffs')}
        ${th('own', '% Own', 'Rostered % and change — sort to find trending adds')}
      </tr></thead><tbody>${rows || '<tr><td colspan="8" class="muted">No players match.</td></tr>'}</tbody>
    </table></div>
    <p class="muted small">UPGRADE = better FP/G than your drop candidate. W = on waivers (claim, not instant add). Click a column to sort.</p>
  </section>`;
}

function vPlayoffs() {
  const { an, model: m } = state;
  const po = A.playoffPeriods(m);
  if (!po.length) return `<div class="card empty"><h2>No playoff schedule yet</h2><p>ESPN hasn't published playoff matchup periods for this league.</p></div>`;
  const label = (id, i) => `<th class="num" title="${A.periodRange(m, id)}">Rd ${i + 1}<br><span class="small">${A.periodRange(m, id)}</span></th>`;
  const head = po.map(label).join('');
  const all = po.flatMap(id => m.periods[id]);

  const mine = an.my.roster.map(p => ({ p, per: po.map(id => A.gamesIn(m, p, m.periods[id])), tot: A.gamesIn(m, p, all) }))
    .sort((a, b) => val(b.p) * b.tot - val(a.p) * a.tot);
  const avgPer = Math.max(1, Math.round(all.length / po.length / 2));
  const hc = n => Math.max(0, Math.min(5, n - avgPer + 3));
  const heatN = n => `<td class="num"><span class="heat h${hc(n)}">${n}</span></td>`;
  const myRows = mine.map(r => `<tr class="${r.p.slot === 13 ? 'ir' : ''}"><td>${pCell(r.p)}</td>${r.per.map(heatN).join('')}<td class="num"><b>${r.tot}</b></td><td class="num">${f0(val(r.p) * r.tot)}</td></tr>`).join('');

  const myByTeam = {};
  for (const p of an.my.roster) (myByTeam[p.proTeamId] ||= []).push(p.name.split(' ').slice(-1)[0]);
  const nba = Object.entries(m.proTeams).map(([id, t]) => ({ id: +id, t, per: po.map(pid => m.periods[pid].filter(sp => t.games[sp]).length) }))
    .map(r => ({ ...r, tot: r.per.reduce((a, b) => a + b, 0) })).sort((a, b) => b.tot - a.tot);
  const nbaRows = nba.map(r => `<tr><td><b>${esc(r.t.abbrev)}</b> <span class="muted small">${esc(r.t.name)}</span></td>${r.per.map(heatN).join('')}<td class="num"><b>${r.tot}</b></td><td class="muted small">${esc((myByTeam[r.id] || []).join(', '))}</td></tr>`).join('');

  const stash = an.waivers.filter(w => !A.isOut(w.p)).map(w => ({ ...w, poPts: w.v * w.poGames })).sort((a, b) => b.poPts - a.poPts).slice(0, 8);

  return `<section class="card"><h3>Your roster in the fantasy playoffs <span class="r muted small">Highlighted = more games than usual</span></h3>
      <div class="scrollx"><table><thead><tr><th>Player</th>${head}<th class="num">Total</th><th class="num">Proj FP</th></tr></thead><tbody>${myRows}</tbody></table></div></section>
    <div class="grid2">
      <section class="card"><h3>NBA games by playoff round</h3>
        <div class="scrollx"><table><thead><tr><th>Team</th>${head}<th class="num">Tot</th><th>Your guys</th></tr></thead><tbody>${nbaRows}</tbody></table></div></section>
      <section class="card"><h3>Playoff stash targets <span class="r muted small">FP/G × playoff games</span></h3>
        ${stash.map(w => `<div class="pick">${pCell(w.p)}<div class="num small muted">${f1(w.v)} FP/G<br>${w.poGames} PO games</div><div class="gain">${f0(w.poPts)}</div></div>`).join('')}
        <p class="muted small">Grab these a couple of weeks before the trade deadline / playoffs while they're cheap.</p></section>
    </div>`;
}

function standings() {
  return state.model.teams.slice().sort((a, b) => (a.seed && b.seed ? a.seed - b.seed : 0) || (b.wins - a.wins) || (a.losses - b.losses) || (b.pf - a.pf));
}

function vLeague() {
  const { an, model: m } = state;
  const st = standings();
  const lead = st[0];
  const rows = st.map((t, i) => {
    const gb = ((lead.wins - t.wins) + (t.losses - lead.losses)) / 2;
    const cls = [t.id === an.my.id ? 'me' : '', i + 1 === m.playoffTeamCount ? 'line' : ''].join(' ');
    return `<tr class="${cls}"><td class="num muted">${i + 1}</td><td><b>${esc(t.name)}</b></td><td class="num">${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}</td><td class="num">${gb ? gb.toFixed(1) : '–'}</td><td class="num">${f0(t.pf)}</td><td class="num">${f0(t.pa)}</td></tr>`;
  }).join('');

  const upcoming = m.matchups.filter(x => x.period >= m.currentPeriod && x.period <= m.regularPeriods && (x.home?.teamId === an.my.id || x.away?.teamId === an.my.id))
    .sort((a, b) => a.period - b.period).slice(0, 8)
    .map(x => {
      const oid = x.home?.teamId === an.my.id ? x.away?.teamId : x.home?.teamId;
      const o = m.teams.find(t => t.id === oid);
      const gp = o ? o.wins + o.losses + o.ties : 0;
      return `<tr><td class="muted">Wk ${x.period}<br><span class="small">${A.periodRange(m, x.period)}</span></td><td>${o ? `<b>${esc(o.name)}</b><br><span class="small muted">${o.wins}-${o.losses}</span>` : '<span class="muted">Bye</span>'}</td><td class="num">${o && gp ? f0(o.pf / gp) : '–'}</td><td class="num">${sumGames(an.my, x.period)}</td><td class="num">${o ? sumGames(o, x.period) : '–'}</td></tr>`;
    }).join('');

  const week = m.matchups.filter(x => x.period === m.currentPeriod && x.home && x.away)
    .map(x => `<tr class="${[x.home.teamId, x.away.teamId].includes(an.my.id) ? 'me' : ''}"><td>${esc(teamName(x.home.teamId))}</td><td class="num"><b>${f0(x.home.pts)}</b></td><td class="num"><b>${f0(x.away.pts)}</b></td><td style="text-align:right">${esc(teamName(x.away.teamId))}</td></tr>`).join('');

  return `<div class="grid2">
    <section class="card"><h3>Standings <span class="r muted small">dashed line = playoff cut (top ${m.playoffTeamCount})</span></h3>
      <table><thead><tr><th class="num">#</th><th>Team</th><th class="num">W-L</th><th class="num">GB</th><th class="num">PF</th><th class="num">PA</th></tr></thead><tbody>${rows}</tbody></table></section>
    <div class="stack">
      <section class="card"><h3>Your upcoming matchups</h3>
        <table><thead><tr><th>Week</th><th>Opponent</th><th class="num" title="Opponent avg points per week">PF/wk</th><th class="num" title="Your roster's NBA games that week">Your G</th><th class="num" title="Their roster's NBA games that week">Their G</th></tr></thead><tbody>${upcoming || '<tr><td colspan="5" class="muted">Regular season complete.</td></tr>'}</tbody></table></section>
      <section class="card"><h3>This week around the league</h3><table><tbody>${week}</tbody></table></section>
    </div></div>`;
}
const sumGames = (team, period) => team.roster.filter(p => p.slot !== 13).reduce((a, p) => a + A.gamesIn(state.model, p, state.model.periods[period] || []), 0);

function vSettings() {
  const s = state.settings;
  const m = state.model;
  const teamOpts = m && !m.demo ? m.teams.map(t => `<option value="${t.id}" ${t.id === m.myTeamId ? 'selected' : ''}>${esc(t.name)}</option>`).join('') : '';
  const signed = state.signedIn == null ? '' : state.signedIn
    ? '<span class="up">✓ Signed in to ESPN in this browser</span>'
    : '<span class="muted">Not signed in? </span> <button class="btn" data-act="signin">Sign in to ESPN</button>';
  return `<section class="card"><h3>Connect your ESPN league</h3>
    <div class="form">
      <label>League ID<input id="f-league" inputmode="numeric" placeholder="e.g. 12345678" value="${esc(s.leagueId)}"></label>
      <label>Season<input id="f-season" inputmode="numeric" value="${esc(s.season)}"></label>
      ${teamOpts ? `<label class="wide">My team<select id="f-team">${teamOpts}</select></label>` : ''}
      <div class="wide row">
        <button class="btn primary" data-act="save">Save & load league</button>
        <button class="btn" data-act="demo">Try demo data</button>
        <span class="small">${signed}</span>
      </div>
    </div></section>
    <details class="card adv"><summary><h3>Advanced: manual ESPN login <span class="r">only if your league still won't load</span></h3></summary>
      <div class="form">
        <label>espn_s2<input id="f-s2" type="password" autocomplete="off" spellcheck="false" placeholder="long value starting with AE…" value="${esc(s.espnS2 || '')}"></label>
        <label>SWID<input id="f-swid" type="password" autocomplete="off" spellcheck="false" placeholder="{XXXXXXXX-XXXX-…}" value="${esc(s.swid || '')}"></label>
      </div>
      <ol class="help" style="margin-top:12px">
        <li>On the fantasy.espn.com tab, press <code>⌥⌘I</code> (Mac) or <code>F12</code> to open DevTools.</li>
        <li>Go to <b>Application → Cookies → https://fantasy.espn.com</b>.</li>
        <li>Copy the <b>Value</b> of <code>espn_s2</code> and <code>SWID</code> into the boxes above, then hit Save & load league.</li>
        <li>These stay in this browser only and are sent only to ESPN. Treat them like a password: don't share them. If you log out of ESPN, paste new ones.</li>
      </ol></details>
    <section class="card"><h3>How to set it up</h3>
      <ol class="help">
        <li>Open your league on <b>fantasy.espn.com</b> and look at the URL: <code>…/basketball/league?leagueId=<b>12345678</b></code>. Tip: open this popup while on that page and the ID fills in for you.</li>
        <li>Season is the year the NBA season ends (2026-27 → <code>2027</code>).</li>
        <li>Private league? Just be signed in at fantasy.espn.com. LinedUpBetter loads your league through an ESPN tab (it opens one in the background if needed), so your login just works.</li>
        <li>Your team is auto-detected from your ESPN login. If it guesses wrong, pick it above.</li>
        <li>Data is cached for 10 minutes. Hit ↻ to force a refresh.</li>
      </ol></section>
    ${state.error ? `<section class="card err"><h3>Last error</h3><p>${esc(state.error)}</p></section>` : ''}`;
}

function vBody() {
  if (state.loading) return '<div class="empty"><div class="spin"></div>Loading your league from ESPN…</div>';
  if (state.tab === 'settings') return vSettings();
  if (state.error) return `<div class="card err empty"><h2>Couldn't load your league</h2><p>${esc(state.error)}</p><div class="row" style="justify-content:center"><button class="btn primary" data-act="refresh">Try again</button><button class="btn" data-tab="settings">Settings</button></div></div>`;
  if (!state.model) return `<div class="empty"><h2>LinedUp<em>Better</em></h2><p>Connect your ESPN league to get started.</p><div class="row" style="justify-content:center"><button class="btn primary" data-tab="settings">Connect league</button><button class="btn" data-act="demo">Try demo</button></div></div>`;
  return { overview: vOverview, roster: vRoster, waivers: vWaivers, playoffs: vPlayoffs, league: vLeague }[state.tab]();
}

function render() {
  const app = document.getElementById('app');
  const scroll = document.querySelector('main')?.scrollTop || 0;
  let body;
  try { body = vBody(); } catch (e) { console.error(e); body = `<div class="card err">Something broke rendering this tab: ${esc(e.message)}</div>`; }
  app.innerHTML = vHeader() + `<main>${body}</main>`;
  if (state.keepScroll) document.querySelector('main').scrollTop = scroll;
  state.keepScroll = false;
}

// ---------- events
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-act],[data-pos],[data-sort]');
  if (!t) return;
  if (t.dataset.tab) { state.tab = t.dataset.tab; render(); return; }
  if (t.dataset.pos) { state.wv.pos = t.dataset.pos; state.keepScroll = true; render(); return; }
  if (t.dataset.sort) { state.wv.sort = t.dataset.sort; state.keepScroll = true; render(); return; }
  const act = t.dataset.act;
  if (act === 'refresh') load(true);
  if (act === 'signin') chrome.tabs.create({ url: 'https://www.espn.com/login' });
  if (act === 'expand') chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1') });
  if (act === 'demo') { state.settings.demo = true; await saveSettings(); state.tab = 'overview'; load(); }
  if (act === 'save') {
    const leagueId = document.getElementById('f-league').value.trim().replace(/\D/g, '');
    const season = +document.getElementById('f-season').value.trim() || defaultSeason();
    const team = document.getElementById('f-team');
    const changed = leagueId !== state.settings.leagueId || season !== +state.settings.season;
    Object.assign(state.settings, { leagueId, season, demo: false, teamId: team && !changed ? +team.value : null });
    state.settings.espnS2 = document.getElementById('f-s2').value.trim();
    state.settings.swid = document.getElementById('f-swid').value.trim();
    await saveSettings();
    state.tab = 'overview';
    load(true);
  }
});
document.addEventListener('change', async e => {
  const act = e.target.dataset.act;
  if (act === 'basis') { state.settings.basis = e.target.value; await saveSettings(); reanalyze(); render(); }
  if (act === 'inj') { state.wv.showInjured = e.target.checked; state.keepScroll = true; render(); }
});

// ---------- boot
(async () => {
  Object.assign(state.settings, (await store.get('settings')) || {});
  state.signedIn = await checkSignedIn();
  const fromTab = await detectFromTab();
  if (fromTab && fromTab.leagueId !== state.settings.leagueId) {
    Object.assign(state.settings, { leagueId: fromTab.leagueId, demo: false, teamId: fromTab.teamId ? +fromTab.teamId : null });
    if (fromTab.season) state.settings.season = +fromTab.season;
    await saveSettings();
  } else if (fromTab?.teamId && !state.settings.teamId) state.settings.teamId = +fromTab.teamId;
  if (!isExt && !state.settings.leagueId) state.settings.demo = true;
  if (!state.settings.leagueId && !state.settings.demo) { state.tab = 'settings'; render(); return; }
  load();
})();
