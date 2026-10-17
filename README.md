# LinedUpBetter

ESPN fantasy basketball dashboard for points leagues.

Chrome extension. Click the toolbar icon for the popup, or ⤢ to open it in a full tab.

## Install
1. Go to `chrome://extensions`, turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this `linedupbetter` folder.
3. Pin the icon. Open your league on fantasy.espn.com, click the icon, and the league ID fills in automatically.

Private leagues: stay logged in to espn.com in the same Chrome profile. The extension uses your existing session and only talks to espn.com.

## Tabs
- **Overview**: live matchup, projected final score and win chance, the rundown (injured starters, healthy players stuck on IR, empty lineup slots by day, hot/cold players, streamer and upgrade suggestions, adds left), and the best adds this week.
- **Roster**: your lineup with FP/G, season vs last-15 trend, games left, and a day-by-day schedule grid showing open slots and overflow.
- **Waivers**: free agents ranked by schedule-adjusted FP/G, projected points gained this week if you swap them in for your weakest player, playoff games and ownership trend. Filter by position and sort by any column.
- **Playoffs**: NBA games per fantasy-playoff round for your roster and all 30 teams, plus free agents worth stashing for the playoffs.
- **League**: standings with the playoff cut line, your upcoming opponents with their games that week, and this week's scores.

The FP/G dropdown in the header switches between Smart blend, Season, Last 15, Last 30 and ESPN projection.

## Notes
- Lineup projections fill starting slots best-first each day and ignore position eligibility, so they run slightly high.
- Data is cached for 10 minutes; ↻ forces a refresh.
- ESPN's API is unofficial and can change between seasons.
