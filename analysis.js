// Points-league analysis: player value, lineup projections, coach's notes, waiver ranking, playoff schedule.

const OUT = new Set(['OUT', 'INJURY_RESERVE', 'SUSPENSION']);
export const isOut = p => OUT.has(p.injury);
export const isDTD = p => p.injury === 'DAY_TO_DAY' || p.injury === 'QUESTIONABLE';

// Whether an injured player is expected to play on a given day: only once ESPN
// predicts them healthy (their expected return date). Out-for-season players and
// anyone out with no return date yet don't count.
export function availableOn(m, p, sp) {
  if (!isOut(p)) return true;
  if (p.outForSeason || !p.returnSP) return false;
  return sp >= p.returnSP;
}
// Day-to-day discount applies to the current matchup only.
const dtdFactor = (m, p, sp) => (isDTD(p) && (m.periods[m.currentPeriod] || []).includes(sp) ? 0.8 : 1);

// ---- Outside factors: teammate usage and back-to-back rest
// Teammate usage: when a regular is out, their production doesn't vanish, and teammates
// absorb part of it. Each player's averages were built with a certain supporting cast
// (how often each teammate actually played so far). On any future day, compare that to
// who's expected to play: more missing than usual means a usage bump for everyone who
// plays, a star returning after missing time means a dip. 60% of the missing production
// is spread over the team in proportion to each player's own (one star out ≈ +10–13%
// for teammates), capped at ±30%.
// Back-to-back rest: stars (35+ Proj/G) sometimes sit the second night, so -5% there.
export const adjustments = { usage: true, rest: true, playoffs: true };
export const setAdjustments = o => Object.assign(adjustments, o);

// ---- Focus matchups
// The weeks a manager has chosen to play for (say, only the games against the other weak
// teams). While a team has focus weeks left, only those weeks count for it and every other
// week counts for nothing, like a bye. It works through dayWeights, so trades, trade ideas,
// waiver gains, player worth and the Slate all follow it.
export const focus = { team: null, periods: new Set() };
export const setFocus = (team, periods) => { focus.team = team; focus.periods = new Set((periods || []).map(Number)); };
// The focus weeks a team still has to play, in order, or null when it has none.
export function focusPeriods(m, teamId) {
  if (focus.team !== teamId || !focus.periods.size) return null;
  const left = [...focus.periods].filter(id => id >= m.currentPeriod && m.periods[id]
    && (id <= m.regularPeriods || adjustments.playoffs)).sort((a, b) => a - b);
  return left.length ? left : null;
}
const USAGE_SHARE = 0.6, USAGE_CAP = 0.3, REST_STAR = 35, REST_FACTOR = 0.95;
const usageMemo = new WeakMap();

function usageCtx(m, basis) {
  let byBasis = usageMemo.get(m);
  if (!byBasis) usageMemo.set(m, byBasis = new Map());
  let u = byBasis.get(basis);
  if (u) return u;
  // Every player we know about (rostered + free agents), grouped by NBA team.
  const pool = new Map();
  for (const t of m.teams) for (const p of t.roster) pool.set(p.id, p);
  for (const p of m.poolFAs || m.freeAgents) if (!pool.has(p.id)) pool.set(p.id, p);
  const played = {};
  for (const [id, t] of Object.entries(m.proTeams)) played[id] = Object.keys(t.games).filter(sp => +sp < m.currentSP).length;
  const byTeam = new Map(), own = new Map();
  for (const p of pool.values()) {
    const v = value(p, basis);
    if (v < 8 || !p.proTeamId) continue;
    const g = played[p.proTeamId] || 0;
    const base = g >= 3 ? Math.min(1, (p.stats?.season?.gp || 0) / g) : 1; // share of team games they played
    const x = { p, v, base };
    own.set(p.id, x);
    if (!byTeam.has(p.proTeamId)) byTeam.set(p.proTeamId, []);
    byTeam.get(p.proTeamId).push(x);
  }
  // Spread over a typical team's tracked production, not just whoever is tracked on a
  // thin team: bench players we don't track soak up minutes too.
  const totals = [...byTeam.values()].map(xs => xs.reduce((a, x) => a + x.v * Math.max(x.base, 0.85), 0)).sort((a, b) => a - b);
  const norm = totals.length ? totals[Math.floor(totals.length / 2)] : 0;
  u = { byTeam, own, norm, cache: new Map() };
  byBasis.set(basis, u);
  return u;
}
// Expected share of games a player plays on a day: 0 if injured; otherwise their usual
// rate (regulars miss a few games anyway), but at least 85% once healthy, so only real
// changes (an injury now, or a long absence ending) shift teammates' usage.
const presence = (m, x, sp) => (availableOn(m, x.p, sp) ? Math.max(x.base, 0.85) : 0);
function teamDelta(m, u, proTeamId, sp) {
  const key = proTeamId * 1000 + sp;
  let d = u.cache.get(key);
  if (!d) {
    let delta = 0, active = 0;
    for (const x of u.byTeam.get(proTeamId) || []) {
      const now = presence(m, x, sp);
      delta += x.v * (x.base - now);
      active += x.v * now;
    }
    u.cache.set(key, d = { delta, active });
  }
  return d;
}
function usageMult(m, u, team, me, sp) {
  const d = teamDelta(m, u, team, sp);
  // A player's own absence or return doesn't change their own share.
  const delta = d.delta - (me ? me.v * (me.base - presence(m, me, sp)) : 0);
  if (!(d.active > 0) || !delta) return 1;
  return 1 + Math.max(-USAGE_CAP, Math.min(USAGE_CAP, USAGE_SHARE * delta / Math.max(d.active, u.norm)));
}
export function usageFactor(m, p, sp, basis) {
  if (!adjustments.usage || !p.proTeamId) return 1;
  const u = usageCtx(m, basis);
  return usageMult(m, u, p.proTeamId, u.own.get(p.id), sp);
}
const restFactor = (m, p, sp, v) => (adjustments.rest && v >= REST_STAR && isB2B(m, p, sp) ? REST_FACTOR : 1);
export const dayFactor = (m, p, sp, basis, v) => usageFactor(m, p, sp, basis) * restFactor(m, p, sp, v);

// Which teammates explain a usage change on a day: regulars out, or players back after
// missing a lot of games.
export function usageReasons(m, p, sp, basis) {
  const mates = (usageCtx(m, basis).byTeam.get(p.proTeamId) || []).filter(x => x.p.id !== p.id);
  return {
    factor: usageFactor(m, p, sp, basis),
    out: mates.filter(x => x.base >= 0.5 && !availableOn(m, x.p, sp)).sort((a, b) => b.v - a.v).map(x => x.p),
    back: mates.filter(x => x.base < 0.5 && availableOn(m, x.p, sp)).sort((a, b) => b.v - a.v).map(x => x.p),
  };
}
export function returnLabel(p) {
  if (!isOut(p)) return '';
  if (p.outForSeason) return 'Out for season';
  if (p.returnDate) return `Expected back ${fmtMD(new Date(p.returnDate + 'T12:00:00'))}`;
  return 'Out, no return date yet (not counted in projections)';
}

export const BASIS = {
  smart: 'Smart blend',
  season: 'Season avg',
  l15: 'Last 15',
  l30: 'Last 30',
  proj: 'ESPN projection',
};

// Fantasy points per game; never NaN (a bad split is ignored instead of poisoning totals).
// "smart" weights season + recent form by sample size, and leans on projections /
// last season early in the year.
export function value(p, basis = 'smart') {
  const v = rawValue(p, basis);
  return Number.isFinite(v) ? v : 0;
}
function rawValue(p, basis) {
  const s = {};
  for (const [k, x] of Object.entries(p.stats || {})) if (Number.isFinite(x?.avg)) s[k] = x;
  if (basis !== 'smart') {
    return s[basis]?.avg ?? s.proj?.avg ?? s.season?.avg ?? s.prev?.avg ?? 0;
  }
  const parts = [];
  const add = (k, w) => { if (s[k]?.avg != null && w > 0) parts.push([s[k].avg, w]); };
  // Real games take over quickly: ~80% actual stats by 10 games played.
  add('season', 0.5 * Math.min(1, (s.season?.gp || 0) / 10));
  add('l15', 0.3 * Math.min(1, (s.l15?.gp || 0) / 6));
  const left = Math.max(0.2, 1 - parts.reduce((a, [, w]) => a + w, 0));
  add('proj', s.prev ? left * 0.6 : left);
  add('prev', s.proj ? left * 0.4 : left);
  const W = parts.reduce((a, [, w]) => a + w, 0);
  return W ? parts.reduce((a, [v, w]) => a + v * w, 0) / W : 0;
}

export function spDate(m, sp) {
  const d = new Date(m.day1 + 'T12:00:00');
  d.setDate(d.getDate() + sp - 1);
  return d;
}
export const fmtDow = d => d.toLocaleDateString('en-US', { weekday: 'short' });
export const fmtMD = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export function periodRange(m, id) {
  const sps = m.periods[id] || [];
  if (!sps.length) return '';
  return `${fmtMD(spDate(m, sps[0]))} – ${fmtMD(spDate(m, sps[sps.length - 1]))}`;
}

export const gameOn = (m, p, sp) => m.proTeams[p.proTeamId]?.games?.[sp] || null;
// A game still to be played. Today's games that have tipped off are already counted in
// ESPN's live score, so projections must not add them again.
export const gameLeft = (m, p, sp, now = Date.now()) => {
  const g = gameOn(m, p, sp);
  return !!g && !(sp === m.currentSP && g.start && g.start <= now);
};
// Games a player is expected to play: not yet tipped off, and healthy by then.
export const gamesIn = (m, p, sps) => sps.reduce((a, sp) => a + (gameLeft(m, p, sp) && availableOn(m, p, sp) ? 1 : 0), 0);
export const remainingSps = (m, period = m.currentPeriod) => (m.periods[period] || []).filter(sp => sp >= m.currentSP);
export const playoffPeriods = m =>
  Object.keys(m.periods).map(Number).filter(id => id > m.regularPeriods).sort((a, b) => a - b);

// ---- Lineups
// Starting slots from the league settings (everything except bench 12 / IR 13+).
export function startingSlots(m) {
  const out = [];
  for (const [k, n] of Object.entries(m.slotCounts || {})) if (+k < 12) for (let i = 0; i < n; i++) out.push(+k);
  return out.length ? out : Array(m.starters || 10).fill(11);
}
// Fill specific positions before flexible ones (PG..C, then SG/SF etc., then G/F, then UTIL).
const SLOT_RANK = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 7: 1, 8: 1, 9: 1, 10: 1, 5: 2, 6: 2, 11: 3 };

// Best lineup for one day: players are taken best-first and placed with augmenting
// paths (bumping an already-placed player to another slot they can play). Greedy by
// value + augmenting paths is optimal here, because lineups form a transversal matroid.
// Slot orders and each player's eligible slots (as a bitmask over slot indices) are
// cached per slot layout: this runs hundreds of thousands of times during trade scans.
const orderCache = new Map();
const eligCache = new WeakMap();
function eligMask(p, slots, key) {
  let byKey = eligCache.get(p);
  if (!byKey) eligCache.set(p, byKey = new Map());
  let mask = byKey.get(key);
  if (mask === undefined) {
    mask = 0;
    for (let i = 0; i < slots.length; i++) if (!p.slots?.length || p.slots.includes(slots[i])) mask |= 1 << i;
    byKey.set(key, mask);
  }
  return mask;
}
export function fillLineup(players, slots, key = slots.join(',')) {
  const n = slots.length;
  const owner = new Array(n).fill(-1);
  let order = orderCache.get(key);
  if (!order) orderCache.set(key, order = slots.map((s, i) => i).sort((a, b) => (SLOT_RANK[slots[a]] ?? 3) - (SLOT_RANK[slots[b]] ?? 3)));
  const masks = players.map(pl => eligMask(pl.p, slots, key));
  const used = [];
  let visited = 0;
  const place = pi => {
    const mask = masks[pi];
    for (const si of order) {
      const bit = 1 << si;
      if (!(mask & bit) || (visited & bit)) continue;
      visited |= bit;
      if (owner[si] === -1 || place(owner[si])) { owner[si] = pi; return true; }
    }
    return false;
  };
  for (let i = 0; i < players.length && used.length < n; i++) {
    visited = 0;
    if (place(i)) used.push(players[i]);
  }
  return { used, owner };
}

