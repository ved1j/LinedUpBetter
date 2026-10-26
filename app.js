import { loadLeague, setTransport, PRO_ABBR, SLOT, STAT_NAMES } from './api.js';
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
const CACHE_MS = 3 * 60 * 1000; // short: live scores must keep up with started games
const TABS = [['overview', 'Overview'], ['roster', 'Roster'], ['matchups', 'Matchups'], ['waivers', 'Waivers'], ['trade', 'Trade'], ['playoffs', 'Playoffs'], ['watchlist', 'Watchlist'], ['league', 'League'], ['settings', 'Settings']];

const state = {
  settings: { leagueId: '', season: defaultSeason(), teamId: null, basis: 'smart', demo: false, starred: {} },
  model: null, an: null, tab: 'overview', loading: false, error: null, signedIn: null,
  viewId: null,      // team whose perspective we're showing
  pnotes: {},        // { playerId: { star: bool, note: string } } for this league
  index: new Map(),  // playerId -> { p, ownerId }
  openPlayer: null,
  trade: { partner: null, give: [], get: [] },
  oddsCache: null,
  wv: { pos: 'ALL', sort: 'score', showInjured: false },
};

// ---------- helpers
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f0 = n => (Number.isFinite(+n) && n != null ? Math.round(n).toLocaleString() : '–');
const f1 = n => (Number.isFinite(+n) && n != null ? (+n).toFixed(1) : '–');
const val = p => A.value(p, state.settings.basis);
const abbr = p => state.model.proTeams[p.proTeamId]?.abbrev || PRO_ABBR[p.proTeamId] || 'FA';
const teamName = id => state.model.teams.find(t => t.id === id)?.name || `Team ${id}`;
const leagueKey = () => (state.settings.demo ? 'demo' : `${state.settings.leagueId}:${state.settings.season}`);
const starredTeam = () => state.settings.starred?.[leagueKey()] ?? null;
const isStar = id => !!state.pnotes[id]?.star;
const isHidden = id => !!state.pnotes[id]?.hidden;
const xBtn = id => `<button class="xbtn" data-act="hide" data-id="${id}" title="Hide from waivers" aria-label="Hide from waivers">✕</button>`;
const noteOf = id => state.pnotes[id]?.note || '';
const savePNotes = () => store.set(`pnotes:${leagueKey()}`, state.pnotes);
const pct = x => (Number.isFinite(x) ? `${Math.min(99, Math.max(1, Math.round(x * 100)))}%` : '–');
const STAR = '<span class="star" title="Starred">★</span>';

