// Points-league analysis: player value, lineup projections, coach's notes, waiver ranking, playoff schedule.

const OUT = new Set(['OUT', 'INJURY_RESERVE', 'SUSPENSION']);
export const isOut = p => OUT.has(p.injury);
export const isDTD = p => p.injury === 'DAY_TO_DAY' || p.injury === 'QUESTIONABLE';

export const BASIS = {
  smart: 'Smart blend',
  season: 'Season avg',
  l15: 'Last 15',
  l30: 'Last 30',
  proj: 'ESPN projection',
};

// Fantasy points per game. "smart" weights season + recent form by sample size,
// and leans on projections / last season early in the year.
export function value(p, basis = 'smart') {
  const s = p.stats || {};
  if (basis !== 'smart') {
    return s[basis]?.avg ?? s.proj?.avg ?? s.season?.avg ?? s.prev?.avg ?? 0;
  }
  const parts = [];
  const add = (k, w) => { if (s[k]?.avg != null && w > 0) parts.push([s[k].avg, w]); };
  add('season', 0.45 * Math.min(1, (s.season?.gp || 0) / 15));
  add('l15', 0.35 * Math.min(1, (s.l15?.gp || 0) / 8));
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
export const gamesIn = (m, p, sps) => sps.reduce((a, sp) => a + (gameOn(m, p, sp) ? 1 : 0), 0);
export const remainingSps = (m, period = m.currentPeriod) => (m.periods[period] || []).filter(sp => sp >= m.currentSP);
export const playoffPeriods = m =>
  Object.keys(m.periods).map(Number).filter(id => id > m.regularPeriods).sort((a, b) => a - b);

// Simulates each remaining day: healthy players with a game fill starting slots best-first.
// Ignores positional eligibility, so it's a slight overestimate for thin rosters.
export function projectDays(m, roster, sps, basis) {
  const active = roster.filter(p => p.slot !== 13 && !isOut(p));
  let total = 0, games = 0;
  const days = [];
  for (const sp of sps) {
    const playing = active
      .filter(p => gameOn(m, p, sp))
      .map(p => value(p, basis) * (isDTD(p) ? 0.8 : 1))
      .sort((a, b) => b - a);
    const used = playing.slice(0, m.starters);
    const pts = used.reduce((a, b) => a + b, 0);
    total += pts;
    games += used.length;
    days.push({
      sp, pts,
      playing: playing.length,
      open: Math.max(0, m.starters - playing.length),
      benched: Math.max(0, playing.length - m.starters),
    });
  }
  return { total, games, days };
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
  return { homeProj: hp, awayProj: ap, homeGames: h.games, awayGames: a.games, winProb, final: !days.length };
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
        winProb: opp ? pr.winProb : null, done: x.period < m.currentPeriod, won, tie: x.winner === 'TIE' };
    });
}

export function analyze(m, basis = 'smart') {
  const team = id => m.teams.find(t => t.id === id);
  const my = team(m.myTeamId) || m.teams[0];
  const rem = remainingSps(m);
  const base = projectDays(m, my.roster, rem, basis);

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
      };
    } else matchup = { bye: true };
  }

  // ---- Waivers
  const pool = my.roster.filter(p => p.slot !== 13);
  const drop = pool.slice().sort((a, b) => value(a, basis) - value(b, basis))[0] || null;
  const dropV = drop ? value(drop, basis) : 0;
  const po = playoffPeriods(m).flatMap(id => m.periods[id] || []);
  const without = my.roster.filter(p => p !== drop);
  const waivers = m.freeAgents.map(p => {
    const v = value(p, basis);
    const gl = gamesIn(m, p, rem);
    let score = v * (1 + 0.06 * (gl - 3));
    if (isOut(p)) score *= 0.4; else if (isDTD(p)) score *= 0.9;
    const weekGain = drop ? projectDays(m, [...without, p], rem, basis).total - base.total : 0;
    const s = p.stats;
    return {
      p, v, gl, score, weekGain,
      rosGain: v - dropV,
      poGames: gamesIn(m, p, po),
      trend: s.l15 && s.season && s.season.gp >= 8 ? s.l15.avg - s.season.avg : null,
    };
  });

  // ---- Notes
  const notes = [];
  const note = (type, tag, title, detail = '') => notes.push({ type, tag, title, detail });
  if (matchup && !matchup.bye) {
    const diff = matchup.myProj - matchup.oppProj;
    const wp = Math.min(99, Math.max(1, Math.round(matchup.winProb * 100)));
    if (diff >= 0) note('good', 'Matchup', `On pace to win by ${Math.round(diff)}`, `${wp}% win chance. ${matchup.myGames} games left for you, ${matchup.oppGames} for ${matchup.opp.name}.`);
    else note('bad', 'Matchup', `On pace to lose by ${Math.round(-diff)}`, `${wp}% win chance. You need volume: stream players who play on your open days.`);
  } else if (matchup?.bye) note('info', 'Matchup', 'Bye week', 'No matchup this period.');

  for (const p of my.roster) {
    if (isOut(p) && p.slot !== 12 && p.slot !== 13) note('bad', 'Lineup', `${p.name} is out and starting`, 'Swap in a healthy bench player before lock.');
  }
  const irSlots = m.slotCounts?.[13] || 0;
  const inIR = my.roster.filter(p => p.slot === 13);
  for (const p of inIR) {
    if (!isOut(p)) note('warn', 'IR', `${p.name} is healthy on IR`, 'ESPN locks adds and drops until you activate or drop them.');
  }
  if (inIR.length < irSlots) {
    const benchOut = my.roster.filter(p => p.slot === 12 && isOut(p));
    if (benchOut.length) note('info', 'IR', 'Open IR slot', `Move ${benchOut.map(p => p.name).join(', ')} to IR and use the spot for a streamer.`);
  }
  const open = base.days.filter(d => d.open > 0);
  const openTotal = open.reduce((a, d) => a + d.open, 0);
  if (openTotal) {
    note('warn', 'Lineup', `${openTotal} empty slot${openTotal > 1 ? 's' : ''} left this week`,
      open.map(d => `${fmtDow(spDate(m, d.sp))} ${d.open}`).join(', ') + '. Each one is free points for a streamer.');
  }
  const benched = base.days.reduce((a, d) => a + d.benched, 0);
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

  if (drop) {
    const bestWeek = waivers.filter(w => !isOut(w.p)).sort((a, b) => b.weekGain - a.weekGain)[0];
    if (bestWeek && bestWeek.weekGain >= 12) note('good', 'Stream', `Add ${bestWeek.p.name}, drop ${drop.name}`, `About +${Math.round(bestWeek.weekGain)} points this week on ${bestWeek.gl} games.`);
    const bestRos = waivers.filter(w => !isOut(w.p)).sort((a, b) => b.v - a.v)[0];
    if (bestRos && bestRos.rosGain >= 2) note('good', 'Waiver', `${bestRos.p.name} over ${drop.name}`, `${bestRos.v.toFixed(1)} vs ${dropV.toFixed(1)} FP/G rest of season.`);
  }
  if (m.acqLimit > 0) {
    const used = my.acq?.[m.currentPeriod] || 0;
    note(used >= m.acqLimit ? 'bad' : 'info', 'Moves', `${Math.max(0, m.acqLimit - used)} of ${m.acqLimit} adds left`, used >= m.acqLimit ? 'Maxed out. Set your best lineup each day.' : 'Resets with the next matchup.');
  }
  if (!notes.length) note('good', 'Lineup', 'Clean lineup', 'No injured starters and no open slots.');

  return { my, rem, base, matchup, waivers, drop, dropV, feedback: notes };
}
