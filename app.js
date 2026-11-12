import { loadLeague, setTransport, fetchPlayerNews, PRO_ABBR, SLOT, STAT_NAMES } from './api.js';
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
const CACHE_MS = 60 * 1000; // short: live scores and lineup changes on ESPN show up quickly
const TABS = [['overview', 'Overview'], ['roster', 'Roster'], ['matchups', 'Matchups'], ['slate', 'Slate'], ['waivers', 'Waivers'], ['players', 'Players'], ['trade', 'Trade'], ['injuries', 'Injuries'], ['playoffs', 'Playoffs'], ['league', 'League'], ['watchlist', 'Watchlist'], ['settings', 'Settings']];

const state = {
  settings: { leagueId: '', season: defaultSeason(), teamId: null, basis: 'smart', demo: false, starred: {} },
  model: null, an: null, tab: 'overview', loading: false, error: null, signedIn: null,
  viewId: null,      // team whose perspective we're showing
  pnotes: {},        // { playerId: { star: bool, note: string } } for this league
  index: new Map(),  // playerId -> { p, ownerId }
  openPlayer: null,
  trade: { partner: null, give: [], get: [] },
  oddsCache: null,
  calc: {},          // memoized season-long results, keyed by data + settings
  scan: null,        // trade-ideas scan: { key, status, done, total, ideas, targets }
  news: new Map(),   // playerId -> { status: 'loading' | 'ok' | 'error', items, at }
  wv: { pos: 'ALL', sort: 'score', showInjured: false },
};

// ---------- helpers
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f0 = n => (Number.isFinite(+n) && n != null ? Math.round(n).toLocaleString() : '–');
const f1 = n => (Number.isFinite(+n) && n != null ? (+n).toFixed(1) : '–');
const val = p => A.value(p, state.settings.basis);
// Actual fantasy points per game this season, scored with the league's settings (matches ESPN).
const avgOf = p => p.stats?.season?.avg ?? null;
const abbr = p => state.model.proTeams[p.proTeamId]?.abbrev || PRO_ABBR[p.proTeamId] || 'FA';
const teamName = id => state.model.teams.find(t => t.id === id)?.name || `Team ${id}`;
const leagueKey = () => (state.settings.demo ? 'demo' : `${state.settings.leagueId}:${state.settings.season}`);
const starredTeam = () => state.settings.starred?.[leagueKey()] ?? null;
const isStar = id => !!state.pnotes[id]?.star;
// Banned = never suggested for you to acquire, anywhere (waivers, streaming, trade
// fill-ins, trade ideas, the finder, targets). Formerly "hidden" (waivers only).
const isBanned = id => !!state.pnotes[id]?.ban;
const bannedSet = () => new Set(Object.keys(state.pnotes).filter(id => state.pnotes[id].ban).map(Number));
const isLocked = id => !!state.pnotes[id]?.lock;
const xBtn = id => `<button class="xbtn" data-act="ban" data-id="${id}" title="Never suggest this player (waivers, trades, everything)" aria-label="Never suggest this player">✕</button>`;
const noteOf = id => state.pnotes[id]?.note || '';
// Bumped on every star / note / lock / ban change so cached results recompute.
const savePNotes = () => { state.pv = (state.pv || 0) + 1; return store.set(`pnotes:${leagueKey()}`, state.pnotes); };
const pct = x => (Number.isFinite(x) ? `${Math.min(99, Math.max(1, Math.round(x * 100)))}%` : '–');
const STAR = '<span class="star" title="Starred">★</span>';
const FRESH_NEWS_MS = 24 * 3600e3;
const hasFreshNews = p => p.newsAt && Date.now() - p.newsAt < FRESH_NEWS_MS;
function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
const signed = (n, digits = 0) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${digits ? Math.abs(n).toFixed(digits) : Math.round(Math.abs(n)).toLocaleString()}`;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: text });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}
// Memoize expensive season-long calculations until the data, projection basis or
// viewed team changes.
function memo(name, fn) {
  const key = `${state.model.fetchedAt || 'demo'}:${state.settings.basis}:${state.viewId}:${adjustOn()}:${state.pv || 0}`;
  const hit = state.calc[name];
  if (hit?.key === key) return hit.v;
  const v = fn();
  state.calc[name] = { key, v };
  return v;
}
const getNeeds = () => memo('needs', () => A.teamNeeds(state.model, state.settings.basis));
const getCtx = () => memo('ctx', () => {
  const ctx = A.seasonContext(state.model, state.settings.basis);
  return { ...ctx, myBase: ctx.S(state.an.my.roster) };
});

function badge(p) {
  const map = { OUT: ['O', 'b-out'], INJURY_RESERVE: ['IR', 'b-out'], SUSPENSION: ['SSPD', 'b-out'], DAY_TO_DAY: ['DTD', 'b-dtd'], QUESTIONABLE: ['Q', 'b-dtd'] };
  const b = map[p.injury];
  const tip = [p.injuryType, A.returnLabel(p)].filter(Boolean).join(' · ');
  return b ? `<span class="badge ${b[1]}" ${tip ? `title="${esc(tip)}"` : ''}>${b[0]}</span>` : '';
}
function pCell(p, extra = '') {
  const pos = p.eligible?.length ? p.eligible.join('/') : p.pos;
  const marks = (isStar(p.id) ? STAR : '') + (isLocked(p.id) ? '<span class="lockmark" title="Untouchable: never offered in trades">🔒</span>' : '') + (isBanned(p.id) ? '<span class="lockmark" title="Never suggested to you">🚫</span>' : '') + (noteOf(p.id) ? '<span class="has-note" title="Has notes">✎</span>' : '');
  const news = hasFreshNews(p) ? `<span class="newsdot" title="News ${ago(p.newsAt)}: open for details"></span>` : '';
  return `<div class="pl"><span class="pn" data-player="${p.id}" title="Notes, news & details">${esc(p.name)}${marks}${news}${badge(p)}${extra}</span><span class="pm">${esc(abbr(p))} · ${esc(pos)}</span></div>`;
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
      const key = `cache:v9:${s.leagueId}:${s.season}`; // bump when the parser changes
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
    // Players hidden from waivers in older versions become banned (never suggested).
    let migrated = false;
    for (const [id, n] of Object.entries(state.pnotes)) if (n.hidden) { state.pnotes[id] = { ...n, ban: true }; delete state.pnotes[id].hidden; migrated = true; }
    if (migrated) await savePNotes();
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
const adjustOn = () => state.settings.adjust !== false;
function reanalyze() {
  const m = state.model;
  if (!m) { state.an = null; return; }
  m.myTeamId = state.viewId;
  A.setAdjustments({ usage: adjustOn(), rest: adjustOn() });
  // Players you've X'd out never show up in waiver suggestions, streaming plans or stash
  // lists (but still count as teammates for usage and as trade fill-ins).
  m.banned = bannedSet();
  state.an = A.analyze({ ...m, freeAgents: m.freeAgents.filter(p => !m.banned.has(p.id)), poolFAs: m.freeAgents }, state.settings.basis);
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
    ${m ? `<label class="basis" title="How projected points per game (Proj/G) are calculated. Avg is always the real season average."><span>Proj</span><select data-act="basis">${opts}</select></label>` : ''}
    ${m?.fetchedAt ? `<span class="upd" title="Last loaded from ESPN">${ago(m.fetchedAt)}</span>` : ''}
    <button class="ghost" data-act="refresh" title="Refresh from ESPN (R)" aria-label="Refresh">${ICON.refresh}</button>
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
    <div><span class="k">__GLABEL__</span><span class="v">__GVAL__</span></div>
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
  const fillStrip = (label, v) => strip.replace('__GLABEL__', label).replace('__GVAL__', v);
  if (!g || !g.opp) return `<section class="board">${nav}<p class="muted" style="margin:18px 0">${g ? 'Bye week.' : 'No matchup scheduled.'}</p>${fillStrip('Games left', live ? an.base.games : '–')}</section>`;

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
      ${done ? fillStrip('Week ' + period, 'Final') : fillStrip(future ? `Wk ${period} games` : 'Games left', x.myGames)}
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
      ${picks.map((w, i) => `<div class="pick"><span class="rk">${String(i + 1).padStart(2, '0')}</span>${pCell(w.p)}<div class="meta">${f1(avgOf(w.p))}<small> avg</small> · ${f1(w.v)}<small> proj</small><br>${w.gl}<small> games</small></div><div class="gain">${w.weekGain > 0 ? '+' : ''}${f0(w.weekGain)}</div>${xBtn(w.p.id)}</div>`).join('') || '<p class="muted">No free agents loaded.</p>'}
      <button class="link" data-tab="waivers">Full waiver wire →</button>
    </section>
  </div>`;
  return h + vDayByDay() + vRosterNews();
}

// Remaining days of the live matchup: your projected points and games vs theirs.
function vDayByDay() {
  const { an, model: m } = state;
  const x = an.matchup;
  if (!x || x.bye || !x.myDays?.length) return '';
  const max = Math.max(1, ...x.myDays.map(d => d.pts), ...x.oppDays.map(d => d.pts));
  const rows = x.myDays.map((d, i) => {
    const o = x.oppDays[i] || { pts: 0, starters: [] };
    const date = A.spDate(m, d.sp);
    const edge = d.pts - o.pts;
    return `<div class="dd ${d.sp === m.currentSP ? 'today' : ''}">
      <span class="dl">${A.fmtDow(date)} <small>${date.getDate()}</small></span>
      <div class="dbars"><div class="db me" style="width:${(d.pts / max * 100).toFixed(1)}%"></div><div class="db them" style="width:${(o.pts / max * 100).toFixed(1)}%"></div></div>
      <span class="dv"><b>${f0(d.pts)}</b> – ${f0(o.pts)}</span>
      <span class="dg" title="Games started, you vs them">${d.starters.length} v ${o.starters.length} g</span>
      <span class="de ${edge >= 0 ? 'up' : 'down'}">${signed(edge)}</span>
      ${d.open ? `<span class="dopen" data-tab="waivers" title="Empty lineup slots this day: stream someone who plays">${d.open} open</span>` : '<span></span>'}
    </div>`;
  }).join('');
  return `<section class="card"><h3>Day by day vs ${esc(x.opp.name)} <span class="r muted small"><i class="lg me"></i>you <i class="lg them"></i>them · projected, rest of this matchup</span></h3><div class="ddlist">${rows}</div></section>`;
}

// ---- News
function newsHtml(id, mode) {
  if (state.model?.demo) return '<p class="muted small">News shows up for real ESPN leagues.</p>';
  const n = state.news.get(id);
  if (!n || n.status === 'loading') return '<p class="muted small">Loading news…</p>';
  if (n.status === 'error') return '<p class="muted small">Couldn\'t load news right now.</p>';
  if (!n.items.length) return '<p class="muted small">No news in the last 30 days.</p>';
  const items = mode === 'one' ? n.items.slice(0, 1) : n.items;
  return items.map(x => `<div class="newsitem">
      <div class="nh">${esc(x.headline)}</div>
      ${mode === 'one' || !x.story || x.story === x.headline ? '' : `<div class="ns">${esc(x.story.length > 420 ? x.story.slice(0, 420) + '…' : x.story)}</div>`}
      <div class="nm">${x.published ? ago(Date.parse(x.published)) : ''}${x.type === 'Rotowire' ? ' · RotoWire' : x.type ? ' · ' + esc(x.type) : ''}${x.link && mode !== 'one' ? ` · <a href="${esc(x.link)}" target="_blank" rel="noopener">ESPN ↗</a>` : ''}</div>
    </div>`).join('');
}
// Fetch news once per player per 10 minutes; fill any visible news boxes in place
// (no full re-render, so typing in notes is never interrupted).
function ensureNews(id) {
  if (state.model?.demo) return;
  const n = state.news.get(id);
  if (n && (n.status === 'loading' || Date.now() - n.at < 10 * 60e3)) return;
  state.news.set(id, { status: 'loading', items: [], at: Date.now() });
  fetchPlayerNews(id)
    .then(items => state.news.set(id, { status: 'ok', items, at: Date.now() }))
    .catch(() => state.news.set(id, { status: 'error', items: [], at: Date.now() }))
    .finally(() => document.querySelectorAll(`[data-news="${id}"]`).forEach(el => { el.innerHTML = newsHtml(id, el.dataset.mode); }));
}