// Simulates each day: healthy players with a game fill the league's starting slots,
// respecting position eligibility. Injured players (including anyone in an IR slot)
// count from the day they're expected back. With track=true it also tallies, per
// player, games started / benched / missed injured and points, and points per slot.
// `w` (a team's dayWeights) scales each day's points by how much it counts for that
// team: 0 on bye weeks, so those days are skipped entirely.
export function projectDays(m, roster, sps, basis, track = false, w = null) {
  const fills = openSpotFills(m, roster, sps, basis);
  if (fills.length) roster = [...roster, ...fills];
  const slots = startingSlots(m);
  const slotsKey = slots.join(',');
  const now = Date.now();
  const cur = new Set(m.periods[m.currentPeriod] || []);
  const u = adjustments.usage ? usageCtx(m, basis) : null;
  // Everything about a player that doesn't change day to day, looked up once. Same rules
  // as gameLeft / availableOn / dtdFactor / dayFactor, inlined: this is the hot loop.
  const info = roster.map(p => {
    const v = value(p, basis);
    const out = isOut(p);
    return {
      p, v, games: m.proTeams[p.proTeamId]?.games || {},
      backSP: !out ? 0 : p.outForSeason || !p.returnSP ? Infinity : p.returnSP,
      dtd: isDTD(p), star: adjustments.rest && v >= REST_STAR, join: p.joinSP || 0,
      team: p.proTeamId, me: u && p.proTeamId ? u.own.get(p.id) : null,
    };
  });
  const players = track ? new Map(roster.map(p => [p, { g: 0, pts: 0, avail: 0, bench: 0, out: 0 }])) : null;
  const slotPts = track ? {} : null;
  let total = 0, games = 0;
  const days = [];
  for (const sp of sps) {
    const wt = w ? w.get(sp) ?? 1 : 1;
    if (wt === 0 && !track) continue;
    const playing = [];
    const isToday = sp === m.currentSP, inCur = cur.has(sp);
    for (const x of info) {
      const g = x.games[sp];
      if (!g || (isToday && g.start && g.start <= now)) continue; // no game, or already tipped off
      if (sp < x.join) continue; // assumed pickup not on the team yet
      if (sp < x.backSP) { if (track) players.get(x.p).out++; continue; }
      let v = x.v;
      if (x.dtd && inCur) v *= 0.8;
      if (u && x.team) v *= usageMult(m, u, x.team, x.me, sp);
      if (x.star && x.games[sp - 1]) v *= REST_FACTOR;
      playing.push({ p: x.p, v });
    }
    playing.sort((a, b) => b.v - a.v);
    const today = sp === m.currentSP;
    const daySlots = today ? slotsLeftToday(m, roster) : slots;
    const { used, owner } = fillLineup(playing, daySlots, today ? daySlots.join(',') : slotsKey);
    const pts = used.reduce((a, x) => a + x.v, 0);
    total += pts * wt;
    if (wt > 0) games += used.length;
    if (track) {
      for (const x of playing) players.get(x.p).avail++;
      owner.forEach((pi, si) => {
        if (pi < 0) return;
        const x = playing[pi], t = players.get(x.p);
        t.g++; t.pts += x.v;
        slotPts[daySlots[si]] = (slotPts[daySlots[si]] || 0) + x.v;
      });
      for (const x of playing) { const t = players.get(x.p); t.bench = t.avail - t.g; }
    }
    days.push({
      sp, pts, starters: used.map(x => x.p),
      playing: playing.length,
      open: daySlots.length - used.length,
      benched: playing.length - used.length,
    });
  }
  return { total, games, days, players, slotPts };
}

// Open roster spots: a roster with fewer players than the league's roster spots (IR
// aside) is assumed to fill them with the best available free agents (by Proj/G, never
// one you've banned) from the start of the next matchup, once adds reset, so future
// weeks don't project an empty spot forever. This week stays as it is. The pickup is
// marked `fill` (shown as an assumed pickup in breakdowns).
const capMemo = new WeakMap(), fillMemo = new WeakMap();
export function rosterSpots(m) {
  if (!capMemo.has(m)) {
    let n = 0;
    for (const [k, c] of Object.entries(m.slotCounts || {})) if (+k <= 12) n += c;
    capMemo.set(m, n);
  }
  return capMemo.get(m);
}
export const openSpots = (m, roster) => Math.max(0, rosterSpots(m) - roster.filter(p => p.slot !== 13).length);
export const fillStart = m => (m.periods[m.currentPeriod + 1] || [])[0] || null;
export function openSpotFills(m, roster, sps, basis) {
  const cap = rosterSpots(m);
  if (!cap) return [];
  let n = 0;
  for (const p of roster) if (p.slot !== 13) n++;
  if (n >= cap) return [];
  const join = fillStart(m);
  if (!join) return [];
  let last = 0;
  for (const sp of sps) if (sp > last) last = sp;
  if (last < join) return [];
  const have = new Set(roster.map(p => p.id));
  let byKey = fillMemo.get(m);
  if (!byKey) fillMemo.set(m, byKey = new Map());
  const out = [];
  for (const p of faPool(m, basis)) {
    if (have.has(p.id) || m.banned?.has(p.id)) continue;
    const k = `${p.id}:${join}`;
    if (!byKey.has(k)) byKey.set(k, { ...p, slot: 12, joinSP: join, fill: true });
    out.push(byKey.get(k));
    if (n + out.length >= cap) break;
  }
  return out;
}

// Evenly spaced subset of days (for season-long simulations), with the factor that
// scales a sampled total back up to the full window.
export function sampleDays(sps, max = 48) {
  if (sps.length <= max) return { days: sps, scale: 1 };
  const step = sps.length / max;
  const days = Array.from({ length: max }, (_, i) => sps[Math.floor(i * step)]);
  return { days, scale: sps.length / max };
}

// Today's starting slots that are still open: starters whose game already tipped off
// are locked into theirs.
export function slotsLeftToday(m, roster) {
  const slots = startingSlots(m);
  for (const p of roster) {
    if (p.slot == null || p.slot >= 12) continue;
    if (!gameOn(m, p, m.currentSP) || gameLeft(m, p, m.currentSP)) continue;
    const i = slots.indexOf(p.slot);
    if (i >= 0) slots.splice(i, 1); else slots.pop();
  }
  return slots;
}

// Back-to-back: the player's NBA team also played the day before.
export const isB2B = (m, p, sp) => !!(gameOn(m, p, sp) && gameOn(m, p, sp - 1));

// A player's points per game on a day, exactly as projections value it (day-to-day
// discount, teammate usage, back-to-back rest).
export function dayValue(m, p, sp, basis) {
  const v = value(p, basis);
  return v * dtdFactor(m, p, sp) * dayFactor(m, p, sp, basis, v);
}

// ---- Today's lineup vs the best possible one
export function lineupCheck(m, team, basis) {
  const sp = m.currentSP;
  if (!(m.periods[m.currentPeriod] || []).includes(sp)) return null;
  const best = projectDays(m, team.roster, [sp], basis).days[0];
  const v = p => dayValue(m, p, sp, basis);
  const plays = p => gameLeft(m, p, sp) && availableOn(m, p, sp);
  const locked = p => gameOn(m, p, sp) && !gameLeft(m, p, sp); // game already tipped off
  const inSlot = team.roster.filter(p => p.slot != null && p.slot < 12);
  const starting = inSlot.filter(p => !locked(p));
  // Your current starters, valued the same way as the best lineup (so an already-optimal
  // lineup shows no gain).
  const current = starting.filter(plays).reduce((a, p) => a + v(p), 0);
  const bestSet = new Set(best.starters);
  const start = best.starters.filter(p => !(p.slot < 12));
  // Open starting slots take incoming players without benching anyone (if eligible);
  // only the rest need someone to sit.
  const open = startingSlots(m);
  for (const p of inSlot) { const i = open.indexOf(p.slot); if (i >= 0) open.splice(i, 1); }
  let needSits = 0;
  for (const p of start) {
    const i = open.findIndex(s => !p.slots?.length || p.slots.includes(s));
    if (i >= 0) open.splice(i, 1); else needSits++;
  }
  // Sit idle starters first (no game / injured), then the weakest.
  const idle = p => !plays(p);
  const sit = starting.filter(p => !bestSet.has(p))
    .sort((a, b) => idle(b) - idle(a) || v(a) - v(b))
    .slice(0, needSits);
  const why = p => (!gameOn(m, p, sp) ? 'no game today' : !availableOn(m, p, sp) ? 'out' : locked(p) ? 'locked' : 'weaker option');
  return { gain: best.pts - current, start, sit, best: best.pts, current, why, intoOpen: start.length - needSits };
}

// ---- Streaming plan: sequence of add/drop moves for the rest of the matchup
export function streamPlan(m, team, basis, maxAdds) {
  const rem = remainingSps(m);
  if (!rem.length || maxAdds <= 0) return [];
  let roster = team.roster.slice();
  let base = projectDays(m, roster, rem, basis).total;
  const pool = m.freeAgents
    .filter(p => gamesIn(m, p, rem) > 0)
    .map(p => ({ p, k: value(p, basis) * gamesIn(m, p, rem) }))
    .sort((a, b) => b.k - a.k).slice(0, 50).map(x => x.p);
  const added = new Set();
  const steps = [];
  for (let k = 0; k < maxAdds; k++) {
    const drops = roster.filter(p => p.slot !== 13 && !added.has(p.id))
      .sort((a, b) => value(a, basis) - value(b, basis)).slice(0, 3);
    let best = null;
    for (const fa of pool) {
      if (added.has(fa.id)) continue;
      for (const d of drops) {
        const gain = projectDays(m, [...roster.filter(p => p !== d), fa], rem, basis).total - base;
        if (!best || gain > best.gain) best = { add: fa, drop: d, gain };
      }
    }
    if (!best || best.gain < 4) break;
    steps.push({ ...best, games: gamesIn(m, best.add, rem) });
    roster = [...roster.filter(p => p !== best.drop), best.add];
    added.add(best.add.id);
    base += best.gain;
  }
  return steps;
}

export function addsLeft(m, team) {
  if (!(m.acqLimit > 0)) return 3;
  return Math.max(0, m.acqLimit - (team.acq?.[m.currentPeriod] || 0));
}

// ---- Playoff odds: Monte Carlo over the remaining regular-season matchups
// With trackId, also records for each of that team's remaining matchups how often it
// makes the playoffs after winning vs losing it (the matchups that matter most).
export function playoffOdds(m, basis, sims = 3000, trackId = null) {
  const left = m.matchups.filter(x => x.period >= m.currentPeriod && x.period <= m.regularPeriods && x.home && x.away);
  const team = id => m.teams.find(t => t.id === id);
  const games = left.map(x => {
    const pr = projectMatchup(m, x.period, team(x.home.teamId), team(x.away.teamId), basis, x.home.pts, x.away.pts);
    return { h: x.home.teamId, a: x.away.teamId, wp: pr.winProb, hp: pr.homeProj, ap: pr.awayProj };
  });
  const n = m.playoffTeamCount || 4;
  const pow2 = 2 ** Math.ceil(Math.log2(n));
  const byes = n === pow2 ? 0 : pow2 - n;
  const ids = m.teams.map(t => t.id);
  const res = Object.fromEntries(ids.map(id => [id, { playoff: 0, bye: 0, seed: 0, expW: team(id).wins, expL: team(id).losses }]));
  const pf0 = Object.fromEntries(m.teams.map(t => [t.id, t.pf]));
  for (const g of games) {
    res[g.h].expW += g.wp; res[g.h].expL += 1 - g.wp;
    res[g.a].expW += 1 - g.wp; res[g.a].expL += g.wp;
    pf0[g.h] += g.hp; pf0[g.a] += g.ap;
  }
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mine = trackId == null ? [] : games.map((g, i) => (g.h === trackId || g.a === trackId ? i : -1)).filter(i => i >= 0);
  const lev = mine.map(() => ({ win: 0, inWin: 0, inLoss: 0 }));
  const won = new Array(games.length);
  for (let s = 0; s < sims; s++) {
    const w = Object.fromEntries(m.teams.map(t => [t.id, t.wins]));
    games.forEach((g, i) => { const hw = rnd() < g.wp; won[i] = hw; w[hw ? g.h : g.a]++; });
    const order = ids.slice().sort((a, b) => w[b] - w[a] || pf0[b] - pf0[a] + (rnd() - 0.5) * 60);
    order.forEach((id, i) => {
      if (i < n) res[id].playoff++;
      if (i < byes) res[id].bye++;
      res[id].seed += i + 1;
    });
    if (mine.length) {
      const made = order.indexOf(trackId) < n;
      mine.forEach((gi, k) => {
        const iWon = won[gi] === (games[gi].h === trackId);
        if (iWon) { lev[k].win++; if (made) lev[k].inWin++; } else if (made) lev[k].inLoss++;
      });
    }
  }
  for (const id of ids) {
    res[id].playoff /= sims; res[id].bye /= sims; res[id].seed /= sims;
  }
  const leverage = mine.map((gi, k) => {
    const g = left[gi], x = lev[k];
    const ifWin = x.win ? x.inWin / x.win : 0, ifLoss = sims - x.win ? x.inLoss / (sims - x.win) : 0;
    return { period: g.period, opp: team(g.home.teamId === trackId ? g.away.teamId : g.home.teamId), wp: x.win / sims, ifWin, ifLoss, swing: ifWin - ifLoss };
  });
  return { teams: res, byes, simulated: games.length, leverage };
}

