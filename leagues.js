// Leagues available in the app. Data comes from ESPN's public scoreboard feed.
// Standings extras per league:
//   standingsLevel  ESPN grouping depth (omitted = conference, 3 = divisions)
//   sortStat        stat used to order teams when ESPN gives no playoff seeds
//   cols            [column label, ESPN stat name] shown in the Standings table
//   scoreboardQuery extra query string for the scoreboard (college football needs groups=80 for all FBS games)
//   teamsQuery      extra query string for the teams list
//   noInjuries      ESPN has no injury feed for this league (hidden from the Injuries tab)
const LEAGUES = [
  { key: 'nhl', sport: 'hockey', league: 'nhl', kind: 'hockey', name: 'NHL', icon: '🏒',
    sortStat: 'points',
    cols: [['GP', 'gamesPlayed'], ['W', 'wins'], ['L', 'losses'], ['OTL', 'otLosses'], ['PTS', 'points'], ['DIFF', 'pointDifferential'], ['L10', 'lasttengames'], ['STRK', 'streak']] },
  { key: 'mlb', sport: 'baseball', league: 'mlb', kind: 'baseball', name: 'MLB', icon: '⚾',
    standingsLevel: 3, sortStat: 'winPercent',
    cols: [['W', 'wins'], ['L', 'losses'], ['PCT', 'winPercent'], ['GB', 'gamesBehind'], ['DIFF', 'pointDifferential'], ['L10', 'lasttengames'], ['STRK', 'streak']] },
  { key: 'nfl', sport: 'football', league: 'nfl', kind: 'football', name: 'NFL', icon: '🏈',
    standingsLevel: 3, sortStat: 'winPercent',
    cols: [['W', 'wins'], ['L', 'losses'], ['T', 'ties'], ['PCT', 'winPercent'], ['PF', 'pointsFor'], ['PA', 'pointsAgainst'], ['DIFF', 'pointDifferential'], ['STRK', 'streak']] },
  { key: 'ncaaf', sport: 'football', league: 'college-football', kind: 'football', name: 'NCAAF', icon: '🏟️',
    sortStat: 'winPercent', scoreboardQuery: '&groups=80', teamsQuery: '&groups=80', noInjuries: true,
    cols: [['W', 'wins'], ['L', 'losses'], ['PCT', 'winPercent'], ['PF', 'pointsFor'], ['PA', 'pointsAgainst'], ['DIFF', 'pointDifferential'], ['STRK', 'streak']] },
  { key: 'nba', sport: 'basketball', league: 'nba', kind: 'basketball', name: 'NBA', icon: '🏀',
    sortStat: 'winPercent',
    cols: [['W', 'wins'], ['L', 'losses'], ['PCT', 'winPercent'], ['GB', 'gamesBehind'], ['L10', 'lasttengames'], ['STRK', 'streak']] }
];

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const scoreboardUrl = (l, dates, limit = 300) =>
  `${BASE}/${l.sport}/${l.league}/scoreboard?dates=${dates}&limit=${limit}${l.scoreboardQuery || ''}`;
// ESPN rejects date ranges (HTTP 400), so the feed is queried one day at a time
const pad2 = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

// Standings live under /apis/v2 (not /apis/site/v2)
const standingsUrl = (l) =>
  `https://site.api.espn.com/apis/v2/sports/${l.sport}/${l.league}/standings${l.standingsLevel ? `?level=${l.standingsLevel}` : ''}`;

const rosterUrl = (l, teamId) => `${BASE}/${l.sport}/${l.league}/teams/${encodeURIComponent(teamId)}/roster`;
const injuriesUrl = (l) => `${BASE}/${l.sport}/${l.league}/injuries`;

const teamsUrl = (l) => `${BASE}/${l.sport}/${l.league}/teams?limit=${l.teamsQuery ? 500 : 100}${l.teamsQuery || ''}`;

module.exports = { LEAGUES, scoreboardUrl, standingsUrl, rosterUrl, injuriesUrl, teamsUrl, dayStr };