function vRosterNews() {
  const { an, model: m } = state;
  if (m.demo) return '';
  const recent = an.my.roster.filter(p => p.newsAt && Date.now() - p.newsAt < 4 * 24 * 3600e3).sort((a, b) => b.newsAt - a.newsAt).slice(0, 6);
  if (!recent.length) return '';
  setTimeout(() => recent.forEach(p => ensureNews(p.id)), 0);
  return `<section class="card"><h3>Latest on ${esc(an.my.name)} <span class="r muted small">ESPN fantasy news · click a name for more</span></h3>
    ${recent.map(p => `<div class="newsrow">${pCell(p)}<div class="newsbox" data-news="${p.id}" data-mode="one">${newsHtml(p.id, 'one')}</div></div>`).join('')}</section>`;
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
  // Best-lineup plan for each remaining day: who starts, who sits, who's out.
  const plan = Object.fromEntries(an.base.days.map(d => [d.sp, new Set(d.starters)]));
  const rows = roster.map(p => {
    const s = p.stats;
    const cells = sps.map(sp => {
      const g = A.gameOn(m, p, sp);
      const cls = sp < m.currentSP ? 'past' : '';
      if (!g) return `<td class="day ${cls}"></td>`;
      const b2b = A.isB2B(m, p, sp);
      let st = '', tip = `${g.home ? 'vs' : '@'} ${m.proTeams[g.opp]?.abbrev || PRO_ABBR[g.opp] || ''}`;
      if (plan[sp] && A.gameLeft(m, p, sp)) {
        if (!A.availableOn(m, p, sp)) { st = 'inj'; tip += ` · out (${A.returnLabel(p)})`; }
        else if (plan[sp].has(p)) { st = 'st'; tip += ' · starts in your best lineup'; }
        else { st = 'bn'; tip += ' · bench: lineup is full that day'; }
      }
      if (b2b) tip += ' · back-to-back';
      return `<td class="day ${cls}"><span class="gm ${g.home ? 'home' : ''} ${b2b ? 'b2b' : ''} ${st}" title="${esc(tip)}">${g.home ? '' : '@'}${esc(m.proTeams[g.opp]?.abbrev || PRO_ABBR[g.opp] || '')}</span></td>`;
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
      <thead><tr><th>Slot</th><th>Player</th><th class="num" title="Projected FP per game (${A.BASIS[state.settings.basis]}) — what projections use">Proj/G</th><th class="num" title="Actual season average (matches ESPN)">Avg</th><th class="num">L15</th><th class="num">Δ</th><th class="num" title="Games left in this matchup">GL</th>${dayHead}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="7" class="num">Healthy players with a game / starting slots →</td>${foot}</tr>
        <tr><td colspan="7" class="num">Projected points →</td>${sps.map(sp => `<td class="day"><span class="dpts">${dayIdx[sp] ? f0(dayIdx[sp].pts) : ''}</span></td>`).join('')}</tr></tfoot>
    </table></div>
    <p class="muted small">Games left: <span class="key st">outlined</span> = starts in your best lineup, <span class="key bn">faded</span> = sits (lineup full), <span class="key inj">red</span> = injured. Red counts = empty slots (stream someone); amber = more players than slots. “@” = road game. Dot = back-to-back.</p>
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
  const key = { score: x => x.score, avg: x => avgOf(x.p) ?? -1, v: x => x.v, week: x => x.weekGain, ros: x => x.rosFP ?? -1e9, next: x => x.nextG, gl: x => x.gl, po: x => x.poGames, trend: x => x.trend ?? -99, own: x => x.p.ownedChange ?? -99 }[w.sort];
  list = list.sort((a, b) => key(b) - key(a)).slice(0, 60);
  const th = (k, label, title = '') => `<th class="num sort ${w.sort === k ? 'on' : ''}" data-sort="${k}" title="${title}">${label}</th>`;
  const rows = list.map(x => {
    const up = an.drop && x.rosGain >= 1 ? '<span class="badge b-up">UPGRADE</span>' : '';
    const wv = x.p.status === 'WAIVERS' ? '<span class="badge b-wv">W</span>' : '';
    const oc = x.p.ownedChange;
    return `<tr><td>${pCell(x.p, up + wv)}</td>
      <td class="num"><b>${f1(x.score)}</b></td><td class="num">${f1(avgOf(x.p))}</td><td class="num">${f1(x.v)}</td>
      <td class="num">${x.gl}</td><td class="num ${x.weekGain > 0 ? 'up' : 'muted'}">${x.weekGain > 0 ? '+' : ''}${f0(x.weekGain)}</td>
      <td class="num ${x.rosFP > 0 ? 'up' : 'muted'}">${x.rosFP == null ? '–' : signed(x.rosFP)}</td><td class="num">${x.nextG}</td>
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
    <h3>Waiver wire <span class="r muted small">${an.drop ? `Drop candidate: <b>${esc(an.drop.name)}</b> (${f1(an.dropV)} proj/G, ${A.gamesIn(m, an.drop, an.rem)} GL)` : ''}</span></h3>
    <div class="chips">
      ${['ALL', 'PG', 'SG', 'SF', 'PF', 'C'].map(p => `<button class="chip ${w.pos === p ? 'on' : ''}" data-pos="${p}">${p}</button>`).join('')}
      ${w.day != null ? `<button class="chip on" data-day="${w.day}" title="Clear day filter">Plays ${A.fmtDow(A.spDate(m, w.day))} ✕</button>` : ''}
      <label><input type="checkbox" data-act="inj" ${w.showInjured ? 'checked' : ''}> Show injured</label>
    </div>
    <div class="scrollx"><table>
      <thead><tr><th>Player</th>
        ${th('score', 'Score', 'Proj/G adjusted for games left this week and injury')}
        ${th('avg', 'Avg', 'Actual season average (matches ESPN)')}
        ${th('v', 'Proj/G', 'Projected FP per game: ' + A.BASIS[state.settings.basis])}
        ${th('gl', 'GL', 'Games left this week')}
        ${th('week', 'Wk +FP', 'Projected points gained this week if you swap in for your drop candidate (accounts for open lineup slots)')}
        ${th('ros', 'ROS +', 'Projected points gained over the rest of the season (incl. playoffs) if swapped in for your drop candidate')}
        ${th('next', 'Next G', 'Games next matchup')}
        ${th('trend', 'Δ L15', 'Last 15 days avg minus season avg')}
        ${th('po', 'PO G', 'Games during fantasy playoffs')}
        ${th('own', '% Own', 'Rostered % and change — sort to find trending adds')}
        ${sps.map(sp => {
          const d = A.spDate(m, sp);
          const cls = sp === m.currentSP ? 'today' : sp < m.currentSP ? 'past' : '';
          const open = sp >= m.currentSP ? openOn[sp] || 0 : 0;
          return `<th class="day sort ${cls} ${w.day === sp ? 'on' : ''}" data-day="${sp}" title="Click to show only players with a game ${A.fmtDow(d)}${open ? ` · you have ${open} open slot${open > 1 ? 's' : ''}` : ''}">${A.fmtDow(d)}<br>${d.getDate()}${open ? `<span class="openmark">${open}</span>` : ''}</th>`;
        }).join('')}<th></th>
      </tr></thead><tbody>${rows || `<tr><td colspan="${12 + sps.length}" class="muted">No players match.</td></tr>`}</tbody>
    </table></div>
    <p class="muted small">Avg = real season average (same as ESPN). Proj/G = what projections use, blending the average with ESPN's projection early in the season. Wk +FP / ROS + = projected points gained this matchup / rest of season if they replace your drop candidate. UPGRADE = better Proj/G than your drop candidate. W = on waivers (claim, not instant add). ✕ = never suggest this player anywhere (waivers, trade fill-ins, trade ideas). Click a column to sort; click a day to see who plays then. Highlighted games land on days you have open lineup slots (number under the day). Dot = back-to-back.</p>
    ${vHidden()}
  </section>
  ${vTrends()}`;
}

// ---- Player power rankings
const getRanks = () => memo('ranks', () => A.playerRankings(state.model, state.settings.basis));
function vPlayers() {
  const { an } = state;
  const f = state.pr ||= { mode: 'season', pos: 'ALL', who: 'all', q: '', limit: 50 };
  const all = getRanks();
  const recency = ['l30', 'l15', 'l7'].includes(f.mode);
  const q = f.q.trim().toLowerCase();
  let list = all.filter(r => r.rank[f.mode] != null
    && (f.pos === 'ALL' || (r.p.eligible || []).includes(f.pos) || r.p.pos === f.pos)
    && (f.who === 'all' || (f.who === 'fa' ? !r.owner : f.who === 'mine' ? r.owner?.id === an.my.id : !!r.owner))
    && (!q || r.p.name.toLowerCase().includes(q)))
    .sort((a, b) => a.rank[f.mode] - b.rank[f.mode]);
  const total = list.length;
  list = list.slice(0, f.limit);
  // Movement: recent rank vs season rank; season rank vs preseason rank.
  const move = r => (recency ? (r.rank.season != null ? r.rank.season - r.rank[f.mode] : null)
    : f.mode === 'season' && r.pre ? r.pre - r.rank.season : null);
  const mv = n => (n == null ? '<td class="num muted">–</td>' : `<td class="num ${n >= 10 ? 'up' : n <= -10 ? 'down' : 'muted'}">${n > 0 ? '▲' + n : n < 0 ? '▼' + -n : '–'}</td>`);
  const cell = (r, k) => `<td class="num ${k === f.mode ? 'sel' : ''}">${r.vals[k] == null ? '–' : k === 'total' ? f0(r.vals[k]) : f1(r.vals[k])}</td>`;
  const rows = list.map(r => `<tr class="${r.owner?.id === an.my.id ? 'me' : ''}">
      <td class="num rk"><b>${r.rank[f.mode]}</b>${f.pos !== 'ALL' ? `<br><span class="small muted">${esc(r.pos[f.mode] || '')}</span>` : ''}</td>
      ${mv(move(r))}
      <td>${pCell(r.p)}</td>
      <td>${r.owner ? `<button class="tlink small" data-view="${r.owner.id}">${esc(r.owner.name)}</button>` : `<span class="badge b-wv">${r.p.status === 'WAIVERS' ? 'W' : 'FA'}</span>`}</td>
      <td class="num muted">${r.gp[f.mode] ?? '–'}</td>
      ${cell(r, 'season')}${cell(r, 'l30')}${cell(r, 'l15')}${cell(r, 'l7')}${cell(r, 'ros')}
      <td class="num muted">${r.p.owned != null ? Math.round(r.p.owned) + '%' : '–'}</td></tr>`).join('');
  const chip = (act, v, text, on) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${v}">${text}</button>`;
  const moveHead = recency ? 'vs season' : f.mode === 'season' ? 'vs preseason' : '';
  return `<section class="card"><h3>Player rankings <span class="r muted small">${total} players · ${esc(A.RANK_MODES[f.mode])} · your league's scoring</span></h3>
    <div class="chips">${Object.entries(A.RANK_MODES).map(([k, t]) => chip('prmode', k, t, f.mode === k)).join('')}</div>
    <div class="chips">${['ALL', 'PG', 'SG', 'SF', 'PF', 'C'].map(p => chip('prpos', p, p, f.pos === p)).join('')}
      <span class="chipsep"></span>${[['all', 'Everyone'], ['fa', 'Free agents'], ['rostered', 'Rostered'], ['mine', 'My team']].map(([k, t]) => chip('prwho', k, t, f.who === k)).join('')}
      <input id="prq" class="prsearch" data-act="prq" placeholder="Search players…" value="${esc(f.q)}" autocomplete="off" spellcheck="false"></div>
    <div class="scrollx"><table class="ranks"><thead><tr>
      <th class="num">#</th><th class="num" title="${recency ? 'Rank in this window vs season rank (▲ = rising)' : f.mode === 'season' ? 'Season rank vs preseason rank (ESPN rank / draft position)' : ''}">${moveHead || ''}</th>
      <th>Player</th><th>Owner</th><th class="num" title="Games played in this window">GP</th>
      <th class="num">Season</th><th class="num">L30</th><th class="num">L15</th><th class="num">L7</th><th class="num" title="Rest-of-season projection per game (${esc(A.BASIS[state.settings.basis])}, with injuries and usage)">ROS</th><th class="num" title="Rostered across ESPN leagues">Rost.</th>
    </tr></thead><tbody>${rows || '<tr><td colspan="11" class="muted">Nobody matches.</td></tr>'}</tbody></table></div>
    ${total > list.length ? `<button class="btn morebtn" data-act="prmore">Show ${Math.min(50, total - list.length)} more <small>(${total - list.length} left)</small></button>` : ''}
    <p class="muted small">Ranked by fantasy points per game in each window (Total points: season total). Recency windows need a few games (Last 7: 1+, Last 15: 2+, Last 30/Overall: 3+). Rest of season ranks the projection the app uses everywhere else, including injuries and teammate usage. Your players are highlighted.</p></section>`;
}

// ---- Risers & fallers: in-season rank vs preseason rank
function vTrends() {
  const m = state.model;
  const t = state.trend ||= { mode: 'up', under50: true };
  const all = memo('trends', () => A.trends(m, state.settings.basis));
  if (!all.length) return '';
  let list = all.filter(r => (t.mode === 'up' ? r.move > 0 : r.move < 0) && !isBanned(r.p.id));
  if (t.under50) list = list.filter(r => (r.p.owned ?? 0) < 50);
  list = list.sort((a, b) => (t.mode === 'up' ? b.move - a.move : a.move - b.move)).slice(0, 12);
  const rows = list.map(r => `<tr><td>${pCell(r.p)}</td>
      <td>${r.owner ? `<button class="tlink small" data-view="${r.owner.id}">${esc(r.owner.name)}</button>` : '<span class="badge b-wv">FA</span>'}</td>
      <td class="num"><span class="muted small">was ${r.pre}</span> → <b>${r.now}</b></td>
      <td class="num ${r.move > 0 ? 'up' : 'down'}">${r.move > 0 ? '▲' : '▼'}${Math.abs(r.move)}</td>
      <td class="num">${f1(r.avg)}</td>
      <td class="num ${r.vsProj > 0 ? 'up' : r.vsProj < 0 ? 'down' : 'muted'}">${r.vsProj == null ? '–' : signed(r.vsProj, 1)}</td>
      <td class="num">${r.p.owned != null ? Math.round(r.p.owned) + '%' : '–'}</td></tr>`).join('');
  return `<section class="card"><h3>Risers &amp; fallers <span class="r muted small">this season's rank vs preseason rank</span></h3>
    <div class="chips"><button class="chip ${t.mode === 'up' ? 'on' : ''}" data-act="trend" data-v="up">Risers</button><button class="chip ${t.mode === 'down' ? 'on' : ''}" data-act="trend" data-v="down">Fallers</button>
      <label><input type="checkbox" data-act="under50" ${t.under50 ? 'checked' : ''}> Under 50% rostered</label></div>
    <div class="scrollx"><table><thead><tr><th>Player</th><th>Owner</th><th class="num">Rank</th><th class="num">Move</th><th class="num">Avg</th><th class="num" title="Season average minus ESPN projection">vs proj</th><th class="num" title="Rostered across ESPN leagues">Rost.</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="muted">Nobody matches.</td></tr>'}</tbody></table></div>
    <p class="muted small">Rank = by fantasy points per game this season (5+ games) with your league's scoring; preseason = ESPN rank / draft position. Risers under 50% rostered are breakouts you can often still grab.</p></section>`;
}

function vHidden() {
  const list = [...bannedSet()].map(id => state.index.get(id)).filter(Boolean).map(x => x.p);
  if (!list.length) return '';
  return `<details class="hidden-list" ${state.showHidden ? 'open' : ''}><summary data-act="toggle-hidden">Never suggested (${list.length})</summary>
    <p class="muted small" style="margin:8px 0 0">Not offered as a pickup, a trade fill-in, or in trade ideas and the finder. Click to allow again.</p>
    <div class="chips">${list.map(p => `<button class="chip unhide" data-act="unban" data-id="${p.id}" title="Allow again">${esc(p.name)} <span>↺</span></button>`).join('')}
    <button class="link" data-act="unban-all">Allow all</button></div></details>`;
}

function vLineupCard() {
  const { an, model: m } = state;
  const lc = an.lineup;
  if (!lc) return '';
  const today = A.fmtDow(A.spDate(m, m.currentSP)) + ' ' + A.fmtMD(A.spDate(m, m.currentSP));
  const asOf = m.fetchedAt ? `ESPN lineup as of ${new Date(m.fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'ESPN lineup';
  if (lc.gain < 1 || !lc.start.length) {
    return `<section class="card lineup ok"><h3>Today's lineup <span class="r muted small">${today} · ${asOf}</span></h3>
      <p class="okline">✓ Optimal: your starters are the best lineup for today's games (≈${f0(lc.best)} pts).</p></section>`;
  }
  const li = (ps, cls, note) => ps.map(p => `<li class="${cls}">${pCell(p)}<span class="num muted small">${note(p)}</span></li>`).join('');
  const startNote = p => `${f1(A.dayValue(m, p, m.currentSP, state.settings.basis))} proj today`;
  return `<section class="card lineup"><h3>Today's lineup <span class="r muted small">${today} · ESPN lineup vs best possible</span></h3>
    <div class="swap">
      <div><div class="rk-label">Start</div><ul class="plist">${li(lc.start, 'in', startNote)}</ul></div>
      <div class="gainbox"><b>+${f0(lc.gain)}</b><span>pts today</span></div>
      <div><div class="rk-label">Bench</div><ul class="plist">${li(lc.sit, 'out', p => lc.why(p)) || `<li class="muted small">Nobody: ${lc.intoOpen === 1 ? 'there\'s an open slot' : 'there are open slots'} for them.</li>`}</ul></div>
    </div>
    <p class="muted small">Based on your ${asOf}, today's NBA games and position rules. Changed your lineup on ESPN? Hit ↻ to refresh.</p></section>`;
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
      <section class="card"><h3>Playoff stash targets <span class="r muted small">Proj/G × playoff games</span></h3>
        ${stash.map(w => `<div class="pick">${pCell(w.p)}<div class="num small muted">${f1(w.v)} proj/G<br>${w.poGames} PO games</div><div class="gain">${f0(w.poPts)}</div>${xBtn(w.p.id)}</div>`).join('')}
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
  </div>
  ${vPower(st)}`;
}

function vPower(st) {
  const { an } = state;
  const needs = getNeeds();
  const pr = A.powerRankings(state.model, state.settings.basis, needs);
  const odds = getOdds();
  const standRank = Object.fromEntries(st.map((t, i) => [t.id, i + 1]));
  const max = Math.max(...pr.map(r => r.projWk));
  const tierOf = id => (odds.teams[id].playoff >= 0.7 ? 0 : odds.teams[id].playoff >= 0.25 ? 1 : 2);
  const TIERS = ['Contenders', 'In the mix', 'Long shots'];
  const outCount = t => t.roster.filter(p => A.isOut(p) && val(p) >= 15).length;
  let lastTier = -1;
  // Grouped by tier (playoff odds), power order within a tier; # stays the power rank.
  const ordered = pr.map((r, i) => ({ r, i })).sort((a, b) => tierOf(a.r.team.id) - tierOf(b.r.team.id) || a.i - b.i);
  const rows = ordered.map(({ r, i }) => {
    const move = standRank[r.team.id] - (i + 1);
    const nd = needs.byTeam[r.team.id];
    const o = odds.teams[r.team.id], tier = tierOf(r.team.id), n = outCount(r.team);
    const head = tier !== lastTier ? `<tr class="tier"><td colspan="8">${TIERS[tier]}</td></tr>` : '';
    lastTier = tier;
    return `${head}<tr class="${r.team.id === an.my.id ? 'me' : ''}"><td class="num muted">${i + 1}</td>
      <td><button class="tlink" data-view="${r.team.id}">${esc(r.team.name)}</button>${n ? ` <span class="badge b-out" title="Players out (15+ proj/G)">${n} OUT</span>` : ''}</td>
      <td><div class="pbar"><i style="width:${(r.projWk / max * 100).toFixed(0)}%"></i><span>${f0(r.projWk)}</span></div></td>
      <td class="num">${r.pfWk == null ? '–' : f0(r.pfWk)}</td>
      <td class="num">${r.team.wins}-${r.team.losses} <span class="muted small">→ ${Math.round(o.expW)}-${Math.round(o.expL)}</span></td>
      <td class="num"><b>${o.playoff >= 0.995 ? '✓' : o.playoff < 0.005 ? '–' : Math.round(o.playoff * 100) + '%'}</b></td>
      <td class="num ${move > 0 ? 'up' : move < 0 ? 'down' : 'muted'}" title="Power rank vs current standing">${move > 0 ? '▲' + move : move < 0 ? '▼' + -move : '–'}</td>
      <td class="small muted">${nd.weak.length ? 'needs ' + nd.weak.slice(0, 2).map(needs.label).join(', ') : ''}</td></tr>`;
  }).join('');
  return `<section class="card"><h3>Power rankings <span class="r muted small">projected strength from here on, blended with results · tiers by playoff odds</span></h3>
    <div class="scrollx"><table><thead><tr><th class="num">#</th><th>Team</th><th>Proj / week</th><th class="num" title="Actual points per matchup so far">PF / wk</th><th class="num" title="Record now → projected final">Record</th><th class="num" title="Chance to make the playoffs">Playoffs</th><th class="num" title="Movement vs standings">±</th><th>Biggest need</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small">Proj / week = each team's best daily lineups over the rest of the season with current rosters, injuries and NBA schedules. ▲ = better than their record says (buy-low trade partner or sleeping giant), ▼ = record flatters them.</p></section>`;
}

function getOdds() {
  const key = `${state.model.fetchedAt || 'demo'}:${state.settings.basis}:${adjustOn()}`;
  if (state.oddsCache?.key !== key) state.oddsCache = { key, odds: A.playoffOdds(state.model, state.settings.basis) };
  return state.oddsCache.odds;
}

// ---- Trade tab
const scanKey = () => `${state.model.fetchedAt || 'demo'}:${state.settings.basis}:${state.viewId}:${adjustOn()}:${state.pv || 0}`;
// Yield to the browser between chunks of work. MessageChannel isn't throttled in
// background tabs the way setTimeout is, so long scans keep moving in a full-tab view.
const yieldChannel = new MessageChannel();
const yieldQueue = [];
yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
const tick = () => new Promise(r => { yieldQueue.push(r); yieldChannel.port2.postMessage(0); });
// Run `work(item)` over a list in ~25 ms slices, yielding in between.
async function chunked(items, work, onProgress, stillValid) {
  let i = 0;
  while (i < items.length) {
    const until = performance.now() + 25;
    while (i < items.length && performance.now() < until) work(items[i++]);
    onProgress?.(i / items.length);
    await tick();
    if (stillValid && !stillValid()) return false;
  }
  return true;
}

// Scans every other team for trade ideas, one team per tick so the popup stays responsive.
async function runTradeScan(force = false) {
  const key = scanKey();
  if (!force && state.scan?.key === key) return;
  const m = state.model, my = state.an.my, b = state.settings.basis;
  const others = m.teams.filter(t => t.id !== my.id);
  const scan = state.scan = { key, status: 'running', done: 0, total: others.length, ideas: [], targets: [], frac: 0 };
  state.ideaView = { kind: 'all', type: 'all', partner: 'all', limit: 10 };
  if (state.tab === 'trade') { state.keepScroll = true; render(); }
  await tick();
  // Screen on sampled days; refineIdeas re-checks the best ones on every day.
  const ctx = A.seasonContext(m, b, 48);
  const myBase = ctx.S(my.roster);
  // A finder search is what you're waiting on, so the background scan steps aside.
  const finderIdle = async () => { while (state.finder?.status === 'running') await new Promise(r => setTimeout(r, 60)); };
  for (const t of others) {
    const found = [];
    for (const type of A.DEAL_TYPES) {
      await finderIdle();
      if (state.scan !== scan) return; // superseded (team switch, refresh…)
      found.push(...A.tradeIdeasWith(m, my, t, b, ctx, myBase, [type], lockedIds()));
      await tick();
    }
    scan.ideas.push(...found);
    scan.done++;
    scanProgress(scan, 0.8 * scan.done / scan.total, `Scanned ${scan.done} of ${scan.total} teams…`);
  }
  // Exact re-check of every screened idea (up to 120), a few at a time so the popup never stalls.
  const refine = A.makeRefiner(m, my, b);
  const queue = scan.ideas.sort((x, y) => y.score - x.score).slice(0, 120);
  const kept = [];
  for (let i = 0; i < queue.length; i += 6) {
    if (state.scan !== scan) return;
    for (const x of queue.slice(i, i + 6)) { const r = refine(x); if (r) kept.push(r); }
    scanProgress(scan, 0.8 + 0.2 * Math.min(1, (i + 6) / queue.length), `Double-checking ${queue.length} ideas on every remaining day…`);
    await tick();
  }
  scan.ideas = kept.sort((x, y) => y.score - x.score);
  await tick();
  if (state.scan !== scan) return;
  const big = getCtx();
  scan.targets = A.tradeTargets(m, my, b, big, big.myBase, 6);
  scan.status = 'done';
  if (state.tab === 'trade' && state.scan === scan) { state.keepScroll = true; render(); }
}

function scanProgress(scan, frac, text) {
  scan.frac = frac;
  scan.msg = text;
  const bar = document.getElementById('scan-bar');
  if (bar) bar.style.width = `${(frac * 100).toFixed(0)}%`;
  const msg = document.getElementById('scan-msg');
  if (msg) msg.textContent = text;
}

function loadIntoAnalyzer(idea) {
  state.trade = { partner: idea.partner.id, give: idea.give.map(p => p.id), get: idea.get.map(p => p.id) };
}

const TYPE_LABEL = { '1for1': '1-for-1', '2for1': '2-for-1', '1for2': '1-for-2', '2for2': '2-for-2' };

// One proposed trade: who's involved, projected gain for both teams, why it helps you,
// roster moves, and trade value. Shared by trade ideas and the trade finder.
function dealCard(x, label, cls, openAttrs) {
  const { an, model: m } = state;
  const needs = getNeeds();
  const mine = needs.byTeam[an.my.id];
  const r = x.reason ||= A.tradeReason(m, an.my, x, state.settings.basis, { days: A.futureDays(m), scale: 1 });
  const why = [];
  if (r?.best) why.push(`${mine.weak.includes(r.best.id) ? 'Fixes your weak' : 'Stronger at'} ${needs.label(r.best.id)} (${signed(r.best.d, 1)} pts/day)`);
  if (r && Math.abs(r.starts) >= 2) why.push(`${signed(r.starts)} games started`);
  if (x.adds?.length) why.push(`you add FA ${x.adds.map(p => esc(p.name)).join(', ')}`);
  if (x.theirAdds?.length) why.push(`they add FA ${x.theirAdds.map(p => esc(p.name)).join(', ')}`);
  if (x.drops.length) why.push(`you drop ${x.drops.map(p => esc(p.name)).join(', ')}`);
  if (x.theirDrops.length) why.push(`they drop ${x.theirDrops.map(p => esc(p.name)).join(', ')}`);
  const side = ps => ps.map(p => `<div class="tchip">${pCell(p)}<span class="num">${f1(val(p))}</span></div>`).join('');
  return `<div class="idea">
    <div class="idea-top">
      <span class="kind ${cls}">${label}</span>
      <span class="dtype">${TYPE_LABEL[x.type] || ''}</span>
      <span>with <button class="tlink" data-view="${x.partner.id}">${esc(x.partner.name)}</button></span>
      <span class="spacer"></span>
      <span class="g-me ${x.myGain < 0 ? 'down' : ''}" title="Your projected points, rest of season + playoffs">${signed(x.myGain)} you</span>
      <span class="g-them ${x.theirGain >= 0 ? 'up' : 'down'}" title="Their projected points, rest of season + playoffs">${signed(x.theirGain)} them</span>
    </div>
    <div class="idea-swap"><div><div class="rk-label">You give</div>${side(x.give)}</div><div class="arrowx">⇄</div><div><div class="rk-label">You get</div>${side(x.get)}</div></div>
    <div class="idea-foot"><span class="muted small">${why.join(' · ') || 'Better lineup fit for your roster.'} · <span title="Trade value = name + form: draft position, last season, ESPN projection and this season. Includes free-agent fill-ins.">trade value ${f1(x.mktGive)} for ${f1(x.mktGet)}${x.adds?.length || x.theirAdds?.length ? ' incl. FA' : ''}</span></span>
      <button class="btn mini" ${openAttrs}>Open in analyzer</button></div>
  </div>`;
}

// ---- Trade finder: aim the search at a player you want, one you'd move, or a position.
const FINDER_MODES = { get: 'Get a player', away: 'Trade away', need: 'Fill a position' };
const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
const lockedIds = () => new Set(state.an.my.roster.filter(p => isLocked(p.id)).map(p => p.id));
const finderKey = f => `${scanKey()}:${f.mode}:${f.arg}:${[...lockedIds()].join(',')}`;

async function runFinder() {
  const f = state.finder;
  if (f.arg == null || f.arg === '') return;
  const key = finderKey(f);
  if (f.key === key && f.status !== 'idle') return;
  const m = state.model, my = state.an.my, b = state.settings.basis;
  const run = { key };
  Object.assign(f, { key, status: 'running', frac: 0, results: [], run });
  state.keepScroll = true; render();
  await tick();
  const cands = A.finderCandidates(m, my, b, f.mode, f.arg, lockedIds());
  const ctx = A.seasonContext(m, b, 48);
  const screen = A.dealEvaluator(m, my, b, ctx.S, false);
  const screened = [];
  const live = () => f.run === run; // false once a newer search starts
  // Rank by your gain, minus part of what it costs them: a deal that's fair on names but
  // wrecks their lineup is a harder sell to a manager paying attention.
  const rank = d => d.myGain + 0.6 * Math.min(0, d.theirGain);
  if (!await chunked(cands, c => {
    const d = screen(c.give, c.get, c.partner);
    if (d.paperGive / d.paperGet >= 0.85) screened.push(d);
  }, frac => finderProgress(0.75 * frac, `Testing ${cands.length.toLocaleString()} possible deals…`), live)) return;
  // Exact re-check of the best, keeping variety (no package or return repeated 3+ times).
  const days = A.futureDays(m);
  const exact = A.dealEvaluator(m, my, b, r => A.projectDays(m, r, days, b).total, true);
  const queue = [], seen = {};
  for (const d of screened.sort((x, y) => rank(y) - rank(x))) {
    const gk = d.give.map(p => p.id).sort().join(','), tk = `${d.partner.id}>${d.get.map(p => p.id).sort().join(',')}`;
    if ((seen[gk] || 0) >= 2 || (seen[tk] || 0) >= 2) continue;
    seen[gk] = (seen[gk] || 0) + 1; seen[tk] = (seen[tk] || 0) + 1;
    queue.push(d);
    if (queue.length >= 30) break;
  }
  const results = [];
  if (!await chunked(queue, d => {
    const x = exact(d.give, d.get, d.partner);
    const acc = A.acceptance(x);
    if (acc) results.push({ ...x, kind: acc });
  }, frac => finderProgress(0.75 + 0.25 * frac, 'Double-checking the best on every remaining day…'), live)) return;
  // Variety: no single player (other than the one you searched for) in more than 4 results.
  const anchor = f.mode === 'need' ? null : f.arg, uses = {}, picked = [];
  for (const x of results.sort((a, b) => rank(b) - rank(a))) {
    const ids = [...x.give, ...x.get].map(p => p.id).filter(id => id !== anchor);
    if (ids.some(id => (uses[id] || 0) >= 4)) continue;
    ids.forEach(id => { uses[id] = (uses[id] || 0) + 1; });
    picked.push(x);
    if (picked.length >= 12) break;
  }
  f.results = picked;
  f.status = 'done';
  if (state.tab === 'trade') { state.keepScroll = true; render(); }
}
function finderProgress(frac, text) {
  const bar = document.getElementById('finder-bar'), msg = document.getElementById('finder-msg');
  if (bar) bar.style.width = `${(frac * 100).toFixed(0)}%`;
  if (msg) msg.textContent = text;
}
function openFinder(mode, arg) {
  state.finder = { mode, arg, status: 'idle' };
  state.openPlayer = null;
  setTab('trade');
  runFinder();
  document.getElementById('finder')?.scrollIntoView({ block: 'start' });
}

function vFinder() {
  const { an, model: m } = state;
  const f = state.finder ||= { mode: 'get', arg: null, status: 'idle' };
  if (f.status === 'done' && f.key !== finderKey(f)) setTimeout(runFinder, 0); // data or settings changed
  const tv = p => f1(A.marketValue(m, p, state.settings.basis));
  const modes = Object.entries(FINDER_MODES).map(([k, t]) => `<button class="chip ${f.mode === k ? 'on' : ''}" data-act="fmode" data-v="${k}">${t}</button>`).join('');
  let picker;
  if (f.mode === 'get') {
    const groups = m.teams.filter(t => t.id !== an.my.id).map(t => `<optgroup label="${esc(t.name)}">${t.roster.slice().sort((a, b) => val(b) - val(a))
      .map(p => `<option value="${p.id}" ${f.arg === p.id ? 'selected' : ''} ${isBanned(p.id) ? 'disabled' : ''}>${isBanned(p.id) ? '🚫 ' : ''}${esc(p.name)} · ${f1(val(p))} proj/G · TV ${tv(p)}</option>`).join('')}</optgroup>`).join('');
    picker = `<select class="fsel" data-act="farg"><option value="">Pick a player you want…</option>${groups}</select>`;
  } else if (f.mode === 'away') {
    picker = `<select class="fsel" data-act="farg"><option value="">Pick one of your players to move…</option>${an.my.roster.slice().sort((a, b) => val(b) - val(a))
      .map(p => `<option value="${p.id}" ${f.arg === p.id ? 'selected' : ''} ${isLocked(p.id) ? 'disabled' : ''}>${isLocked(p.id) ? '🔒 ' : ''}${esc(p.name)} · ${f1(val(p))} proj/G · TV ${tv(p)}</option>`).join('')}</select>`;
  } else {
    picker = `<span class="chips" style="margin:0">${POSITIONS.map(p => `<button class="chip ${f.arg === p ? 'on' : ''}" data-act="fpos" data-v="${p}">${p}</button>`).join('')}</span>`;
  }
  let body = '';
  if (f.status === 'running') {
    body = `<div class="scan"><div class="scanbar"><i id="finder-bar" style="width:0%"></i></div><p class="muted small" id="finder-msg">Building possible deals…</p></div>`;
  } else if (f.status === 'done') {
    const label = { likely: 'Likely yes', possible: 'Possible' };
    body = f.results.length
      ? `<div class="ideas">${f.results.map((x, i) => dealCard(x, label[x.kind], x.kind, `data-act="fopen" data-i="${i}"`)).join('')}</div>
         <p class="muted small">Sorted by what each deal adds to your lineup over the rest of the season + playoffs, discounted when it costs them a lot (a harder sell). Likely yes = they get at least as much trade value as they give; possible = within ~10%, expect a counter. A negative number for you = the price of the player you asked for.</p>`
      : `<p class="muted">No deal they'd plausibly accept turned up. Try another player, or unlock someone on your roster.</p>`;
  } else {
    body = `<p class="muted small">${f.mode === 'get' ? 'Choose any player on another team: the finder builds packages from your roster (adding one of their role players to balance it when that helps) and keeps the ones they would plausibly accept.'
      : f.mode === 'away' ? 'Choose one of your players: the finder checks every team for the best return, alone or with one of your lesser players added.'
      : 'Choose a position: the finder looks at the best players there on other teams and what it would take to get them.'} Players you mark 🔒 untouchable are never offered.</p>`;
  }
  return `<section class="card" id="finder"><h3>Trade finder</h3>
    <div class="chips finder-modes">${modes}</div>
    <div class="finder-pick">${picker}</div>
    ${body}</section>`;
}

function vTradeIdeas() {
  const { an, model: m } = state;
  const sc = state.scan;
  const f = state.ideaView ||= { kind: 'all', type: 'all', partner: 'all', limit: 10 };
  const done = sc?.status === 'done';
  const head = `<h3>Trade ideas <span class="r muted small">${done ? `${sc.ideas.length} ideas from ${sc.total} teams · rest of season + playoffs <button class="link" data-act="rescan">Rescan</button>` : ''}</span></h3>`;
  if (!done) {
    return `<section class="card">${head}<div class="scan"><div class="scanbar"><i id="scan-bar" style="width:${((sc?.frac || 0) * 100).toFixed(0)}%"></i></div>
      <p class="muted small" id="scan-msg">${esc(sc?.msg || 'Testing 1-for-1, 2-for-1, 1-for-2 and 2-for-2 deals against every roster, with positions, schedules and injuries…')}</p></div></section>`;
  }
  if (!sc.ideas.length) return `<section class="card">${head}<p class="muted">No trades found that clearly help you without hurting the other team. Your lineup may already be well balanced, or try the Season avg projection.</p></section>`;

  // Filters (with counts), then a league-wide mix: at most 3 per team near the top.
  const count = (k, v) => sc.ideas.filter(x => x[k] === v).length;
  const chip = (act, v, text, n) => `<button class="chip ${f[act === 'ik' ? 'kind' : 'type'] === v ? 'on' : ''}" data-act="${act}" data-v="${v}">${text}${n != null ? ` <small>${n}</small>` : ''}</button>`;
  const kinds = Object.entries(A.IDEA_KINDS).filter(([k]) => count('kind', k)).map(([k, t]) => chip('ik', k, t, count('kind', k))).join('');
  const types = A.DEAL_TYPES.filter(t => count('type', t)).map(t => chip('it', t, TYPE_LABEL[t], count('type', t))).join('');
  const partners = [...new Set(sc.ideas.map(x => x.partner.id))].map(id => m.teams.find(t => t.id === id))
    .map(t => `<option value="${t.id}" ${f.partner === t.id ? 'selected' : ''}>${esc(t.name)} (${sc.ideas.filter(x => x.partner.id === t.id).length})</option>`).join('');
  const filters = `<div class="chips ideafilters">${chip('ik', 'all', 'All')}${kinds}<span class="chipsep"></span>${chip('it', 'all', 'Any deal')}${types}
    <select class="tsel" data-act="ip"><option value="all">All teams</option>${partners}</select></div>`;

  let list = sc.ideas.filter(x => (f.kind === 'all' || x.kind === f.kind) && (f.type === 'all' || x.type === f.type) && (f.partner === 'all' || x.partner.id === f.partner));
  if (f.partner === 'all') {
    const per = {}, top = [], later = [];
    for (const x of list) ((per[x.partner.id] = (per[x.partner.id] || 0) + 1) <= 3 ? top : later).push(x);
    list = [...top, ...later];
  }
  const shown = list.slice(0, f.limit);
  const cards = shown.map(x => dealCard(x, A.IDEA_KINDS[x.kind], x.kind, `data-act="idea" data-i="${sc.ideas.indexOf(x)}"`)).join('');
  const more = list.length > shown.length
    ? `<button class="btn morebtn" data-act="more-ideas">Show ${Math.min(10, list.length - shown.length)} more <small>(${list.length - shown.length} left)</small></button>` : '';
  return `<section class="card">${head}${filters}
    <div class="ideas">${cards || '<p class="muted">No ideas match these filters.</p>'}</div>${more}
    <p class="muted small">Win-win = both teams project to score more. Fair on paper = they get at least as much Proj/G and lose little in fit. Worth asking = close in value on paper, but it costs them more, so expect a counter. Gains are projected points over the rest of the regular season plus playoffs.</p></section>`;
}

function vNeeds() {
  const { an } = state;
  const needs = getNeeds();
  const me = needs.byTeam[an.my.id];
  const max = Math.max(1, ...needs.ids.map(id => Math.max(me.perSlot[id], needs.league[id])));
  const bars = needs.ids.map(id => {
    const mine = me.perSlot[id], lg = needs.league[id], d = me.diff[id];
    const cls = me.weak.includes(id) ? 'weak' : me.strong.includes(id) ? 'strong' : '';
    return `<div class="need ${cls}"><span class="nl">${needs.label(id)}${needs.count[id] > 1 ? `<small>×${needs.count[id]}</small>` : ''}</span>
      <div class="nbar"><i style="width:${(mine / max * 100).toFixed(0)}%"></i><b style="left:${(lg / max * 100).toFixed(0)}%" title="League average ${f1(lg)}"></b></div>
      <span class="nv">${f1(mine)} <small class="${d >= 0 ? 'up' : 'down'}">${signed(d, 1)}</small></span></div>`;
  }).join('');
  const chips = me.chips.slice(0, 4).map(c => `<div class="pick">${pCell(c.p)}<div class="meta">starts ${Math.round(c.startRate * 100)}%<br><small>of their games</small></div></div>`).join('');
  return `<section class="card"><h3>Team needs <span class="r muted small">pts per lineup slot per day vs league (line)</span></h3>
    <div class="needs">${bars}</div>
    <p class="small" style="margin:10px 0 0">${me.weak.length ? `Weakest: <b>${me.weak.map(needs.label).join(', ')}</b>. ` : 'No big holes. '}${me.strong.length ? `Strongest: <b>${me.strong.map(needs.label).join(', ')}</b>.` : ''}</p>
    ${chips ? `<div class="rk-label" style="margin-top:12px">Trade chips <span class="muted">(good players stuck on your bench)</span></div>${chips}` : ''}
  </section>`;
}

function vTargets() {
  const sc = state.scan;
  if (!sc || sc.status !== 'done') return `<section class="card"><h3>Targets</h3><p class="muted small">Waiting for the league scan…</p></section>`;
  const rows = sc.targets.map(x => `<div class="pick">${pCell(x.p)}<div class="meta"><button class="tlink small" data-view="${x.owner.id}">${esc(x.owner.name)}</button><br>${f1(val(x.p))}<small> proj/G</small> · ${f1(A.marketValue(state.model, x.p, state.settings.basis))}<small> trade value</small></div>
    <div class="gain">${signed(x.gain)}</div><button class="btn mini" data-act="target" data-id="${x.p.id}" data-owner="${x.owner.id}">Target</button></div>`).join('');
  return `<section class="card"><h3>Targets <span class="r muted small">who'd add the most to your lineup, before what you give up</span></h3>${rows || '<p class="muted">Nobody on another roster beats your current lineup.</p>'}</section>`;
}

function vTrade() {
  const { an, model: m } = state;
  const b = state.settings.basis;
  const tr = state.trade;
  if (state.scan?.key !== scanKey()) setTimeout(() => runTradeScan(), 0);
  const others = m.teams.filter(t => t.id !== an.my.id);
  if (!others.some(t => t.id === tr.partner)) { tr.partner = others[0]?.id ?? null; tr.get = []; }
  const partner = m.teams.find(t => t.id === tr.partner);
  const mine = an.my.roster, theirs = partner?.roster || [];
  const give = mine.filter(p => tr.give.includes(p.id)), get = theirs.filter(p => tr.get.includes(p.id));
  const pick = (list, side) => list.slice().sort((a, b2) => val(b2) - val(a)).map(p => {
    const on = tr[side].includes(p.id);
    return `<label class="tp ${on ? 'on' : ''}"><input type="checkbox" data-trade="${side}" value="${p.id}" ${on ? 'checked' : ''}>${pCell(p)}<span class="num">${f1(val(p))}</span></label>`;
  }).join('');
  let result = '<p class="muted">Pick players on both sides, or open one of the trade ideas above.</p>';
  if (give.length || get.length) {
    const a = A.tradeImpact(m, an.my, give, get, b, true);
    const z = partner ? A.tradeImpact(m, partner, get, give, b, false) : null;
    const d = (x, y) => { const v = y - x; return `<span class="${v > 0.5 ? 'up' : v < -0.5 ? 'down' : 'muted'}">${signed(v)}</span>`; };
    // Trade value excludes any free agent a team picks up (it could add them anyway).
    const net = (r, k) => r.after[k] - r.before[k] - r.fa[k];
    const row = (label, k) => `<tr><td>${label}</td><td class="num">${d(0, net(a, k))}</td>${z ? `<td class="num">${d(0, net(z, k))}</td>` : ''}</tr>`;
    const verdict = net(a, 'ros') + net(a, 'po');
    const theirs2 = z ? net(z, 'ros') + net(z, 'po') : 0;
    const faNote = [...(a.adds.length ? [`${esc(an.my.name)}'s pickup of ${a.adds.map(p => esc(p.name)).join(', ')} is worth ${signed(a.fa.ros + a.fa.po)} on its own`] : []),
      ...(z && z.adds.length ? [`${esc(partner.name)}'s pickup of ${z.adds.map(p => esc(p.name)).join(', ')} is worth ${signed(z.fa.ros + z.fa.po)} on its own`] : [])];
    const drops = [...a.drops.map(p => `${esc(an.my.name)} drops ${esc(p.name)}`), ...(z ? z.drops.map(p => `${esc(partner.name)} drops ${esc(p.name)}`) : []),
      ...a.adds.map(p => `${esc(an.my.name)} picks up free agent ${esc(p.name)}`), ...(z ? z.adds.map(p => `${esc(partner.name)} picks up free agent ${esc(p.name)}`) : [])];
    const vGive = give.reduce((s2, p) => s2 + val(p), 0), vGet = get.reduce((s2, p) => s2 + val(p), 0);
    const mv = p => A.marketValue(m, p, b);
    const mGive = give.reduce((s2, p) => s2 + mv(p), 0) + (z ? z.adds.reduce((s2, p) => s2 + mv(p), 0) : 0);
    const mGet = get.reduce((s2, p) => s2 + mv(p), 0) + a.adds.reduce((s2, p) => s2 + mv(p), 0);
    const ratio = mGet ? mGive / mGet : 1;
    const odds = ratio >= 0.97 ? ['likely', 'up', 'they get as much name value as they give'] : ratio >= 0.88 ? ['possible', 'muted', 'close on name value, expect a counter'] : ['unlikely', 'down', 'they give up a bigger name than they get'];
    result = `<table class="impact"><thead><tr><th>Projected points</th><th class="num">${esc(an.my.name)}</th>${z ? `<th class="num">${esc(partner.name)}</th>` : ''}</tr></thead><tbody>
        ${row('This matchup', 'week')}${row('Rest of regular season', 'ros')}${row('Fantasy playoffs', 'po')}
        <tr class="sum"><td>Proj/G swapped</td><td class="num">${d(vGive, vGet)}</td>${z ? `<td class="num">${d(vGet, vGive)}</td>` : ''}</tr>
        <tr class="sum"><td title="Name + form: draft position, last season, ESPN projection and this season (free-agent fill-ins included)">Trade value swapped</td><td class="num">${d(mGive, mGet)}</td>${z ? `<td class="num">${d(mGet, mGive)}</td>` : ''}</tr>
      </tbody></table>
      ${z ? `<p class="small" style="margin:10px 0 0">Acceptance: <b class="${odds[1]}">${odds[0]}</b> <span class="muted">— ${odds[2]} (trade value ${f1(mGive)} for ${f1(mGet)}).</span></p>` : ''}
      <p class="verdict ${verdict > 0 ? 'up' : 'down'}">${verdict > 0 ? 'Good for' : 'Bad for'} ${esc(an.my.name)}: ${signed(verdict)} projected points the rest of the way (season + playoffs).
        ${z ? `<span class="muted">${esc(partner.name)}: ${signed(theirs2)}${verdict > 0 && theirs2 > 0 ? ' — good for both, easy sell.' : verdict > 0 && vGive >= vGet * 0.97 ? ' — looks fair to them on paper.' : ''}</span>` : ''}</p>
      ${drops.length ? `<p class="muted small">Roster spots: ${drops.join('; ')}. A team left a player short fills the spot with the best free agent for its lineup.</p>` : ''}
      ${faNote.length ? `<p class="muted small">${faNote.join('; ')}. That part isn't counted above, since it doesn't need the trade.</p>` : ''}`;
  }
  const bs = A.buySell(m, an.my.id, b);
  const bsRow = (x, act) => `<div class="pick">${pCell(x.p)}<div class="meta">${f1(x.p.stats.l15.avg)}<small> L15</small><br>${f1(x.p.stats.season.avg)}<small> season</small></div>
    <div class="gain ${x.d < 0 ? 'down' : ''}">${signed(x.d, 1)}</div>${act ? `<button class="btn mini" data-act="target" data-id="${x.p.id}" data-owner="${x.owner.id}">Target</button>` : ''}</div>`;
  return `${vFinder()}${vTradeIdeas()}
    <div class="grid2" id="analyzer">
      <section class="card"><h3>You give <span class="r">${esc(an.my.name)}</span></h3><div class="tlist">${pick(mine, 'give')}</div></section>
      <section class="card"><h3>You get <select class="tsel" data-act="partner">${others.map(t => `<option value="${t.id}" ${t.id === tr.partner ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></h3><div class="tlist">${pick(theirs, 'get')}</div></section>
    </div>
    <section class="card"><h3>Trade analyzer <span class="r">${give.length || get.length ? '<button class="link" data-act="trade-clear">Clear</button>' : ''}</span></h3>${result}</section>
    <div class="grid2">${vTargets()}${vNeeds()}</div>
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

  return `<section class="card"><h3>Week ${m.currentPeriod} scoreboard <span class="r muted small">${A.periodRange(m, m.currentPeriod)} · live score + projected final <button class="link" data-act="recap">Copy recap</button></span></h3>
      <div class="board-list">${live || '<p class="muted">No matchups this week.</p>'}</div></section>
    ${vMatter()}
    ${vBreakdown()}
    <section class="card"><h3>${esc(an.my.name)} · schedule & predictions <span class="r muted small">projected record <b>${Math.round(projW)}-${Math.round(projL)}</b></span></h3>
      <div class="scrollx"><table><thead><tr><th>Week</th><th>Opponent</th><th class="num">Score / Proj</th><th class="num">Win %</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No schedule yet.</td></tr>'}</tbody></table></div>
      <p class="muted small">Future weeks are projected with each team's current roster and NBA schedule, using ${esc(A.BASIS[state.settings.basis])} values and this league's scoring.</p></section>`;
}

// Where a projection comes from: every player's projected starts and points for a week.
function vBreakdown() {
  const { an, model: m } = state;
  const b = state.settings.basis;
  const sched = A.teamSchedule(m, an.my.id, b);
  const periods = sched.map(x => x.period);
  if (!periods.length) return '';
  let period = state.boardPeriod ?? m.currentPeriod;
  if (!periods.includes(period)) period = periods.reduce((a, c) => (Math.abs(c - m.currentPeriod) < Math.abs(a - m.currentPeriod) ? c : a));
  const i = periods.indexOf(period), g = sched[i];
  const prev = periods[i - 1], next = periods[i + 1];
  const nav = `<span class="wknav">
      <button class="arrow" data-act="wk" data-p="${prev ?? ''}" ${prev == null ? 'disabled' : ''} aria-label="Previous week">‹</button>
      <span>Week ${period}</span>
      <button class="arrow" data-act="wk" data-p="${next ?? ''}" ${next == null ? 'disabled' : ''} aria-label="Next week">›</button></span>`;
  const head = `<h3>Projection breakdown ${nav}<span class="r muted small">${A.periodRange(m, period)}${period === m.currentPeriod ? ' · remaining days only' : ''}</span></h3>`;
  if (period < m.currentPeriod) return `<section class="card">${head}<p class="muted">Week ${period} is final: ${f0(g.myPts)}–${f0(g.oppPts)} ${g.won ? 'win' : g.tie ? 'tie' : 'loss'}.</p></section>`;
  const side = (team, pts) => {
    const bd = A.breakdown(m, team, period, b);
    const rows = bd.rows.filter(r => r.avail || r.out || r.g).map(r => {
      const notes = [];
      if (r.bench) notes.push(`<span class="muted">sits ${r.bench}</span>`);
      if (r.out) notes.push(`<span class="down" title="${esc(A.returnLabel(r.p))}">out ${r.out}</span>`);
      return `<tr class="${r.g ? '' : 'dim'}"><td>${pCell(r.p)}</td><td class="num">${r.g}<small class="muted">/${r.avail + r.out}</small></td><td class="small">${notes.join(' · ')}</td><td class="num"><b>${f0(r.pts)}</b></td></tr>`;
    }).join('');
    const idle = bd.rows.filter(r => !r.avail && !r.out && !r.g).map(r => esc(r.p.name)).join(', ');
    return `<div><div class="bd-head"><b>${esc(team.name)}</b><span>${pts ? `${f0(pts)} + ` : ''}<b>${f0(bd.total)}</b> = ${f0(pts + bd.total)}</span></div>
      <table class="bd"><thead><tr><th>Player</th><th class="num" title="Projected games started / games on the schedule">Starts</th><th></th><th class="num">Pts</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No games left.</td></tr>'}</tbody></table>
      ${idle ? `<p class="muted small">No games: ${idle}</p>` : ''}</div>`;
  };
  if (!g?.opp) return `<section class="card">${head}<p class="muted">Bye week.</p></section>`;
  const live = period === m.currentPeriod;
  return `<section class="card">${head}<div class="grid2 bdgrid">${side(an.my, live ? g.myPts : 0)}${side(g.opp, live ? g.oppPts : 0)}</div>
    <p class="muted small">Starts = games each player is projected to start in the best daily lineup, out of games on their schedule. "Sits" = games lost to a full lineup; "out" = games missed while injured (counted only from ESPN's expected return date).</p></section>`;
}

function recapText() {
  const m = state.model, b = state.settings.basis;
  const lines = [`${m.name} · Week ${m.currentPeriod} (${A.periodRange(m, m.currentPeriod)})`];
  for (const x of A.scoreboard(m, m.currentPeriod, b)) {
    if (!x.away) { lines.push(`${x.home.name}: bye`); continue; }
    lines.push(`${x.home.name} ${f0(x.homePts)} – ${f0(x.awayPts)} ${x.away.name}  (proj ${f0(x.homeProj)}–${f0(x.awayProj)}, ${pct(x.winProb)} / ${pct(1 - x.winProb)})`);
  }
  lines.push('— via LinedUpBetter');
  return lines.join('\n');
}

// ---- Matchups that matter (leverage) + who to stream for them
const myFAs = () => state.model.freeAgents.filter(p => !isBanned(p.id));
function vMatter() {
  const { an, model: m } = state;
  const list = memo('matter', () => A.matchupsThatMatter(m, an.my, state.settings.basis, myFAs()));
  if (!list.length) return '';
  const rows = list.map(x => `<div class="matter">
      <div class="mt-week"><b>Wk ${x.period}</b><span class="muted small">${A.periodRange(m, x.period)}</span></div>
      <div class="mt-opp">vs <button class="tlink" data-view="${x.opp.id}">${esc(x.opp.name)}</button><br><span class="small muted">win chance ${pct(x.wp)}</span></div>
      <div class="mt-swing"><b>${signed(x.swing * 100)}%</b><span class="small muted">playoff odds: ${Math.round(x.ifWin * 100)}% if you win, ${Math.round(x.ifLoss * 100)}% if you lose</span></div>
      <div class="mt-stream">${x.stream ? `<span class="small muted">stream</span> ${pCell(x.stream.fa)}<span class="small"><span class="up">${signed(x.stream.gain)}</span> · ${x.stream.games} g · for ${esc(x.stream.drop.name)}</span>` : '<span class="muted small">no stream beats your roster</span>'}</div>
    </div>`).join('');
  return `<section class="card"><h3>Matchups that matter <span class="r muted small">your remaining matchups that swing your playoff odds most</span></h3>${rows}
    <p class="muted small">From 3,000 simulated seasons: how often you make the playoffs after winning vs losing each matchup. Stream = the free agent who'd add the most that week, and who they'd replace.</p></section>`;
}

// ---- Weekly slate
function vSlate() {
  const { an, model: m } = state;
  const sched = A.teamSchedule(m, an.my.id, state.settings.basis).map(x => x.period).filter(p => p >= m.currentPeriod);
  const periods = sched.length ? sched : [m.currentPeriod];
  let period = state.slatePeriod ?? m.currentPeriod;
  if (!periods.includes(period)) period = periods[0];
  const i = periods.indexOf(period), prev = periods[i - 1], next = periods[i + 1];
  const s = memo(`slate:${period}`, () => A.weeklySlate(m, an.my, period, state.settings.basis, myFAs()));
  const nav = `<span class="wknav">
      <button class="arrow" data-act="slwk" data-p="${prev ?? ''}" ${prev == null ? 'disabled' : ''} aria-label="Previous slate week">‹</button>
      <span>Week ${period}</span>
      <button class="arrow" data-act="slwk" data-p="${next ?? ''}" ${next == null ? 'disabled' : ''} aria-label="Next slate week">›</button></span>`;
  const maxNba = 15;
  const days = s.perDay.map(d => {
    const date = A.spDate(m, d.sp);
    const tag = d.nba <= 5 ? '<span class="nite light">light night</span>' : d.nba >= 11 ? '<span class="nite heavy">heavy night</span>' : '';
    const best = d.adds[0];
    const alts = d.adds.slice(1).map(x => `<button class="chip altadd" data-player="${x.fa.id}" title="${esc(x.fa.name)} · ${signed(x.gain)} · ${x.left} of ${x.week} left">${esc(x.fa.name)} <span class="up">${signed(x.gain)}</span></button>`).join('');
    return `<div class="sday ${d.past ? 'past' : ''} ${d.sp === m.currentSP ? 'today' : ''}">
      <div class="sd-date"><b>${A.fmtDow(date)}</b><span>${A.fmtMD(date)}</span></div>
      <div class="sd-nba"><div class="nbabar"><i style="width:${(d.nba / maxNba * 100).toFixed(0)}%"></i></div><span>${d.nba} of ${maxNba} games ${tag}</span></div>
      <div class="sd-vs">${d.past || !d.mine ? '<span class="muted small">played</span>' : `<b>${d.mine.starters.length}</b> <span class="muted">v</span> ${d.theirs ? d.theirs.starters.length : '–'}<span class="small muted"> starts</span>${d.mine.open ? `<br><span class="dopen" title="Empty lineup slots">${d.mine.open} open</span>` : ''}`}</div>
      <div class="sd-add">${d.past ? '' : best ? `<span class="small muted">spend an add here</span>
          <div class="addline">${pCell(best.fa)}<span class="small">${best.left} of ${best.week} left${best.b2b ? ' · B2B' : ''} · drop ${esc(best.drop.name)}</span><b class="up">${signed(best.gain)}</b></div>
          ${alts ? `<div class="alts"><span class="small muted">if not them</span>${alts}</div>` : ''}`
        : '<span class="muted small">no add beats your roster</span>'}</div>
    </div>`;
  }).join('');
  const groups = s.groups.map(g => `<div class="tgroup"><b>${g.games}</b><div class="tlist2">${g.teams.map(t => `<span class="tm" title="${t.b2b ? t.b2b + ' back-to-back' + (t.b2b > 1 ? 's' : '') : ''}">${esc(t.abbrev)}${t.b2b ? '<sup>B2B</sup>' : ''}</span>`).join('')}</div></div>`).join('');
  return `<section class="card"><h3>The weekly slate ${nav}<span class="r muted small">${A.periodRange(m, period)}${s.opp ? ` · vs <button class="tlink" data-view="${s.opp.id}">${esc(s.opp.name)}</button>` : ''}</span></h3>
      <div class="slate-top"><div><span class="k">Games ${period === m.currentPeriod ? 'left' : 'this week'}</span><span class="v">${s.myGames} <small>you</small></span></div><div class="vsx">vs</div><div><span class="k">&nbsp;</span><span class="v">${s.oppGames ?? '–'} <small>opp</small></span></div></div>
      <div class="sdays">${days}</div>
      <p class="muted small">Starts = games your best lineup uses each night (open = empty slots to stream into). Spend an add here = the free agent who adds the most from that night to the end of the week, replacing one of your three least useful players. Banned players are never suggested.</p></section>
    <section class="card"><h3>Games per NBA team <span class="r muted small">this week · B2B = back-to-back</span></h3><div class="tgroups">${groups}</div></section>`;
}

// ---- Injury report
function vInjuries() {
  const { an, model: m } = state;
  const rows = memo('injuries', () => A.injuryReport(m, an.my, state.settings.basis));
  const oppId = an.matchup && !an.matchup.bye ? an.matchup.opp.id : null;
  const group = (title, list) => !list.length ? '' : `<section class="card"><h3>${title} <span class="r muted small">${list.length}</span></h3>
    <div class="scrollx"><table class="injt"><thead><tr><th>Player</th><th>Team</th><th>Status</th><th class="num" title="Games missed of games left this season">Misses</th><th>Who benefits</th></tr></thead><tbody>
    ${list.map(r => `<tr><td>${pCell(r.p)}</td>
      <td>${r.owner ? `<button class="tlink" data-view="${r.owner.id}">${esc(r.owner.name)}</button>` : '<span class="badge b-wv">FREE AGENT</span>'}</td>
      <td class="small">${esc([r.p.injuryType, A.isOut(r.p) ? A.returnLabel(r.p) : 'Day-to-day'].filter(Boolean).join(' · '))}</td>
      <td class="num">${A.isOut(r.p) ? `${r.missed}<small class="muted">/${r.sched}</small>` : '<span class="muted">–</span>'}</td>
      <td class="benef">${r.beneficiaries.length ? `<span class="small up">+${Math.round(r.bump * 100)}%</span> ${r.beneficiaries.map(b => `<button class="chip benchip ${b.owner ? '' : 'fa'}" data-player="${b.q.id}" title="${b.owner ? esc(b.owner.name) : 'Free agent: pickup idea'}">${esc(b.q.name)}${b.owner ? '' : ' <span>FA</span>'}</button>`).join('')}` : '<span class="muted small">–</span>'}</td></tr>`).join('')}
    </tbody></table></div></section>`;
  // Free agents who gain most from injuries: pickup ideas.
  const pick = new Map();
  for (const r of rows) for (const b of r.beneficiaries) if (!b.owner && !isBanned(b.q.id)) {
    const x = pick.get(b.q.id) || { q: b.q, gain: 0, because: [] };
    x.gain += b.gain; x.because.push(r.p.name);
    pick.set(b.q.id, x);
  }
  const picks = [...pick.values()].sort((a, b) => b.gain - a.gain).slice(0, 6);
  return `${picks.length ? `<section class="card"><h3>Injury pickups <span class="r muted small">free agents whose role grows while a teammate is out</span></h3>
      ${picks.map(x => `<div class="pick">${pCell(x.q)}<div class="meta">${f1(val(x.q))}<small> proj/G</small><br><small>with ${esc(x.because.slice(0, 2).join(' & '))} out</small></div><div class="gain">+${f1(x.gain)}</div>${xBtn(x.q.id)}</div>`).join('')}
      <p class="muted small">+ = extra fantasy points per game from the usage bump while those teammates are out (already in their projections).</p></section>` : ''}
    ${group(`${esc(an.my.name)}`, rows.filter(r => r.mine))}
    ${oppId != null ? group(`Your opponent: ${esc(an.matchup.opp.name)}`, rows.filter(r => r.owner?.id === oppId)) : ''}
    ${group('Rest of your league', rows.filter(r => r.owner && !r.mine && r.owner.id !== oppId))}
    ${group('Notable free agents', rows.filter(r => !r.owner))}
    ${rows.length ? '' : '<div class="card empty"><h2>Clean bill of health</h2><p>No notable injuries in your league right now.</p></div>'}`;
}

function vWatchlist() {
  const { an, model: m } = state;
  const ids = Object.entries(state.pnotes).filter(([, v]) => v.star || v.note).map(([id]) => +id);
  const rows = ids.map(id => state.index.get(id)).filter(Boolean)
    .sort((a, b) => isStar(b.p.id) - isStar(a.p.id) || val(b.p) - val(a.p))
    .map(({ p, ownerId }) => `<tr>
      <td>${pCell(p)}</td>
      <td>${ownerId == null ? `<span class="badge b-wv">${p.status === 'WAIVERS' ? 'WAIVERS' : 'FREE AGENT'}</span>` : `<button class="tlink" data-view="${ownerId}">${esc(teamName(ownerId))}</button>`}</td>
      <td class="num"><b>${f1(avgOf(p))}</b></td><td class="num">${f1(val(p))}</td>
      <td class="num">${A.gamesIn(m, p, an.rem)}</td>
      <td class="note-cell">${esc(noteOf(p.id)) || '<span class="muted">–</span>'}</td></tr>`).join('');
  const missing = ids.filter(id => !state.index.has(id)).length;
  return `<section class="card"><h3>Watchlist <span class="r muted small">star players or add notes from any player's name</span></h3>
    ${rows ? `<div class="scrollx"><table><thead><tr><th>Player</th><th>Owner</th><th class="num" title="Actual season average">Avg</th><th class="num" title="Projected FP per game">Proj/G</th><th class="num" title="Games left this matchup">GL</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty" style="padding:30px"><p>Nothing here yet. Click any player name, anywhere in the app, to star them or write a note.</p></div>'}
    ${missing ? `<p class="muted small">${missing} saved player${missing > 1 ? 's are' : ' is'} no longer rostered or in the top free agents.</p>` : ''}
  </section>`;
}

// Where a player ranks in each window (from the Players tab).
function vRanks(p) {
  const r = getRanks().find(x => x.p.id === p.id);
  if (!r) return '';
  const bits = ['season', 'l15', 'l7', 'ros'].filter(k => r.rank[k] != null)
    .map(k => `<span><small>${k === 'season' ? 'Overall' : A.RANK_MODES[k]}</small><b>#${r.rank[k]}</b></span>`).join('');
  return bits ? `<div class="rankrow" title="Player rankings with your league's scoring">${bits}</div>` : '';
}

// How trade value is built for a player: reputation vs current form.
function vMarket(p) {
  const x = A.marketParts(state.model, p, state.settings.basis);
  if (x.rep == null) return '';
  const bits = [x.adp ? `ADP ${f1(x.adp)}` : x.espnRank ? `ESPN rank ${x.espnRank}` : '', x.auction ? `$${Math.round(x.auction)} auction` : '',
    x.prev != null ? `last season ${f1(x.prev)}` : '', x.proj != null ? `ESPN proj ${f1(x.proj)}` : ''].filter(Boolean).join(' · ');
  const gap = x.current - x.rep;
  const read = Math.abs(gap) < 3 ? 'Playing to their name.'
    : gap > 0 ? 'Playing above their name: a sell-high chip, but most managers won’t pay full price yet.'
    : 'Playing below their name: other managers still value them, so they cost more than current stats suggest.';
  const hurt = x.health < 0.99 ? ` Injury cuts their trade value to ${Math.round(x.health * 100)}%.` : '';
  return `<div class="usage"><b>Name value ${f1(x.rep)}</b> (${bits}). This season ${f1(x.current)}. ${read}${hurt}</div>`;
}

// Usage outlook for the player's next game, and when it changes over the next two weeks.
function vUsage(p) {
  const m = state.model, b = state.settings.basis;
  if (!adjustOn() || A.isOut(p)) return '';
  const days = Array.from({ length: 14 }, (_, i) => m.currentSP + i).filter(sp => A.gameLeft(m, p, sp));
  if (!days.length) return '';
  const r = A.usageReasons(m, p, days[0], b);
  const pct = f => `${f > 1 ? '+' : '−'}${Math.abs(Math.round((f - 1) * 100))}%`;
  const names = ps => ps.slice(0, 3).map(q => `${esc(q.name)}${q.returnDate ? ` <span class="muted">(back ${A.fmtMD(new Date(q.returnDate + 'T12:00:00'))})</span>` : ''}`).join(', ');
  const later = days.map(sp => ({ sp, f: A.usageFactor(m, p, sp, b) })).find(x => Math.abs(x.f - r.factor) >= 0.04);
  const changes = later ? ` From ${A.fmtDow(A.spDate(m, later.sp))} ${A.fmtMD(A.spDate(m, later.sp))}: ${Math.abs(later.f - 1) < 0.02 ? 'back to normal' : pct(later.f)}.` : '';
  if (Math.abs(r.factor - 1) < 0.02) return later ? `<div class="usage"><b>Usage</b> normal now.${changes}</div>` : '';
  return `<div class="usage ${r.factor > 1 ? 'up' : 'down'}"><b>Usage ${pct(r.factor)}</b> next game
    ${r.factor > 1 && r.out.length ? `with ${names(r.out)} out` : r.factor < 1 && r.back.length ? `with ${names(r.back)} back` : ''}.${changes}</div>`;
}

// How much a player is worth to the viewed team's lineup over the rest of the season.
function vWorth(p, ownerId) {
  const my = state.an.my;
  const ctx = getCtx();
  let pts, label;
  if (ownerId === my.id) {
    pts = ctx.myBase - ctx.S(my.roster.filter(x => x.id !== p.id));
    label = `Worth to ${esc(my.name)}`;
  } else {
    pts = ctx.S(A.applyTrade(my.roster, [], [p], state.settings.basis).after) - ctx.myBase;
    label = `Adds to ${esc(my.name)}`;
  }
  return `<div class="worth" title="Projected points over the rest of the season + playoffs, with ${ownerId === my.id ? 'vs without' : 'after adding (dropping your least useful player)'} this player">
    <span>${label}</span><b class="${pts > 0 ? 'up' : 'muted'}">${signed(pts)}</b><small>pts rest of season</small></div>`;
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
      ${ownerId !== state.an.my.id ? `<button class="btn ${isBanned(p.id) ? 'warnbtn' : ''}" data-act="${isBanned(p.id) ? 'unban' : 'ban'}" data-id="${p.id}" title="Never suggest as a pickup, trade fill-in or trade target">${isBanned(p.id) ? '↺ Allow again' : '🚫 Never suggest'}</button>` : ''}
      ${ownerId != null && ownerId !== state.an.my.id ? `<button class="btn" data-act="target" data-id="${p.id}" data-owner="${ownerId}">⇄ Find trades for</button>` : ''}
      ${ownerId === state.an.my.id ? `<button class="btn ${isLocked(p.id) ? 'warnbtn' : ''}" data-act="plock" title="Untouchable players are never offered in trade ideas or the finder">${isLocked(p.id) ? '🔒 Untouchable' : '🔓 Mark untouchable'}</button>
        <button class="btn" data-act="faway" data-id="${p.id}">⇄ Shop this player</button>` : ''}
    </div>
    ${vRanks(p)}
    ${vWorth(p, ownerId)}
    ${vUsage(p)}
    ${vMarket(p)}
    <div class="facts">
      <div><span class="k">Avg</span><span class="v">${f1(avgOf(p))}</span></div><div><span class="k">Proj/G</span><span class="v">${f1(val(p))}</span></div>
      <div title="What other managers think they're worth: draft position, last season, ESPN projection and this season"><span class="k">Trade value</span><span class="v">${f1(A.marketValue(m, p, state.settings.basis))}</span></div>
      <div><span class="k">Draft</span><span class="v">${p.adp ? 'ADP ' + Math.round(p.adp) : p.espnRank ? '#' + p.espnRank : '–'}</span></div>
      <div><span class="k">Games left</span><span class="v">${A.gamesIn(m, p, state.an.rem)}</span></div>
      <div><span class="k">Playoff G</span><span class="v">${A.gamesIn(m, p, po)}</span></div>
    </div>
    <table><thead><tr><th>Split</th><th class="num">Avg FP</th><th class="num">GP</th></tr></thead><tbody>
      ${row('season', 'Season')}${row('l7', 'Last 7')}${row('l15', 'Last 15')}${row('l30', 'Last 30')}${row('proj', 'ESPN projection')}${row('prev', 'Last season')}
    </tbody></table>
    <div class="rk-label">Latest news</div>
    <div class="newsbox" data-news="${p.id}" data-mode="full">${newsHtml(p.id, 'full')}</div>
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
    <section class="card"><h3>Projections</h3>
      <label class="toggle"><input type="checkbox" data-act="adjust" ${adjustOn() ? 'checked' : ''}>
        <span><b>Adjust for teammate injuries and back-to-back rest</b><br><span class="muted small">When a regular is out, teammates absorb part of their production (and lose it when a starter returns from a long absence). Stars get −5% on the second night of back-to-backs. Turn off for raw averages × games.</span></span></label>
    </section>
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
        <li>Data refreshes after a minute. Hit ↻ (or press R) to force a refresh, for example right after changing your lineup on ESPN.</li>
        <li>Shortcuts: <code>1</code>–<code>9</code> switch tabs, <code>←</code> <code>→</code> step through weeks, <code>Esc</code> closes the player panel.</li>
      </ol></section>
    ${state.error ? `<section class="card err"><h3>Last error</h3><p>${esc(state.error)}</p></section>` : ''}`;
}

function vBody() {
  if (state.loading) return '<div class="empty"><div class="spin"></div>Loading your league from ESPN…</div>';
  if (state.tab === 'settings') return vSettings();
  if (state.error) return `<div class="card err empty"><h2>Couldn't load your league</h2><p>${esc(state.error)}</p><div class="row" style="justify-content:center"><button class="btn primary" data-act="refresh">Try again</button><button class="btn" data-tab="settings">Settings</button></div></div>`;
  if (!state.model) return `<div class="empty"><h2>LinedUp<em>Better</em></h2><p>Connect your ESPN league to get started.</p><div class="row" style="justify-content:center"><button class="btn primary" data-tab="settings">Connect league</button><button class="btn" data-act="demo">Try demo</button></div></div>`;
  return { overview: vOverview, roster: vRoster, matchups: vMatchups, slate: vSlate, waivers: vWaivers, players: vPlayers, trade: vTrade, injuries: vInjuries, playoffs: vPlayoffs, watchlist: vWatchlist, league: vLeague }[state.tab]();
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
  if (state.model && state.openPlayer != null) ensureNews(state.openPlayer);
}

// ---------- events
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-act],[data-pos],[data-sort],[data-player],[data-view],[data-day]');
  if (!t) return;
  if (t.matches('select, textarea, input')) return;
  if (t.dataset.player) { state.openPlayer = +t.dataset.player; state.keepScroll = true; render(); return; }
  if (t.dataset.view) { setView(+t.dataset.view); return; }
  if (t.dataset.tab) { setTab(t.dataset.tab); return; }
  if (t.dataset.day) { const d = +t.dataset.day; state.wv.day = state.wv.day === d ? null : d; state.keepScroll = true; render(); return; }
  if (t.dataset.pos) { state.wv.pos = t.dataset.pos; state.keepScroll = true; render(); return; }
  if (t.dataset.sort) { state.wv.sort = t.dataset.sort; state.keepScroll = true; render(); return; }
  const act = t.dataset.act;
  if (act === 'close') { state.openPlayer = null; state.keepScroll = true; render(); return; }
  if (act === 'ban' || act === 'unban') {
    const id = +t.dataset.id;
    state.pnotes[id] = { ...state.pnotes[id], ban: act === 'ban' };
    await savePNotes(); reanalyze(); state.keepScroll = true; render();
    toast(act === 'ban' ? `${state.index.get(id)?.p.name || 'Player'} won't be suggested anywhere` : 'Allowed again');
    return;
  }
  if (act === 'unban-all') {
    for (const id of Object.keys(state.pnotes)) if (state.pnotes[id].ban) state.pnotes[id] = { ...state.pnotes[id], ban: false };
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
  if (act === 'prmode' || act === 'prpos' || act === 'prwho') {
    state.pr[{ prmode: 'mode', prpos: 'pos', prwho: 'who' }[act]] = t.dataset.v;
    state.pr.limit = 50; state.keepScroll = true; render(); return;
  }
  if (act === 'prmore') { state.pr.limit += 50; state.keepScroll = true; render(); return; }
  if (act === 'slwk') { if (t.dataset.p !== '') { state.slatePeriod = +t.dataset.p; state.keepScroll = true; render(); } return; }
  if (act === 'trend') { state.trend.mode = t.dataset.v; state.keepScroll = true; render(); return; }
  if (act === 'wk') { if (t.dataset.p !== '') { state.boardPeriod = +t.dataset.p; state.keepScroll = true; render(); } return; }
  if (act === 'trade-clear') { state.trade.give = []; state.trade.get = []; state.keepScroll = true; render(); return; }
  if (act === 'target') { openFinder('get', +t.dataset.id); return; }
  if (act === 'faway') { openFinder('away', +t.dataset.id); return; }
  if (act === 'fmode') {
    if (state.finder.mode !== t.dataset.v) state.finder = { mode: t.dataset.v, arg: null, status: 'idle' };
    state.keepScroll = true; render(); return;
  }
  if (act === 'fpos') { state.finder.arg = t.dataset.v; state.finder.status = 'idle'; runFinder(); return; }
  if (act === 'fopen') {
    const x = state.finder.results[+t.dataset.i];
    if (x) { loadIntoAnalyzer(x); render(); scrollToAnalyzer(); }
    return;
  }
  if (act === 'plock') {
    const id = state.openPlayer;
    state.pnotes[id] = { ...state.pnotes[id], lock: !isLocked(id) };
    await savePNotes(); state.keepScroll = true; render(); return;
  }
  if (act === 'idea') {
    const idea = state.scan?.ideas[+t.dataset.i];
    if (idea) { loadIntoAnalyzer(idea); render(); scrollToAnalyzer(); }
    return;
  }
  if (act === 'rescan') { runTradeScan(true); return; }
  if (act === 'ik' || act === 'it') {
    const f = state.ideaView;
    f[act === 'ik' ? 'kind' : 'type'] = t.dataset.v;
    f.limit = 10; state.keepScroll = true; render(); return;
  }
  if (act === 'more-ideas') { state.ideaView.limit += 10; state.keepScroll = true; render(); return; }
  if (act === 'recap') {
    navigator.clipboard.writeText(recapText()).then(() => toast('Recap copied: paste it in your group chat'), () => toast('Couldn\'t copy. Try again.'));
    return;
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
function setTab(tab) {
  state.tab = tab;
  if (tab !== 'settings' && state.settings.lastTab !== tab) { state.settings.lastTab = tab; saveSettings(); }
  render();
  document.querySelector('main')?.scrollTo(0, 0);
}
function scrollToAnalyzer() {
  const el = document.getElementById('analyzer');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function setView(id) {
  if (id == null || !state.model?.teams.some(t => t.id === id)) return;
  state.viewId = id; state.openPlayer = null; state.trade.give = []; state.boardPeriod = null; state.finder = null;
  reanalyze(); render();
}
let prTimer;
document.addEventListener('input', e => {
  if (e.target.dataset.act !== 'prq') return;
  state.pr.q = e.target.value; state.pr.limit = 50;
  clearTimeout(prTimer);
  prTimer = setTimeout(() => {
    const pos = e.target.selectionStart;
    state.keepScroll = true; render();
    const box = document.getElementById('prq');
    if (box) { box.focus(); box.setSelectionRange(pos, pos); }
  }, 180);
});
let noteTimer;
document.addEventListener('input', e => {
  if (e.target.dataset.act !== 'pnote') return;
  const id = state.openPlayer, text = e.target.value;
  state.pnotes[id] = { ...state.pnotes[id], note: text };
  clearTimeout(noteTimer);
  noteTimer = setTimeout(savePNotes, 300);
});
// Shortcuts: 1–9 switch tabs, ←/→ step weeks, R refreshes, Esc closes the player panel.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.openPlayer != null) { state.openPlayer = null; state.keepScroll = true; render(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
  if (/^[1-9]$/.test(e.key) && TABS[+e.key - 1]) { setTab(TABS[+e.key - 1][0]); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    document.querySelector(`.arrow[aria-label="${e.key === 'ArrowLeft' ? 'Previous' : 'Next'} week"]:not([disabled]), .arrow[aria-label="${e.key === 'ArrowLeft' ? 'Previous' : 'Next'} slate week"]:not([disabled])`)?.click();
    return;
  }
  if (e.key === 'r' || e.key === 'R') load(true);
});
document.addEventListener('change', async e => {
  const act = e.target.dataset.act;
  if (act === 'view') { setView(+e.target.value); return; }
  if (act === 'partner') { state.trade.partner = +e.target.value; state.trade.get = []; render(); return; }
  if (act === 'farg') { state.finder.arg = e.target.value ? +e.target.value : null; state.finder.status = 'idle'; runFinder(); return; }
  if (act === 'ip') { const v = e.target.value; Object.assign(state.ideaView, { partner: v === 'all' ? 'all' : +v, limit: 10 }); state.keepScroll = true; render(); return; }
  if (e.target.dataset.trade) {
    const side = e.target.dataset.trade, id = +e.target.value;
    const list = state.trade[side];
    state.trade[side] = e.target.checked ? [...list, id] : list.filter(x => x !== id);
    state.keepScroll = true; render(); return;
  }
  if (act === 'basis') { state.settings.basis = e.target.value; await saveSettings(); reanalyze(); render(); }
  if (act === 'inj') { state.wv.showInjured = e.target.checked; state.keepScroll = true; render(); }
  if (act === 'under50') { state.trend.under50 = e.target.checked; state.keepScroll = true; render(); }
  if (act === 'adjust') { state.settings.adjust = e.target.checked; await saveSettings(); reanalyze(); render(); toast(e.target.checked ? 'Teammate usage + rest adjustments on' : 'Adjustments off: raw averages'); }
});

// ---------- boot
(async () => {
  Object.assign(state.settings, (await store.get('settings')) || {});
  if (TABS.some(([k]) => k === state.settings.lastTab) && state.settings.lastTab !== 'settings') state.tab = state.settings.lastTab;
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