// ---- Trade value ("name value")
// What other managers think a player is worth, on the same FP/G scale as everything
// else. Reputation = draft position (turned into the FP/G a pick at that spot is worth
// in this league), last season and ESPN's projection; current form = this season's
// production. Early on reputation dominates; current form takes over gradually (up to
// 70% by ~35 games), so a hot start doesn't make a mid-round pick look like a star.
const marketMemo = new WeakMap();
function marketCtx(m, basis) {
  let byBasis = marketMemo.get(m);
  if (!byBasis) marketMemo.set(m, byBasis = new Map());
  basis = `${basis}:${adjustments.playoffs}`; // injury discounts depend on which days count
  let c = byBasis.get(basis);
  if (c) return c;
  const pool = new Map();
  for (const t of m.teams) for (const p of t.roster) pool.set(p.id, p);
  for (const p of m.poolFAs || m.freeAgents || []) if (!pool.has(p.id)) pool.set(p.id, p);
  // League-wide value ladder (best first) to translate a draft slot into FP/G.
  const ladder = [...pool.values()].map(p => p.stats?.proj?.avg ?? p.stats?.prev?.avg ?? value(p, basis))
    .filter(Number.isFinite).sort((a, b) => b - a);
  byBasis.set(basis, c = { ladder, cache: new Map() });
  return c;
}
export function marketParts(m, p, basis) {
  const c = marketCtx(m, basis);
  const hit = c.cache.get(p.id);
  if (hit) return hit;
  const s = p.stats || {};
  const slot = p.adp || p.espnRank;
  const draft = slot && c.ladder.length ? c.ladder[Math.min(c.ladder.length - 1, Math.max(0, Math.round(slot) - 1))] : null;
  const prev = s.prev?.gp >= 20 && Number.isFinite(s.prev.avg) ? s.prev.avg : null;
  const proj = Number.isFinite(s.proj?.avg) ? s.proj.avg : null;
  const parts = [[draft, 0.4], [prev, 0.3], [proj, 0.3]].filter(([x]) => x != null);
  const w = parts.reduce((a, [, k]) => a + k, 0);
  const rep = w ? parts.reduce((a, [x, k]) => a + x * k, 0) / w : null;
  const current = value(p, 'smart');
  const gp = s.season?.gp || 0;
  const wc = rep == null ? 1 : Math.min(0.7, 0.15 + gp / 60);
  // Injuries cut trade value: by the share of remaining games they're expected to play
  // (managers still pay a little for a stash), much more if there's no return date.
  let health = 1;
  if (p.outForSeason) health = 0.05;
  else if (isOut(p) && !p.returnSP) health = 0.45;
  else if (isOut(p)) {
    const days = c.days || (c.days = futureDays(m));
    const sched = days.filter(sp => gameOn(m, p, sp)).length;
    health = sched ? 0.4 + 0.6 * (days.filter(sp => gameOn(m, p, sp) && availableOn(m, p, sp)).length / sched) : 1;
  }
  const v = (rep == null ? current : (1 - wc) * rep + wc * current) * health;
  const out = { value: v, rep, current, draft, prev, proj, wc, health, adp: p.adp, auction: p.auction, espnRank: p.espnRank };
  c.cache.set(p.id, out);
  return out;
}
export const marketValue = (m, p, basis) => marketParts(m, p, basis).value;

// ---- Trades
export function seasonWindows(m) {
  const week = remainingSps(m);
  const ros = Object.keys(m.periods).map(Number).filter(id => id >= m.currentPeriod && id <= m.regularPeriods)
    .flatMap(id => m.periods[id]).filter(sp => sp >= m.currentSP);
  const po = adjustments.playoffs ? playoffPeriods(m).flatMap(id => m.periods[id] || []) : [];
  return { week, ros, po };
}

// ---- Which days count
// A team's points only matter in weeks it has a matchup that counts. Everything that
// adds up future days (trades, waivers, streaming, needs) weights each day by this:
//  - bye weeks count for nothing: a regular-season week with no opponent, a first-round
//    playoff bye, playoff rounds once a team is out (missed the bracket or lost);
//  - with "Count fantasy playoffs" off in Settings, nothing after the regular season counts;
//  - before the bracket is set, round 1 counts at the team's chance of NOT getting a bye
//    (from the playoff-odds simulation); later rounds count fully.
// Returns { period: Map(periodId → weight), sp: Map(day → weight) }, listing only days
// that don't count fully.
const WINNERS = 'WINNERS_BRACKET';
const weightMemo = new WeakMap(), byeMemo = new WeakMap();
const hasTeam = (x, id) => x.home?.teamId === id || x.away?.teamId === id;
const realGame = x => x.home?.teamId != null && x.away?.teamId != null;
const inBracket = x => !x.tier || x.tier === 'NONE' || x.tier === WINNERS;
export const playoffByes = m => { const n = m.playoffTeamCount || 4; return 2 ** Math.ceil(Math.log2(n)) - n; };
function byeChance(m, teamId, basis) {
  let byKey = byeMemo.get(m);
  if (!byKey) byeMemo.set(m, byKey = new Map());
  const k = `${basis}:${adjustments.usage}:${adjustments.rest}`;
  if (!byKey.has(k)) byKey.set(k, playoffOdds(m, basis, 2000));
  return byKey.get(k).teams[teamId]?.bye ?? 0;
}
// With focus weeks set for the team (and useFocus on), every other week from now on counts 0.
const spWeights = (m, period) => {
  const sp = new Map();
  for (const [id, w] of period) for (const d of m.periods[id] || []) sp.set(d, w);
  return sp;
};
export function dayWeights(m, teamId, basis = 'smart', useFocus = true) {
  let byKey = weightMemo.get(m);
  if (!byKey) weightMemo.set(m, byKey = new Map());
  const k = `${teamId}:${basis}:${adjustments.playoffs}:${adjustments.usage}:${adjustments.rest}`;
  const fp = useFocus ? focusPeriods(m, teamId) : null;
  if (fp) {
    const fk = `${k}:focus:${fp.join(',')}`;
    if (byKey.has(fk)) return byKey.get(fk);
    const keep = new Set(fp);
    const period = new Map(dayWeights(m, teamId, basis, false).period);
    const last = Math.max(...Object.keys(m.periods).map(Number));
    for (let id = m.currentPeriod; id <= last; id++) if (!keep.has(id)) period.set(id, 0);
    const out = { period, sp: spWeights(m, period) };
    byKey.set(fk, out);
    return out;
  }
  if (byKey.has(k)) return byKey.get(k);
  const period = new Map();
  for (let id = m.currentPeriod; id <= m.regularPeriods; id++) {
    const games = m.matchups.filter(x => x.period === id && realGame(x));
    if (games.length && !games.some(x => hasTeam(x, teamId))) period.set(id, 0);
  }
  const rounds = playoffPeriods(m);
  if (!adjustments.playoffs) for (const id of rounds) period.set(id, 0);
  else {
    const bracket = m.matchups.filter(x => x.period > m.regularPeriods && inBracket(x));
    const drawn = bracket.some(realGame);
    const team = m.teams.find(t => t.id === teamId);
    const inIt = bracket.some(x => hasTeam(x, teamId)) || (team?.seed != null && team.seed <= (m.playoffTeamCount || 4));
    const lost = bracket.some(x => realGame(x) && hasTeam(x, teamId) && (x.winner === 'HOME' || x.winner === 'AWAY')
      && (x.winner === 'HOME') !== (x.home.teamId === teamId));
    rounds.forEach((id, i) => {
      const games = bracket.filter(x => x.period === id && realGame(x));
      let w = 1;
      if (!drawn) w = i === 0 && playoffByes(m) ? 1 - byeChance(m, teamId, basis) : 1;
      else if (!inIt || lost) w = 0;
      else if (games.length) w = games.some(x => hasTeam(x, teamId)) ? 1 : 0;
      if (w !== 1) period.set(id, w);
    });
  }
  const out = { period, sp: spWeights(m, period) };
  byKey.set(k, out);
  return out;
}
export const periodWeight = (m, teamId, id, basis, useFocus = true) => dayWeights(m, teamId, basis, useFocus).period.get(id) ?? 1;
// Why a week doesn't count for a team (for notes and the Slate). With a team, a week that
// only drops out because of its focus matchups says so.
export function offReason(m, id, teamId = null, basis = 'smart') {
  const fp = teamId != null ? focusPeriods(m, teamId) : null;
  if (fp && !fp.includes(id) && periodWeight(m, teamId, id, basis, false) > 0) {
    return { title: 'Not a focus matchup', detail: 'You’re only playing for your focus matchups, so this week counts for nothing: no streams needed. Setting your lineup is still free.', focus: true };
  }
  if (id > m.regularPeriods && !adjustments.playoffs) return { title: 'Playoffs not counted', detail: 'Fantasy playoffs are switched off in Settings, so this week doesn’t count anywhere.' };
  if (id > m.regularPeriods) return { title: 'No playoff matchup', detail: 'A first-round bye or out of the bracket, so nothing this round counts: no lineup moves or streams needed.' };
  return { title: 'Bye week', detail: 'No opponent this week, so nothing counts: no lineup moves or streams needed.' };
}

// Roster after a trade. Incoming players arrive on the bench; if the team now has more
// players than before, it drops its least useful ones (out-for-season first, then
// lowest value), never a player it just received.
// With `fill` ({ fas, S?, k?, exclude? }), a team left with an open spot (gave more than
// it got) picks up its best waiver option: fill.fas is that team's free agents ranked by
// how much each adds to its lineup (rankFillins); with a scorer S, the top k are
// re-checked on the actual post-trade roster and the best fit wins.
export function applyTrade(roster, give, get, basis, fill = null) {
  const giveIds = new Set(give.map(p => p.id)), getIds = new Set(get.map(p => p.id));
  let after = [...roster.filter(p => !giveIds.has(p.id)), ...get.map(p => ({ ...p, slot: 12 }))];
  const drops = [], adds = [];
  const worth = p => (p.outForSeason ? -1 : value(p, basis));
  while (after.length > roster.length) {
    const pool = after.filter(p => !getIds.has(p.id));
    const d = (pool.length ? pool : after).reduce((a, b) => (worth(b) < worth(a) ? b : a));
    drops.push(d);
    after = after.filter(p => p !== d);
  }
  if (fill && after.length < roster.length) {
    // fill.fas is already sorted best-first and limited to players who can play.
    const owned = new Set(after.map(p => p.id));
    const want = fill.S ? (fill.k || 4) : roster.length - after.length;
    const pool = [];
    for (const p of fill.fas || []) {
      if (owned.has(p.id) || giveIds.has(p.id) || fill.exclude?.has(p.id)) continue;
      pool.push(p);
      if (pool.length >= want) break;
    }
    while (after.length < roster.length && pool.length) {
      let best = pool[0];
      if (fill.S && pool.length > 1) {
        let top = -Infinity;
        for (const fa of pool) { const sc = fill.S([...after, { ...fa, slot: 12 }]); if (sc > top) { top = sc; best = fa; } }
      }
      pool.splice(pool.indexOf(best), 1);
      after = [...after, { ...best, slot: 12 }];
      adds.push(best);
    }
  }
  return { after, drops, adds };
}
// Free agents who can play (not out for the season, not out with no return date),
// best Proj/G first. Sorted once per model + basis: trade scans fill spots thousands of times.
const faMemo = new WeakMap();
function faPool(m, basis) {
  let byBasis = faMemo.get(m);
  if (!byBasis) faMemo.set(m, byBasis = new Map());
  let list = byBasis.get(basis);
  if (!list) {
    list = (m.poolFAs || m.freeAgents || []).filter(p => !p.outForSeason && (!isOut(p) || p.returnSP))
      .map(p => [p, value(p, basis)]).sort((a, b) => b[1] - a[1]).map(([p]) => p);
    byBasis.set(basis, list);
  }
  return list;
}

// A team's waiver options ranked by what each would add to its lineup (positions, NBA
// schedule, injuries), checked across the 60 best free agents by Proj/G. This is the
// "best possible waiver pickup" used whenever a trade leaves a team a player short.
export function rankFillins(m, team, basis, S, exclude = null) {
  const base = S(team.roster, team);
  return faPool(m, basis).filter(p => !exclude?.has(p.id)).slice(0, 60)
    .map(fa => ({ fa, gain: S(applyTrade(team.roster, [], [fa], basis).after, team) - base }))
    .sort((a, b) => b.gain - a.gain).map(x => x.fa);
}
// Fill-in settings per team, ranked once per context. Players you've banned are never
// your pickup (other teams can still add them).
function makeFills(m, my, basis, S, exact) {
  const cache = new Map();
  return team => {
    if (!cache.has(team.id)) {
      const exclude = team.id === my.id ? m.banned || null : null;
      cache.set(team.id, { fas: rankFillins(m, team, basis, S, exclude), S: exact ? r => S(r, team) : null, k: 4, exclude });
    }
    return cache.get(team.id);
  };
}
const banned = m => m.banned || new Set();

