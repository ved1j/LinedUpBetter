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
- **Roster**: today's lineup checker (who to start and sit, and the points at stake), plus FP/G, trends, games left and a day-by-day schedule grid with back-to-back flags.
- **Matchups**: every matchup this week with live and projected scores and win chances, plus the viewed team's full schedule: past results, predicted scores for every future week, and a projected final record.
- **Waivers**: a streaming plan (step-by-step add/drop moves within your adds limit), then free agents ranked, with each player's games this week day by day (highlighted when they land on your open lineup days; click a day to filter), by schedule-adjusted FP/G, projected points gained this week, playoff games and ownership trend.
- **Trade**: pick players on both sides to see the projected points change this matchup, rest of season and in the playoffs, for both teams. Includes buy-low and sell-high lists.
- **Playoffs**: NBA games per fantasy-playoff round for the roster and all 30 teams, plus free agents to stash.
- **Watchlist**: players you starred or wrote notes on, wherever they are rostered.
- **League**: standings with simulated playoff and bye odds and projected records (click a team to view as them) and the league's rules: points per stat, lineup, playoff teams and round dates.

## Your league's settings
Every number uses your league's own scoring (points per stat), lineup size, matchup calendar and playoff rounds. Category leagues get ESPN's standard points scoring as an estimate.

## Teams, stars and notes
- Use the team switcher in the header to see everything from any team's point of view.
- Tap ☆ to make a team your main one. The app always opens on it.
- Click any player name to star them or keep notes. Notes are saved per league, in this browser only.
- Tap ✕ on a free agent to hide them from waivers, pickups, streaming plans and stash lists. Bring them back from "Hidden players" under the waiver wire.

## Notes
- Projections fill each day's lineup optimally while respecting position eligibility (PG/SG/G/UTIL...).
- Data is cached for 3 minutes; ↻ forces a refresh.
- ESPN's API is unofficial and can change between seasons.
