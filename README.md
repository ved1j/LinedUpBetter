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
- **Matchups**: live scoreboard with projections and win odds, a per-player projection breakdown for any week (starts, games sat, games missed injured), your full schedule with predictions and projected record, and a one-click recap to paste in your group chat.
- **Waivers**: streaming plan within your adds limit, then free agents with real average, projected FP/G, this week's and rest-of-season gain over your drop candidate, next week's games, playoff games, ownership trend and a day-by-day game grid. ✕ hides players you don't want.
- **Trade**: a trade finder (pick a player you want, one of yours to shop, or a position to fill, and it builds packages the other manager would plausibly accept, labelled likely or possible), trade ideas from a scan of every roster (1-for-1, 2-for-1, 1-for-2, 2-for-2), each checked on rest-of-season + playoff projections for both teams and labelled win-win, fair on paper or worth asking, with filters by category, deal type and team and a Show more button; an analyzer for any deal; targets who'd help you most; team needs by lineup slot vs the league, with trade chips; buy-low and sell-high lists.
- **Playoffs**: NBA games per fantasy-playoff round for your roster and all 30 teams, plus free agents to stash.
- **Watchlist**: players you starred or wrote notes on.
- **League**: standings with simulated playoff and bye odds, power rankings (projected strength + results, biggest need per team), and the league's rules.

## Your league's settings
Every number uses your league's own scoring (points per stat), lineup size, matchup calendar and playoff rounds. Category leagues get ESPN's standard points scoring as an estimate.

## Teams, stars and notes
- Use the team switcher in the header to see everything from any team's point of view.
- Tap ☆ to make a team your main one. The app always opens on it.
- Click any player name for their stats, latest ESPN news, what they're worth to your lineup, a Trade for button, a star and notes. A blue dot marks players with news in the last 24 hours.
- Mark your players 🔒 untouchable (in their panel) and they're never offered in trade ideas or the finder. "Shop this player" in the panel opens the finder for them.
- Click any player name to star them or keep notes. Notes are saved per league, in this browser only.
- Tap ✕ on a free agent, or 🚫 Never suggest in any non-roster player's panel, to ban them from everything you'd acquire: waiver suggestions, pickups, streaming plans, stash lists, your trade fill-ins, trade ideas, the finder and targets. Other teams are still modelled normally. Undo from "Never suggested" under the waiver wire.

## Notes
- Projections adjust for outside factors (toggle in Settings): when a regular is out, teammates absorb part of their production (about +10–13% for one star out, capped at ±30%), and lose it when a starter returns from a long absence; stars get −5% on the second night of back-to-backs.
- Trade value ("name value"): what other managers think a player is worth = reputation (draft position turned into FP/G, last season, ESPN projection) blended with this season's form, which gains weight as games are played (up to 70%), and cut for injuries (by expected games missed; much more with no return date). Trade ideas must be close on trade value, so a hot start doesn't make a mid-round pick look like a star; the analyzer rates acceptance as likely / possible / unlikely.
- Uneven trades (2-for-1, 1-for-2): the team left a player short picks up its best possible waiver pickup: free agents are ranked by what each adds to that team's lineup (positions, schedule, injuries) across the top 60, and the best fit on the post-trade roster wins. That pickup counts toward fairness on paper, but its standalone value isn't credited to the trade, since the team could add that player anyway.
- Shortcuts: 1–9 switch tabs, ← → step through weeks, R refreshes, Esc closes the player panel. The app reopens on the last tab you used.
- Trade ideas are screened on sampled days, then the best are re-checked on every remaining day, so their numbers match the analyzer exactly.
- Injuries: players count from ESPN's expected return date. Out-for-season players never return; players out with no return date are not counted until ESPN posts one; day-to-day players are discounted 20% for the current matchup only.
- Projections fill each day's lineup optimally while respecting position eligibility (PG/SG/G/UTIL...).
- Data is cached for 3 minutes; ↻ forces a refresh.
- ESPN's API is unofficial and can change between seasons.