// What the free agents a trade lets a team pick up would be worth on their own (added by
// dropping its least useful players instead of trading). Taken out of a trade's value,
// so a 2-for-1 isn't credited for a waiver move the team could make anyway.
export function faAlone(roster, adds, basis, S, base = null, team = null) {
  if (!adds?.length) return 0;
  return Math.max(0, S(applyTrade(roster, [], adds, basis).after, team) - (base ?? S(roster, team)));
}
// Same, memoized per team + pickup: within one scan it's always the same answer.
function faAloneMemo(memo, team, adds, basis, S, base) {
  if (!adds?.length) return 0;
  const k = `${team.id}:${adds.map(p => p.id).join(',')}`;
  if (!memo.has(k)) memo.set(k, faAlone(team.roster, adds, basis, S, base, team));
  return memo.get(k);
}

// Projected points for a team before/after a trade, in each window.
export function tradeImpact(m, team, give, get, basis, mine = true) {
  const before = team.roster;
  // Pick any free-agent fill-in on every remaining day, exactly like the trade ideas do.
  const days = futureDays(m);
  const tw = dayWeights(m, team.id, basis).sp;
  const S = r => projectDays(m, r, days, basis, false, tw).total;
  const exclude = mine ? m.banned || null : null;
  const { after, drops, adds } = applyTrade(before, give, get, basis, { fas: rankFillins(m, team, basis, S, exclude), S, k: 4, exclude });
  const w = seasonWindows(m);
  const calc = r => ({
    week: projectDays(m, r, w.week, basis, false, tw).total,
    ros: projectDays(m, r, w.ros, basis, false, tw).total,
    po: projectDays(m, r, w.po, basis, false, tw).total,
  });
  const b = calc(before);
  // Value of the free-agent pickup on its own, per window (not credited to the trade).
  let fa = { week: 0, ros: 0, po: 0 };
  if (adds.length) {
    const alone = calc(applyTrade(before, [], adds, basis).after);
    fa = { week: Math.max(0, alone.week - b.week), ros: Math.max(0, alone.ros - b.ros), po: Math.max(0, alone.po - b.po) };
  }
  return { before: b, after: calc(after), drops, adds, fa, roster: after };
}

// League-wide form: rostered players on other teams playing below their norm (buy low),
// and your players playing above it (sell high).
export function buySell(m, teamId, basis) {
  const form = p => {
    const s = p.stats;
    if (!s.season || !s.l15 || s.season.gp < 10 || s.l15.gp < 5) return null;
    return s.l15.avg - s.season.avg;
  };
  const rows = m.teams.flatMap(t => t.roster.map(p => ({ p, owner: t, d: form(p), v: value(p, basis) }))).filter(x => x.d != null);
  return {
    buy: rows.filter(x => x.owner.id !== teamId && x.d < -2 && x.p.stats.season.avg >= 20 && !banned(m).has(x.p.id)).sort((a, b) => a.d - b.d).slice(0, 8),
    sell: rows.filter(x => x.owner.id === teamId && x.d > 2).sort((a, b) => b.d - a.d).slice(0, 6),
  };
}

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const phi = z => 0.5 * (1 + erf(z / Math.SQRT2));

// Days of a matchup that still count toward a projection.
export function daysLeft(m, period) {
  const all = m.periods[period] || [];
  if (period < m.currentPeriod) return [];
  return period === m.currentPeriod ? all.filter(sp => sp >= m.currentSP) : all;
}

// Projected final score for any matchup: points already scored + best-lineup projection
// for the days left, using each team's current roster.
export function projectMatchup(m, period, home, away, basis, homePts = 0, awayPts = 0) {
  const days = daysLeft(m, period);
  const h = projectDays(m, home.roster, days, basis);
  const a = away ? projectDays(m, away.roster, days, basis) : { total: 0, games: 0 };
  const hp = homePts + h.total, ap = awayPts + a.total;
  // Uncertainty: ~12.5 FP per player-game of noise, plus ~6% for lineup/minutes changes.
  const sd = Math.sqrt((h.games + a.games) * 160 + (0.06 * (h.total + a.total)) ** 2) + 5;
  const winProb = days.length ? phi((hp - ap) / sd) : (hp > ap ? 1 : hp < ap ? 0 : 0.5);
  return { homeProj: hp, awayProj: ap, homeGames: h.games, awayGames: a.games, winProb, final: !days.length, homeDays: h.days, awayDays: a.days || [] };
}

// Every matchup in a period, with live score and projection.
export function scoreboard(m, period, basis) {
  const team = id => m.teams.find(t => t.id === id);
  return m.matchups.filter(x => x.period === period && x.home).map(x => {
    const home = team(x.home.teamId), away = x.away && team(x.away.teamId);
    return { period, home, away, homePts: x.home.pts, awayPts: x.away?.pts ?? 0, winner: x.winner,
      ...projectMatchup(m, period, home, away, basis, x.home.pts, x.away?.pts ?? 0) };
  });
}

// A team's focus matchups, projected: win chance against each opponent, or just its own
// projected points for a playoff round with no opponent yet. `rosters` (team id → roster)
// swaps in rosters, say after a trade, for either side. Scores already in count.
export function focusOdds(m, teamId, basis, rosters = {}) {
  const fp = focusPeriods(m, teamId);
  if (!fp) return [];
  const team = id => { const t = m.teams.find(x => x.id === id); return t && rosters[id] ? { ...t, roster: rosters[id] } : t; };
  const me = team(teamId);
  return fp.map(id => {
    const g = m.matchups.find(x => x.period === id && hasTeam(x, teamId) && realGame(x));
    if (!g) return { period: id, opp: null, myProj: projectDays(m, me.roster, daysLeft(m, id), basis).total, winProb: null };
    const home = g.home.teamId === teamId;
    const mine = home ? g.home : g.away, theirs = home ? g.away : g.home;
    const opp = team(theirs.teamId);
    const pr = projectMatchup(m, id, me, opp, basis, mine.pts || 0, theirs.pts || 0);
    return { period: id, opp, myProj: pr.homeProj, oppProj: pr.awayProj, winProb: pr.winProb };
  });
}

// One team's full schedule from its point of view: results, live week, projections.
export function teamSchedule(m, teamId, basis) {
  const team = id => m.teams.find(t => t.id === id);
  const me = team(teamId);
  return m.matchups
    .filter(x => x.home?.teamId === teamId || x.away?.teamId === teamId)
    .sort((a, b) => a.period - b.period)
    .map(x => {
      const home = x.home?.teamId === teamId;
      const mine = home ? x.home : x.away, theirs = home ? x.away : x.home;
      const opp = theirs && team(theirs.teamId);
      const myPts = mine?.pts ?? 0, oppPts = theirs?.pts ?? 0;
      const pr = projectMatchup(m, x.period, me, opp, basis, myPts, oppPts);
      const won = x.winner === 'UNDECIDED' || !x.winner ? null : (x.winner === (home ? 'HOME' : 'AWAY'));
      return { period: x.period, opp, myPts, oppPts, myProj: pr.homeProj, oppProj: pr.awayProj,
        myGames: pr.homeGames, oppGames: pr.awayGames,
        winProb: opp ? pr.winProb : null, done: x.period < m.currentPeriod, won, tie: x.winner === 'TIE' };
    });
}

