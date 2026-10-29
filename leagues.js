// Leagues available in the app. Data comes from ESPN's public scoreboard feed.
// Standings extras per league:
//   standingsLevel  ESPN grouping depth (omitted = conference, 3 = divisions)
//   sortStat        stat used to order teams when ESPN gives no playoff seeds
//   cols            [column label, ESPN stat name] shown in the Standings table
//   scoreboardQuery extra query string for the scoreboard (college football needs groups=80 for all FBS games)
//   teamsQuery      extra query string for the teams list
//   noInjuries      ESPN has no injury feed for this league (hidden from the Injuries tab)
//   noTransactions  ESPN has no trades/signings feed for this league (hidden from the Pickups tab)
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
    sortStat: 'winPercent', scoreboardQuery: '&groups=80', teamsQuery: '&groups=80', noInjuries: true, noTransactions: true,
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

// Per-game detail (scoring plays, box score, ...). `eventId` is ESPN's own id, without our "league:" prefix
const summaryUrl = (l, eventId) => `${BASE}/${l.sport}/${l.league}/summary?event=${encodeURIComponent(eventId)}`;

const rosterUrl = (l, teamId) => `${BASE}/${l.sport}/${l.league}/teams/${encodeURIComponent(teamId)}/roster`;
const injuriesUrl = (l) => `${BASE}/${l.sport}/${l.league}/injuries`;

// Trades, signings, waivers ...
const transactionsUrl = (l) => `${BASE}/${l.sport}/${l.league}/transactions?limit=100`;

// Season leaders come from ESPN's core API (categories per sport: goals, passing yards ...). The season is named by the
// year it ends (NHL/NBA 2026-27 is 2027), by the year it starts (NFL/college football, which still counts January as the
// previous season) or by the calendar year (MLB). type 2 is the regular season.
const seasonYear = (l, d = new Date()) => {
  const y = d.getFullYear(), m = d.getMonth() + 1;
  if (l.kind === 'hockey' || l.kind === 'basketball') return m >= 9 ? y + 1 : y;
  if (l.kind === 'football') return m >= 3 ? y : y - 1;
  return y;
};
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const leadersUrl = (l, year) => `${CORE}/${l.sport}/leagues/${l.league}/seasons/${year}/types/2/leaders`;
const athleteUrl = (l, id) => `${CORE}/${l.sport}/leagues/${l.league}/athletes/${encodeURIComponent(id)}`;
const athleteStatsUrl = (l, year, id) => `${CORE}/${l.sport}/leagues/${l.league}/seasons/${year}/types/2/athletes/${encodeURIComponent(id)}/statistics/0`;
const teamsUrl = (l) => `${BASE}/${l.sport}/${l.league}/teams?limit=${l.teamsQuery ? 500 : 100}${l.teamsQuery || ''}`;

module.exports = { LEAGUES, scoreboardUrl, standingsUrl, summaryUrl, rosterUrl, injuriesUrl, transactionsUrl, leadersUrl, athleteUrl, athleteStatsUrl, seasonYear, CORE, teamsUrl, dayStr };
