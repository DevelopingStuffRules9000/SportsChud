# SportsChud

Live game alerts for the NFL, NCAA football (FBS), NHL, MLB and NBA, as a Windows desktop app.

## Run it
Double-click `Start-SportsChud.bat`. On first run it calls `Setup-SportsChud.bat`, which installs Node.js and the app's dependencies, then opens the app. If something breaks, run `Setup-SportsChud.bat repair` to reinstall from scratch. On its first start the app itself adds a **SportsChud** shortcut with its icon to your desktop (only once; delete it and it stays gone). After that, use the desktop shortcut.

Node.js is installed with winget when available. On Windows editions without winget (such as Windows 10/11 LTSC), setup downloads a portable copy of Node.js into a `.node` folder next to the app instead, with no installer and no admin rights needed. Delete `.node` to remove it.

The icon lives in `assets/` (`icon.png` is the source; `icon.ico` is rendered from it). `renderer/icon.png` is the same logo for the sidebar.

Version: see `package.json` (shown in Settings). Bump it each release; the zip is named `SportsChud-vX.Y.Z.zip`.

Manual route: install Node.js 18+, then `npm install` and `npm start` in this folder.

## Build an installer
`npm run dist` builds on Windows. Or push this folder to GitHub and run the "Build Windows installer" workflow.

The installer (`SportsChud-Setup.exe`) lets you pick the folder and installs to `C:\Program Files\SportsChud` by default (needs administrator permission). It bundles everything, so Node.js is not needed.

## Release and install from GitHub
1. Set `version` in `package.json`, commit and push.
2. Tag it and push the tag, e.g. `v0.3.4`. GitHub Desktop: History tab, right-click the commit, Create Tag. Then Push origin.
3. The workflow builds the installer and attaches `SportsChud-Setup.exe` to a GitHub Release.
4. On any PC, run `Install-SportsChud.ps1`. It downloads the latest release and installs it silently to Program Files. (The GitHub `username/repository` is set at the top of that file and in `updater.js`; change both if the account or repo is renamed.)

The tag must match `version` in `package.json` (for example tag `v0.4.1` for version `0.4.1`). The build fails on purpose if they differ.

## Updates
The installed app checks GitHub for a newer release 20 seconds after it starts and then every 6 hours. When one exists you get a notification, a banner under the title bar, and an **Install update** button in Settings. Clicking it downloads `SportsChud-Setup.exe`, opens the installer (Windows asks for administrator permission, since the app lives in Program Files) and closes SportsChud so the installer can replace it. It never installs anything on its own. Turn the automatic check off in Settings with **Check for updates automatically**; **Check now** still works. Updates only apply to the installed app, not to a copy run from source with the `.bat` files. Versions before 0.4.0 can't update themselves, so install 0.4.0 by hand once.

## How it works
- **Standings** shows every league's table (conferences for NHL/NBA, divisions for MLB/NFL) with your followed teams highlighted and clinch markers (x, y, z, e) where ESPN provides them.
- **Playoffs** lists every series in a league's postseason with the series score, live game or next game time, and your teams first. By default the tab only appears while one of your teams is still alive in a postseason (it hides if they missed the playoffs or were eliminated); turn off **Autohide Playoffs** in Settings to always show it. All three autohide switches (Playoffs, Activity, out of season sports) sit together under **Autohide** in Settings.
- **Scores** and **Recaps** are grouped by team by default; the **By team / By status** pills in the header switch it. All pills live in the header on the same line as the title: on the left the league or team picker (Teams, Standings, Roster, Injuries), then a `|`, then the option pills (By team / By status, Injuries' My teams / Whole league, Schedules' Day / Week / Month). On the right: the blue subtitle, a `|`, then the category name.
- **Roster** shows the full roster of any team you follow, grouped by position or unit, with a player search, jersey, age, size, experience and an injury badge. Click a player's name to open their ESPN page.
- **Injuries** shows the league injury report with status (Out, Day-To-Day, IR), injury type, expected return date and ESPN's note. Switch between **My teams** and **Whole league**; your teams are listed first and tagged.
- **Scores** shows live and today's games with the current period, inning or quarter. **Schedules** is a monthly calendar of games for every team you follow. **Teams** is where you pick teams and set alerts. **Activity** logs every alert sent (by default the tab only appears once the first alert has gone out; turn off **Autohide Activity** in Settings to always show it).
- Pick teams on the **Teams** tab. Each team has its own toggles: reminder, game start, periods/innings/quarters, scoring, close game, overtime, final.
- Leagues you don't follow any team in are left out of the Standings and Injuries league pickers. Only the Teams tab always lists every league, so you can add a first team.
- **Autohide out of season sports** (Settings, off by default) drops leagues with no games in the next ~10 days from the league pickers (it combines with the rule above). Alerts for teams you follow keep working. Nothing is hidden if ESPN can't be reached.
- **Close game** alerts once per game when it is late and tight: NHL 3rd period with 10:00 left or less and within a goal, NBA 4th quarter with 5:00 left or less and within 5, NFL and NCAAF 4th quarter with 5:00 left or less and within 8, MLB 8th inning or later and within a run. A tied game in those windows reads "Tied late".
- **Overtime** alerts when a game enters overtime, a shootout, extra innings or a further overtime period. It replaces the "Periods" alert for that moment so you don't get two.
- **Standings** alerts (a per-team toggle, on by default) tell you when a finished game moved your team in the standings: a new rank in its division or conference, or a clinch marker (x, y, z, e). ESPN's standings lag a final by a few minutes, so SportsChud waits until your team's record updates (checking for up to about 90 minutes), then sends one alert only if something actually changed, for example "Moved up to 2nd in Atlantic (was 3rd)". It stays quiet in the playoffs. Your tables are compared the same way the Standings tab shows them.
- **Mini scoreboard** (Settings, off by default, or the tray menu's **Mini scoreboard** checkbox) is a small always-on-top window that lists only your live games, with each team's score and the period and clock. It floats above other windows without taking focus, has no taskbar button, and you can drag it anywhere; it remembers its spot and reopens there. The ✕ hides it, and clicking its name opens SportsChud. With nothing live it shows "No live games" and your next game, or turn on **Autohide Mini scoreboard** (under Autohide in Settings) so it only appears while one of your teams is playing. It closes along with the app.
- NBA games report at each quarter break and at the final instead of every basket.
- The app polls ESPN's public scoreboard feed (every 15s when a game is live, 60s otherwise) and sends Windows toast notifications when something changes.
- SportsChud must be running to send alerts. Closing the window quits the app.

## Recaps
Recaps shows the last 3 finished games for each team you follow (looking back up to 35 days, so weekly sports with a bye still fill up). **By status** shows those same games in one list.

## Recap videos
The **Recap videos** button opens the league's official YouTube channel (`@NHL`, `@NBA`, `@MLB`, `@NFL`; NCAAF uses a general YouTube search) searched for the team you follow plus the game date (e.g. `Maple Leafs Oct 6, 2026`), so that game's video comes first. **Stats** opens ESPN's recap and box score.

## Notes
- The ESPN feed is unofficial and undocumented, so it could change without notice. All feed access lives in `leagues.js` and `engine.js`.
- Add leagues by adding an entry to `leagues.js`.