export function analyze(m, basis = 'smart') {
  const team = id => m.teams.find(t => t.id === id);
  const my = team(m.myTeamId) || m.teams[0];
  const rem = remainingSps(m);
  const base = projectDays(m, my.roster, rem, basis);
  // A week that doesn't count for you (bye, out of the playoffs, playoffs switched off):
  // no lineup advice, streaming or this-week gains.
  const tw = dayWeights(m, my.id, basis);
  const off = periodWeight(m, my.id, m.currentPeriod, basis, false) === 0 ? offReason(m, m.currentPeriod) : null;
  // Not one of your focus matchups: lineup advice stays (it's free), but streams and
  // this-week gains go, since the week doesn't count.
  const skip = !off && (tw.period.get(m.currentPeriod) ?? 1) === 0 ? offReason(m, m.currentPeriod, my.id, basis) : null;
  const quiet = off || skip;

  // ---- Matchup
  let matchup = null;
  const mu = m.matchups.find(x => x.period === m.currentPeriod && (x.home?.teamId === my.id || x.away?.teamId === my.id));
  if (mu) {
    const mine = mu.home?.teamId === my.id ? mu.home : mu.away;
    const theirs = mine === mu.home ? mu.away : mu.home;
    const opp = theirs && team(theirs.teamId);
    if (opp) {
      const pr = projectMatchup(m, m.currentPeriod, my, opp, basis, mine.pts, theirs.pts);
      matchup = {
        opp, myPts: mine.pts, oppPts: theirs.pts, myProj: pr.homeProj, oppProj: pr.awayProj,
        myGames: pr.homeGames, oppGames: pr.awayGames, winProb: pr.winProb,
        myDays: pr.homeDays, oppDays: pr.awayDays,
      };
    } else matchup = { bye: true };
  }

  // ---- Waivers
  const pool = my.roster.filter(p => p.slot !== 13);
  const drop = pool.slice().sort((a, b) => value(a, basis) - value(b, basis))[0] || null;
  const dropV = drop ? value(drop, basis) : 0;
  const po = playoffPeriods(m).flatMap(id => m.periods[id] || []);
  const poW = sp => tw.sp.get(sp) ?? 1;
  const nextCounts = (tw.period.get(m.currentPeriod + 1) ?? 1) > 0;
  const without = my.roster.filter(p => p !== drop);
  const waivers = m.freeAgents.map(p => {
    const v = value(p, basis);
    const gl = gamesIn(m, p, rem);
    let score = v * (1 + 0.06 * (gl - 3));
    if (isOut(p) && (p.outForSeason || !p.returnSP)) score *= 0.4; else if (isDTD(p)) score *= 0.9;
    const weekGain = drop && !quiet ? projectDays(m, [...without, p], rem, basis).total - base.total : 0;
    const s = p.stats;
    return {
      p, v, gl, score, weekGain,
      rosGain: v - dropV,
      // Playoff games that count for you (a likely first-round bye counts for little).
      poGames: Math.round(po.reduce((a, sp) => a + (gameLeft(m, p, sp) && availableOn(m, p, sp) ? poW(sp) : 0), 0)),
      nextG: nextCounts ? gamesIn(m, p, m.periods[m.currentPeriod + 1] || []) : 0,
      trend: s.l15 && s.season && s.season.gp >= 8 ? s.l15.avg - s.season.avg : null,
      rosFP: null,
    };
  });
  // Rest-of-season value of each top free agent if swapped in for the drop candidate.
  if (drop) {
    const ctx = seasonContext(m, basis, 36);
    const rosBase = ctx.S(my.roster, my);
    for (const w of waivers.slice().sort((a, b) => b.v - a.v).slice(0, 80)) w.rosFP = ctx.S([...without, w.p], my) - rosBase;
  }

  // ---- Notes
  const notes = [];
  const note = (type, tag, title, detail = '') => notes.push({ type, tag, title, detail });
  if (off) note('info', 'Matchup', off.title, off.detail);
  else if (matchup && !matchup.bye) {
    const diff = matchup.myProj - matchup.oppProj;
    const wp = Math.min(99, Math.max(1, Math.round(matchup.winProb * 100)));
    if (diff >= 0) note('good', 'Matchup', `On pace to win by ${Math.round(diff)}`, `${wp}% win chance. ${matchup.myGames} games left for you, ${matchup.oppGames} for ${matchup.opp.name}.`);
    else note('bad', 'Matchup', `On pace to lose by ${Math.round(-diff)}`, `${wp}% win chance.${skip ? '' : ' You need volume: stream players who play on your open days.'}`);
  } else if (matchup?.bye) note('info', 'Matchup', 'Bye week', 'No matchup this period.');
  if (skip) {
    const nextF = focusPeriods(m, my.id)[0];
    const g = m.matchups.find(x => x.period === nextF && hasTeam(x, my.id) && realGame(x));
    const vs = g && team(g.home.teamId === my.id ? g.away.teamId : g.home.teamId);
    note('info', 'Focus', 'Not one of your focus matchups',
      `This week counts for nothing, so no streams. Next focus matchup: ${nextF > m.regularPeriods ? `playoff round ${playoffPeriods(m).indexOf(nextF) + 1}` : `week ${nextF}`}${vs ? ` vs ${vs.name}` : ''} (${periodRange(m, nextF)}). Set your lineup anyway: it's free.`);
  }

  const lc = off ? null : lineupCheck(m, my, basis);
  if (lc && lc.gain >= 1 && lc.start.length) {
    note('bad', 'Today', `Set your lineup: +${Math.round(lc.gain)} pts today`,
      [`Start ${lc.start.map(p => p.name).join(', ')}${lc.intoOpen ? (lc.sit.length ? '' : ' (open slots, no one needs to sit)') : ''}`,
        lc.sit.length ? `bench ${lc.sit.map(p => `${p.name} (${lc.why(p)})`).join(', ')}` : ''].filter(Boolean).join('; ') + '.');
  }
  // An injured starter only costs you if someone healthy could take the slot, which is
  // exactly what lineupCheck decides; warn separately only when it can't run.
  if (!lc && !off) for (const p of my.roster) {
    if (!availableOn(m, p, m.currentSP) && p.slot != null && p.slot < 12) note('bad', 'Lineup', `${p.name} is out and starting`, `${returnLabel(p)}. Swap in a healthy bench player before lock.`);
  }
  const openSp = openSpots(m, my.roster);
  if (openSp) {
    const next = fillStart(m);
    const fills = next ? openSpotFills(m, my.roster, [next], basis) : [];
    const noAdds = m.acqLimit > 0 && (my.acq?.[m.currentPeriod] || 0) >= m.acqLimit;
    note(noAdds ? 'info' : 'warn', 'Roster', `${openSp} open roster spot${openSp > 1 ? 's' : ''}`,
      (noAdds ? 'No adds left this week. ' : 'Free points: add someone. ') + (fills.length ? `From next week, projections assume you pick up ${fills.map(p => p.name).join(', ')} (best free agent${fills.length > 1 ? 's' : ''}).` : ''));
  }
  const irSlots = m.slotCounts?.[13] || 0;
  const inIR = my.roster.filter(p => p.slot === 13);
  for (const p of inIR) {
    if (availableOn(m, p, m.currentSP)) note('warn', 'IR', `${p.name} is healthy on IR`, 'ESPN locks adds and drops until you activate or drop them.');
  }
  if (inIR.length < irSlots) {
    const benchOut = my.roster.filter(p => p.slot === 12 && isOut(p));
    if (benchOut.length) note('info', 'IR', 'Open IR slot', `Move ${benchOut.map(p => p.name).join(', ')} to IR and use the spot for a streamer.`);
  }
  const open = quiet ? [] : base.days.filter(d => d.open > 0);
  const openTotal = open.reduce((a, d) => a + d.open, 0);
  if (openTotal) {
    note('warn', 'Lineup', `${openTotal} empty slot${openTotal > 1 ? 's' : ''} left this week`,
      open.map(d => `${fmtDow(spDate(m, d.sp))} ${d.open}`).join(', ') + '. Each one is free points for a streamer.');
  }
  const benched = quiet ? 0 : base.days.reduce((a, d) => a + d.benched, 0);
  if (benched >= 3) note('info', 'Lineup', `${benched} games stuck on your bench`, 'Too many players on the same nights. Trade volume for someone who plays your light days.');

  const hot = [], cold = [];
  for (const p of my.roster) {
    const s = p.stats;
    if (!s.season || !s.l15 || s.season.gp < 10 || s.l15.gp < 5 || s.season.avg < 10) continue;
    const r = s.l15.avg / s.season.avg;
    if (r >= 1.2) hot.push(`${p.name} +${(s.l15.avg - s.season.avg).toFixed(1)}`);
    if (r <= 0.8) cold.push(`${p.name} ${(s.l15.avg - s.season.avg).toFixed(1)}`);
  }
  if (hot.length) note('good', 'Form', 'Heating up', hot.slice(0, 4).join(', ') + ' (last 15 vs season).');
  if (cold.length) note('warn', 'Form', 'Cooling off', cold.slice(0, 4).join(', ') + '. Check minutes before benching.');

  // Usage shifts on your roster over the next week (teammates out or returning).
  if (adjustments.usage) {
    const next = Array.from({ length: 7 }, (_, i) => m.currentSP + i);
    const shifts = my.roster.map(p => {
      const sp = next.find(d => gameLeft(m, p, d) && availableOn(m, p, d));
      return sp ? { p, ...usageReasons(m, p, sp, basis) } : null;
    }).filter(x => x && Math.abs(x.factor - 1) >= 0.06).sort((a, b) => Math.abs(b.factor - 1) - Math.abs(a.factor - 1));
    const up = shifts.filter(x => x.factor > 1), down = shifts.filter(x => x.factor < 1);
    const why = x => (x.factor > 1 ? x.out : x.back).slice(0, 2).map(q => q.name.split(' ').slice(-1)[0]).join(' & ');
    if (up.length) note('good', 'Usage', 'Usage bump from teammate injuries',
      up.slice(0, 3).map(x => `${x.p.name} +${Math.round((x.factor - 1) * 100)}%${why(x) ? ` (${why(x)} out)` : ''}`).join(', ') + '. Already in your projections.');
    if (down.length) note('warn', 'Usage', 'Usage dip: teammates returning',
      down.slice(0, 3).map(x => `${x.p.name} ${Math.round((x.factor - 1) * 100)}%${why(x) ? ` (${why(x)} back)` : ''}`).join(', ') + '.');
  }

  const plan = quiet ? [] : streamPlan(m, my, basis, addsLeft(m, my));
  if (plan.length) {
    const total = plan.reduce((a, x) => a + x.gain, 0);
    note('good', 'Stream', `Streaming plan: +${Math.round(total)} pts this week`,
      plan.map(x => `add ${x.add.name} for ${x.drop.name}`).join(', then ') + '. Details on the Waivers tab.');
  }
  if (drop) {
    const bestRos = waivers.filter(w => !isOut(w.p)).sort((a, b) => b.v - a.v)[0];
    if (bestRos && bestRos.rosGain >= 2) note('good', 'Waiver', `${bestRos.p.name} over ${drop.name}`, `${bestRos.v.toFixed(1)} vs ${dropV.toFixed(1)} proj/G rest of season.`);
  }
  if (m.acqLimit > 0) {
    const used = my.acq?.[m.currentPeriod] || 0;
    note(used >= m.acqLimit ? 'bad' : 'info', 'Moves', `${Math.max(0, m.acqLimit - used)} of ${m.acqLimit} adds left`, used >= m.acqLimit ? 'Maxed out. Set your best lineup each day.' : 'Resets with the next matchup.');
  }
  if (!notes.length) note('good', 'Lineup', 'Clean lineup', 'No injured starters and no open slots.');

  return { my, rem, base, matchup, waivers, drop, dropV, feedback: notes, lineup: lc, plan, off, skip };
}

// ---- Season-long evaluation: team needs, trade ideas, targets, power rankings

// Remaining regular-season days plus the fantasy playoffs (when counted): what a trade
// is judged on. Each team then weights these days by dayWeights (byes count 0).
export function futureDays(m) {
  const w = seasonWindows(m);
  return [...w.ros, ...w.po.filter(sp => sp >= m.currentSP)];
}

// Shared sampled window + scorer so every trade is compared on identical days.
// S(roster, team): projected points over the days that count for that team.
export function seasonContext(m, basis, max = 48) {
  const all = futureDays(m);
  const fp = focus.team != null ? focusPeriods(m, focus.team) : null;
  if (!fp) {
    const { days, scale } = sampleDays(all, max);
    return { days, scale, S: (roster, team) => projectDays(m, roster, days, basis, false, team ? dayWeights(m, team.id, basis).sp : null).total * scale };
  }
  // With focus matchups, the focused team's season is just those weeks, and sampling one
  // day in four of them is far too noisy. That team gets its own sample: every focus day
  // (or a dense sample if there are many). Everyone else keeps the usual one.
  const keep = new Set(fp.flatMap(id => m.periods[id] || []));
  const f = sampleDays(all.filter(sp => keep.has(sp)), Math.max(max, 60));
  const r = sampleDays(all, max);
  return {
    days: f.days, scale: f.scale,
    S: (roster, team) => (team?.id === focus.team
      ? projectDays(m, roster, f.days, basis, false, dayWeights(m, team.id, basis).sp).total * f.scale
      : projectDays(m, roster, r.days, basis, false, team ? dayWeights(m, team.id, basis).sp : null).total * r.scale),
  };
}
// Same on every remaining day (exact re-checks).
export function exactScorer(m, basis) {
  const days = futureDays(m);
  return (roster, team) => projectDays(m, roster, days, basis, false, team ? dayWeights(m, team.id, basis).sp : null).total;
}

const SLOT_GROUP = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 7: 'SG/SF', 8: 'G/F', 9: 'PF/C', 10: 'F/C', 11: 'UTIL' };

// How well each team fills each starting slot over the rest of the season (points per
// slot per day), against the league average for that slot. Also flags each team's
// "trade chips": useful players who often sit because the lineup is full.
export function teamNeeds(m, basis) {
  const { days } = sampleDays(futureDays(m), 40);
  const slots = startingSlots(m);
  const count = {};
  for (const s of slots) count[s] = (count[s] || 0) + 1;
  const ids = Object.keys(count).map(Number).sort((a, b) => (SLOT_RANK[a] ?? 3) - (SLOT_RANK[b] ?? 3) || a - b);
  const byTeam = {};
  for (const t of m.teams) {
    const r = projectDays(m, t.roster, days, basis, true);
    const n = Math.max(1, days.length);
    const perSlot = Object.fromEntries(ids.map(id => [id, (r.slotPts[id] || 0) / n / count[id]]));
    const chips = [...r.players.entries()]
      .filter(([p, x]) => x.avail >= 6 && x.g / x.avail < 0.7 && value(p, basis) >= 15)
      .map(([p, x]) => ({ p, startRate: x.g / x.avail }))
      .sort((a, b) => value(b.p, basis) - value(a.p, basis));
    const dead = [...r.players.entries()].filter(([p, x]) => x.g === 0 && (x.out > 0 || x.avail > 0)).map(([p]) => p);
    byTeam[t.id] = { perSlot, perDay: r.total / n, chips, dead, players: r.players };
  }
  const league = Object.fromEntries(ids.map(id => [id, m.teams.reduce((a, t) => a + byTeam[t.id].perSlot[id], 0) / Math.max(1, m.teams.length)]));
  for (const t of m.teams) {
    const b = byTeam[t.id];
    b.diff = Object.fromEntries(ids.map(id => [id, b.perSlot[id] - league[id]]));
    b.weak = ids.filter(id => b.diff[id] < -0.12 * league[id]).sort((a, c) => b.diff[a] - b.diff[c]);
    b.strong = ids.filter(id => b.diff[id] > 0.12 * league[id]).sort((a, c) => b.diff[c] - b.diff[a]);
  }
  return { ids, label: id => SLOT_GROUP[id] || String(id), count, league, byTeam, days: days.length };
}