function badge(p) {
  const map = { OUT: ['O', 'b-out'], INJURY_RESERVE: ['IR', 'b-out'], SUSPENSION: ['SSPD', 'b-out'], DAY_TO_DAY: ['DTD', 'b-dtd'], QUESTIONABLE: ['Q', 'b-dtd'] };
  const b = map[p.injury];
  const tip = [p.injuryType, A.returnLabel(p)].filter(Boolean).join(' · ');
  return b ? `<span class="badge ${b[1]}" ${tip ? `title="${esc(tip)}"` : ''}>${b[0]}</span>` : '';
}
function pCell(p, extra = '') {
  const pos = p.eligible?.length ? p.eligible.join('/') : p.pos;
  const marks = (isStar(p.id) ? STAR : '') + (noteOf(p.id) ? '<span class="has-note" title="Has notes">✎</span>' : '');
  return `<div class="pl"><span class="pn" data-player="${p.id}" title="Notes & details">${esc(p.name)}${marks}${badge(p)}${extra}</span><span class="pm">${esc(abbr(p))} · ${esc(pos)}</span></div>`;
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
      const key = `cache:v5:${s.leagueId}:${s.season}`; // bump when the parser changes
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
    // Main team: the one you starred, else your ESPN login's team, else the first team.
    const has = id => id != null && model.teams.some(t => t.id === +id);
    let tid = starredTeam() ?? (s.demo ? model.myTeamId : s.teamId);
    if (!has(tid)) {
      const sw = (await swid())?.toLowerCase();
      tid = (sw && model.teams.find(t => t.owners?.some(o => String(o).toLowerCase() === sw))?.id) ?? model.teams[0]?.id;
    }
    if (!has(state.viewId) || state.loadedKey !== leagueKey()) state.viewId = +tid;
    state.loadedKey = leagueKey();
    state.pnotes = (await store.get(`pnotes:${leagueKey()}`)) || {};
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
function reanalyze() {
  const m = state.model;
  if (!m) { state.an = null; return; }
  m.myTeamId = state.viewId;
  // Players you've X'd out never show up in waiver suggestions, streaming plans or stash lists.
  state.an = A.analyze({ ...m, freeAgents: m.freeAgents.filter(p => !isHidden(p.id)) }, state.settings.basis);
  state.index = new Map();
  for (const t of m.teams) for (const p of t.roster) state.index.set(p.id, { p, ownerId: t.id });
  for (const p of m.freeAgents) if (!state.index.has(p.id)) state.index.set(p.id, { p, ownerId: null });
}
async function saveSettings() { await store.set('settings', state.settings); }

// ---------- views
function vHeader() {
  const m = state.model;
  const opts = Object.entries(A.BASIS).map(([k, v]) => `<option value="${k}" ${k === state.settings.basis ? 'selected' : ''}>${v}</option>`).join('');
  return `<header>
    <div class="brand"><span class="mark" aria-hidden="true"></span><span class="wm">LinedUp<em>Better</em></span></div>
    ${m ? vTeamPicker() : ''}
    <div class="spacer"></div>
    ${m ? `<label class="basis"><span>FP/G</span><select data-act="basis" title="How player value is calculated">${opts}</select></label>` : ''}
    <button class="ghost" data-act="refresh" title="Refresh from ESPN" aria-label="Refresh">${ICON.refresh}</button>
    ${isExt && !full ? `<button class="ghost" data-act="expand" title="Open in a full tab" aria-label="Open full view">${ICON.expand}</button>` : ''}
  </header>
  <nav>${TABS.map(([k, v]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${v}</button>`).join('')}</nav>`;
}

function vTeamPicker() {
  const m = state.model;
  const main = starredTeam() ?? null;
  const viewing = state.viewId;
  const isMain = main === viewing;
  const opts = m.teams.map(t => `<option value="${t.id}" ${t.id === viewing ? 'selected' : ''}>${t.id === main ? '★ ' : ''}${esc(t.name)}</option>`).join('');
  return `<div class="ctx">
    <button class="starbtn ${isMain ? 'on' : ''}" data-act="star-team" title="${isMain ? 'This is your main team (opens first)' : 'Make this your main team (opens first)'}" aria-label="Star team">${isMain ? '★' : '☆'}</button>
    <select class="teamsel" data-act="view" title="See the league from any team's point of view">${opts}</select>
    ${main != null && !isMain ? '<button class="pill ghostpill" data-act="home" title="Back to your starred team">My team</button>' : ''}
    <span class="sep">/</span><span class="muted lgname">${esc(m.name)}</span>
    ${m.demo ? '<span class="pill" data-tab="settings" title="Connect your league in Settings">Sample data</span>' : ''}
  </div>`;
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
  return vBoard(strip) + vOverviewBody();
}

// Scoreboard with ‹ › to step through the viewed team's matchups: live week, final
// results for past weeks, predicted scores for future ones.
function vBoard(strip) {
  const { an, model: m } = state;
  const my = an.my;
  const sched = A.teamSchedule(m, my.id, state.settings.basis);
  const periods = sched.map(x => x.period);
  let period = state.boardPeriod ?? m.currentPeriod;
  if (periods.length && !periods.includes(period)) period = periods.reduce((a, b) => (Math.abs(b - m.currentPeriod) < Math.abs(a - m.currentPeriod) ? b : a));
  const i = periods.indexOf(period);
  const prev = periods[i - 1], next = periods[i + 1];
  const live = period === m.currentPeriod;
  const g = sched[i];
  const label = period > m.regularPeriods ? `Playoffs · ${A.periodRange(m, period)}` : A.periodRange(m, period);
  const nav = `<div class="board-top">
      <div class="wknav">
        <button class="arrow" data-act="wk" data-p="${prev ?? ''}" ${prev == null ? 'disabled' : ''} aria-label="Previous week">‹</button>
        <span>Week ${period}</span>
        <button class="arrow" data-act="wk" data-p="${next ?? ''}" ${next == null ? 'disabled' : ''} aria-label="Next week">›</button>
        ${!live ? `<button class="wkback" data-act="wk" data-p="${m.currentPeriod}">This week</button>` : ''}
      </div>
      <span>${label}</span></div>`;
  if (!g || !g.opp) return `<section class="board">${nav}<p class="muted" style="margin:18px 0">${g ? 'Bye week.' : 'No matchup scheduled.'}</p>${strip}</section>`;

  // Live week uses the main analysis (lineup-aware); other weeks use the schedule projection.
  const x = live && an.matchup && !an.matchup.bye ? an.matchup
    : { opp: g.opp, myPts: g.myPts, oppPts: g.oppPts, myProj: g.myProj, oppProj: g.oppProj, myGames: g.myGames, oppGames: g.oppGames, winProb: g.winProb };
  const future = period > m.currentPeriod;
  const done = period < m.currentPeriod;
  const big = (pts, proj) => (future ? proj : pts);
  const sub = (proj, games) => (done ? 'final' : future ? `projected · ${games} games` : `proj <b>${f0(proj)}</b> · ${games} games left`);
  const wp = Math.min(99, Math.max(1, Math.round((x.winProb ?? 0.5) * 100)));
  const result = done ? `<div class="odds"><span class="a">${g.won ? 'WIN' : g.tie ? 'TIE' : 'LOSS'}</span><div class="bar"><i style="width:${g.won ? 100 : g.tie ? 50 : 0}%"></i></div><span class="b">${f0(Math.abs(g.myPts - g.oppPts))} pt margin</span></div>`
    : `<div class="odds"><span class="a">${wp}%</span><div class="bar"><i style="width:${wp}%"></i></div><span class="b">${100 - wp}%</span></div>`;
  return `<section class="board ${future ? 'future' : ''}">${nav}
      <div class="score">
        <div class="side me"><div class="tn">${esc(my.name)}</div><div class="pts">${f0(big(x.myPts, x.myProj))}</div><div class="proj">${sub(x.myProj, x.myGames)}</div></div>
        <div class="vs">vs</div>
        <div class="side them"><div class="tn"><button class="tlink" data-view="${x.opp.id}" title="View as this team">${esc(x.opp.name)}</button></div><div class="pts">${f0(big(x.oppPts, x.oppProj))}</div><div class="proj">${sub(x.oppProj, x.oppGames)}</div></div>
      </div>
      ${result}
      ${strip}
    </section>`;
}

function vOverviewBody() {
  const { an } = state;
  let h = '';

  const picks = an.waivers.filter(w => !A.isOut(w.p)).sort((a, b) => b.weekGain - a.weekGain).slice(0, 6);
  h += `<div class="grid2">
    <section class="card"><h3>The rundown</h3><ul class="notes">
      ${an.feedback.map(n => `<li class="note t-${n.type}"><span class="tag">${esc(n.tag)}</span><div><b>${esc(n.title)}</b>${n.detail ? `<span>${esc(n.detail)}</span>` : ''}</div></li>`).join('')}
    </ul></section>
    <section class="card"><h3>Pickups this week <span class="r">${an.drop ? `for ${esc(an.drop.name)}` : ''}</span></h3>
      ${picks.map((w, i) => `<div class="pick"><span class="rk">${String(i + 1).padStart(2, '0')}</span>${pCell(w.p)}<div class="meta">${f1(w.v)}<small> FP/G</small><br>${w.gl}<small> games</small></div><div class="gain">${w.weekGain > 0 ? '+' : ''}${f0(w.weekGain)}</div>${xBtn(w.p.id)}</div>`).join('') || '<p class="muted">No free agents loaded.</p>'}
      <button class="link" data-tab="waivers">Full waiver wire →</button>
    </section>
  </div>`;
  return h;
}

// Days to show in schedule grids. Long matchups (opening week, All-Star, playoffs)
// span two weeks, so show the Mon–Sun week that contains today.
function weekWindow(m) {
  const all = m.periods[m.currentPeriod] || [];
  const monday = sp => { const d = A.spDate(m, sp); return sp - ((d.getDay() + 6) % 7); };
  const today = Math.min(Math.max(m.currentSP, all[0] ?? 1), all[all.length - 1] ?? 1);
  return { all, sps: all.length > 7 ? all.filter(sp => monday(sp) === monday(today)) : all };
}

function vRoster() {
  const { an, model: m } = state;
  const { all, sps } = weekWindow(m);
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
      const b2b = g && A.isB2B(m, p, sp);
      return `<td class="day ${cls}">${g ? `<span class="gm ${g.home ? 'home' : ''} ${b2b ? 'b2b' : ''}" ${b2b ? 'title="Back-to-back: rest risk"' : ''}>${g.home ? '' : '@'}${esc(m.proTeams[g.opp]?.abbrev || PRO_ABBR[g.opp] || '')}</span>` : ''}</td>`;
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
  return vLineupCard() + `<section class="card"><h3>${esc(an.my.name)} · week ${m.currentPeriod} <span class="r muted small">${A.periodRange(m, m.currentPeriod)}${all.length > 7 ? ` · showing ${A.fmtMD(A.spDate(m, sps[0]))} – ${A.fmtMD(A.spDate(m, sps[sps.length - 1]))}` : ''}</span></h3>
    <div class="scrollx"><table>
      <thead><tr><th>Slot</th><th>Player</th><th class="num" title="${A.BASIS[state.settings.basis]}">FP/G</th><th class="num">Season</th><th class="num">L15</th><th class="num">Δ</th><th class="num" title="Games left in this matchup">GL</th>${dayHead}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="7" class="num">Healthy players with a game / starting slots →</td>${foot}</tr></tfoot>
    </table></div>
    <p class="muted small">Red counts = empty lineup slots (stream someone). Amber = more players than slots (games left on your bench). “@” = road game. Dot = back-to-back (rest risk).</p>
  </section>`;
}

function vWaivers() {
  const { an, model: m } = state;
  const w = state.wv;
  const { sps } = weekWindow(m);
  const openOn = Object.fromEntries(an.base.days.map(d => [d.sp, d.open]));
  if (w.day != null && !sps.includes(w.day)) w.day = null;
  let list = an.waivers.filter(x => (w.showInjured || !A.isOut(x.p)) && (w.pos === 'ALL' || x.p.eligible.includes(w.pos) || x.p.pos === w.pos)
    && (w.day == null || A.gameOn(m, x.p, w.day)));
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
      <td class="num">${x.p.owned != null ? x.p.owned.toFixed(0) + '%' : '–'} <span class="small ${oc > 0 ? 'up' : oc < 0 ? 'down' : 'muted'}">${oc ? (oc > 0 ? '+' : '') + oc.toFixed(1) : ''}</span></td>
      ${sps.map(sp => {
        const g = A.gameOn(m, x.p, sp);
        const past = sp < m.currentSP;
        const fills = g && !past && openOn[sp] > 0;
        const opp = g ? (m.proTeams[g.opp]?.abbrev || PRO_ABBR[g.opp] || '') : '';
        const tip = g ? `${g.home ? 'vs' : '@'} ${opp}${fills ? ' · fills one of your open slots' : ''}${A.isB2B(m, x.p, sp) ? ' · back-to-back' : ''}` : '';
        return `<td class="day ${past ? 'past' : ''} ${w.day === sp ? 'sel' : ''}">${g ? `<span class="gm ${g.home ? 'home' : ''} ${fills ? 'fill' : ''} ${A.isB2B(m, x.p, sp) ? 'b2b' : ''}" title="${esc(tip)}">${g.home ? '' : '@'}${esc(opp)}</span>` : ''}</td>`;
      }).join('')}
      <td class="xcell">${xBtn(x.p.id)}</td></tr>`;
  }).join('');
  return vPlanCard() + `<section class="card">
    <h3>Waiver wire <span class="r muted small">${an.drop ? `Drop candidate: <b>${esc(an.drop.name)}</b> (${f1(an.dropV)} FP/G, ${A.gamesIn(m, an.drop, an.rem)} GL)` : ''}</span></h3>
    <div class="chips">
      ${['ALL', 'PG', 'SG', 'SF', 'PF', 'C'].map(p => `<button class="chip ${w.pos === p ? 'on' : ''}" data-pos="${p}">${p}</button>`).join('')}
      ${w.day != null ? `<button class="chip on" data-day="${w.day}" title="Clear day filter">Plays ${A.fmtDow(A.spDate(m, w.day))} ✕</button>` : ''}
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
        ${sps.map(sp => {
          const d = A.spDate(m, sp);
          const cls = sp === m.currentSP ? 'today' : sp < m.currentSP ? 'past' : '';
          const open = sp >= m.currentSP ? openOn[sp] || 0 : 0;
          return `<th class="day sort ${cls} ${w.day === sp ? 'on' : ''}" data-day="${sp}" title="Click to show only players with a game ${A.fmtDow(d)}${open ? ` · you have ${open} open slot${open > 1 ? 's' : ''}` : ''}">${A.fmtDow(d)}<br>${d.getDate()}${open ? `<span class="openmark">${open}</span>` : ''}</th>`;
        }).join('')}<th></th>
      </tr></thead><tbody>${rows || `<tr><td colspan="${9 + sps.length}" class="muted">No players match.</td></tr>`}</tbody>
    </table></div>
    <p class="muted small">UPGRADE = better FP/G than your drop candidate. W = on waivers (claim, not instant add). ✕ = hide a player you don't want. Click a column to sort; click a day to see who plays then. Highlighted games land on days you have open lineup slots (number under the day). Dot = back-to-back.</p>
    ${vHidden()}
  </section>`;
}

