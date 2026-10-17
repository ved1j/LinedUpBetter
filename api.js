// ESPN Fantasy Basketball (game code "fba") API client.
// Runs inside the extension, so requests carry the user's espn.com cookies
// (espn_s2 / SWID) automatically — private leagues work once logged in.

const BASE = 'https://lm-api-reads.fantasy.espn.com/apps/fantasy/v3/games/fba/seasons';

export const PRO_ABBR = {
  1: 'ATL', 2: 'BOS', 3: 'NOP', 4: 'CHI', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GSW', 10: 'HOU',
  11: 'IND', 12: 'LAC', 13: 'LAL', 14: 'MIA', 15: 'MIL', 16: 'MIN', 17: 'BKN', 18: 'NYK', 19: 'ORL', 20: 'PHI',
  21: 'PHX', 22: 'POR', 23: 'SAC', 24: 'SAS', 25: 'OKC', 26: 'UTA', 27: 'WAS', 28: 'TOR', 29: 'MEM', 30: 'CHA',
};
export const SLOT = {
  0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 7: 'SG/SF', 8: 'G/F',
  9: 'PF/C', 10: 'F/C', 11: 'UTIL', 12: 'BE', 13: 'IR',
};
const POS = { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' };
const SPLIT = { 0: 'season', 1: 'l7', 2: 'l15', 3: 'l30' };
const GP_STAT = '42';

export class EspnError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// Default transport: fetch from the extension itself. app.js can swap in one that
// runs inside an open fantasy.espn.com tab, where ESPN's own login cookies apply.
const direct = async (url, headers) => {
  const res = await fetch(url, { credentials: 'include', headers });
  return { status: res.status, text: await res.text() };
};
let transport = direct;
export const setTransport = fn => { transport = fn || direct; };

async function getJSON(url, filter) {
  const headers = { Accept: 'application/json' };
  if (filter) headers['X-Fantasy-Filter'] = JSON.stringify(filter);
  let res;
  try {
    res = await transport(url, headers);
  } catch {
    throw new EspnError('network', 'Could not reach ESPN. Check your connection and try again.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new EspnError('auth', 'This league is private. Log in at espn.com in this Chrome profile, then hit refresh.');
  }
  if (res.status === 404) throw new EspnError('notfound', 'League not found. Double-check the league ID and season.');
  if (res.status < 200 || res.status >= 300) throw new EspnError('http', `ESPN returned an error (${res.status}). Try again in a minute.`);
  const text = res.text;
  try { return JSON.parse(text); } catch {
    throw new EspnError('auth', 'ESPN sent back a login page instead of data. Log in at espn.com and refresh.');
  }
}

export async function loadLeague({ leagueId, season }) {
  season = +season;
  const leagueUrl = `${BASE}/${season}/segments/0/leagues/${leagueId}`;
  const faFilter = {
    players: {
      filterStatus: { value: ['FREEAGENT', 'WAIVERS'] },
      filterSlotIds: { value: [0, 1, 2, 3, 4, 5, 6, 11] },
      limit: 200,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' },
    },
  };
  const [league, pro, fa] = await Promise.all([
    getJSON(`${leagueUrl}?view=mSettings&view=mTeam&view=mRoster&view=mMatchupScore&view=mStatus`),
    getJSON(`${BASE}/${season}?view=proTeamSchedules_wl`),
    getJSON(`${leagueUrl}?view=kona_player_info`, faFilter),
  ]);
  return normalize(league, pro, fa, season, leagueId);
}

const etDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
function shiftISO(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

function normalize(L, P, F, season, leagueId) {
  const S = L.settings || {};
  const pts = {};
  for (const it of S.scoringSettings?.scoringItems || []) pts[it.statId] = it.points;
  const slotCounts = S.rosterSettings?.lineupSlotCounts || {};
  const starters = Object.entries(slotCounts)
    .filter(([k]) => +k !== 12 && +k !== 13)
    .reduce((a, [, v]) => a + v, 0) || 10;
  const sched = S.scheduleSettings || {};

  // NBA schedule: proTeams[id].games[scoringPeriodId] = { opp, home }
  const proTeams = {};
  let anchor = null; // earliest (scoringPeriod, date) pair, used to map periods -> calendar days
  for (const t of P.settings?.proTeams || []) {
    if (!t.id) continue;
    const games = {};
    for (const [spk, list] of Object.entries(t.proGamesByScoringPeriod || {})) {
      const g = list?.[0];
      if (!g) continue;
      const home = g.homeProTeamId === t.id;
      games[spk] = { opp: home ? g.awayProTeamId : g.homeProTeamId, home };
      if (g.date && (!anchor || +spk < anchor.sp)) anchor = { sp: +spk, date: g.date };
    }
    proTeams[t.id] = { abbrev: (t.abbrev || PRO_ABBR[t.id] || '').toUpperCase(), name: `${t.location || ''} ${t.name || ''}`.trim(), games };
  }
  const day1 = anchor ? shiftISO(etDate(anchor.date), -(anchor.sp - 1)) : new Date().toLocaleDateString('en-CA');

  const teams = (L.teams || []).map(t => {
    const rec = t.record?.overall || {};
    return {
      id: t.id,
      name: t.name || `${t.location || ''} ${t.nickname || ''}`.trim() || `Team ${t.id}`,
      abbrev: t.abbrev || '',
      logo: t.logo || null,
      owners: t.owners || (t.primaryOwner ? [t.primaryOwner] : []),
      wins: rec.wins || 0, losses: rec.losses || 0, ties: rec.ties || 0,
      pf: rec.pointsFor || t.points || 0, pa: rec.pointsAgainst || 0,
      seed: t.playoffSeed || null,
      acq: t.transactionCounter?.matchupAcquisitionTotals || {},
      roster: (t.roster?.entries || [])
        .map(e => normPlayer(e.playerPoolEntry?.player, { slot: e.lineupSlotId, season, pts }))
        .filter(Boolean),
    };
  });

  const side = s => s && { teamId: s.teamId, pts: s.totalPointsLive ?? s.totalPoints ?? 0 };
  const matchups = (L.schedule || []).map(m => ({
    period: m.matchupPeriodId,
    home: side(m.home),
    away: side(m.away),
    winner: m.winner,
  }));

  const freeAgents = (F.players || [])
    .map(e => normPlayer(e.player, { status: e.status, season, pts }))
    .filter(Boolean);

  const periods = {};
  for (const [k, v] of Object.entries(sched.matchupPeriods || {})) periods[k] = v.map(Number);

  return {
    demo: false,
    leagueId: String(leagueId),
    season,
    name: S.name || `League ${leagueId}`,
    currentSP: L.scoringPeriodId || L.status?.latestScoringPeriod || 1,
    currentPeriod: L.status?.currentMatchupPeriod || 1,
    regularPeriods: sched.matchupPeriodCount || Object.keys(periods).length,
    playoffTeamCount: sched.playoffTeamCount || 4,
    periods,
    starters,
    slotCounts,
    acqLimit: S.acquisitionSettings?.matchupAcquisitionLimit ?? -1,
    day1,
    teams,
    matchups,
    freeAgents,
    proTeams,
    myTeamId: null,
  };
}

function normPlayer(p, { slot = null, status = null, season, pts }) {
  if (!p) return null;
  const stats = {};
  for (const s of p.stats || []) {
    let key = null;
    if (s.seasonId === season && s.statSourceId === 0) key = SPLIT[s.statSplitTypeId];
    else if (s.seasonId === season && s.statSourceId === 1 && s.statSplitTypeId === 0) key = 'proj';
    else if (s.seasonId === season - 1 && s.statSourceId === 0 && s.statSplitTypeId === 0) key = 'prev';
    if (!key || stats[key]) continue;
    const gp = s.stats?.[GP_STAT] || 0;
    let avg = s.appliedAverage;
    if (avg == null && s.averageStats) {
      avg = Object.entries(s.averageStats).reduce((a, [k, v]) => a + (pts[k] || 0) * v, 0);
    }
    if (avg == null && s.appliedTotal != null && gp) avg = s.appliedTotal / gp;
    if (avg == null || (key !== 'proj' && !gp && !avg)) continue;
    stats[key] = { avg: Math.round(avg * 10) / 10, gp };
  }
  return {
    id: p.id,
    name: p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    proTeamId: p.proTeamId,
    pos: POS[p.defaultPositionId] || '',
    eligible: (p.eligibleSlots || []).filter(x => x <= 4).map(x => SLOT[x]),
    injury: p.injuryStatus || (p.injured ? 'OUT' : 'ACTIVE'),
    owned: p.ownership?.percentOwned ?? null,
    ownedChange: p.ownership?.percentChange ?? null,
    slot,
    status,
    stats,
  };
}