// Trade ideas with one other team: 1-for-1 swaps of similar value, 2-for-1
// consolidations (two of yours for one better player) and 1-for-2 depth deals. Each is
// scored on rest-of-season + playoff projections for BOTH rosters, so suggestions fix a
// real lineup need for you without obviously hurting them.
export const DEAL_TYPES = ['1for1', '2for1', '1for2', '2for2'];
export function tradeIdeasWith(m, my, other, basis, ctx, myBase, types = DEAL_TYPES, locked = new Set()) {
  const v = p => value(p, basis);
  const theirBase = ctx.S(other.roster, other);
  const pieces = t => t.roster.filter(p => !p.outForSeason && v(p) >= 8).sort((a, b) => v(b) - v(a)).slice(0, 11);
  const mine = pieces(my).filter(p => !locked.has(p.id)), theirs = pieces(other).filter(p => !banned(m).has(p.id));
  const sum = ps => ps.reduce((a, p) => a + v(p), 0);
  // "On paper" = trade value (name + form, see marketParts). In uneven deals the side
  // that ends up a player short is credited with the best free agent it can add, plus a
  // mild star premium (one 45 FP/G player still edges a 30 + 15: lineup spots are limited).
  const paper = ps => ps.reduce((a, p) => a + Math.max(0, marketValue(m, p, basis)) ** 1.2, 0);
  const fillOf = ctx.fillOf || (ctx.fillOf = makeFills(m, my, basis, ctx.S, false));
  const faMemo = ctx.faMemo || (ctx.faMemo = new Map());
  const out = [];
  const consider = (give, get) => {
    const a = applyTrade(my.roster, give, get, basis, fillOf(my));
    // Screening on sampled days is loose on purpose; refineIdeas re-checks exactly.
    const myGain = ctx.S(a.after, my) - myBase - faAloneMemo(faMemo, my, a.adds, basis, ctx.S, myBase);
    if (myGain < 0) return;
    const z = applyTrade(other.roster, get, give, basis, fillOf(other));
    const theirGain = ctx.S(z.after, other) - theirBase - faAloneMemo(faMemo, other, z.adds, basis, ctx.S, theirBase);
    const giveV = sum(give), getV = sum(get);
    const paperGive = paper([...give, ...z.adds]), paperGet = paper([...get, ...a.adds]);
    // Same acceptance rule as the exact pass, with slack for sampling noise.
    const slack = 60 + 0.15 * Math.abs(myGain);
    const rated = rateIdea(myGain + slack, theirGain + slack, paperGive * 1.03, paperGet);
    if (!rated) return;
    const mkt = ps => ps.reduce((a2, p) => a2 + marketValue(m, p, basis), 0);
    // Trade value each side receives, counting any free-agent fill-in.
    out.push({ partner: other, give, get, type: `${give.length}for${get.length}`, myGain, theirGain, giveV, getV, paperGive, paperGet,
      mktGive: mkt([...give, ...z.adds]), mktGet: mkt([...get, ...a.adds]),
      drops: a.drops, theirDrops: z.drops, adds: a.adds, theirAdds: z.adds, score: rated.score });
  };
  if (types.includes('1for1')) for (const a of mine) for (const b of theirs) {
    const r = v(b) / Math.max(1, v(a));
    if (r >= 0.75 && r <= 1.35) consider([a], [b]);
  }
  const mine9 = mine.slice(0, 9);
  if (types.includes('2for1')) for (let i = 0; i < mine9.length; i++) for (let j = i + 1; j < mine9.length; j++) {
    const two = v(mine9[i]) + v(mine9[j]);
    for (const b of theirs.slice(0, 6)) {
      // 2-for-1: the single player is better than either, worth 60–90% of the pair.
      if (v(b) <= Math.max(v(mine9[i]), v(mine9[j])) || v(b) > 0.9 * two || v(b) < 0.6 * two) continue;
      consider([mine9[i], mine9[j]], [b]);
    }
  }
  const theirs9 = theirs.slice(0, 9);
  if (types.includes('1for2')) for (const a of mine.slice(0, 6)) for (let i = 0; i < theirs9.length; i++) for (let j = i + 1; j < theirs9.length; j++) {
    const two = v(theirs9[i]) + v(theirs9[j]);
    if (v(a) <= Math.max(v(theirs9[i]), v(theirs9[j])) || v(a) > 0.9 * two || v(a) < 0.6 * two) continue;
    consider([a], [theirs9[i], theirs9[j]]);
  }
  if (types.includes('2for2')) {
    // 2-for-2: swap two of your top players for two of theirs with similar total value.
    const pairs = list => list.slice(0, 5).flatMap((a, i, l) => l.slice(i + 1).map(b => [a, b]));
    for (const g of pairs(mine)) for (const t of pairs(theirs)) {
      const r = sum(t) / Math.max(1, sum(g));
      if (r >= 0.85 && r <= 1.18) consider(g, t);
    }
  }
  // Best few of each deal type, so one shape (2-for-2 has the most combinations)
  // can't crowd out the others.
  return DEAL_TYPES.flatMap(t => keepBest(out.filter(x => x.type === t), 5));
}

// Best ideas for one partner: no duplicate deals, and at most two ideas that bring
// back the same incoming players (so one target doesn't crowd out the rest).
export function keepBest(ideas, n = 12) {
  const kept = [], seen = new Set(), perGet = {};
  for (const x of ideas.slice().sort((a, b) => b.score - a.score)) {
    const getKey = x.get.map(p => p.id).sort().join(',');
    const key = `${x.give.map(p => p.id).sort().join(',')}>${getKey}`;
    if (seen.has(key) || (perGet[getKey] || 0) >= 2) continue;
    seen.add(key);
    perGet[getKey] = (perGet[getKey] || 0) + 1;
    kept.push(x);
    if (kept.length >= n) break;
  }
  return kept;
}

// Would they plausibly say yes? "On paper" is trade value (name + form, counting the
// free agent a short-handed side picks up, with a mild star premium). Nobody accepts a
// deal that looks lopsided on names, even if it would help their lineup, so:
//  win-win: it helps them too, and they get at least ~90% of the trade value back.
//  fair:    they get at least ~as much trade value and lose little in fit.
//  ask:     close in trade value but costs them more; still worth proposing.
// Ranked by your gain, nudged up when it helps them (easier yes) and down when it
// costs them (harder sell).
export const IDEA_KINDS = { 'win-win': 'Win-win', fair: 'Fair on paper', ask: 'Worth asking' };
function rateIdea(myGain, theirGain, giveV, getV) {
  if (myGain < 8) return null;
  if (theirGain >= 0 && giveV >= getV * 0.9) return { kind: 'win-win', score: myGain + 0.6 * Math.min(theirGain, myGain) };
  if (giveV >= getV * 0.95 && theirGain >= -0.6 * myGain) return { kind: 'fair', score: myGain + 1.2 * theirGain };
  if (giveV >= getV * 0.88 && theirGain >= -1.0 * myGain) return { kind: 'ask', score: myGain + 1.5 * theirGain };
  return null;
}
// Rate a scored deal (from dealEvaluator) the way trade ideas are: null if it doesn't qualify.
export const rateDeal = d => rateIdea(d.myGain, d.theirGain, d.paperGive, d.paperGet);

// Re-score screened ideas on every remaining day (no sampling), so the numbers match
// the trade analyzer exactly. Returns a function that refines one idea (or null if it
// no longer holds up), so callers can work through a long list in small steps.
// Scores one deal for both teams: projected points gained (net of any free agent a
// short-handed side picks up), and what each side gets on paper (trade value with a mild
// star premium) and in plain trade value. `S` scores a roster; with exact = true a free
// agent fill-in is picked for lineup fit (otherwise the top Proj/G one, for screening).
export function dealEvaluator(m, my, basis, S, exact = false) {
  const base = new Map();
  const baseOf = t => { if (!base.has(t.id)) base.set(t.id, S(t.roster, t)); return base.get(t.id); };
  const fillOf = makeFills(m, my, basis, S, exact);
  const paper = ps => ps.reduce((a, p) => a + Math.max(0, marketValue(m, p, basis)) ** 1.2, 0);
  const mkt = ps => ps.reduce((a, p) => a + marketValue(m, p, basis), 0);
  const sum = ps => ps.reduce((a, p) => a + value(p, basis), 0);
  const faMemo = new Map();
  return (give, get, partner) => {
    const a = applyTrade(my.roster, give, get, basis, fillOf(my));
    const z = applyTrade(partner.roster, get, give, basis, fillOf(partner));
    return {
      partner, give, get, type: `${give.length}for${get.length}`,
      myGain: S(a.after, my) - baseOf(my) - faAloneMemo(faMemo, my, a.adds, basis, S, baseOf(my)),
      theirGain: S(z.after, partner) - baseOf(partner) - faAloneMemo(faMemo, partner, z.adds, basis, S, baseOf(partner)),
      giveV: sum(give), getV: sum(get),
      paperGive: paper([...give, ...z.adds]), paperGet: paper([...get, ...a.adds]),
      mktGive: mkt([...give, ...z.adds]), mktGet: mkt([...get, ...a.adds]),
      drops: a.drops, theirDrops: z.drops, adds: a.adds, theirAdds: z.adds,
    };
  };
}

export function makeRefiner(m, my, basis) {
  const evalDeal = dealEvaluator(m, my, basis, exactScorer(m, basis), true);
  return x => {
    const d = evalDeal(x.give, x.get, x.partner);
    const rated = rateIdea(d.myGain, d.theirGain, d.paperGive, d.paperGet);
    return rated ? { ...x, ...d, ...rated } : null;
  };
}

// ---- Trade finder
// Would the other manager plausibly accept, judged on trade value (name + form)?
export function acceptance(d) {
  const r = d.paperGive / Math.max(1e-9, d.paperGet);
  return r >= 0.97 ? 'likely' : r >= 0.88 ? 'possible' : null;
}

// Candidate deals for one finder search. Your side never includes locked players.
//  get:  a specific player on another team, for one or two of yours, optionally with one
//        of their other players added to balance it.
//  away: one of your players, for one or two of theirs, from every team, optionally with
//        one of your lesser players added.
//  need: the best players at a position on other teams, for one or two of yours.
export function finderCandidates(m, my, basis, mode, arg, locked = new Set()) {
  const v = p => value(p, basis), mv = p => marketValue(m, p, basis);
  const usable = p => !p.outForSeason && v(p) >= 5;
  const wanted = p => usable(p) && !banned(m).has(p.id); // players you'd receive
  const mine = my.roster.filter(p => usable(p) && !locked.has(p.id)).sort((a, b) => mv(b) - mv(a));
  const pairs = list => list.flatMap((a, i) => list.slice(i + 1).map(b => [a, b]));
  const mk = ps => ps.reduce((a, p) => a + mv(p), 0);
  // Loose trade-value band; the exact pass (with free-agent fill-ins) decides.
  const near = (give, get) => { const r = mk(give) / Math.max(1, mk(get)); return r >= 0.75 && r <= 1.6; };
  const out = [];
  const add = (give, get, partner) => { if (near(give, get)) out.push({ give, get, partner }); };
  const gives = [...mine.map(p => [p]), ...pairs(mine.slice(0, 10))];
  if (mode === 'get') {
    const partner = m.teams.find(t => t.roster.some(p => p.id === arg));
    const target = partner?.roster.find(p => p.id === arg);
    if (!target || partner.id === my.id || banned(m).has(target.id)) return [];
    const fillers = partner.roster.filter(p => p !== target && wanted(p)).sort((a, b) => v(b) - v(a)).slice(0, 8);
    for (const g of gives) {
      add(g, [target], partner);
      for (const f of fillers) add(g, [target, f], partner);
    }
  } else if (mode === 'away') {
    const me = my.roster.find(p => p.id === arg);
    if (!me) return [];
    const sweeteners = mine.filter(p => p !== me && mv(p) < mv(me)).slice(0, 6);
    const myGives = [[me], ...sweeteners.map(f => [me, f])];
    for (const t of m.teams) {
      if (t.id === my.id) continue;
      const theirs = t.roster.filter(wanted).sort((a, b) => v(b) - v(a));
      const gets = [...theirs.slice(0, 10).map(p => [p]), ...pairs(theirs.slice(0, 7))];
      for (const g of myGives) for (const x of gets) add(g, x, t);
    }
  } else if (mode === 'team') {
    // Every 1-for-1, 2-for-1, 1-for-2 and 2-for-2 between your roster and one team's,
    // wider than the background scan (which skims every team).
    const t = m.teams.find(x => x.id === arg);
    if (!t || t.id === my.id) return [];
    const theirs = t.roster.filter(wanted).sort((a, b) => v(b) - v(a));
    const gets = [...theirs.map(p => [p]), ...pairs(theirs.slice(0, 10))];
    const myGives = [...mine.map(p => [p]), ...pairs(mine.slice(0, 10))];
    for (const g of myGives) for (const x of gets) add(g, x, t);
  } else if (mode === 'need') {
    const targets = m.teams.filter(t => t.id !== my.id)
      .flatMap(t => t.roster.filter(p => wanted(p) && (p.eligible || []).includes(arg)).map(p => ({ p, t })))
      .sort((a, b) => v(b.p) - v(a.p)).slice(0, 12);
    for (const { p, t } of targets) for (const g of [...mine.map(q => [q]), ...pairs(mine.slice(0, 8))]) add(g, [p], t);
  }
  return out;
}
export function refineIdeas(m, my, ideas, basis, top = 80) {
  const refine = makeRefiner(m, my, basis);
  return ideas.slice().sort((a, b) => b.score - a.score).slice(0, top).map(refine).filter(Boolean).sort((a, b) => b.score - a.score);
}

// Why a trade helps: which lineup slots get stronger and how many more starts you get.
export function tradeReason(m, my, idea, basis, ctx) {
  // Compare against the roster that already made the free-agent pickup on its own, so the
  // reason reflects the trade itself.
  const start = idea.adds?.length ? applyTrade(my.roster, [], idea.adds, basis).after : my.roster;
  const tw = dayWeights(m, my.id, basis).sp;
  const days = ctx.days.filter(sp => (tw.get(sp) ?? 1) > 0);
  const before = projectDays(m, start, days, basis, true);
  const after = projectDays(m, applyTrade(my.roster, idea.give, [...idea.get, ...(idea.adds || [])], basis).after, days, basis, true);
  const n = Math.max(1, days.length);
  const deltas = Object.keys({ ...before.slotPts, ...after.slotPts }).map(Number)
    .map(id => ({ id, d: ((after.slotPts[id] || 0) - (before.slotPts[id] || 0)) / n }))
    .sort((a, b) => b.d - a.d);
  return { starts: Math.round((after.games - before.games) * ctx.scale), best: deltas[0]?.d > 0.5 ? deltas[0] : null, label: id => SLOT_GROUP[id] };
}

