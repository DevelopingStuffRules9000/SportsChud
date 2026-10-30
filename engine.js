const { LEAGUES, scoreboardUrl, standingsUrl, summaryUrl, rosterUrl, injuriesUrl, transactionsUrl, leadersUrl, athleteUrl, athleteStatsUrl, seasonYear, teamsUrl, dayStr } = require('./leagues');

const dayCache = new Map(); // `${league}:${YYYYMMDD}` -> { at, events }

// Fetch one league's games for a list of days (one request per day, a few at a time).
// Returns { events, errors }: a failing day is reported but never blocks the others.
async function fetchDays(l, days, ttl = 0) {
  const events = new Map();
  const errors = [];
  const queue = [...days];
  const worker = async () => {
    while (queue.length) {
      const d = queue.shift();
      const ck = `${l.key}:${d}`;
      const hit = dayCache.get(ck);
      let evs;
      if (ttl && hit && Date.now() - hit.at < ttl) {
        evs = hit.events;
      } else {
        try {
          const res = await fetch(scoreboardUrl(l, d, 300), { signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw new Error(`${l.name}: HTTP ${res.status}`);
          evs = (await res.json()).events || [];
          dayCache.set(ck, { at: Date.now(), events: evs });
          if (dayCache.size > 400) { // a tray app runs for weeks: drop the oldest days
            const old = [...dayCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
            for (const [k] of old) dayCache.delete(k);
          }
        } catch (err) {
          errors.push(err.message);
          continue;
        }
      }
      for (const ev of evs) events.set(ev.id, ev);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { events: [...events.values()], errors: [...new Set(errors)] };
}

function ord(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Turns ESPN's status block into a readable label plus a key that changes
// whenever the game moves to a new period/inning/quarter/half.
function periodInfo(kind, st) {
  const state = st.type.state;
  if (state === 'pre') return { label: 'Upcoming', key: 'pre' };
  if (state === 'post') return { label: 'Final', key: 'post' };

  const p = st.period || 1;
  const name = st.type.name || '';
  if (name === 'STATUS_HALFTIME') return { label: 'Halftime', key: 'half' };
  if (name === 'STATUS_END_PERIOD') return { label: `End of ${ord(p)}`, key: `end${p}` };

  switch (kind) {
    case 'hockey':
      if (p <= 3) return { label: `${ord(p)} Period`, key: `p${p}` };
      if (p === 4) return { label: 'Overtime', key: 'ot' };
      // playoffs have no shootout: ESPN's own text ("2OT", "3OT") says which overtime this is
      if (/\bOT\b|\dOT/i.test(`${st.type.shortDetail || ''} ${st.type.detail || ''}`) && !/\bSO\b|shootout/i.test(`${st.type.shortDetail || ''} ${st.type.detail || ''}`)) return { label: `${p - 3}OT`, key: `ot${p}` };
      return { label: 'Shootout', key: 'so' };
    case 'baseball': {
      const d = st.type.shortDetail || `Inning ${p}`;
      return { label: d, key: d };
    }
    case 'football':
      if (p <= 4) return { label: `${ord(p)} Quarter`, key: `q${p}` };
      return { label: 'Overtime', key: 'ot' };
    case 'basketball':
      if (p <= 4) return { label: `${ord(p)} Quarter`, key: `q${p}` };
      return { label: p === 5 ? 'Overtime' : `${p - 4}OT`, key: `ot${p}` };
    default:
      return { label: `Period ${p}`, key: `p${p}` };
  }
}

// ESPN's displayClock is "4:32" while a period has minutes left and "12.3" in the final minute
function parseClock(s) {
  if (!s) return null;
  if (s.includes(':')) {
    const [m, sec] = s.split(':').map(Number);
    return Number.isFinite(m) && Number.isFinite(sec) ? m * 60 + sec : null;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Past regulation: hockey 4th+ period, football/basketball 5th+, baseball beyond the 9th
function isExtra(g) {
  switch (g.kind) {
    case 'hockey': return g.period >= 4;
    case 'baseball': return g.period > 9;
    case 'football':
    case 'basketball': return g.period >= 5;
    default: return false;
  }
}

// "Close game" = late in regulation and within a one-possession margin. Extra frames are
// covered by the Overtime alert instead, and break frames (end of period) are skipped.
const CLOSE_RULES = {
  hockey:     { period: (p) => p === 3, maxClock: 600, margin: 1 },  // 3rd period, last 10:00, within a goal
  basketball: { period: (p) => p === 4, maxClock: 300, margin: 5 },  // 4th quarter, last 5:00, within 5
  football:   { period: (p) => p === 4, maxClock: 300, margin: 8 },  // 4th quarter, last 5:00, within a score
  baseball:   { period: (p) => p === 8 || p === 9, maxClock: null, margin: 1 } // 8th/9th, within a run
};

function isCloseLate(g) {
  const r = CLOSE_RULES[g.kind];
  if (!r || g.state !== 'in' || g.isBreak || !r.period(g.period)) return false;
  if (Math.abs(g.home.score - g.away.score) > r.margin) return false;
  if (r.maxClock == null) return true;
  return g.clockSec != null && g.clockSec <= r.maxClock;
}

// First https URL found anywhere inside a value (ESPN's highlight objects vary in shape)
function firstUrl(v, depth = 0) {
  if (!v || depth > 6) return '';
  if (typeof v === 'string') return /^https:\/\//.test(v) ? v : '';
  if (Array.isArray(v)) { for (const x of v) { const u = firstUrl(x, depth + 1); if (u) return u; } return ''; }
  if (typeof v === 'object') {
    if (typeof v.href === 'string' && /^https:\/\//.test(v.href)) return v.href;
    for (const k of Object.keys(v)) { const u = firstUrl(v[k], depth + 1); if (u) return u; }
  }
  return '';
}

// ESPN highlight objects list a thumbnail (.jpg) before their links, so a blind "first URL"
// picks the image. Use the watch page explicitly, or build it from the clip id.
const isHttps = (u) => typeof u === 'string' && /^https:\/\//.test(u);
const isMedia = (u) => /\.(jpe?g|png|gif|webp|mp4|m3u8|mpd)(\?|$)/i.test(u);
function highlightUrl(list) {
  for (const h of Array.isArray(list) ? list : []) {
    if (!h || typeof h !== 'object') continue;
    const web = h.links && h.links.web;
    const cands = [web && web.href, web && web.self && web.self.href, web && web.seo && web.seo.href];
    const page = cands.find((u) => isHttps(u) && !isMedia(u));
    if (page) return page;
    if (h.id && /^\d+$/.test(String(h.id))) return `https://www.espn.com/video/clip/_/id/${h.id}`;
  }
  return '';
}

function parseEvent(l, ev) {
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const st = ev.status || comp.status;
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  if (!home || !away || !st) return null;
  const side = (c) => ({
    id: String(c.team.id),
    name: c.team.displayName,
    nick: c.team.name || '',
    abbr: c.team.abbreviation,
    logo: c.team.logo || (c.team.logos && c.team.logos[0] && c.team.logos[0].href) || '',
    color: c.team.color ? '#' + c.team.color : null,
    score: Number(c.score || 0)
  });
  const { label, key } = periodInfo(l.kind, st);
  return {
    id: `${l.key}:${ev.id}`,
    eventId: String(ev.id),
    league: l.key,
    leagueName: l.name,
    icon: l.icon,
    kind: l.kind,
    date: ev.date,
    state: st.type.state, // pre | in | post
    label,
    key,
    clock: st.displayClock || '',
    clockSec: parseClock(st.displayClock),
    period: st.period || 0,
    isBreak: st.type.name === 'STATUS_END_PERIOD' || st.type.name === 'STATUS_HALFTIME',
    detail: st.type.shortDetail || '',
    home: side(home),
    away: side(away),
    link: firstUrl((ev.links || []).filter((x) => (x.rel || []).includes('summary'))) || firstUrl(ev.links),
    highlight: highlightUrl(comp.highlights),
    broadcast: [...new Set((comp.broadcasts || []).flatMap((b) => b.names || []))].join(', ')
  };
}

/* ---------- Standings ---------- */
const standCache = new Map(); // league key -> { at, data }

// ESPN nests teams as children (conference > division). Every node that has standings.entries becomes a table.
function parseStandings(l, data) {
  const groups = [];
  let season = '';
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const st = node.standings;
    if (st && Array.isArray(st.entries) && st.entries.length) {
      if (!season) season = st.seasonDisplayName || '';
      const rows = st.entries.map((e) => {
        const t = e.team || {};
        const stats = {};
        let sort = null, seed = 0, clincher = '';
        for (const s of e.stats || []) {
          const val = s.summary != null ? s.summary : s.displayValue;
          if (s.name) stats[s.name] = val;
          if (s.type === 'lasttengames') stats.lasttengames = val;
          if (s.name === l.sortStat && typeof s.value === 'number') sort = s.value;
          if (s.name === 'playoffSeed') seed = Number(s.value) || 0;
          if (s.name === 'clincher' && s.displayValue && s.displayValue !== '-' && s.displayValue.length <= 3) clincher = s.displayValue;
        }
        return {
          teamId: String(t.id),
          name: t.displayName || t.name || '',
          abbr: t.abbreviation || '',
          logo: (t.logos && t.logos[0] && t.logos[0].href) || t.logo || '',
          stats, sort, seed, clincher
        };
      });
      // Prefer ESPN's seeds when every team has one, otherwise rank by the league's main stat
      if (rows.every((r) => r.seed > 0)) rows.sort((a, b) => a.seed - b.seed);
      else if (rows.every((r) => r.sort != null)) rows.sort((a, b) => b.sort - a.sort);
      groups.push({ name: node.name || node.abbreviation || '', rows });
    }
    for (const c of node.children || []) walk(c);
  };
  walk(data);
  return { season, groups };
}

async function fetchStandings(l, ttl = 300000) {
  const hit = standCache.get(l.key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(standingsUrl(l));
  if (!res.ok) throw new Error(`${l.name} standings: HTTP ${res.status}`);
  const data = parseStandings(l, await res.json());
  if (!data.groups.length) throw new Error(`${l.name} standings: no data returned`);
  standCache.set(l.key, { at: Date.now(), data });
  return data;
}

/* ---------- Standings change alerts ---------- */
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// Wording for ESPN's clinch markers; anything unknown falls back to showing the marker itself
const CLINCH_TEXT = {
  x: 'Clinched a playoff spot',
  y: 'Clinched the division',
  z: 'Clinched the top seed',
  e: 'Eliminated from playoff contention'
};

// A string that changes when a team's own results (games played, W/L/OTL/T, points) change. Used to tell
// that ESPN has counted a finished game, because the standings feed lags the final by a few minutes.
function recordSig(stats) {
  const keys = ['gamesPlayed', 'wins', 'losses', 'otLosses', 'ties', 'points'];
  const sig = keys.map((k) => (stats && stats[k] != null ? stats[k] : '')).join('|');
  return sig.replace(/\|/g, '') ? sig : JSON.stringify(stats || {});
}

// teamId -> where the team sits in its table right now
function standingsSnapshot(data) {
  const snap = new Map();
  for (const g of (data && data.groups) || []) {
    g.rows.forEach((r, i) => {
      if (snap.has(r.teamId)) return;
      const s = r.stats || {};
      snap.set(r.teamId, {
        group: g.name, rank: i + 1, clincher: r.clincher || '',
        sig: recordSig(s), record: String(s.overall || s.record || '')
      });
    });
  }
  return snap;
}

// What moved for one team between two snapshots: a list of short phrases, empty when nothing did
function standingsChanges(before, after) {
  if (!before || !after) return [];
  const out = [];
  if (before.group === after.group && after.rank !== before.rank) {
    out.push(`${after.rank < before.rank ? 'Moved up' : 'Dropped'} to ${ordinal(after.rank)} in ${after.group || 'the standings'} (was ${ordinal(before.rank)})`);
  }
  if (after.clincher && after.clincher !== before.clincher) {
    out.push(`${CLINCH_TEXT[after.clincher] || `Now marked "${after.clincher}"`} (${after.clincher})`);
  }
  return out;
}

/* ---------- Playoffs ---------- */
const postCache = new Map(); // league key -> { at, on }
const POST_TTL_FALLBACK = 540000; // a failed lookup is retried after ~1 minute instead of 10
const seasonType = (v) => (v && typeof v === 'object' ? Number(v.type) : Number(v));

// Cheap check: is this league in its postseason today? One request, cached for 10 minutes.
async function isPostseason(l, ttl = 600000) {
  const hit = postCache.get(l.key);
  if (hit && Date.now() - hit.at < ttl) return hit.on;
  let on = hit ? hit.on : false; // keep the last answer if the network hiccups
  try {
    const res = await fetch(scoreboardUrl(l, dayStr(new Date()), 50), { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    {
      const j = await res.json();
      const top = seasonType(j.season && j.season.type);
      const lg = seasonType(j.leagues && j.leagues[0] && j.leagues[0].season && j.leagues[0].season.type);
      on = top === 3 || lg === 3 || (j.events || []).some((ev) => ev.season && ev.season.type === 3);
    }
  } catch (_) {
    // offline moment: keep the last answer but ask again soon instead of trusting it for the whole TTL
    postCache.set(l.key, { at: Date.now() - POST_TTL_FALLBACK, on });
    return on;
  }
  postCache.set(l.key, { at: Date.now(), on });
  return on;
}

// Builds the series (or single games, e.g. NFL) from postseason scoreboard events. ESPN attaches the
// running series score to every playoff event, so no separate bracket feed is needed.
// `back` = how many days of results to look at (the Playoffs tab uses the default; working out who is out of the
// playoffs looks back over the whole postseason), `keepDays` = how long a finished series stays in the list.
async function fetchPlayoffs(l, { back = 14, keepDays = 4 } = {}) {
  const now = new Date();
  const dayOf = (i) => dayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
  let events, errors;
  if (back <= 14) {
    const days = [];
    for (let i = -back; i <= 2; i++) days.push(dayOf(i));
    ({ events, errors } = await fetchDays(l, days, 300000));
  } else {
    // Long look-back: results older than a few days don't change, so those days are cached for hours
    const recent = [], old = [];
    for (let i = -back; i <= 2; i++) (i >= -3 ? recent : old).push(dayOf(i));
    const [a, b] = await Promise.all([fetchDays(l, recent, 300000), fetchDays(l, old, 6 * 3600000)]);
    const byId = new Map();
    for (const ev of [...a.events, ...b.events]) byId.set(ev.id, ev);
    events = [...byId.values()];
    errors = [...new Set([...a.errors, ...b.errors])];
  }

  const groups = new Map();
  for (const ev of events) {
    if (!ev.season || ev.season.type !== 3) continue;
    const g = parseEvent(l, ev);
    if (!g) continue;
    const comp = ev.competitions[0];
    const note = ((comp.notes || []).map((n) => n.headline).find(Boolean)) || '';
    const round = note.replace(/\s*[-–]\s*Game\s*\d+.*$/i, '').trim() || 'Playoffs';
    const gm = note.match(/Game\s*(\d+)/i);
    const sr = comp.series && comp.series.type === 'playoff' ? comp.series : null;
    const wins = {};
    if (sr) for (const c of sr.competitors || []) wins[String(c.id)] = Number(c.wins) || 0;
    const key = sr ? [g.home.id, g.away.id].sort().join('-') : g.id;
    if (!groups.has(key)) groups.set(key, { sr: !!sr, games: [] });
    groups.get(key).games.push({ g, round, gameNo: gm ? Number(gm[1]) : null, wins, summary: sr ? sr.summary || '' : '', completed: !!(sr && sr.completed), bestOf: sr ? Number(sr.totalCompetitions) || 0 : 1 });
  }

  const out = [];
  for (const [key, grp] of groups) {
    const games = grp.games.sort((a, b) => new Date(a.g.date) - new Date(b.g.date));
    const first = games[0].g;
    // The event with the most series wins carries the newest series state
    const total = (x) => Object.values(x.wins).reduce((s, n) => s + n, 0);
    const latest = games.reduce((best, x) => (total(x) >= total(best) ? x : best), games[0]);
    const lastGame = games[games.length - 1];
    const liveGame = games.find((x) => x.g.state === 'in');
    const nextGame = games.find((x) => x.g.state === 'pre');
    const need = latest.bestOf ? Math.ceil(latest.bestOf / 2) : 0;
    const teamsRaw = [first.home, first.away]; // higher seed hosts game 1
    const completed = grp.sr
      ? latest.completed || (need > 0 && teamsRaw.some((t) => (latest.wins[t.id] || 0) >= need))
      : lastGame.g.state === 'post';
    const cur = liveGame || lastGame;
    const scoreOf = (id) => (cur.g.home.id === id ? cur.g.home.score : cur.g.away.score);
    out.push({
      id: key,
      league: l.key,
      leagueName: l.name,
      icon: l.icon,
      round: latest.round,
      single: !grp.sr,
      bestOf: latest.bestOf,
      teams: teamsRaw.map((t) => ({ id: t.id, name: t.name, abbr: t.abbr, logo: t.logo, color: t.color, wins: latest.wins[t.id] || 0, score: scoreOf(t.id) })),
      summary: latest.summary,
      completed,
      live: liveGame ? { label: liveGame.g.label, clock: liveGame.g.kind === 'baseball' ? '' : liveGame.g.clock, gameNo: liveGame.gameNo } : null,
      next: !completed && nextGame ? { date: nextGame.g.date, gameNo: nextGame.gameNo } : null,
      state: cur.g.state,
      firstDate: first.date,
      lastDate: lastGame.g.date
    });
  }
  // Drop series that finished a while ago; keep the freshest results on screen
  const cutoff = Date.now() - keepDays * 86400000;
  const kept = out.filter((s) => !s.completed || new Date(s.lastDate).getTime() >= cutoff);
  return { series: kept, errors };
}

// Is any followed team still alive in these series? Alive = in a series that isn't over, or won the one
// that just ended (the next round may not be on the scoreboard yet). Eliminated or absent teams don't count.
function followedAlive(series, ids) {
  for (const s of series) {
    if (!s.teams.some((t) => ids.has(t.id))) continue;
    if (!s.completed) return true;
    const val = (t) => (s.single ? t.score : t.wins);
    const [a, b] = s.teams;
    const winner = val(a) === val(b) ? null : val(a) > val(b) ? a : b;
    if (winner && ids.has(winner.id)) return true;
  }
  return false;
}

// How a team stands in the postseason, judged by its newest series: 'alive' while that series is still going or
// once it has won it (the next round may not be scheduled yet), 'out' if it lost it, 'absent' if it is in none.
function playoffsOutcome(series, teamId) {
  const mine = series
    .filter((s) => s.teams.some((t) => t.id === teamId))
    .sort((a, b) => new Date(a.lastDate) - new Date(b.lastDate));
  if (!mine.length) return 'absent';
  const s = mine[mine.length - 1];
  if (!s.completed) return 'alive';
  const val = (t) => (s.single ? t.score : t.wins);
  const [a, b] = s.teams;
  const winner = val(a) === val(b) ? null : val(a) > val(b) ? a : b;
  return !winner || winner.id === teamId ? 'alive' : 'out'; // no clear winner: don't guess
}

/* ---------- Teams that are out ---------- */
// Which followed teams are out of the season or the playoffs, as "league:teamId" keys. Only ever answers "out"
// on positive evidence, because a wrong answer would hide a live team from the app:
//   - it lost its newest playoff series,
//   - ESPN's standings mark it eliminated ("e"),
//   - NHL and NBA only (no byes): the playoffs have been going for a few days and it never appeared in them.
// MLB and NFL give the top seeds byes and college bowls are one game each, so for those an absent team is
// just waiting for its first game and counts as alive. Anything that can't be worked out counts as alive.
const OUT_AFTER_DAYS = 3;
async function fetchOutTeams(follows) {
  const out = [];
  const byLeague = new Map();
  for (const f of follows || []) {
    if (!byLeague.has(f.league)) byLeague.set(f.league, []);
    byLeague.get(f.league).push(f);
  }
  await Promise.all([...byLeague].map(async ([key, teams]) => {
    const l = LEAGUES.find((x) => x.key === key);
    if (!l) return;
    const out0 = new Set();
    let elim = new Set();
    try {
      const st = await fetchStandings(l);
      for (const g of st.groups) for (const r of g.rows) if (r.clincher === 'e') elim.add(r.teamId);
    } catch (_) {} // no standings: judge by the playoffs alone
    try {
      if (await isPostseason(l)) {
        const { series, errors } = await fetchPlayoffs(l, { back: 75, keepDays: 3650 });
        const hasByes = l.kind === 'baseball' || l.kind === 'football';
        const started = series.length ? Math.min(...series.map((s) => new Date(s.firstDate).getTime())) : Infinity;
        const settled = !errors.length && series.length > 0 && Date.now() - started >= OUT_AFTER_DAYS * 86400000;
        for (const f of teams) {
          const o = playoffsOutcome(series, f.teamId);
          if (o === 'out' || (o === 'absent' && !hasByes && settled)) out0.add(f.teamId);
        }
      }
    } catch (_) {}
    for (const f of teams) if (out0.has(f.teamId) || elim.has(f.teamId)) out.push(`${key}:${f.teamId}`);
  }));
  return out;
}

/* ---------- Season status ---------- */
const seasonCache = new Map(); // league key -> { at, on }

// A league counts as in season when it has games from 2 days ago to 10 days ahead (covers preseason,
// regular season and postseason without relying on ESPN's season metadata). Cached for 3 hours.
// If ESPN can't be reached the last answer is kept, and with no answer yet the league counts as in season,
// so a network problem never hides a sport.
async function isInSeason(l, ttl = 3 * 3600000) {
  const hit = seasonCache.get(l.key);
  if (hit && Date.now() - hit.at < ttl) return hit.on;
  const now = new Date();
  const days = [];
  for (let i = -2; i <= 10; i++) days.push(dayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)));
  const { events, errors } = await fetchDays(l, days, ttl);
  let on;
  if (events.length) on = true;
  else if (errors.length) on = hit ? hit.on : true; // unknown: don't hide
  else on = false;
  // an unknown answer is only remembered for a few minutes
  seasonCache.set(l.key, { at: errors.length && !events.length ? Date.now() - ttl + 5 * 60000 : Date.now(), on });
  return on;
}

/* ---------- Rosters ---------- */
const rosterCache = new Map(); // `${league}:${teamId}` -> { at, data }

const playerCard = (a) => {
  const l = (a.links || []).find((x) => (x.rel || []).includes('playercard')) || (a.links || [])[0];
  return l && /^https:\/\//.test(l.href || '') ? l.href : '';
};
// An athlete's id: ESPN's injury feed often leaves `id` off, so fall back to its $ref or the player-card link (.../id/3114/...)
const athleteId = (a) => {
  a = a && typeof a === 'object' ? a : {};
  if (a.id != null && /^\d+$/.test(String(a.id))) return String(a.id);
  const m = /\/athletes\/(\d+)/.exec(String(a.$ref || '')) || /\/id\/(\d+)/.exec(playerCard(a)) || /\/(?:player|athletes)\/(?:[^\s?#]*\/)?(\d+)/.exec(playerCard(a));
  return m ? m[1] : '';
};
const prettyGroup = (s) =>
  String(s || 'Roster').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

function parseRoster(data) {
  const raw = Array.isArray(data.athletes) ? data.athletes.filter(Boolean) : [];
  const mapAthlete = (a) => ({
    id: athleteId(a) || String(a.id),
    name: a.displayName || a.fullName || '',
    jersey: a.jersey != null ? String(a.jersey) : '',
    pos: (a.position && a.position.abbreviation) || '',
    age: a.age != null ? a.age : '',
    height: a.displayHeight || '',
    weight: a.displayWeight || '',
    exp: a.experience && a.experience.years != null ? a.experience.years : '',
    headshot: (a.headshot && a.headshot.href) || '',
    injury: (a.injuries && a.injuries[0] && (a.injuries[0].status || 'Injured')) || '',
    link: playerCard(a)
  });
  const byJersey = (x, y) => (Number.isNaN(parseInt(x.jersey, 10)) ? 999 : parseInt(x.jersey, 10)) - (Number.isNaN(parseInt(y.jersey, 10)) ? 999 : parseInt(y.jersey, 10)) || x.name.localeCompare(y.name);

  const groups = [];
  if (raw.length && raw.every((g) => g && Array.isArray(g.items))) {
    // Grouped by unit (NHL, NFL, MLB)
    for (const g of raw) if (g.items.length) groups.push({ title: prettyGroup(g.position), players: g.items.map(mapAthlete).sort(byJersey) });
  } else {
    // Flat list (NBA): group by position
    const map = new Map();
    for (const a of raw) {
      const p = mapAthlete(a);
      const title = prettyGroup((a.position && (a.position.displayName || a.position.name)) || 'Roster');
      if (!map.has(title)) map.set(title, []);
      map.get(title).push(p);
    }
    for (const [title, players] of map) groups.push({ title, players: players.sort(byJersey) });
  }
  const coachRaw = Array.isArray(data.coach) ? data.coach[0] : null;
  const coach = coachRaw ? `${coachRaw.firstName || ''} ${coachRaw.lastName || ''}`.trim() : '';
  return { coach, count: groups.reduce((n, g) => n + g.players.length, 0), groups };
}

async function fetchRoster(l, teamId, ttl = 600000) {
  const ck = `${l.key}:${teamId}`;
  const hit = rosterCache.get(ck);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(rosterUrl(l, teamId));
  if (!res.ok) throw new Error(`${l.name} roster: HTTP ${res.status}`);
  const data = parseRoster(await res.json());
  if (!data.count) throw new Error(`${l.name} roster: no players returned`);
  rosterCache.set(ck, { at: Date.now(), data });
  return data;
}

/* ---------- Injuries ---------- */
const injCache = new Map(); // league key -> { at, data }

function parseInjuries(l, data) {
  const teams = [];
  for (const t of (data.injuries || []).filter(Boolean)) {
    const items = (t.injuries || []).filter(Boolean).map((i) => {
      const a = i.athlete || {};
      const d = i.details || {};
      return {
        id: String(i.id),
        playerId: athleteId(a),
        name: a.displayName || [a.firstName, a.lastName].filter(Boolean).join(' '),
        pos: (a.position && a.position.abbreviation) || '',
        headshot: (a.headshot && a.headshot.href) || '',
        status: i.status || (i.type && i.type.description) || 'Unknown',
        kind: [d.side, d.type].filter(Boolean).join(' '),
        returnDate: d.returnDate || '',
        date: i.date || '',
        comment: i.shortComment || '',
        link: playerCard(a)
      };
    }).sort((x, y) => (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0));
    if (!items.length) continue;
    const at = (t.injuries.find((i) => i.athlete && i.athlete.team) || {}).athlete;
    const team = (at && at.team) || {};
    const abbr = team.abbreviation || '';
    teams.push({
      teamId: String(t.id),
      name: t.displayName || team.displayName || '',
      abbr,
      logo: (team.logos && team.logos[0] && team.logos[0].href) || (abbr ? `https://a.espncdn.com/i/teamlogos/${l.league}/500/${abbr.toLowerCase()}.png` : ''),
      items
    });
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));
  return { teams, total: teams.reduce((n, t) => n + t.items.length, 0) };
}

async function fetchInjuries(l, ttl = 300000) {
  const hit = injCache.get(l.key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(injuriesUrl(l));
  if (!res.ok) throw new Error(`${l.name} injuries: HTTP ${res.status}`);
  const data = parseInjuries(l, await res.json());
  injCache.set(l.key, { at: Date.now(), data });
  return data;
}

/* ---------- Who scored (details for scoring alerts) ---------- */
// ESPN's per-game summary lists every scoring play with the running score. Only used to say who scored,
// so every function here is defensive: anything unexpected just means the alert goes out without detail.
function parseScoringPlays(data) {
  let plays = data && Array.isArray(data.scoringPlays) ? data.scoringPlays : null;
  if (!plays) plays = ((data && Array.isArray(data.plays)) ? data.plays : []).filter((p) => p && p.scoringPlay);
  return plays
    .map((p) => ({
      away: Number(p.awayScore),
      home: Number(p.homeScore),
      text: String((p && (p.text || p.shortText)) || '').trim()
    }))
    .filter((p) => Number.isFinite(p.away) && Number.isFinite(p.home) && p.text)
    .sort((a, b) => a.away + a.home - (b.away + b.home));
}

async function fetchScoringPlays(l, eventId) {
  const res = await fetch(summaryUrl(l, eventId), { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`${l.name} summary: HTTP ${res.status}`);
  return parseScoringPlays(await res.json());
}

// The plays that account for the score moving from `prev` to `cur`, oldest first. `complete` means the last one
// lands exactly on the current score, i.e. the summary feed has caught up with the scoreboard feed.
function playsBetween(plays, prev, cur) {
  const found = plays.filter((p) => (p.away > prev.away || p.home > prev.home) && p.away <= cur.away && p.home <= cur.home);
  const last = found[found.length - 1];
  return { plays: found, complete: !!last && last.away === cur.away && last.home === cur.home };
}

// ESPN puts season totals in brackets ("Auston Matthews (12) Wrist Shot ..."); drop them and keep it toast-sized
function cleanPlayText(t) {
  const s = String(t || '').replace(/\s*\(\d+\)/g, '').replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 137).trimEnd() + '…' : s;
}

/* ---------- Game detail (the panel opened from Scores) ---------- */
// One normalized object from ESPN's per-game summary: line score, team stats, scoring summary, box score and
// recent plays. ESPN's shape differs per sport and is undocumented, so every read is defensive and a missing
// section just comes back empty (the panel then says there is nothing yet) instead of failing the whole view.
const asArr = (v) => (Array.isArray(v) ? v : []);
const objs = (v) => asArr(v).filter((x) => x && typeof x === 'object'); // lists of objects: skip null/odd entries
const asTxt = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const DETAIL_PLAYS = 30, DETAIL_ROWS = 40, DETAIL_STATS = 24;

// Column heading for the Nth period of a line score
function periodHead(kind, n) {
  if (kind === 'baseball') return String(n);
  if (kind === 'hockey') return n <= 3 ? String(n) : n === 4 ? 'OT' : 'SO';
  return n <= 4 ? String(n) : n === 5 ? 'OT' : `${n - 4}OT`;
}

function allPlays(data) {
  let list = objs(data.plays);
  if (!list.length && data.drives && typeof data.drives === 'object') { // football keeps its plays inside drives
    list = [...objs(data.drives.previous), data.drives.current].filter((d) => d && typeof d === 'object').flatMap((d) => objs(d.plays));
  }
  return list;
}

function parseGameDetail(l, data) {
  data = data && typeof data === 'object' ? data : {};
  const comp = objs(data.header && data.header.competitions)[0] || {};
  const teams = objs(comp.competitors).map((c) => {
    const t = c.team || {};
    return {
      id: asTxt(t.id || c.id),
      homeAway: c.homeAway === 'home' ? 'home' : 'away',
      name: asTxt(t.displayName || t.name),
      abbr: asTxt(t.abbreviation),
      score: asTxt(c.score),
      lines: objs(c.linescores).map((s) => asTxt(s.displayValue != null ? s.displayValue : s.value))
    };
  });
  const abbrOf = (id) => (teams.find((t) => t.id === asTxt(id)) || {}).abbr || '';
  const periods = Math.max(0, ...teams.map((t) => t.lines.length));
  const heads = Array.from({ length: periods }, (_, i) => periodHead(l.kind, i + 1));

  const periodText = (p) => asTxt(p && (p.displayValue || (p.number != null ? periodHead(l.kind, Number(p.number)) : '')));
  const mapPlay = (p) => ({
    text: cleanPlayText(p.text || p.shortText),
    period: periodText(p.period),
    clock: asTxt(p.clock && p.clock.displayValue),
    team: abbrOf(p.team && p.team.id),
    away: p.awayScore != null ? asTxt(p.awayScore) : '',
    home: p.homeScore != null ? asTxt(p.homeScore) : '',
    scoring: !!p.scoringPlay
  });

  const plays = allPlays(data);
  let scoring = objs(data.scoringPlays);
  if (!scoring.length) scoring = plays.filter((p) => p && p.scoringPlay);
  const scoringOut = scoring.map(mapPlay).filter((p) => p.text);
  const recent = plays.map(mapPlay).filter((p) => p.text).slice(-DETAIL_PLAYS).reverse(); // newest first

  const box = data.boxscore || {};
  const teamStats = objs(box.teams).map((t) => ({
    id: asTxt(t.team && t.team.id),
    stats: objs(t.statistics).map((s) => ({ label: asTxt(s.label || s.name), value: asTxt(s.displayValue != null ? s.displayValue : s.value) }))
      .filter((s) => s.label && s.value).slice(0, DETAIL_STATS)
  }));
  const players = objs(box.players).map((p) => ({
    id: asTxt(p.team && p.team.id),
    groups: objs(p.statistics).map((g) => {
      const name = asTxt(g.text || g.name || g.type);
      return {
        name: name.charAt(0).toUpperCase() + name.slice(1),
        labels: asArr(g.labels).map(asTxt),
        rows: objs(g.athletes).slice(0, DETAIL_ROWS).map((a) => ({
          id: asTxt(a.athlete && a.athlete.id),
          name: asTxt(a.athlete && (a.athlete.shortName || a.athlete.displayName)),
          jersey: asTxt(a.athlete && a.athlete.jersey),
          stats: asArr(a.stats).map(asTxt)
        })).filter((r) => r.name),
        totals: asArr(g.totals).map(asTxt)
      };
    }).filter((g) => g.rows.length)
  })).filter((p) => p.groups.length);

  return { heads, teams, teamStats, scoring: scoringOut, plays: recent, players, winProb: parseWinProb(data, teams), leaders: parseGameLeaders(data) };
}

// Win probability from the summary feed: `winprobability` is one row per play (homeWinPercentage, as a fraction or
// a percent depending on the sport), `predictor` is the pre-game projection. Returns null when there is neither.
const pct = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function parseWinProb(data, teams) {
  const rows = objs(data.winprobability).map((r) => pct(r.homeWinPercentage)).filter((n) => n != null);
  if (rows.length) {
    const scale = rows.some((n) => n > 1) ? 1 : 100; // fractions (0..1) become percent
    const all = rows.map((n) => Math.max(0, Math.min(100, n * scale)));
    const stride = Math.max(1, Math.ceil(all.length / 60)); // a small trend line is enough
    const trend = all.filter((_, i) => i % stride === 0);
    if (trend[trend.length - 1] !== all[all.length - 1]) trend.push(all[all.length - 1]);
    const home = all[all.length - 1];
    return { home: Math.round(home * 10) / 10, away: Math.round((100 - home) * 10) / 10, trend, live: true };
  }
  const pred = data.predictor && typeof data.predictor === 'object' ? data.predictor : null;
  if (pred) {
    const h = pct(pred.homeTeam && pred.homeTeam.gameProjection);
    const a = pct(pred.awayTeam && pred.awayTeam.gameProjection);
    if (h != null || a != null) {
      const home = h != null ? h : 100 - a;
      return { home: Math.round(home * 10) / 10, away: Math.round((100 - home) * 10) / 10, trend: [], live: false };
    }
  }
  return null;
}

// Top performers per team ("leaders" in the summary feed: one entry per team, each with a few stat categories)
const LEADER_CATS = 4;
function parseGameLeaders(data) {
  return objs(data.leaders).map((t) => ({
    id: asTxt(t.team && t.team.id),
    abbr: asTxt(t.team && t.team.abbreviation),
    categories: objs(t.leaders).map((c) => {
      const top = objs(c.leaders)[0];
      if (!top) return null;
      const a = top.athlete || {};
      return {
        label: asTxt(c.shortDisplayName || c.displayName || c.name),
        name: asTxt(a.shortName || a.displayName || a.fullName),
        pos: asTxt(a.position && a.position.abbreviation),
        value: asTxt(top.displayValue != null ? top.displayValue : top.value),
        detail: asTxt(top.summary || top.mainStat && top.mainStat.value)
      };
    }).filter((c) => c && c.name && c.value).slice(0, LEADER_CATS)
  })).filter((t) => t.categories.length);
}

/* ---------- Pickups (trades and signings) ---------- */
const txCache = new Map(); // league key -> { at, data }
// What kind of move is it? Used for the little tag on each row.
function txKind(text) {
  const t = String(text || '').toLowerCase();
  if (/\btrad(ed|e)\b|\bacquir/.test(t)) return 'Trade';
  if (/waiv|claim|designated for assignment/.test(t)) return 'Waivers';
  if (/releas|cut\b|terminat|buyout|bought out/.test(t)) return 'Released';
  if (/\bsign(ed|s|ing)?\b|extension|extend|agree|contract/.test(t)) return 'Signing';
  if (/recall|assign|call(ed)? up|optioned|send|sent down|reassign|promot/.test(t)) return 'Roster move';
  if (/injur|placed on|reserve|activate|\bil\b|suspen/.test(t)) return 'Status';
  if (/draft/.test(t)) return 'Draft';
  return 'Move';
}
function parseTransactions(l, data) {
  const list = objs(data && (data.transactions || data.items));
  const items = list.map((t, i) => {
    const team = t.team && typeof t.team === 'object' ? t.team : {};
    const abbr = asTxt(team.abbreviation);
    const text = asTxt(t.description || t.text || t.headline);
    return {
      id: asTxt(t.id) || `${i}`,
      date: asTxt(t.date),
      text,
      kind: txKind(text),
      teamId: asTxt(team.id),
      team: asTxt(team.displayName || team.name),
      abbr,
      logo: (team.logos && team.logos[0] && team.logos[0].href) || asTxt(team.logo) || (abbr ? `https://a.espncdn.com/i/teamlogos/${l.league}/500/${abbr.toLowerCase()}.png` : '')
    };
  }).filter((t) => t.text);
  items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return { items: items.slice(0, 150) };
}
async function fetchTransactions(l, ttl = 600000) {
  const hit = txCache.get(l.key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(transactionsUrl(l), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${l.name} trades and signings: HTTP ${res.status}`);
  const data = parseTransactions(l, await res.json());
  txCache.set(l.key, { at: Date.now(), data });
  return data;
}

/* ---------- Leaderboards (season leaders) ---------- */
// ESPN's core API lists leaders per category with links ($ref) to the athlete and team. A category's top players are
// resolved one category at a time (and cached), so opening the tab is one request plus a handful.
const leadCache = new Map(); // league key -> { at, data: { season, categories: [{ name, label, abbr, leaders: [{ id, value, teamId }] }] } }
const athleteCache = new Map(); // `${league}:${athleteId}` -> { at, a }
const teamIdxCache = new Map(); // league key -> { at, map: teamId -> { abbr, name, logo } }
const CORE_HOST = 'sports.core.api.espn.com';
const safeRef = (ref) => {
  try {
    const u = new URL(String(ref).replace(/^http:/, 'https:'));
    return u.protocol === 'https:' && u.hostname === CORE_HOST ? u.toString() : null; // only ever follow links to ESPN's core API
  } catch (_) { return null; }
};
const idFromRef = (ref, seg) => { const m = new RegExp(`/${seg}/(\\d+)`).exec(String(ref || '')); return m ? m[1] : ''; };
const LEADER_ROWS = 10;

function parseLeaders(data) {
  return objs(data && data.categories).map((c) => ({
    name: asTxt(c.name),
    label: asTxt(c.displayName || c.name),
    abbr: asTxt(c.shortDisplayName || c.abbreviation),
    leaders: objs(c.leaders).slice(0, LEADER_ROWS).map((x) => ({
      id: idFromRef(x.athlete && x.athlete.$ref, 'athletes'),
      teamId: idFromRef(x.team && x.team.$ref, 'teams'),
      ref: x.athlete && x.athlete.$ref ? String(x.athlete.$ref) : '',
      value: asTxt(x.displayValue != null ? x.displayValue : x.value)
    })).filter((x) => x.id && x.value)
  })).filter((c) => c.name && c.leaders.length);
}

async function leagueTeamIndex(l) {
  const hit = teamIdxCache.get(l.key);
  if (hit && Date.now() - hit.at < 24 * 3600000) return hit.map;
  const map = new Map();
  try {
    const res = await fetch(teamsUrl(l), { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const j = await res.json();
      const list = objs(j && j.sports && j.sports[0] && j.sports[0].leagues && j.sports[0].leagues[0] && j.sports[0].leagues[0].teams);
      for (const { team: t } of list.filter((x) => x.team)) {
        map.set(asTxt(t.id), { abbr: asTxt(t.abbreviation), name: asTxt(t.displayName), logo: asTxt(t.logos && t.logos[0] && t.logos[0].href) });
      }
    }
  } catch (_) {}
  if (map.size) teamIdxCache.set(l.key, { at: Date.now(), map });
  return map;
}

async function fetchLeaderCategories(l, ttl = 900000) {
  const hit = leadCache.get(l.key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const year = seasonYear(l);
  let lastErr = null;
  for (const y of [year, year - 1]) { // before the season starts ESPN may only have last year's numbers
    try {
      const res = await fetch(leadersUrl(l, y), { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`${l.name} leaders: HTTP ${res.status}`);
      const categories = parseLeaders(await res.json());
      if (!categories.length) throw new Error(`${l.name} has no leaders listed yet`);
      const data = { season: y, categories };
      leadCache.set(l.key, { at: Date.now(), data });
      return data;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('No leaders');
}

async function fetchAthlete(l, entry) {
  const ck = `${l.key}:${entry.id}`;
  const hit = athleteCache.get(ck);
  if (hit && Date.now() - hit.at < 24 * 3600000) return hit.a;
  let a = { name: '', pos: '', headshot: '', link: '' };
  const url = safeRef(entry.ref);
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json();
        a = {
          name: asTxt(j.displayName || j.fullName || j.shortName),
          pos: asTxt(j.position && j.position.abbreviation),
          headshot: asTxt(j.headshot && j.headshot.href),
          link: playerCard(j),
          teamId: idFromRef(j.team && j.team.$ref, 'teams')
        };
        athleteCache.set(ck, { at: Date.now(), a });
      }
    } catch (_) {}
  }
  return a;
}

// Runs fn over items, a few at a time
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

// One league's leaderboard: the list of categories plus the rows of the one asked for (the first by default)
async function fetchLeaderboard(l, catName) {
  const { season, categories } = await fetchLeaderCategories(l);
  const cat = categories.find((c) => c.name === catName) || categories[0];
  const [teams, athletes] = await Promise.all([leagueTeamIndex(l), pool(cat.leaders, 6, (e) => fetchAthlete(l, e))]);
  const rows = cat.leaders.map((e, i) => {
    const a = athletes[i] || {};
    const t = teams.get(e.teamId || a.teamId || '') || {};
    return {
      rank: i + 1, id: e.id, name: a.name || `Player ${e.id}`, pos: a.pos || '', headshot: a.headshot || '', link: a.link || '',
      teamId: e.teamId || a.teamId || '', team: t.abbr || '', teamLogo: t.logo || (t.abbr ? `https://a.espncdn.com/i/teamlogos/${l.league}/500/${t.abbr.toLowerCase()}.png` : ''),
      value: e.value
    };
  });
  return { season, categories: categories.map((c) => ({ name: c.name, label: c.label, abbr: c.abbr })), category: { name: cat.name, label: cat.label, rows } };
}

// One player: bio from the core athlete record plus the season's regular-season stats (grouped by category).
// ESPN's stats payload is `splits.categories[].stats[]`; written from its usual layout, unverified against live data.
const playerCache = new Map(); // `${league}:${id}` -> { at, data }
// Hockey players' stat groups read Offensive, then Defensive, then Penalties (ESPN's own order differs); the rest keep theirs
const HOCKEY_ORDER = ['general', 'offensive', 'defensive', 'penalties'];
const orderCats = (cats, kind) => {
  if (kind !== 'hockey') return cats;
  const rank = (c) => { const i = HOCKEY_ORDER.indexOf(c.name.toLowerCase()); return i < 0 ? HOCKEY_ORDER.length : i; };
  return cats.map((c, i) => [c, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([c]) => c);
};
function parsePlayer(a, stats, teams, kind) {
  a = a && typeof a === 'object' ? a : {};
  const tid = idFromRef(a.team && a.team.$ref, 'teams');
  const t = teams.get(tid) || {};
  const bp = a.birthPlace && typeof a.birthPlace === 'object' ? [a.birthPlace.city, a.birthPlace.state, a.birthPlace.country].map(asTxt).filter(Boolean).join(', ') : '';
  const cats = objs(stats && stats.splits && stats.splits.categories).map((c) => ({
    name: asTxt(c.displayName || c.name),
    stats: objs(c.stats).map((s) => ({
      label: asTxt(s.shortDisplayName || s.abbreviation || s.displayName || s.name),
      full: asTxt(s.displayName || s.name),
      value: asTxt(s.displayValue != null ? s.displayValue : s.value)
    })).filter((s) => s.label && s.value)
  })).filter((c) => c.stats.length);
  return {
    name: asTxt(a.displayName || a.fullName),
    jersey: asTxt(a.jersey),
    pos: asTxt(a.position && (a.position.displayName || a.position.abbreviation)),
    team: t.name || '', teamAbbr: t.abbr || '', teamLogo: t.logo || '',
    headshot: asTxt(a.headshot && a.headshot.href),
    bio: [['Age', a.age], ['Height', a.displayHeight], ['Weight', a.displayWeight], ['Experience', a.experience && a.experience.years != null ? `${a.experience.years} yr` : ''], ['Born', bp]]
      .map(([k, v]) => [k, asTxt(v)]).filter(([, v]) => v),
    link: playerCard(a),
    categories: orderCats(cats, kind)
  };
}
async function fetchPlayer(l, id, ttl = 600000) {
  const ck = `${l.key}:${id}`;
  const hit = playerCache.get(ck);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const getJson = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const year = seasonYear(l);
  const [aRes, teams] = await Promise.all([getJson(athleteUrl(l, id)), leagueTeamIndex(l)]);
  // This season's stats; before the season starts (or for a rookie) fall back to last season's
  let stats = null, season = year;
  for (const y of [year, year - 1]) {
    try { const s = await getJson(athleteStatsUrl(l, y, id)); if (objs(s && s.splits && s.splits.categories).length) { stats = s; season = y; break; } } catch (_) {}
  }
  const data = { ...parsePlayer(aRes, stats, teams, l.kind), id: String(id), season: stats ? season : null };
  playerCache.set(ck, { at: Date.now(), data });
  if (playerCache.size > 60) playerCache.delete(playerCache.keys().next().value);
  return data;
}

const detailCache = new Map(); // `${league}:${eventId}` -> { at, data }
async function fetchGameDetail(l, eventId, ttl = 10000) {
  const ck = `${l.key}:${eventId}`;
  const hit = detailCache.get(ck);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(summaryUrl(l, eventId), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${l.name} game details: HTTP ${res.status}`);
  const data = { ...parseGameDetail(l, await res.json()), at: Date.now() };
  detailCache.set(ck, { at: Date.now(), data });
  if (detailCache.size > 40) detailCache.delete(detailCache.keys().next().value); // keep it small
  return data;
}

// The summary feed can trail the scoreboard by a few seconds, so ask again a couple of times before giving up
const SCORE_DETAIL_DELAYS = [0, 4000, 8000];

class Engine {
  constructor({ getSettings, notify, onUpdate }) {
    this.getSettings = getSettings;
    this.notify = notify;
    this.onUpdate = onUpdate;
    this.prev = new Map();
    this.reminded = new Set();
    this.closeSent = new Set();
    this.gameBase = new Map(); // game id -> standings snapshot from while the game was live (null while loading)
    this.standJobs = new Set(); // post-game standings checks still waiting for ESPN to count a final
    this.scoreJobs = new Map(); // game id -> promise of its latest alert that is still waiting on scoring detail
    this.stopped = false;
    this.games = [];
    this.timer = null;
  }

  start() {
    this.stopped = false;
    this.tick().catch(() => {});
  }

  stop() {
    this.stopped = true;
    this.again = false;
    clearTimeout(this.timer);
    for (const job of this.standJobs) clearTimeout(job.timer);
    this.standJobs.clear();
    this.scoreJobs.clear(); // pending detail lookups notice `stopped` when they wake and send nothing
  }

  // Alerts for one game go out in order. While a scoring alert is still waiting for its detail, anything that
  // follows it for that game (period end, final) waits behind it, so "Final" never arrives before the last goal.
  queue(gameId, fn) {
    const before = this.scoreJobs.get(gameId) || Promise.resolve();
    const job = before.then(fn).catch(() => {});
    this.scoreJobs.set(gameId, job);
    job.then(() => { if (this.scoreJobs.get(gameId) === job) this.scoreJobs.delete(gameId); });
    return job;
  }

  sendInOrder(gameId, n) {
    if (this.scoreJobs.has(gameId)) this.queue(gameId, () => this.notify(n));
    else this.notify(n);
  }

  // Who scored, as text lines, or null when ESPN's summary has nothing (yet) for this score change
  async scoringDetail(g, prev, cur) {
    const l = LEAGUES.find((x) => x.key === g.league);
    if (!l || !g.eventId) return null;
    let best = null;
    for (const delay of SCORE_DETAIL_DELAYS) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (this.stopped) return null;
      try {
        const m = playsBetween(await fetchScoringPlays(l, g.eventId), prev, cur);
        if (m.plays.length) best = m;
        if (m.complete) break;
      } catch (_) {} // timeouts and HTTP errors just mean "no detail"
    }
    return best ? best.plays.slice(-3).map((p) => cleanPlayText(p.text)).join('\n') : null;
  }

  // Standings as they were before this game counted, so the final can be compared against them
  async captureGameBase(g) {
    this.gameBase.set(g.id, null);
    try {
      const l = LEAGUES.find((x) => x.key === g.league);
      this.gameBase.set(g.id, standingsSnapshot(await fetchStandings(l, 300000)));
    } catch (_) {
      this.gameBase.delete(g.id); // try again on the next poll
    }
  }

  // After a final: ESPN's standings lag the game by minutes, so poll until a followed team's record
  // changes, then alert once for anything that moved (rank in its table, a clinch marker). Gives up after ~90 min.
  async watchStandings(g, followed, base) {
    const l = LEAGUES.find((x) => x.key === g.league);
    const teams = followed.filter((f) => f.alerts && f.alerts.standings).map((f) => ({ id: String(f.teamId), name: f.name }));
    if (!l || !base || !teams.length || this.stopped) return;
    try { if (await isPostseason(l)) return; } catch (_) {} // seeds barely move in the playoffs
    const job = { teams, tries: 0, timer: null };
    this.standJobs.add(job);
    const step = async () => {
      job.tries++;
      let data = null;
      try { data = await fetchStandings(l, 90000); } catch (_) {}
      if (this.stopped) return;
      if (data) {
        const now = standingsSnapshot(data);
        const waiting = [];
        for (const t of job.teams) {
          const was = base.get(t.id), cur = now.get(t.id);
          if (!was || !cur) continue; // not in the table, nothing to compare
          if (cur.sig === was.sig) { waiting.push(t); continue; } // ESPN hasn't counted the game yet
          const bits = standingsChanges(was, cur);
          if (bits.length) {
            this.notify({
              title: `${g.icon} Standings · ${t.name}`,
              body: bits.join(' · ') + (cur.record ? ` · ${cur.record}` : ''),
              gameId: g.id
            });
          }
        }
        job.teams = waiting;
      }
      if (!job.teams.length || job.tries >= 45) { this.standJobs.delete(job); return; }
      job.timer = setTimeout(step, 120000);
    };
    job.timer = setTimeout(step, 90000);
  }

  // One poll at a time: a settings change during a poll asks for another poll right after it, instead of
  // running two at once (they would write the game state out of order and could repeat a Final)
  async tick() {
    if (this.stopped) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    clearTimeout(this.timer);
    let anyLive = this.anyLive;
    try {
      const settings = this.getSettings();
      const leagueKeys = [...new Set(settings.follows.map((f) => f.league))];
      const now = new Date();
      // While a game is live only yesterday-to-tomorrow needs the fast poll; otherwise look a week ahead
      const span = this.anyLive ? 1 : 7;
      const days = [];
      for (let i = -1; i <= span; i++) days.push(dayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)));
      const games = [];
      const seen = new Set();

      const results = await Promise.all(
        leagueKeys.map(async (key) => {
          const l = LEAGUES.find((x) => x.key === key);
          if (!l) return null;
          const { events, errors } = await fetchDays(l, days);
          if (errors.length) console.error(`[engine] ${key}:`, errors.join('; '));
          return { l, events };
        })
      );
      if (this.stopped) return; // shut down while we were waiting: send nothing, schedule nothing

      for (const r of results) {
        if (!r) continue;
        for (const ev of r.events) {
          try {
            const g = parseEvent(r.l, ev);
            if (!g || seen.has(g.id)) continue;
            const followed = this.followedIn(settings, g);
            if (!followed.length) continue;
            seen.add(g.id);
            this.process(g, followed, settings);
            games.push(g);
          } catch (err) {
            // one odd event from ESPN must never stop the poll for everything else
            console.error(`[engine] skipped an event in ${r.l.key}:`, err && err.message);
          }
        }
      }

      this.games = games;
      this.onUpdate(games);
      anyLive = games.some((g) => g.state === 'in');
      this.anyLive = anyLive;
    } catch (err) {
      console.error('[engine] poll failed:', err && err.message);
    } finally {
      this.busy = false;
      if (!this.stopped) {
        const again = this.again;
        this.again = false;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), again ? 250 : anyLive ? 15000 : 60000);
      }
    }
  }

  followedIn(settings, g) {
    return settings.follows.filter(
      (f) => f.league === g.league && (f.teamId === g.home.id || f.teamId === g.away.id)
    );
  }

  wants(followed, type) {
    return followed.some((f) => f.alerts && f.alerts[type]);
  }

  process(g, followed, settings) {
    const prev = this.prev.get(g.id);
    this.prev.set(g.id, { state: g.state, key: g.key, period: g.period, home: g.home.score, away: g.away.score });
    const matchup = `${g.away.name} at ${g.home.name}`;
    const scoreLine = `${g.away.abbr} ${g.away.score} – ${g.home.score} ${g.home.abbr}`;

    // Reminder before start
    if (g.state === 'pre' && this.wants(followed, 'reminder')) {
      const mins = (new Date(g.date) - Date.now()) / 60000;
      if (mins > 0 && mins <= settings.reminderMinutes && !this.reminded.has(g.id)) {
        this.reminded.add(g.id);
        this.notify({ title: `Starting in ${Math.ceil(mins)} min`, body: matchup, gameId: g.id });
      }
    }

    // Close game, late: once per game, the first time it qualifies
    if (g.state === 'post') this.closeSent.delete(g.id);
    else if (!this.closeSent.has(g.id) && this.wants(followed, 'close') && isCloseLate(g)) {
      this.closeSent.add(g.id);
      const tied = g.home.score === g.away.score;
      const when = `${g.label}${g.clock && g.kind !== 'baseball' ? ' ' + g.clock : ''}`;
      this.notify({
        title: `${g.icon} ${tied ? 'Tied late' : 'Close game'}`,
        body: `${scoreLine} · ${when}`,
        gameId: g.id
      });
    }

    // Standings alerts: remember the table while the game is live (also covers opening the app mid-game)
    if (g.state === 'in' && !this.gameBase.has(g.id) && this.wants(followed, 'standings')) this.captureGameBase(g);

    if (!prev) return; // first sighting: don't fire retroactive alerts

    // Game start
    if (prev.state === 'pre' && g.state === 'in' && this.wants(followed, 'start')) {
      this.notify({ title: `${g.icon} Game on!`, body: matchup, gameId: g.id });
    }

    if (prev.state === 'in' || (prev.state === 'pre' && g.state === 'in')) {
      // Scoring
      const dHome = g.home.score - prev.home;
      const dAway = g.away.score - prev.away;
      // Basketball scores every few seconds, so it gets period-by-period updates instead
      if ((dHome > 0 || dAway > 0) && g.kind !== 'basketball' && this.wants(followed, 'score')) {
        const both = dHome > 0 && dAway > 0; // both sides scored between two polls
        const scorer = dHome > 0 ? g.home : g.away;
        const diff = dHome > 0 ? dHome : dAway;
        const word =
          g.kind === 'baseball' ? (both ? 'Runs score' : diff > 1 ? `${diff} runs score` : 'Run scores')
          : g.kind === 'football' ? (both ? 'Both teams score' : `+${diff} points`)
          : both ? 'Goals' : 'GOAL!'; // hockey
        const who = both ? `${g.away.name} and ${g.home.name}` : scorer.name;
        // The line under the title is fixed now (the clock moves on while we wait for ESPN's detail)
        const head = `${scoreLine} · ${g.label}${g.state === 'in' && g.kind === 'hockey' ? ' ' + g.clock : ''}`.trim();
        const from = { away: prev.away, home: prev.home };
        const to = { away: g.away.score, home: g.home.score };
        this.queue(g.id, async () => {
          const detail = await this.scoringDetail(g, from, to); // null: send the plain alert as before
          if (this.stopped) return;
          this.notify({ title: `${word} ${who}`, body: detail ? `${detail}\n${head}` : head, gameId: g.id });
        });
      }

      // Overtime / extra innings / shootout: fires when a game first enters each extra frame
      let otFired = false;
      if (g.state === 'in' && prev.state === 'in' && !g.isBreak && isExtra(g) && g.period > (prev.period || 0) && this.wants(followed, 'overtime')) {
        otFired = true;
        this.sendInOrder(g.id, {
          title: g.kind === 'baseball' ? `${g.icon} Extra innings!` : `${g.icon} ${g.label}!`,
          body: `${scoreLine} · ${g.leagueName}`,
          gameId: g.id
        });
      }

      // Period / inning / quarter / half changes
      if (g.state === 'in' && prev.state === 'in' && prev.key !== g.key && !otFired && this.wants(followed, 'period')) {
        const isEnd = g.key.startsWith('end') || g.key === 'half';
        const skipBaseball = g.kind === 'baseball' && !/^(Top|Bot)/.test(g.label);
        if (!skipBaseball) {
          this.sendInOrder(g.id, {
            title: isEnd ? g.label : `${g.label} underway`,
            body: `${scoreLine} · ${g.leagueName}`,
            gameId: g.id
          });
        }
      }

      // Final
      if (g.state === 'post' && this.wants(followed, 'final')) {
        this.sendInOrder(g.id, { title: `Final · ${g.icon}`, body: scoreLine, gameId: g.id });
      }

      // Standings change after the final (independent of the Final alert)
      if (g.state === 'post') {
        const base = this.gameBase.get(g.id);
        this.gameBase.delete(g.id);
        if (base && this.wants(followed, 'standings')) this.watchStandings(g, followed, base);
      }
    }
  }
}

module.exports = { parsePlayer, fetchPlayer, parseTransactions, txKind, fetchTransactions, parseLeaders, fetchLeaderboard, Engine, parseEvent, periodInfo, fetchDays, fetchStandings, standingsSnapshot, standingsChanges, parseScoringPlays, playsBetween, cleanPlayText, parseGameDetail, parseWinProb, parseGameLeaders, fetchGameDetail, isPostseason, fetchPlayoffs, followedAlive, playoffsOutcome, fetchOutTeams, isInSeason, fetchRoster, fetchInjuries, parseRoster, parseInjuries };
