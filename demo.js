// Sample league in the same shape loadLeague() returns, so every tab works without an ESPN account.
import { PRO_ABBR } from './api.js';

const FIRST = ['Jalen', 'Marcus', 'Devin', 'Tyrese', 'Andre', 'Malik', 'Jordan', 'Cam', 'Darius', 'Isaiah', 'Kris', 'Trey', 'Miles', 'Nico', 'Theo', 'Rico', 'Dante', 'Zion', 'Corey', 'Luka', 'Shai', 'Evan', 'Bam', 'Jaden', 'Keon', 'Amari', 'Xavier', 'Quentin', 'Bryce', 'Omar'];
const LAST = ['Hale', 'Brooks', 'Carter', 'Vance', 'Ellis', 'Monroe', 'Price', 'Fields', 'Reyes', 'Holt', 'Banks', 'Sutton', 'Grant', 'Pierce', 'Wade', 'Mercer', 'Dawson', 'Okafor', 'Lindqvist', 'Barros', 'Kimura', 'Nash', 'Rowe', 'Tate', 'Whitfield', 'Quarles', 'Ibeh', 'Santos', 'Lowry', 'Fox'];
const TEAMS = ['Dunk Dynasty', 'Pick & Roll Tide', 'Splash Zone', 'The Glass Cleaners', 'Fast Break Fiends', 'Triple Double Trouble', 'Bench Mob', 'Brick City', 'Euro Steppers', 'Box Out Bandits'];
const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
const ELIG = { PG: ['PG', 'SG'], SG: ['PG', 'SG', 'SF'], SF: ['SG', 'SF', 'PF'], PF: ['SF', 'PF'], C: ['PF', 'C'] };

export function makeDemo() {
  let seed = 7;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const rand = (a, b) => a + (b - a) * r();
  const int = (a, b) => Math.floor(rand(a, b + 1));
  const pick = a => a[int(0, a.length - 1)];

  const REG = 20, PO = 3, total = (REG + PO) * 7;
  const periods = {};
  for (let i = 1; i <= REG + PO; i++) periods[i] = Array.from({ length: 7 }, (_, k) => (i - 1) * 7 + k + 1);
  const currentPeriod = 5, currentSP = (currentPeriod - 1) * 7 + 3;
  const d1 = new Date(); d1.setHours(12); d1.setDate(d1.getDate() - (currentSP - 1));

  const proTeams = {};
  for (let id = 1; id <= 30; id++) proTeams[id] = { abbrev: PRO_ABBR[id], name: '', games: {} };
  for (let sp = 1; sp <= total; sp++) {
    const ids = Array.from({ length: 30 }, (_, i) => i + 1).sort(() => r() - 0.5);
    const n = int(3, 13);
    for (let j = 0; j < n; j++) {
      const [a, b] = [ids[2 * j], ids[2 * j + 1]];
      proTeams[a].games[sp] = { opp: b, home: true };
      proTeams[b].games[sp] = { opp: a, home: false };
    }
  }

  let pid = 1;
  const usedNames = new Set();
  const player = (base, extra) => {
    let name;
    do name = `${pick(FIRST)} ${pick(LAST)}`; while (usedNames.has(name));
    usedNames.add(name);
    const pos = pick(POS);
    const inj = r();
    const gp = int(9, 13);
    const l15 = base * rand(0.78, 1.25);
    return {
      id: pid++, name, proTeamId: int(1, 30), pos, eligible: ELIG[pos],
      injury: inj < 0.05 ? 'OUT' : inj < 0.11 ? 'DAY_TO_DAY' : 'ACTIVE',
      slot: null, status: null,
      stats: {
        season: { avg: +base.toFixed(1), gp },
        l7: { avg: +(base * rand(0.7, 1.3)).toFixed(1), gp: int(2, 4) },
        l15: { avg: +l15.toFixed(1), gp: int(5, 8) },
        l30: { avg: +((base + l15) / 2).toFixed(1), gp },
        proj: { avg: +(base * rand(0.92, 1.08)).toFixed(1), gp: 70 },
        prev: { avg: +(base * rand(0.85, 1.1)).toFixed(1), gp: int(50, 80) },
      },
      ...extra,
    };
  };

  // Snake-draft 14 players onto each of 10 teams.
  const values = Array.from({ length: 140 }, () => 14 + 38 * r() ** 1.6).sort((a, b) => b - a);
  const teams = TEAMS.map((name, i) => ({
    id: i + 1, name, abbrev: name.split(' ').map(w => w[0]).join('').slice(0, 4).toUpperCase(),
    owners: [], wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, seed: null, acq: { [currentPeriod]: int(0, 3) }, roster: [],
  }));
  values.forEach((v, i) => {
    const round = Math.floor(i / 10), k = i % 10;
    teams[round % 2 ? 9 - k : k].roster.push(player(v, { owned: +rand(55, 100).toFixed(1), ownedChange: +rand(-2, 2).toFixed(1) }));
  });
  const SLOTS = [0, 1, 2, 3, 4, 5, 6, 11, 11, 11, 12, 12, 12, 13];
  for (const t of teams) {
    t.roster.sort(() => r() - 0.5);
    t.roster.forEach((p, i) => { p.slot = SLOTS[i]; });
    const ir = t.roster.find(p => p.slot === 13);
    ir.injury = 'OUT';
  }

  const freeAgents = Array.from({ length: 160 }, () => player(6 + 22 * r() ** 1.4, {
    owned: +rand(0, 45).toFixed(1), ownedChange: +rand(-4, 9).toFixed(1), status: r() < 0.15 ? 'WAIVERS' : 'FREEAGENT',
  }));

  // Round-robin schedule (circle method).
  const matchups = [];
  const ids = teams.map(t => t.id);
  for (let wk = 1; wk <= REG; wk++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + wk - 1) % 9)])];
    for (let j = 0; j < 5; j++) {
      const home = rot[j], away = rot[9 - j];
      let hp = 0, ap = 0, winner = 'UNDECIDED';
      if (wk < currentPeriod) {
        hp = Math.round(rand(950, 1400)); ap = Math.round(rand(950, 1400));
        winner = hp > ap ? 'HOME' : 'AWAY';
        const H = teams[home - 1], Aw = teams[away - 1];
        H.pf += hp; H.pa += ap; Aw.pf += ap; Aw.pa += hp;
        if (hp > ap) { H.wins++; Aw.losses++; } else { Aw.wins++; H.losses++; }
      } else if (wk === currentPeriod) {
        hp = Math.round(rand(330, 480)); ap = Math.round(rand(330, 480));
      }
      matchups.push({ period: wk, home: { teamId: home, pts: hp }, away: { teamId: away, pts: ap }, winner });
    }
  }

  return {
    demo: true, leagueId: 'demo', season: 2027, name: 'Demo League',
    currentSP, currentPeriod, regularPeriods: REG, playoffTeamCount: 6,
    periods, starters: 10, slotCounts: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 11: 3, 12: 3, 13: 1 },
    acqLimit: 4, day1: d1.toLocaleDateString('en-CA'),
    teams, matchups, freeAgents, proTeams, myTeamId: 1,
  };
}