// Players on other teams who would add the most to your lineup the rest of the way
// (after dropping your least useful player to make room).
export function tradeTargets(m, my, basis, ctx, myBase, limit = 10) {
  const v = p => value(p, basis);
  return m.teams.filter(t => t.id !== my.id)
    .flatMap(t => t.roster.filter(p => !p.outForSeason && !banned(m).has(p.id)).map(p => ({ p, owner: t })))
    .sort((a, b) => v(b.p) - v(a.p)).slice(0, 60)
    .map(x => ({ ...x, gain: ctx.S(applyTrade(my.roster, [], [x.p], basis).after, my) - myBase }))
    .filter(x => x.gain > 0)
    .sort((a, b) => b.gain - a.gain).slice(0, limit);
}

// Power rankings: projected strength from here on (per week), blended with results so far.
export function powerRankings(m, basis, needs) {
  const rows = m.teams.map(t => {
    const gp = t.wins + t.losses + t.ties;
    return { team: t, projWk: needs.byTeam[t.id].perDay * 7, pfWk: gp ? t.pf / gp : null, gp };
  });
  const avg = k => rows.reduce((a, r) => a + (r[k] ?? 0), 0) / Math.max(1, rows.filter(r => r[k] != null).length);
  const aProj = avg('projWk'), aPf = avg('pfWk') || aProj;
  for (const r of rows) {
    // Results matter more as the season goes on (up to 40% after ~8 matchups).
    const wRes = Math.min(0.4, r.gp * 0.05);
    r.power = (1 - wRes) * (r.projWk / aProj) + wRes * ((r.pfWk ?? aPf) / aPf);
  }
  return rows.sort((a, b) => b.power - a.power);
}

// Per-player projection for a team in a given matchup (games started, benched, out).
export function breakdown(m, team, period, basis) {
  const r = projectDays(m, team.roster, daysLeft(m, period), basis, true);
  return { total: r.total, games: r.games, rows: [...r.players.entries()].map(([p, x]) => ({ p, ...x })).sort((a, b) => b.pts - a.pts || b.avail - a.avail) };
}


// ---- Weekly slate (one matchup week, day by day)
// NBA games each night, your projected starts vs your opponent's, NBA teams grouped by
// games that week, and for every remaining day the free agent most worth adding that
// day (with the player to drop), plus two backups. `fas` = free agents you'd consider.
export function weeklySlate(m, my, period, basis, fas) {
  const days = m.periods[period] || [];
  const team = id => m.teams.find(t => t.id === id);
  const mu = m.matchups.find(x => x.period === period && (x.home?.teamId === my.id || x.away?.teamId === my.id));
  const opp = mu ? team(mu.home?.teamId === my.id ? mu.away?.teamId : mu.home?.teamId) : null;
  const left = daysLeft(m, period);
  const mineP = projectDays(m, my.roster, left, basis), theirsP = opp ? projectDays(m, opp.roster, left, basis) : null;
  const myDay = Object.fromEntries(mineP.days.map(d => [d.sp, d]));
  const oppDay = theirsP ? Object.fromEntries(theirsP.days.map(d => [d.sp, d])) : {};
  const nbaGames = sp => Object.values(m.proTeams).filter(t => t.games[sp]).length / 2;
  const teams = Object.entries(m.proTeams).map(([id, t]) => ({
    id: +id, abbrev: t.abbrev,
    games: days.filter(sp => t.games[sp]).length,
    b2b: days.filter(sp => t.games[sp] && t.games[sp - 1]).length,
  }));
  const groups = {};
  for (const t of teams) (groups[t.games] ||= []).push(t);

  // Best add for each remaining day: swap one of your three least useful players for a
  // free agent from that day to the end of the week.
  const drops = my.roster.filter(p => p.slot !== 13).sort((a, b) => value(a, basis) - value(b, basis)).slice(0, 3);
  const pool = fas.filter(p => !p.outForSeason && gamesIn(m, p, left) > 0)
    .sort((a, b) => value(b, basis) * gamesIn(m, b, left) - value(a, basis) * gamesIn(m, a, left)).slice(0, 40);
  const adds = {};
  const off = periodWeight(m, my.id, period, basis) === 0 ? offReason(m, period, my.id, basis) : null;
  for (const d of off ? [] : left) {
    const rest = left.filter(sp => sp >= d);
    const base = projectDays(m, my.roster, rest, basis).total;
    adds[d] = pool.filter(p => gameLeft(m, p, d) && availableOn(m, p, d)).map(fa => {
      let best = null;
      for (const drop of drops) {
        const gain = projectDays(m, [...my.roster.filter(p => p !== drop), fa], rest, basis).total - base;
        if (!best || gain > best.gain) best = { fa, drop, gain };
      }
      return { ...best, left: gamesIn(m, fa, rest), week: days.filter(sp => gameOn(m, fa, sp)).length, b2b: isB2B(m, fa, d) };
    }).filter(x => x.gain >= 3).sort((a, b) => b.gain - a.gain).slice(0, 3);
  }
  return {
    period, days, left, opp, off,
    myGames: mineP.games, oppGames: theirsP?.games ?? null,
    perDay: days.map(sp => ({ sp, nba: nbaGames(sp), past: sp < m.currentSP || !left.includes(sp), mine: myDay[sp], theirs: oppDay[sp], adds: adds[sp] || [] })),
    groups: Object.entries(groups).map(([g, ts]) => ({ games: +g, teams: ts.sort((a, b) => a.abbrev.localeCompare(b.abbrev)) })).sort((a, b) => b.games - a.games),
  };
}

// ---- Injury report with who benefits
// Every injured player that matters (rostered in this league, or 10%+ rostered on ESPN),
// their timeline, and the teammates who pick up usage while they're out (from the same
// teammate-usage model as projections). Free agents who benefit are pickup ideas.
function absenceShare(m, p, sp, basis) {
  const u = usageCtx(m, basis);
  const me = u.own.get(p.id);
  if (!me || !p.proTeamId) return 0;
  const d = teamDelta(m, u, p.proTeamId, sp);
  return Math.min(USAGE_CAP, USAGE_SHARE * me.v * me.base / Math.max(d.active, u.norm));
}
export function injuryReport(m, my, basis) {
  const owner = new Map();
  for (const t of m.teams) for (const p of t.roster) owner.set(p.id, t);
  const pool = new Map();
  for (const t of m.teams) for (const p of t.roster) pool.set(p.id, p);
  for (const p of m.poolFAs || m.freeAgents || []) if (!pool.has(p.id)) pool.set(p.id, p);
  const all = [...pool.values()];
  const rest = futureDays(m);
  const next14 = Array.from({ length: 14 }, (_, i) => m.currentSP + i);
  const rows = all.filter(p => (isOut(p) || isDTD(p)) && value(p, basis) >= 12 && (owner.has(p.id) || (p.owned ?? 0) >= 10)).map(p => {
    const missDay = next14.find(sp => gameOn(m, p, sp) && (!availableOn(m, p, sp) || isDTD(p)));
    const sched = rest.filter(sp => gameOn(m, p, sp)).length;
    const missed = rest.filter(sp => gameOn(m, p, sp) && !availableOn(m, p, sp)).length;
    const bump = missDay && isOut(p) ? absenceShare(m, p, missDay, basis) : 0;
    const beneficiaries = bump ? all.filter(q => q.id !== p.id && q.proTeamId === p.proTeamId && !isOut(q) && value(q, basis) >= 10)
      .sort((a, b) => value(b, basis) - value(a, basis)).slice(0, 4)
      .map(q => ({ q, owner: owner.get(q.id) || null, gain: value(q, basis) * bump })) : [];
    return { p, owner: owner.get(p.id) || null, missed, sched, bump, beneficiaries, mine: owner.get(p.id)?.id === my.id };
  });
  return rows.sort((a, b) => b.mine - a.mine || value(b.p, basis) - value(a.p, basis));
}

// ---- Matchups that matter
// Your remaining regular-season matchups ranked by how much a win moves your playoff
// odds, each with the free agent who'd add the most that week (who to stream for it).
export function matchupsThatMatter(m, my, basis, fas) {
  const odds = playoffOdds(m, basis, 3000, my.id);
  const pool = fas.filter(p => !p.outForSeason).sort((a, b) => value(b, basis) - value(a, basis)).slice(0, 40);
  const drops = my.roster.filter(p => p.slot !== 13).sort((a, b) => value(a, basis) - value(b, basis)).slice(0, 3);
  return odds.leverage.sort((a, b) => b.swing - a.swing).slice(0, 4).map(x => {
    const days = daysLeft(m, x.period);
    const base = projectDays(m, my.roster, days, basis).total;
    let stream = null;
    for (const fa of pool) for (const drop of drops) {
      const gain = projectDays(m, [...my.roster.filter(p => p !== drop), fa], days, basis).total - base;
      if (!stream || gain > stream.gain) stream = { fa, drop, gain, games: gamesIn(m, fa, days) };
    }
    return { ...x, stream: stream && stream.gain >= 5 ? stream : null };
  });
}

// ---- Risers & fallers
// In-season rank (by this season's average) vs preseason rank (ESPN rank / draft
// position), plus average vs ESPN's projection. Needs a few games played.
export function trends(m, basis) {
  const owner = new Map();
  for (const t of m.teams) for (const p of t.roster) owner.set(p.id, t);
  const pool = new Map();
  for (const t of m.teams) for (const p of t.roster) pool.set(p.id, p);
  for (const p of m.poolFAs || m.freeAgents || []) if (!pool.has(p.id)) pool.set(p.id, p);
  const played = [...pool.values()].filter(p => (p.stats?.season?.gp || 0) >= 5 && Number.isFinite(p.stats.season.avg))
    .sort((a, b) => b.stats.season.avg - a.stats.season.avg);
  return played.map((p, i) => {
    const pre = p.espnRank || (p.adp ? Math.round(p.adp) : null);
    return { p, owner: owner.get(p.id) || null, now: i + 1, pre, move: pre ? pre - (i + 1) : null,
      avg: p.stats.season.avg, vsProj: p.stats.proj ? p.stats.season.avg - p.stats.proj.avg : null };
  }).filter(r => r.pre);
}

// ---- Player power rankings
// Every player we know about (all rosters + top free agents), ranked several ways with
// the league's scoring. Recency modes need a few games in the window.
// Injuries: `rank` scores each window's FP/G × the share of the player's upcoming games
// they're expected to play: the next two weeks for recent form, the rest of the season
// for Overall and Rest of season. ESPN return dates decide when they're back,
// day-to-day counts 80% this matchup (as in projections), out with no return date is
// assumed out two weeks, out for season is zero. Total points is history, so it isn't
// adjusted. `rawRank` keeps the injury-blind order.
export const RANK_MODES = {
  season: 'Overall', l30: 'Last 30', l15: 'Last 15', l7: 'Last 7', ros: 'Rest of season', total: 'Total points',
};
export const RANK_HORIZON = { season: 'ros', l30: 'near', l15: 'near', l7: 'near', ros: 'ros', total: null };
const RANK_MIN_GP = { season: 3, l30: 3, l15: 2, l7: 1, total: 1, ros: 0 };
const NEAR_DAYS = 14;
export function playerRankings(m, basis) {
  const owner = new Map(), pool = new Map();
  for (const t of m.teams) for (const p of t.roster) { owner.set(p.id, t); pool.set(p.id, p); }
  for (const p of m.poolFAs || m.freeAgents || []) if (!pool.has(p.id)) pool.set(p.id, p);
  const players = [...pool.values()];
  const far = futureDays(m);
  const near = Array.from({ length: NEAR_DAYS }, (_, i) => m.currentSP + i);
  const healthy = { n: 0, s: 0, share: 1 };
  const health = p => {
    if (!isOut(p) && !isDTD(p)) return { near: healthy, ros: healthy, guess: false };
    const back = isOut(p) && !p.outForSeason && !p.returnSP ? m.currentSP + NEAR_DAYS : null;
    const plays = sp => (p.outForSeason ? 0 : back ? (sp >= back ? 1 : 0) : availableOn(m, p, sp) ? dtdFactor(m, p, sp) : 0);
    const share = days => {
      let n = 0, s = 0;
      for (const sp of days) if (gameOn(m, p, sp)) { n++; s += plays(sp); }
      return { n, s, share: n ? s / n : (isOut(p) ? 0 : 1) };
    };
    return { near: share(near), ros: share(far), guess: !!back };
  };
  const stat = (p, mode) => {
    const s = p.stats || {};
    if (mode === 'ros') return p.outForSeason ? null : { v: value(p, basis), gp: s.season?.gp || 0 };
    if (mode === 'total') return s.season ? { v: s.season.avg * s.season.gp, gp: s.season.gp } : null;
    return s[mode] && Number.isFinite(s[mode].avg) ? { v: s[mode].avg, gp: s[mode].gp || 0 } : null;
  };
  const rows = new Map(players.map(p => [p.id, {
    p, owner: owner.get(p.id) || null, health: health(p),
    vals: {}, score: {}, gp: {}, rank: {}, rawRank: {}, pos: {}, rawPos: {},
  }]));
  const place = (list, rankKey, posKey) => {
    const posCount = {};
    list.forEach(({ r, mode }, i) => {
      r[rankKey][mode] = i + 1;
      const pos = r.p.pos || r.p.eligible?.[0] || '';
      r[posKey][mode] = `${pos}${(posCount[pos] = (posCount[pos] || 0) + 1)}`;
    });
  };
  for (const mode of Object.keys(RANK_MODES)) {
    const hz = RANK_HORIZON[mode];
    const list = [];
    for (const p of players) {
      const x = stat(p, mode);
      if (!x || !Number.isFinite(x.v) || x.gp < RANK_MIN_GP[mode]) continue;
      const r = rows.get(p.id);
      r.vals[mode] = x.v; r.gp[mode] = x.gp;
      r.score[mode] = hz ? x.v * r.health[hz].share : x.v;
      list.push({ r, mode });
    }
    place(list.slice().sort((a, b) => b.r.vals[mode] - a.r.vals[mode]), 'rawRank', 'rawPos');
    place(list.sort((a, b) => b.r.score[mode] - a.r.score[mode] || b.r.vals[mode] - a.r.vals[mode]), 'rank', 'pos');
  }
  for (const r of rows.values()) r.pre = r.p.espnRank || (r.p.adp ? Math.round(r.p.adp) : null);
  return [...rows.values()];
}