function vHidden() {
  const hidden = state.model.freeAgents.filter(p => isHidden(p.id));
  if (!hidden.length) return '';
  return `<details class="hidden-list" ${state.showHidden ? 'open' : ''}><summary data-act="toggle-hidden">Hidden players (${hidden.length})</summary>
    <div class="chips">${hidden.map(p => `<button class="chip unhide" data-act="unhide" data-id="${p.id}" title="Show in waivers again">${esc(p.name)} <span>↺</span></button>`).join('')}
    <button class="link" data-act="unhide-all">Unhide all</button></div></details>`;
}

function vLineupCard() {
  const { an, model: m } = state;
  const lc = an.lineup;
  if (!lc) return '';
  const today = A.fmtDow(A.spDate(m, m.currentSP)) + ' ' + A.fmtMD(A.spDate(m, m.currentSP));
  if (lc.gain < 1) {
    return `<section class="card lineup ok"><h3>Today's lineup <span class="r muted small">${today}</span></h3>
      <p class="okline">✓ Optimal: your starters are the best lineup for today's games (≈${f0(lc.best)} pts).</p></section>`;
  }
  const li = (ps, cls) => ps.map(p => `<li class="${cls}">${pCell(p)}<span class="num muted small">${A.gameOn(m, p, m.currentSP) ? f1(val(p)) + ' FP/G' : 'no game'}</span></li>`).join('');
  return `<section class="card lineup"><h3>Today's lineup <span class="r muted small">${today} · ESPN lineup vs best possible</span></h3>
    <div class="swap">
      <div><div class="rk-label">Start</div><ul class="plist">${li(lc.start, 'in') || '<li class="muted">–</li>'}</ul></div>
      <div class="gainbox"><b>+${f0(lc.gain)}</b><span>pts today</span></div>
      <div><div class="rk-label">Sit</div><ul class="plist">${li(lc.sit, 'out') || '<li class="muted">–</li>'}</ul></div>
    </div>
    <p class="muted small">Based on today's NBA games and position rules. Make the swap on ESPN before tip-off.</p></section>`;
}

