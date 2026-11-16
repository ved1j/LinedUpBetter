# LinedUpBetter

ESPN fantasy basketball dashboard for points leagues.

Chrome extension. Click the toolbar icon for the popup, or ⤢ to open it in a full tab.

## Install
1. Go to `chrome://extensions`, turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this `linedupbetter` folder.
3. Pin the icon. Open your league on fantasy.espn.com, click the icon, and the league ID fills in automatically.

Private leagues: stay logged in to espn.com in the same Chrome profile. The extension uses your existing session and only talks to espn.com.

## Tabs
- **Overview**: scoreboard with ‹ › arrows through every week (finals for past weeks, predicted scores and odds for future ones), the rundown (lineup fixes, injuries with return dates, streaming plan, form), best pickups, a day-by-day chart of you vs your opponent for the rest of the matchup, and the latest ESPN news on your roster.
- **Roster**: today's lineup checker (who to start and sit), and a schedule grid that marks every remaining game as starting, sitting (lineup full) or injured, with projected points per day.
- **Matchups**: focus matchups (pick the games you care about and everything plays for those), live scoreboard with projections and win odds, matchups that matter (which of your games swing your playoff odds most, and who to stream for them), a per-player projection breakdown for any week (starts, games sat, games missed injured), your full schedule with predictions and projected record, and a one-click recap to paste in your group chat.
- **Slate**: the week day by day: NBA games each night (light / heavy nights), your starts vs your opponent's and open slots, the best free agent to add each remaining day with two backups and who to drop, and an NBA schedule for the week: teams grouped by games, then every team night by night (opponent, home/road, back-to-backs, games left, games on nights you have empty lineup slots, and which of your and your opponent's players are on each team), sortable by most games, most left or most on your empty nights. Step through future weeks.
- **Waivers**: streaming plan within your adds limit, risers & fallers (in-season rank vs preseason, filter under 50% rostered), then free agents with real average, projected FP/G, this week's and rest-of-season gain over your drop candidate, next week's games, playoff games, ownership trend and a day-by-day game grid. ✕ hides players you don't want.
- **Players**: player power rankings for everyone in the league pool, with your league's scoring: Overall (season FP/G), Last 30 / Last 15 / Last 7 for recency, Rest of season (the projection the app uses, with injuries and teammate usage) and Total points. Injuries count by default (toggle off with Count injuries): each rank uses FP/G × the share of games the player is expected to play, over the next 2 weeks for recent form and the rest of the season for Overall / Rest of season, from ESPN return dates, with a Health column showing that share and when they're back. A movement column shows who's rising on form (recent rank vs season rank, or season rank vs preseason), with filters by position and free agents / rostered / your team, plus search. Each player's panel shows their ranks too.
- **Trade**: a trade finder (pick a team to trade with and it tries every 1-for-1, 2-for-1, 1-for-2 and 2-for-2 between your rosters, rated win-win, fair on paper or worth asking, with a note on where that team is thin or deep; or pick a player you want, one of yours to shop, or a position to fill, and it builds packages the other manager would plausibly accept, labelled likely or possible; "Find deals" in the analyzer and "Search every deal" in a team's trade ideas open the team search), trade ideas from a scan of every roster (1-for-1, 2-for-1, 1-for-2, 2-for-2), each checked on rest-of-season + playoff projections for both teams and labelled win-win, fair on paper or worth asking, with filters by category, deal type and team and a Show more button; an analyzer for any deal (with your lineup before → after: games started, empty slots and benched games per week, plus a Roster-style day grid for any week with incoming players tagged NEW and outgoing ones faded); targets who'd help you most; team needs by lineup slot vs the league, with trade chips; buy-low and sell-high lists.
- **Injuries**: every injury that matters in your league (your team, your opponent, everyone else, notable free agents) with timeline, games missed, and who benefits (teammates' usage bump), plus injury pickups: free agents whose role grows.
- **Playoffs**: NBA games per fantasy-playoff round for your roster and all 30 teams, plus free agents to stash.
- **Fun**: jump buttons up top, then: season awards so far, grouped (luck & schedule, big weeks, streaks, players & trades, managers), with your team's outlined; schedule luck for the full season (real scores for finished weeks, projections for the rest) or so far, with a one-line summary for your team, deserved wins, luck, and the best and worst schedule you could have had; a what-if schedules grid (every team's record with every other team's schedule); a trade report card (so far, rest of season and total for both sides, most lopsided first); best pickups; and each manager's season moves.
- **Watchlist**: players you starred or wrote notes on.
- **League**: standings with simulated playoff and bye odds, power rankings grouped into contenders / in the mix / long shots (projected strength + results, players out, projected record, biggest need), and the league's rules.

## Your league's settings
Every number uses your league's own scoring (points per stat), lineup size, matchup calendar and playoff rounds. Category leagues get ESPN's standard points scoring as an estimate.

## Bye weeks and playoffs
- Bye weeks never count. A week a team has no matchup (a regular-season bye, a first-round playoff bye, or playoff rounds after it's out) is ignored everywhere: trade values for both teams, the finder, waiver ROS gains, player worth, playoff games, the Slate's adds, and this week's lineup and streaming advice ("Bye week: nothing counts"). Before the bracket is set, round 1 counts at each team's chance of *not* getting a bye, from the playoff-odds simulation (the Playoffs tab shows "counts 10%" when you're a near-lock for a bye).
- Settings → **Count the fantasy playoffs**: on by default. Off makes everything season-long cover the regular season only (trades, finder, waivers, rankings, injury discounts, team needs), and playoff weeks count for nothing.

## Focus matchups
Only care about a few games, like the ones against the other weak teams? In **Matchups → Focus matchups**, star the weeks you want to win, pick an opponent (every game left against them), or use a quick pick: your 3 best shots, toss-ups (35–65%), or playoffs only. **Matchups that matter** has a "Focus on these" button too.
- While focus is on, only those weeks count for your team, and every other week counts for nothing, like a bye. That covers trade values, the trade finder and ideas, waiver ROS gains (the column becomes **Focus +**), player worth, playoff games and the Slate. Other teams still count their whole season, so the finder's acceptance read doesn't change.
- The trade analyzer adds a table of your win chance in each focus matchup before and after the deal, plus the change in expected wins. If your trade partner is one of those opponents, their weaker or stronger roster counts too.
- In a week that isn't a focus matchup, lineup advice stays (it's free), but streams and this-week waiver gains are switched off.
- Focus is saved per league and team. A bar on the affected tabs shows what's on, with Edit and Turn off.
- **Focus trade plan** (top of the Trade tab, or "Who to trade away" on the focus card): other managers pay for a whole season, but you only need your focus weeks. It shows your lineup in each focus week (starts, empty slots, benched games), the players to trade away (worth more to others than to you: few games in those weeks, benched because your lineup's full those nights, out injured, or a free agent would do as well), who to keep, the nights with empty lineup slots, and who to go after. "Find a return" searches every team for the best deal on your focus weeks.
- Losing a trade outside your focus weeks doesn't matter: with focus on, trade ideas and the finder also try deals where you overpay on per-game and trade value, and the analyzer shows what a deal does to your other weeks on a muted "don't count" row.

## Teams, stars and notes
- Use the team switcher in the header to see everything from any team's point of view.
- Tap ☆ to make a team your main one. The app always opens on it.
- Click any player name for their stats, latest ESPN news, what they're worth to your lineup, a Trade for button, a star and notes. A blue dot marks players with news in the last 24 hours.
- Mark your players 🔒 untouchable (in their panel) and they're never offered in trade ideas or the finder. "Shop this player" in the panel opens the finder for them.
- Click any player name to star them or keep notes. Notes are saved per league, in this browser only.
- Tap ✕ on a free agent, or 🚫 Never suggest in any non-roster player's panel, to ban them from everything you'd acquire: waiver suggestions, pickups, streaming plans, stash lists, your trade fill-ins, trade ideas, the finder and targets. Other teams are still modelled normally. Undo from "Never suggested" under the waiver wire.

## Notes
- Week rollover: ESPN keeps a finished matchup as the current one until it rolls over overnight. Once every game on the matchup's last day has tipped off 3+ hours ago, LinedUpBetter moves on to the next matchup right away: the lineup card, Slate, waivers and scoreboard show the new week, last week is decided from the final scores and counted in records and points (ESPN makes it official overnight), and a note at the top says so.
- Projected record (Matchups → schedule & predictions) adds up the win chances of the games left (a 90% game counts 0.9 wins), so it builds in a few upsets. Next to it: the record if every favorite wins.
- Open roster spots: a team with fewer players than roster spots (IR aside) is assumed to pick up the best available free agent (never one you banned) from the start of next week, once adds reset. This week stays as is. Applies to every projection (future matchups, win %, playoff odds, trades, player worth); breakdowns label it "assumed pickup".
- Projections adjust for outside factors (toggle in Settings): when a regular is out, teammates absorb part of their production (about +10–13% for one star out, capped at ±30%), and lose it when a starter returns from a long absence; stars get −5% on the second night of back-to-backs.
- Trade value ("name value"): what other managers think a player is worth = reputation (draft position turned into FP/G, last season, ESPN projection) blended with this season's form, which gains weight as games are played (up to 70%), and cut for injuries (by expected games missed; much more with no return date). Trade ideas must be close on trade value, so a hot start doesn't make a mid-round pick look like a star; the analyzer rates acceptance as likely / possible / unlikely.
- Uneven trades (2-for-1, 1-for-2): the team left a player short picks up its best possible waiver pickup: free agents are ranked by what each adds to that team's lineup (positions, schedule, injuries) across the top 60, and the best fit on the post-trade roster wins. That pickup counts toward fairness on paper, but its standalone value isn't credited to the trade, since the team could add that player anyway.
- Shortcuts: 1–9 switch tabs, ← → step through weeks, R refreshes, Esc closes the player panel. The app reopens on the last tab you used.
- Trade ideas are screened on sampled days, then the best are re-checked on every remaining day, so their numbers match the analyzer exactly.
- Injuries: players count from ESPN's expected return date. Out-for-season players never return; players out with no return date are not counted until ESPN posts one; day-to-day players are discounted 20% for the current matchup only.
- Projections fill each day's lineup optimally while respecting position eligibility (PG/SG/G/UTIL...).
- Data refreshes after a minute; ↻ forces a refresh (e.g. right after changing your lineup on ESPN). Lineups are read for today specifically, matching the TODAY view on ESPN.
- ESPN's API is unofficial and can change between seasons.