// ---- Fun: superlatives, schedule luck, schedule swap, trade report card, waiver heroes
// Matchup stats use completed regular-season weeks. Trades are rebuilt from current
// rosters: players who arrived by trade at the same moment were one deal (a piece that
// was later dropped or flipped is missing). Points "since" are estimates: team games
// since then × how often the player has played × his average over that stretch.
const spOfTime = (m, t) => Math.floor((t - new Date(m.day1 + 'T00:00:00').getTime()) / 86400000) + 1;
export function pointsSince(m, p, sinceSP) {
  const games = m.proTeams[p.proTeamId]?.games || {};
  let all = 0, since = 0;
  for (let sp = 1; sp < m.currentSP; sp++) if (games[sp]) { all++; if (sp >= sinceSP) since++; }
  const s = p.stats || {};
  const rate = all ? Math.min(1, (s.season?.gp || 0) / all) : 0;
  const g = since * rate;
  const days = m.currentSP - sinceSP;
  const win = days <= 7 ? s.l7 : days <= 15 ? s.l15 : days <= 30 ? s.l30 : s.season;
  const avg = Number.isFinite(win?.avg) && win.gp ? win.avg : Number.isFinite(s.season?.avg) ? s.season.avg : 0;
  return { games: g, pts: g * avg, avg };
}
export function funStats(m, basis) {
  const team = id => m.teams.find(t => t.id === id);
  const ids = m.teams.map(t => t.id);
  const done = m.matchups.filter(x => x.period <= m.regularPeriods && x.home && x.away && x.winner && x.winner !== 'UNDECIDED');
  const weeks = [...new Set(done.map(x => x.period))].sort((a, b) => a - b).map(period => {
    const score = {}, opp = {};
    for (const x of done) if (x.period === period) {
      score[x.home.teamId] = x.home.pts; score[x.away.teamId] = x.away.pts;
      opp[x.home.teamId] = x.away.teamId; opp[x.away.teamId] = x.home.teamId;
    }
    return { period, score, opp, ids: Object.keys(score).map(Number) };
  });

  // Records, all-play (vs every team every week), luck, streaks.
  const rows = new Map(ids.map(id => [id, { team: team(id), w: 0, l: 0, t: 0, apW: 0, apL: 0, apT: 0, expW: 0, games: 0, pf: 0, pa: 0, top: 0, bottom: 0, results: [] }]));
  const games = [];
  for (const wk of weeks) {
    const sc = wk.ids.map(i => wk.score[i]);
    const hi = Math.max(...sc), lo = Math.min(...sc);
    for (const id of wk.ids) {
      const r = rows.get(id), s = wk.score[id], o = wk.opp[id], os = wk.score[o];
      const res = s > os ? 'W' : s < os ? 'L' : 'T';
      r.games++; r.pf += s; r.pa += os;
      r[res === 'W' ? 'w' : res === 'L' ? 'l' : 't']++;
      let bw = 0, bl = 0, bt = 0;
      for (const j of wk.ids) if (j !== id) { if (s > wk.score[j]) bw++; else if (s < wk.score[j]) bl++; else bt++; }
      r.apW += bw; r.apL += bl; r.apT += bt;
      r.expW += (bw + bt / 2) / Math.max(1, wk.ids.length - 1);
      if (s === hi) r.top++;
      if (s === lo) r.bottom++;
      r.results.push(res);
      games.push({ id, period: wk.period, s, os, opp: o, res, margin: s - os, beat: bw, field: wk.ids.length - 1 });
    }
  }
  const streak = (res, k) => { let best = 0, cur = 0; for (const x of res) { cur = x === k ? cur + 1 : 0; best = Math.max(best, cur); } return best; };
  for (const r of rows.values()) {
    r.luck = r.w + r.t / 2 - r.expW;
    r.winStreak = streak(r.results, 'W'); r.loseStreak = streak(r.results, 'L');
  }

  // Schedule luck, two ways: finished weeks only ("so far"), and the whole regular season
  // (finished weeks with real scores, this week live + projected, later weeks projected
  // with current rosters). In projected weeks a win is a probability, from the same
  // model as matchup win %.
  const season = [];
  for (let p = 1; p <= m.regularPeriods; p++) {
    const ms = m.matchups.filter(x => x.period === p && x.home && x.away);
    if (!ms.length) continue;
    const final = p < m.currentPeriod;
    const days = final ? [] : daysLeft(m, p);
    const wk = { period: p, final, score: {}, opp: {}, games: {}, rem: {} };
    for (const x of ms) for (const [me, them] of [[x.home, x.away], [x.away, x.home]]) {
      const id = me.teamId;
      wk.opp[id] = them.teamId;
      if (final || !team(id)) { wk.score[id] = me.pts || 0; wk.games[id] = 0; wk.rem[id] = 0; continue; }
      const pr = projectDays(m, team(id).roster, days, basis);
      wk.score[id] = (p === m.currentPeriod ? me.pts || 0 : 0) + pr.total;
      wk.games[id] = pr.games; wk.rem[id] = pr.total;
    }
    wk.ids = Object.keys(wk.score).map(Number);
    wk.wp = (x, y) => {
      const d = wk.score[x] - wk.score[y];
      if (wk.final) return d > 0 ? 1 : d < 0 ? 0 : 0.5;
      return phi(d / (Math.sqrt((wk.games[x] + wk.games[y]) * 160 + (0.06 * (wk.rem[x] + wk.rem[y])) ** 2) + 5));
    };
    season.push(wk);
  }
  const luckTable = list => {
    const out = new Map(ids.map(id => [id, { team: team(id), w: 0, l: 0, t: 0, games: 0, pf: 0, pa: 0, expW: 0, projected: 0 }]));
    for (const wk of list) for (const id of wk.ids) {
      const r = out.get(id), o = wk.opp[id], win = wk.wp(id, o);
      r.games++; r.w += win; r.l += 1 - win; r.pf += wk.score[id]; r.pa += wk.score[o];
      if (wk.final && win === 0.5) { r.t++; r.w -= 0.5; r.l -= 0.5; }
      if (!wk.final) r.projected++;
      let sum = 0;
      for (const j of wk.ids) if (j !== id) sum += wk.wp(id, j);
      r.expW += sum / Math.max(1, wk.ids.length - 1);
    }
    // Swap: team a against team b's opponents (when b played a, a plays b).
    const swap = {};
    for (const a of ids) {
      swap[a] = {};
      for (const b of ids) {
        let w = 0, g = 0;
        for (const wk of list) {
          if (wk.score[a] == null || wk.score[b] == null) continue;
          const o = wk.opp[b] === a ? b : wk.opp[b];
          if (wk.score[o] == null) continue;
          w += wk.wp(a, o); g++;
        }
        swap[a][b] = { w, l: g - w, g };
      }
    }
    for (const r of out.values()) {
      r.luck = r.w + r.t / 2 - r.expW;
      const recs = ids.map(b => ({ b, ...swap[r.team.id][b] })).filter(x => x.g);
      r.bestSched = recs.length ? recs.reduce((x, y) => (y.w > x.w ? y : x)) : null;
      r.worstSched = recs.length ? recs.reduce((x, y) => (y.w < x.w ? y : x)) : null;
    }
    return { rows: [...out.values()].filter(r => r.games), swap, weeks: list.length, projected: list.filter(w => !w.final).length };
  };
  const luck = { sofar: luckTable(season.filter(w => w.final)), season: luckTable(season) };

  // Trades rebuilt from rosters, graded like the trade analyzer, for each side:
  //  - rest of season: lineup-aware projection of its roster now vs with the trade undone
  //    (an uneven deal's open spot filled by the best free agent, extra bodies dropped);
  //  - so far: points the players it got have scored since, minus what it gave away
  //    scored, with each extra body charged at replacement level (best free agent).
  const worth = p => {
    const since = pointsSince(m, p, spOfTime(m, p.acqDate));
    return { p, since: since.pts, sinceG: since.games, v: value(p, basis) };
  };
  const owned = [];
  for (const t of m.teams) for (const p of t.roster) owned.push({ p, t });
  const arrivals = owned.filter(x => x.p.acqType === 'TRADE' && x.p.acqDate).sort((a, b) => a.p.acqDate - b.p.acqDate);
  const deals = [];
  for (const x of arrivals) {
    const last = deals[deals.length - 1];
    if (last && x.p.acqDate - last.at <= 5 * 60000) last.items.push(x); else deals.push({ at: x.p.acqDate, items: [x] });
  }
  const ex = exactScorer(m, basis), ctx = seasonContext(m, basis, 48);
  const rep = (m.poolFAs || m.freeAgents || []).filter(p => !isOut(p)).reduce((a, p) => Math.max(a, value(p, basis)), 0);
  const trades = deals.map(d => {
    const bySide = new Map();
    for (const { p, t } of d.items) (bySide.get(t.id) || bySide.set(t.id, { team: t, got: [] }).get(t.id)).got.push(worth(p));
    const sides = [...bySide.values()].map(s => ({ ...s, since: s.got.reduce((a, x) => a + x.since, 0) }));
    // One side only (the rest was dropped or flipped), or several trades processed at the
    // same moment: we can't tell who gave what, so no verdict.
    if (sides.length !== 2) return { at: d.at, sides, partial: true, margin: null, share: null };
    const grade = (me, them) => {
      const r = me.got.length, g = them.got.length;
      const fill = r > g ? { fas: rankFillins(m, me.team, basis, ctx.S), S: x => ex(x, me.team), k: 4 } : null;
      const undo = applyTrade(me.team.roster, me.got.map(x => x.p), them.got.map(x => x.p), basis, fill).after;
      const ros = ex(me.team.roster, me.team) - ex(undo, me.team);
      const games = [...me.got, ...them.got].reduce((a, x) => a + x.sinceG, 0) / (r + g);
      const sofar = me.since - them.since - (r - g) * rep * games;
      return { ros, sofar, net: ros + sofar };
    };
    const [a, b] = sides;
    const ga = grade(a, b), gb = grade(b, a);
    Object.assign(a, ga); Object.assign(b, gb);
    sides.sort((x, y) => y.net - x.net);
    const margin = sides[0].net - sides[1].net;
    const scale = sides.reduce((acc, s) => acc + Math.abs(s.ros) + s.since, 0) || 1;
    return { at: d.at, sides, partial: false, margin, share: margin / scale };
  }).sort((x, y) => (y.margin ?? -1) - (x.margin ?? -1));

  // Waiver wire heroes: rostered players picked up off waivers / free agency.
  const pickups = owned.filter(x => x.p.acqDate && x.p.acqType && x.p.acqType !== 'DRAFT' && x.p.acqType !== 'TRADE')
    .map(({ p, t }) => { const s = pointsSince(m, p, spOfTime(m, p.acqDate)); return { p, team: t, at: p.acqDate, pts: s.pts, games: s.games, avg: s.avg }; })
    .filter(x => x.games >= 1).sort((a, b) => b.pts - a.pts);

  // Fantasy MVP: most points so far by a rostered player.
  const mvp = owned.map(({ p, t }) => ({ p, team: t, pts: (p.stats?.season?.avg || 0) * (p.stats?.season?.gp || 0) })).sort((a, b) => b.pts - a.pts)[0] || null;
  // Infirmary: production sidelined right now.
  const hurt = m.teams.map(t => { const out = t.roster.filter(isOut); return { team: t, n: out.length, fp: out.reduce((a, p) => a + value(p, basis), 0) }; })
    .sort((a, b) => b.fp - a.fp);

  return { weeks: weeks.map(w => w.period), rows: [...rows.values()], luck, games, trades, pickups, mvp, hurt };
}