function vPlanCard() {
  const { an, model: m } = state;
  const plan = an.plan || [];
  const left = A.addsLeft(m, an.my);
  const head = `<h3>Streaming plan <span class="r muted small">${m.acqLimit > 0 ? `${left} add${left === 1 ? '' : 's'} left this matchup` : 'no add limit, showing up to 3 moves'}</span></h3>`;
  if (!plan.length) return `<section class="card">${head}<p class="muted">No add/drop beats your current roster for the rest of this matchup.</p></section>`;
  const total = plan.reduce((a, x) => a + x.gain, 0);
  return `<section class="card">${head}
    <ol class="plan">${plan.map((x, i) => `<li><span class="rk">${i + 1}</span>
      <div class="mv"><span class="tag-add">ADD</span>${pCell(x.add)}</div>
      <div class="mv"><span class="tag-drop">DROP</span>${pCell(x.drop)}</div>
      <div class="meta">${x.games}<small> games left</small></div>
      <div class="gain">+${f0(x.gain)}</div></li>`).join('')}</ol>
    <p class="muted small">Total ≈ <b>+${f0(total)}</b> projected points this matchup. Each move is picked given the ones before it, and drops only come from your weakest players.</p></section>`;
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

  return `<section class="card"><h3>${esc(an.my.name)} in the fantasy playoffs <span class="r muted small">Highlighted = more games than usual</span></h3>
      <div class="scrollx"><table><thead><tr><th>Player</th>${head}<th class="num">Total</th><th class="num">Proj FP</th></tr></thead><tbody>${myRows}</tbody></table></div></section>
    <div class="grid2">
      <section class="card"><h3>NBA games by playoff round</h3>
        <div class="scrollx"><table><thead><tr><th>Team</th>${head}<th class="num">Tot</th><th>Roster</th></tr></thead><tbody>${nbaRows}</tbody></table></div></section>
      <section class="card"><h3>Playoff stash targets <span class="r muted small">FP/G × playoff games</span></h3>
        ${stash.map(w => `<div class="pick">${pCell(w.p)}<div class="num small muted">${f1(w.v)} FP/G<br>${w.poGames} PO games</div><div class="gain">${f0(w.poPts)}</div>${xBtn(w.p.id)}</div>`).join('')}
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
  const main = starredTeam();
  const odds = getOdds();
  const oc = x => `<td class="num"><span class="odds-cell" style="--p:${(x * 100).toFixed(0)}%">${x >= 0.995 ? '✓' : x < 0.005 ? '–' : Math.round(x * 100) + '%'}</span></td>`;
  const rows = st.map((t, i) => {
    const gb = ((lead.wins - t.wins) + (t.losses - lead.losses)) / 2;
    const cls = [t.id === an.my.id ? 'me' : '', i + 1 === m.playoffTeamCount ? 'line' : ''].join(' ');
    const o = odds.teams[t.id];
    return `<tr class="${cls}"><td class="num muted">${i + 1}</td><td><button class="tlink" data-view="${t.id}" title="View as this team">${t.id === main ? '<span class="star">★</span> ' : ''}${esc(t.name)}</button></td><td class="num">${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}</td><td class="num">${gb ? gb.toFixed(1) : '–'}</td><td class="num">${f0(t.pf)}</td>
      <td class="num muted">${Math.round(o.expW)}-${Math.round(o.expL)}</td>${oc(o.playoff)}${odds.byes ? oc(o.bye) : ''}</tr>`;
  }).join('');
  return `<div class="grid2">
    <section class="card"><h3>Standings & playoff odds <span class="r muted small">click a team to view as them</span></h3>
      <div class="scrollx"><table><thead><tr><th class="num">#</th><th>Team</th><th class="num">W-L</th><th class="num">GB</th><th class="num">PF</th><th class="num" title="Projected final record">Proj</th><th class="num" title="Chance to make the playoffs">Playoffs</th>${odds.byes ? '<th class="num" title="Chance of a first-round bye">Bye</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">${odds.simulated ? `Simulated the ${odds.simulated} remaining regular-season matchups 3,000 times using each team's projected scores. Ties broken by points for.` : 'Regular season is over.'} Dashed line = playoff cut (top ${m.playoffTeamCount}).</p></section>
    ${vRules()}
  </div>`;
}

function getOdds() {
  const key = `${state.model.fetchedAt || 'demo'}:${state.settings.basis}`;
  if (state.oddsCache?.key !== key) state.oddsCache = { key, odds: A.playoffOdds(state.model, state.settings.basis) };
  return state.oddsCache.odds;
}

function vTrade() {
  const { an, model: m } = state;
  const b = state.settings.basis;
  const tr = state.trade;
  const others = m.teams.filter(t => t.id !== an.my.id);
  if (!others.some(t => t.id === tr.partner)) { tr.partner = others[0]?.id ?? null; tr.get = []; }
  const partner = m.teams.find(t => t.id === tr.partner);
  const mine = an.my.roster, theirs = partner?.roster || [];
  const give = mine.filter(p => tr.give.includes(p.id)), get = theirs.filter(p => tr.get.includes(p.id));
  const pick = (list, side) => list.slice().sort((a, b2) => val(b2) - val(a)).map(p => {
    const on = tr[side].includes(p.id);
    return `<label class="tp ${on ? 'on' : ''}"><input type="checkbox" data-trade="${side}" value="${p.id}" ${on ? 'checked' : ''}>${pCell(p)}<span class="num">${f1(val(p))}</span></label>`;
  }).join('');
  let result = '<p class="muted">Pick players on both sides to see the impact.</p>';
  if (give.length || get.length) {
    const a = A.tradeImpact(m, an.my, give, get, b);
    const z = partner ? A.tradeImpact(m, partner, get, give, b) : null;
    const d = (x, y) => { const v = y - x; return `<span class="${v > 0.5 ? 'up' : v < -0.5 ? 'down' : 'muted'}">${v > 0 ? '+' : ''}${f0(v)}</span>`; };
    const row = (label, k) => `<tr><td>${label}</td><td class="num">${d(a.before[k], a.after[k])}</td>${z ? `<td class="num">${d(z.before[k], z.after[k])}</td>` : ''}</tr>`;
    const verdict = (a.after.ros - a.before.ros) + (a.after.po - a.before.po);
    const drops = [...a.drops.map(p => `${esc(an.my.name)} drops ${esc(p.name)}`), ...(z ? z.drops.map(p => `${esc(partner.name)} drops ${esc(p.name)}`) : [])];
    result = `<table class="impact"><thead><tr><th>Projected points</th><th class="num">${esc(an.my.name)}</th>${z ? `<th class="num">${esc(partner.name)}</th>` : ''}</tr></thead><tbody>
        ${row('This matchup', 'week')}${row('Rest of regular season', 'ros')}${row('Fantasy playoffs', 'po')}
        <tr class="sum"><td>FP/G swapped</td><td class="num">${d(give.reduce((s2, p) => s2 + val(p), 0), get.reduce((s2, p) => s2 + val(p), 0))}</td>${z ? `<td class="num">${d(get.reduce((s2, p) => s2 + val(p), 0), give.reduce((s2, p) => s2 + val(p), 0))}</td>` : ''}</tr>
      </tbody></table>
      <p class="verdict ${verdict > 0 ? 'up' : 'down'}">${verdict > 0 ? 'Good for' : 'Bad for'} ${esc(an.my.name)}: ${verdict > 0 ? '+' : ''}${f0(verdict)} projected points the rest of the way (season + playoffs).</p>
      ${drops.length ? `<p class="muted small">Roster spots: ${drops.join('; ')}.</p>` : ''}`;
  }
  const bs = A.buySell(m, an.my.id, b);
  const bsRow = (x, act) => `<div class="pick">${pCell(x.p)}<div class="meta">${f1(x.p.stats.l15.avg)}<small> L15</small><br>${f1(x.p.stats.season.avg)}<small> season</small></div>
    <div class="gain ${x.d < 0 ? 'down' : ''}">${x.d > 0 ? '+' : ''}${f1(x.d)}</div>${act ? `<button class="btn mini" data-act="target" data-id="${x.p.id}" data-owner="${x.owner.id}">Target</button>` : ''}</div>`;
  return `<div class="grid2">
      <section class="card"><h3>You give <span class="r">${esc(an.my.name)}</span></h3><div class="tlist">${pick(mine, 'give')}</div></section>
      <section class="card"><h3>You get <select class="tsel" data-act="partner">${others.map(t => `<option value="${t.id}" ${t.id === tr.partner ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></h3><div class="tlist">${pick(theirs, 'get')}</div></section>
    </div>
    <section class="card"><h3>Trade impact <span class="r">${give.length || get.length ? '<button class="link" data-act="trade-clear">Clear</button>' : ''}</span></h3>${result}</section>
    <div class="grid2">
      <section class="card"><h3>Buy low <span class="r muted small">other teams' players in a slump (last 15 vs season)</span></h3>${bs.buy.map(x => bsRow(x, true)).join('') || '<p class="muted">Shows up after ~2 weeks of games.</p>'}</section>
      <section class="card"><h3>Sell high <span class="r muted small">your players above their norm</span></h3>${bs.sell.map(x => bsRow(x, false)).join('') || '<p class="muted">Nobody on your roster is running hot right now.</p>'}</section>
    </div>`;
}

function vRules() {
  const m = state.model;
  const scoring = (m.scoring || []).slice().sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const chips = scoring.map(x => `<span class="rule ${x.points < 0 ? 'neg' : ''}"><b>${esc(STAT_NAMES[x.statId] || 'Stat ' + x.statId)}</b>${x.points > 0 ? '+' : ''}${+x.points.toFixed(2)}</span>`).join('');
  const slotCounts = Object.entries(m.slotCounts || {}).filter(([, n]) => n > 0).map(([k, n]) => `${SLOT[k] || k}${n > 1 ? '×' + n : ''}`).join(', ');
  const po = A.playoffPeriods(m);
  const longWeeks = Object.keys(m.periods).map(Number).filter(id => id <= m.regularPeriods && (m.periods[id] || []).length > 7)
    .sort((a, b) => a - b).map(id => `Wk ${id} (${A.periodRange(m, id)})`);
  const rounds = po.map((id, i) => `<li><b>Round ${i + 1}</b> <span class="muted">${A.periodRange(m, id)} · ${(m.periods[id] || []).length} days</span></li>`).join('');
  return `<section class="card"><h3>League rules <span class="r muted small">what every projection here uses</span></h3>
    ${m.pointsEstimate ? `<p class="warnline">This league scores by categories (${esc(m.scoringType)}). Values below use ESPN's standard points scoring as an estimate.</p>` : ''}
    <div class="rk-label">Points per stat</div><div class="rules">${chips || '<span class="muted">No scoring found.</span>'}</div>
    <div class="facts">
      <div><span class="k">Starters / day</span><span class="v">${m.starters}</span></div>
      <div><span class="k">Regular season</span><span class="v">${m.regularPeriods} matchups</span></div>
      <div><span class="k">Playoff teams</span><span class="v">${m.playoffTeamCount}</span></div>
      <div><span class="k">Adds / matchup</span><span class="v">${m.acqLimit > 0 ? m.acqLimit : 'No limit'}</span></div>
    </div>
    <div class="rk-label">Lineup</div><p class="small" style="margin:0 0 10px">${esc(slotCounts) || '–'}</p>
    <div class="rk-label">Matchup calendar</div>
    <p class="small" style="margin:0 0 10px">This week: <b>${A.periodRange(m, m.currentPeriod)}</b>. ${longWeeks.length ? `Longer matchups: ${longWeeks.join(', ')}.` : 'Every regular-season matchup is one week.'}
      <span class="muted">Compare with ESPN's schedule page if anything looks off.</span></p>
    ${rounds ? `<div class="rk-label">Playoff rounds</div><ul class="rounds">${rounds}</ul>` : ''}
  </section>`;
}

function vMatchups() {
  const { an, model: m } = state;
  const b = state.settings.basis;
  const me = an.my.id;
  const board = A.scoreboard(m, m.currentPeriod, b);
  const live = board.map(x => {
    const mine = x.home.id === me || x.away?.id === me;
    return `<div class="mrow ${mine ? 'me' : ''}">
      <button class="tlink l" data-view="${x.home.id}">${esc(x.home.name)}</button>
      <div class="sc"><b>${f0(x.homePts)}</b><small>proj ${f0(x.homeProj)}</small></div>
      <div class="wpm"><span>${x.away ? pct(x.winProb) : ''}</span><div class="bar"><i style="width:${(x.winProb * 100).toFixed(0)}%"></i></div><span>${x.away ? pct(1 - x.winProb) : ''}</span></div>
      <div class="sc r"><b>${x.away ? f0(x.awayPts) : '–'}</b><small>${x.away ? 'proj ' + f0(x.awayProj) : 'bye'}</small></div>
      ${x.away ? `<button class="tlink r" data-view="${x.away.id}">${esc(x.away.name)}</button>` : '<span class="muted r">Bye</span>'}
    </div>`;
  }).join('');

  const sched = A.teamSchedule(m, me, b);
  const future = sched.filter(x => !x.done && x.period <= m.regularPeriods);
  const expWins = future.reduce((a, x) => a + (x.winProb ?? 0), 0);
  const projW = an.my.wins + expWins, projL = an.my.losses + future.filter(x => x.opp).length - expWins;
  const rows = sched.map(x => {
    const cur = x.period === m.currentPeriod;
    const po = x.period > m.regularPeriods;
    const res = x.done
      ? `<span class="res ${x.won ? 'w' : x.tie ? '' : 'l'}">${x.won ? 'W' : x.tie ? 'T' : 'L'}</span> ${f0(x.myPts)}–${f0(x.oppPts)}`
      : `${f0(x.myProj)}–${f0(x.oppProj)}`;
    return `<tr class="${cur ? 'me' : ''} ${x.done ? 'done' : ''}">
      <td class="muted">${po ? 'PO ' : 'Wk '}${x.period}<br><span class="small">${A.periodRange(m, x.period)}</span></td>
      <td>${x.opp ? `<button class="tlink" data-view="${x.opp.id}">${esc(x.opp.name)}</button><br><span class="small muted">${x.opp.wins}-${x.opp.losses}</span>` : '<span class="muted">Bye</span>'}</td>
      <td class="num">${res}${cur ? '<br><span class="small muted">live + proj</span>' : ''}</td>
      <td class="num">${x.done || x.winProb == null ? '' : `<b class="${x.winProb >= 0.5 ? 'up' : 'down'}">${pct(x.winProb)}</b>`}</td>
    </tr>`;
  }).join('');

  return `<section class="card"><h3>Week ${m.currentPeriod} scoreboard <span class="r muted small">${A.periodRange(m, m.currentPeriod)} · live score + projected final</span></h3>
      <div class="board-list">${live || '<p class="muted">No matchups this week.</p>'}</div></section>
    <section class="card"><h3>${esc(an.my.name)} · schedule & predictions <span class="r muted small">projected record <b>${Math.round(projW)}-${Math.round(projL)}</b></span></h3>
      <div class="scrollx"><table><thead><tr><th>Week</th><th>Opponent</th><th class="num">Score / Proj</th><th class="num">Win %</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No schedule yet.</td></tr>'}</tbody></table></div>
      <p class="muted small">Future weeks are projected with each team's current roster and NBA schedule, using ${esc(A.BASIS[state.settings.basis])} values and this league's scoring.</p></section>`;
}

function vWatchlist() {
  const { an, model: m } = state;
  const ids = Object.entries(state.pnotes).filter(([, v]) => v.star || v.note).map(([id]) => +id);
  const rows = ids.map(id => state.index.get(id)).filter(Boolean)
    .sort((a, b) => isStar(b.p.id) - isStar(a.p.id) || val(b.p) - val(a.p))
    .map(({ p, ownerId }) => `<tr>
      <td>${pCell(p)}</td>
      <td>${ownerId == null ? `<span class="badge b-wv">${p.status === 'WAIVERS' ? 'WAIVERS' : 'FREE AGENT'}</span>` : `<button class="tlink" data-view="${ownerId}">${esc(teamName(ownerId))}</button>`}</td>
      <td class="num"><b>${f1(val(p))}</b></td>
      <td class="num">${A.gamesIn(m, p, an.rem)}</td>
      <td class="note-cell">${esc(noteOf(p.id)) || '<span class="muted">–</span>'}</td></tr>`).join('');
  const missing = ids.filter(id => !state.index.has(id)).length;
  return `<section class="card"><h3>Watchlist <span class="r muted small">star players or add notes from any player's name</span></h3>
    ${rows ? `<div class="scrollx"><table><thead><tr><th>Player</th><th>Owner</th><th class="num">FP/G</th><th class="num" title="Games left this matchup">GL</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty" style="padding:30px"><p>Nothing here yet. Click any player name, anywhere in the app, to star them or write a note.</p></div>'}
    ${missing ? `<p class="muted small">${missing} saved player${missing > 1 ? 's are' : ' is'} no longer rostered or in the top free agents.</p>` : ''}
  </section>`;
}

function vDrawer() {
  const hit = state.index.get(state.openPlayer);
  if (!hit) return '';
  const { p, ownerId } = hit;
  const m = state.model;
  const s = p.stats;
  const row = (k, label) => s[k] ? `<tr><td>${label}</td><td class="num"><b>${f1(s[k].avg)}</b></td><td class="num muted">${s[k].gp || '–'}</td></tr>` : '';
  const po = A.playoffPeriods(m).flatMap(id => m.periods[id] || []);
  return `<div class="scrim" data-act="close"></div>
  <aside class="drawer" role="dialog" aria-label="${esc(p.name)}">
    <div class="dh">
      <div><div class="dn">${esc(p.name)}${badge(p)}</div><div class="pm">${esc(abbr(p))} · ${esc(p.eligible.join('/') || p.pos)} · ${ownerId == null ? (p.status === 'WAIVERS' ? 'On waivers' : 'Free agent') : esc(teamName(ownerId))}</div>
        ${A.isOut(p) ? `<div class="injline">${esc([p.injuryType, A.returnLabel(p)].filter(Boolean).join(' · '))}</div>` : ''}</div>
      <button class="ghost" data-act="close" aria-label="Close">✕</button>
    </div>
    <div class="row">
      <button class="btn ${isStar(p.id) ? 'primary' : ''}" data-act="pstar">${isStar(p.id) ? '★ Starred' : '☆ Star player'}</button>
      ${ownerId == null ? `<button class="btn ${isHidden(p.id) ? 'warnbtn' : ''}" data-act="${isHidden(p.id) ? 'unhide' : 'hide'}" data-id="${p.id}">${isHidden(p.id) ? '↺ Unhide in waivers' : '✕ Hide from waivers'}</button>` : ''}
    </div>
    <div class="facts">
      <div><span class="k">FP/G</span><span class="v">${f1(val(p))}</span></div>
      <div><span class="k">Games left</span><span class="v">${A.gamesIn(m, p, state.an.rem)}</span></div>
      <div><span class="k">Playoff G</span><span class="v">${A.gamesIn(m, p, po)}</span></div>
    </div>
    <table><thead><tr><th>Split</th><th class="num">FP/G</th><th class="num">GP</th></tr></thead><tbody>
      ${row('season', 'Season')}${row('l7', 'Last 7')}${row('l15', 'Last 15')}${row('l30', 'Last 30')}${row('proj', 'ESPN projection')}${row('prev', 'Last season')}
    </tbody></table>
    <label class="rk-label" for="pnote">Your notes</label>
    <textarea id="pnote" data-act="pnote" rows="5" placeholder="e.g. buy-low target, minutes up since trade, ask about in trades…">${esc(noteOf(p.id))}</textarea>
    <p class="muted small">Saved automatically, only in this browser.</p>
  </aside>`;
}

function vSettings() {
  const s = state.settings;
  const m = state.model;
  const mainId = starredTeam() ?? state.viewId;
  const teamOpts = m && !m.demo ? m.teams.map(t => `<option value="${t.id}" ${t.id === mainId ? 'selected' : ''}>${esc(t.name)}</option>`).join('') : '';
  const signed = state.signedIn == null ? '' : state.signedIn
    ? '<span class="up">✓ Signed in to ESPN in this browser</span>'
    : '<span class="muted">Not signed in? </span> <button class="btn" data-act="signin">Sign in to ESPN</button>';
  return `<section class="card"><h3>Connect your ESPN league</h3>
    <div class="form">
      <label>League ID<input id="f-league" inputmode="numeric" placeholder="e.g. 12345678" value="${esc(s.leagueId)}"></label>
      <label>Season<input id="f-season" inputmode="numeric" value="${esc(s.season)}"></label>
      ${teamOpts ? `<label class="wide">My main team (★ — opens first)<select id="f-team">${teamOpts}</select></label>` : ''}
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
        <li>Your team is auto-detected from your ESPN login. Pick another above, or use ☆ next to the team switcher to star any team as your main one.</li>
        <li>Data is cached for 3 minutes. Hit ↻ to force a refresh.</li>
      </ol></section>
    ${state.error ? `<section class="card err"><h3>Last error</h3><p>${esc(state.error)}</p></section>` : ''}`;
}

function vBody() {
  if (state.loading) return '<div class="empty"><div class="spin"></div>Loading your league from ESPN…</div>';
  if (state.tab === 'settings') return vSettings();
  if (state.error) return `<div class="card err empty"><h2>Couldn't load your league</h2><p>${esc(state.error)}</p><div class="row" style="justify-content:center"><button class="btn primary" data-act="refresh">Try again</button><button class="btn" data-tab="settings">Settings</button></div></div>`;
  if (!state.model) return `<div class="empty"><h2>LinedUp<em>Better</em></h2><p>Connect your ESPN league to get started.</p><div class="row" style="justify-content:center"><button class="btn primary" data-tab="settings">Connect league</button><button class="btn" data-act="demo">Try demo</button></div></div>`;
  return { overview: vOverview, roster: vRoster, matchups: vMatchups, waivers: vWaivers, trade: vTrade, playoffs: vPlayoffs, watchlist: vWatchlist, league: vLeague }[state.tab]();
}

function render() {
  const app = document.getElementById('app');
  const scroll = document.querySelector('main')?.scrollTop || 0;
  let body;
  try { body = vBody(); } catch (e) { console.error(e); body = `<div class="card err">Something broke rendering this tab: ${esc(e.message)}</div>`; }
  let drawer = '';
  try { drawer = state.model && state.openPlayer != null ? vDrawer() : ''; } catch (e) { console.error(e); }
  app.innerHTML = vHeader() + `<main>${body}</main>` + drawer;
  if (state.keepScroll) document.querySelector('main').scrollTop = scroll;
  state.keepScroll = false;
}

// ---------- events
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-act],[data-pos],[data-sort],[data-player],[data-view],[data-day]');
  if (!t) return;
  if (t.matches('select, textarea, input')) return;
  if (t.dataset.player) { state.openPlayer = +t.dataset.player; state.keepScroll = true; render(); return; }
  if (t.dataset.view) { setView(+t.dataset.view); return; }
  if (t.dataset.tab) { state.tab = t.dataset.tab; render(); return; }
  if (t.dataset.day) { const d = +t.dataset.day; state.wv.day = state.wv.day === d ? null : d; state.keepScroll = true; render(); return; }
  if (t.dataset.pos) { state.wv.pos = t.dataset.pos; state.keepScroll = true; render(); return; }
  if (t.dataset.sort) { state.wv.sort = t.dataset.sort; state.keepScroll = true; render(); return; }
  const act = t.dataset.act;
  if (act === 'close') { state.openPlayer = null; state.keepScroll = true; render(); return; }
  if (act === 'hide' || act === 'unhide') {
    const id = +t.dataset.id;
    state.pnotes[id] = { ...state.pnotes[id], hidden: act === 'hide' };
    await savePNotes(); reanalyze(); state.keepScroll = true; render(); return;
  }
  if (act === 'unhide-all') {
    for (const id of Object.keys(state.pnotes)) if (state.pnotes[id].hidden) state.pnotes[id] = { ...state.pnotes[id], hidden: false };
    await savePNotes(); reanalyze(); state.keepScroll = true; render(); return;
  }
  if (act === 'toggle-hidden') { e.preventDefault(); state.showHidden = !state.showHidden; state.keepScroll = true; render(); return; }
  if (act === 'pstar') {
    const id = state.openPlayer;
    state.pnotes[id] = { ...state.pnotes[id], star: !isStar(id) };
    await savePNotes(); state.keepScroll = true; render(); return;
  }
  if (act === 'star-team') {
    const key = leagueKey();
    state.settings.starred = { ...state.settings.starred };
    if (state.settings.starred[key] === state.viewId) delete state.settings.starred[key];
    else state.settings.starred[key] = state.viewId;
    await saveSettings(); render(); return;
  }
  if (act === 'home') { setView(starredTeam()); return; }
  if (act === 'wk') { if (t.dataset.p !== '') { state.boardPeriod = +t.dataset.p; state.keepScroll = true; render(); } return; }
  if (act === 'trade-clear') { state.trade.give = []; state.trade.get = []; state.keepScroll = true; render(); return; }
  if (act === 'target') {
    const owner = +t.dataset.owner, id = +t.dataset.id;
    if (state.trade.partner !== owner) { state.trade.partner = owner; state.trade.get = []; }
    if (!state.trade.get.includes(id)) state.trade.get.push(id);
    document.querySelector('main').scrollTop = 0; render(); return;
  }
  if (act === 'refresh') load(true);
  if (act === 'signin') chrome.tabs.create({ url: 'https://www.espn.com/login' });
  if (act === 'expand') chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1') });
  if (act === 'demo') { state.settings.demo = true; await saveSettings(); state.tab = 'overview'; load(); }
  if (act === 'save') {
    const leagueId = document.getElementById('f-league').value.trim().replace(/\D/g, '');
    const season = +document.getElementById('f-season').value.trim() || defaultSeason();
    const team = document.getElementById('f-team');
    const changed = leagueId !== state.settings.leagueId || season !== +state.settings.season;
    Object.assign(state.settings, { leagueId, season, demo: false });
    if (team && !changed) {
      state.settings.starred = { ...state.settings.starred, [leagueKey()]: +team.value };
      state.viewId = +team.value;
    }
    state.settings.espnS2 = document.getElementById('f-s2').value.trim();
    state.settings.swid = document.getElementById('f-swid').value.trim();
    await saveSettings();
    state.tab = 'overview';
    load(true);
  }
});
function setView(id) {
  if (id == null || !state.model?.teams.some(t => t.id === id)) return;
  state.viewId = id; state.openPlayer = null; state.trade.give = []; state.boardPeriod = null;
  reanalyze(); render();
}
let noteTimer;
document.addEventListener('input', e => {
  if (e.target.dataset.act !== 'pnote') return;
  const id = state.openPlayer, text = e.target.value;
  state.pnotes[id] = { ...state.pnotes[id], note: text };
  clearTimeout(noteTimer);
  noteTimer = setTimeout(savePNotes, 300);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.openPlayer != null) { state.openPlayer = null; state.keepScroll = true; render(); }
});
document.addEventListener('change', async e => {
  const act = e.target.dataset.act;
  if (act === 'view') { setView(+e.target.value); return; }
  if (act === 'partner') { state.trade.partner = +e.target.value; state.trade.get = []; render(); return; }
  if (e.target.dataset.trade) {
    const side = e.target.dataset.trade, id = +e.target.value;
    const list = state.trade[side];
    state.trade[side] = e.target.checked ? [...list, id] : list.filter(x => x !== id);
    state.keepScroll = true; render(); return;
  }
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
