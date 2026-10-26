const $ = (s) => document.querySelector(s);
const view = $('#view');
const titleEl = $('#title');
const subEl = $('#sub');

const ALERT_TYPES = [
  ['reminder', 'Reminder'],
  ['start', 'Game start'],
  ['period', 'Periods'],
  ['score', 'Scoring'],
  ['close', 'Close game'],
  ['overtime', 'Overtime'],
  ['final', 'Final'],
  ['standings', 'Standings']
];

const state = {
  tab: 'scores',
  cal: { y: new Date().getFullYear(), m: new Date().getMonth() },
  leagues: [],
  defaults: {},
  settings: { follows: [], reminderMinutes: 15 },
  games: [],
  activity: [],
  pickLeague: null,
  standLeague: null,
  rosterKey: null,
  rosterQuery: '',
  injLeague: null,
  injScope: 'mine',
  playoffLeagues: [],
  version: '',
  activeLeagues: null, // keys of leagues in season (null until known)
  outTeams: new Set(), // "league:teamId" of followed teams that are out of the season or playoffs
  detail: null, // the game open in the live panel on Scores (see "Live game panel"), or null
  detailTimer: null,
  teamQuery: '',
  teamCache: {}
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const leagueOf = (key) => state.leagues.find((l) => l.key === key);
const isFollowed = (league, teamId) => state.settings.follows.some((f) => f.league === league && f.teamId === teamId);

// A setting that counts as on unless it was saved as false (DEFAULT_ON, which must match the defaults in main.js)
const settingOn = (k) => (DEFAULT_ON.includes(k) ? state.settings[k] !== false : !!state.settings[k]);

// Why a followed team is left out of Scores, Recaps, Standings, Schedules and Injuries (null = it is shown):
//   'season': its sport's season and playoffs are over  ("Autohide out of season sports")
//   'out':    the team is out of the season or playoffs ("Autohide teams that are out")
// Nothing is hidden until the status is known. Roster and the Teams tab always show every team, and alerts
// are never affected.
function hiddenReason(f) {
  if (settingOn('hideOffSeason') && state.activeLeagues && !state.activeLeagues.includes(f.league)) return 'season';
  if (settingOn('hideEliminated') && state.outTeams.has(`${f.league}:${f.teamId}`)) return 'out';
  return null;
}
const shownFollows = () => state.settings.follows.filter((f) => !hiddenReason(f));
// Is this a followed team that is currently shown? (Standings highlight, Injuries "My teams")
const isShownFollowed = (league, teamId) => shownFollows().some((f) => f.league === league && f.teamId === teamId);
// A game is shown when at least one of the teams playing in it is
const gameShown = (g, shown) => shown.some((f) => f.league === g.league && (f.teamId === g.home.id || f.teamId === g.away.id));

// Leagues to offer in pickers.
//   followedOnly: only leagues that still have a shown team (Standings, Injuries). This is what takes a sport out once
//                 its season is over or every team you follow in it is out. The Teams picker leaves it off, otherwise
//                 there would be no way to follow a first team.
function visibleLeagues(extra = () => true, followedOnly = false) {
  const base = state.leagues.filter(extra);
  if (!followedOnly) return base;
  const shown = shownFollows();
  return base.filter((l) => shown.some((f) => f.league === l.key));
}

// Shown instead of a section when you follow teams but every one of them is currently hidden by the Autohide settings
const allHiddenHtml = (what) => `<div class="empty"><h3>Nothing to show right now</h3><p>The teams you follow are hidden from ${what} because their sport is out of season or they're out of the playoffs. You can change this under Autohide in Settings.</p>
  <button class="cta" id="goSettings">Open Settings</button></div>`;
function showAllHidden(what) {
  view.innerHTML = allHiddenHtml(what);
  $('#goSettings').onclick = () => setTab('settings');
}
// Header pills: every pill group lives here, on the same line as the title. render() clears them on every tab change.
// One line, left to right: the league or team picker (picker), a | divider, then option pills (opts).
// Either part is optional. picker = { items: [[key, labelHtml], ...], current, onPick }.
function setActions(opts, current, onPick, picker) {
  const box = $('#hact');
  const optHtml = (opts || []).map(([k, label]) => `<button class="chip ${k === current ? 'on' : ''}" data-ha="${k}">${label}</button>`).join('');
  const pickHtml = picker ? picker.items.map(([k, label]) => `<button class="chip ${k === picker.current ? 'on' : ''}" data-hp="${esc(k)}">${label}</button>`).join('') : '';
  box.innerHTML = pickHtml + (optHtml && pickHtml ? '<span class="hsep" aria-hidden="true">|</span>' : '') + optHtml;
  box.querySelectorAll('[data-ha]').forEach((b) => (b.onclick = () => onPick(b.dataset.ha)));
  box.querySelectorAll('[data-hp]').forEach((b) => (b.onclick = () => picker.onPick(b.dataset.hp)));
}
const GROUP_OPTS = [['team', 'By team'], ['status', 'By status']];
const groupMode = () => (state.settings.groupBy === 'status' ? 'status' : 'team');
function pickGroup(rerender) {
  setActions(GROUP_OPTS, groupMode(), (k) => { state.settings.groupBy = k; persist(); rerender(); });
}
const gamesOfTeam = (f, list) => list.filter((g) => g.league === f.league && (g.home.id === f.teamId || g.away.id === f.teamId));
const teamHead = (f) => {
  const lg = leagueOf(f.league);
  return `<div class="teamhd"><img src="${esc(f.logo)}" alt="" /><div><b>${esc(f.name)}</b><span>${lg ? lg.icon + ' ' + esc(lg.name) : ''}</span></div></div>`;
};

const noFollowedHtml = (what) => `<div class="empty"><h3>Pick your teams</h3><p>Follow a team and its league shows up here with ${what}.</p>
  <button class="cta" id="goTeams">Choose teams</button></div>`;
// Keeps a picker's current choice valid when its league list changes
const validLeague = (cur, list) => (list.some((l) => l.key === cur) ? cur : list[0].key);

// Tabs whose contents depend on the Autohide settings (Roster never does)
const HIDING_TABS = ['teams', 'scores', 'schedule', 'recaps', 'standings', 'injuries'];

async function refreshSeasonStatus() {
  let list;
  try { list = await api.seasonStatus(); } catch (_) { return; }
  const same = Array.isArray(list) && Array.isArray(state.activeLeagues) && list.length === state.activeLeagues.length && list.every((k) => state.activeLeagues.includes(k));
  state.activeLeagues = list;
  if (!same && HIDING_TABS.includes(state.tab)) render(); // unchanged answer: leave the view (and anything typed in it) alone
}

// Which followed teams are out of the season or the playoffs. Only asked while "Autohide teams that are out" is on.
async function refreshOutStatus() {
  if (!settingOn('hideEliminated')) return;
  let list;
  try { list = await api.outTeams(); } catch (_) { return; }
  const next = new Set(list);
  const same = next.size === state.outTeams.size && [...next].every((k) => state.outTeams.has(k));
  state.outTeams = next;
  if (!same && HIDING_TABS.includes(state.tab)) render();
}

async function persist() {
  state.settings = await api.saveSettings(state.settings);
}

/* ---------- time helpers ---------- */
function whenText(iso) {
  const d = new Date(iso);
  const diff = d - Date.now();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  let rel = '';
  if (diff > 0 && diff < 86400000) {
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    rel = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  return { time, day, rel };
}

/* ---------- Games view ---------- */
function gameCard(g, i) {
  const live = g.state === 'in';
  const post = g.state === 'post';
  const awayWin = post && g.away.score > g.home.score;
  const homeWin = post && g.home.score > g.away.score;
  const t = whenText(g.date);

  let pill;
  if (live) pill = `<span class="pill in"><span class="dot"></span>${esc(g.label)}</span>`;
  else if (post) pill = `<span class="pill">Final</span>`;
  else pill = `<span class="pill">${esc(t.rel || t.time)}</span>`;

  const showScore = live || post;
  const row = (team, dim) => `
    <div class="row">
      <img src="${esc(team.logo)}" alt="" />
      <div class="name ${dim ? 'dim' : ''}">${esc(team.name)}</div>
      ${showScore ? `<div class="score ${dim ? 'dim' : ''}">${team.score}</div>` : ''}
    </div>`;

  let foot;
  if (live) foot = `<span>${esc(g.detail)}</span><b>${g.kind === 'baseball' ? '' : esc(g.clock)}</b>`;
  else if (post) foot = `<span>${esc(t.day)}</span><b>${esc(g.detail)}</b>`;
  else foot = `<span>${esc(t.day)}</span><b>${esc(t.time)}</b>`;

  return `
    <article class="card clickable ${live ? 'live' : ''}" data-gid="${esc(g.id)}" tabindex="0" role="button" aria-label="Game details: ${esc(g.away.name)} at ${esc(g.home.name)}" style="--a:${g.away.color || '#7c8cff'};--h:${g.home.color || '#3de0c0'};animation-delay:${i * 40}ms">
      <div class="meta"><span>${g.icon} ${esc(g.leagueName)}</span>${pill}</div>
      ${row(g.away, post && homeWin)}
      ${row(g.home, post && awayWin)}
      <div class="foot">${foot}</div>
    </article>`;
}

function renderScores() {
  titleEl.textContent = 'Scores';
  if (!state.settings.follows.length) {
    subEl.textContent = '';
    view.innerHTML = `<div class="empty"><h3>Pick your teams</h3><p>Follow a few teams and their scores will show up here, live.</p>
      <button class="cta" id="goTeams">Choose teams</button></div>`;
    $('#goTeams').onclick = () => setTab('teams');
    return;
  }
  if (state.detail) return paintDetail(); // a game is open: the live panel replaces the list

  const shown = shownFollows(); // teams hidden by the Autohide settings take their games with them
  if (!shown.length) return showAllHidden('Scores');
  const games = state.games.filter((g) => gameShown(g, shown));

  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = dayStart.getTime() + 86400000;
  const isToday = (g) => { const t = new Date(g.date).getTime(); return t >= dayStart.getTime() && t < dayEnd; };
  const byTime = (a, b) => new Date(a.date) - new Date(b.date);

  const live = games.filter((g) => g.state === 'in');
  const later = games.filter((g) => g.state === 'pre' && isToday(g)).sort(byTime);
  const done = games.filter((g) => g.state === 'post' && now - new Date(g.date) < 36 * 3600000).sort((a, b) => byTime(b, a));
  const next = games.filter((g) => g.state === 'pre' && !isToday(g)).sort(byTime).slice(0, 3);

  subEl.textContent = live.length ? `${live.length} live right now` : later.length ? `${later.length} game${later.length > 1 ? 's' : ''} later today` : 'Nothing live right now';

  const section = (name, list) => (list.length ? `<h2>${name}</h2><div class="grid">${list.map(gameCard).join('')}</div>` : '');
  pickGroup(renderScores);
  let html;
  if (groupMode() === 'team') {
    // One block per followed team: its live game, today's games and recent finals, or its next game if none
    const blocks = shown.map((f) => {
      const mine = (list) => gamesOfTeam(f, list);
      let games = [...mine(live), ...mine(later), ...mine(done)];
      if (!games.length) games = mine(next).slice(0, 1);
      return { f, games, rank: mine(live).length ? 0 : mine(later).length ? 1 : mine(done).length ? 2 : 3 };
    }).filter((b) => b.games.length);
    blocks.sort((a, b) => a.rank - b.rank); // stable: follow order within each rank
    html = blocks.map((b) => `${teamHead(b.f)}<div class="grid">${b.games.map(gameCard).join('')}</div>`).join('');
  } else {
    html =
      section('Live now', live) +
      section('Later today', later) +
      section('Final', done) +
      (!live.length && !later.length ? section('Up next', next) : '');
  }
  view.innerHTML = html || `<div class="empty"><h3>No games right now</h3><p>Your teams don't have games today. Check Schedules for what's coming.</p></div>`;
  view.querySelectorAll('.card[data-gid]').forEach((c) => {
    c.onclick = () => openDetail(c.dataset.gid);
    c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(c.dataset.gid); } };
  });
}

/* ---------- Live game panel (click a game in Scores) ---------- */
// state.detail = { id, tab: 'sum' | 'box' | 'plays', data, error, loading, settled } while a game is open.
// The header numbers come from the live scoreboard feed (state.games); the line score, scoring summary,
// box score and plays come from the per-game summary (api.gameDetail), refreshed every 15 s while the game is live.
const DETAIL_REFRESH_MS = 15000;
const stopDetailTimer = () => { clearInterval(state.detailTimer); state.detailTimer = null; };
const detailGame = () => (state.detail ? state.games.find((g) => g.id === state.detail.id) : null);

function openDetail(id) {
  stopDetailTimer();
  const d = (state.detail = { id, tab: 'sum', data: null, error: null, loading: true, settled: false });
  paintDetail();
  loadDetail();
  state.detailTimer = setInterval(() => {
    const g = detailGame();
    if (state.detail !== d || !g || state.tab !== 'scores') return stopDetailTimer();
    if (document.hidden) return; // the window is in the tray: don't poll ESPN for nobody
    if (g.state === 'in' || !d.data || (g.state === 'post' && !d.settled)) loadDetail();
  }, DETAIL_REFRESH_MS);
}

function closeDetail() {
  stopDetailTimer();
  state.detail = null;
  if (state.tab === 'scores') renderScores();
}

async function loadDetail() {
  const d = state.detail;
  const g = detailGame();
  if (!d || !g) return;
  const seq = (d.seq = (d.seq || 0) + 1);
  let r;
  try { r = await api.gameDetail(g.league, g.eventId); } catch (e) { r = { ok: false, error: e.message }; }
  if (state.detail !== d || d.seq !== seq) return; // closed or switched while we waited, or a newer answer already arrived
  d.loading = false;
  if (r && r.ok) { d.data = r; d.error = null; if (g.state === 'post') d.settled = true; }
  else d.error = (r && r.error) || 'ESPN did not answer';
  if (state.tab === 'scores') paintDetail();
}

const detailWhen = (p) => [p.period, p.clock].filter(Boolean).join(' ');

function detailHero(g, d) {
  const post = g.state === 'post', live = g.state === 'in';
  const t = whenText(g.date);
  const status = live ? `<span class="pill in"><span class="dot"></span>${esc(g.label)}${g.kind !== 'baseball' && g.clock ? ' · ' + esc(g.clock) : ''}</span>`
    : post ? `<span class="pill">${esc(g.detail || 'Final')}</span>`
    : `<span class="pill">${esc(t.day)} · ${esc(t.time)}</span>`;
  const side = (team, win) => `
    <div class="dteam ${win ? 'win' : ''}">
      <img src="${esc(team.logo)}" alt="" />
      <b>${esc(team.name)}</b>
      <em class="dscore">${live || post ? esc(team.score) : ''}</em>
    </div>`;
  let lines = '';
  const data = d.data;
  if (data && data.heads && data.heads.length) {
    const row = (team) => {
      const info = data.teams.find((x) => x.id === team.id);
      const cells = data.heads.map((_, i) => `<td>${esc(info && info.lines[i] != null ? info.lines[i] : '')}</td>`).join('');
      return `<tr><td class="lt"><div class="tm"><img src="${esc(team.logo)}" alt="" /><span>${esc(team.abbr)}</span></div></td>${cells}<td class="tot">${esc(team.score)}</td></tr>`;
    };
    lines = `<table class="stbl dlines"><thead><tr><th class="tmh"></th>${data.heads.map((h) => `<th>${esc(h)}</th>`).join('')}<th>T</th></tr></thead><tbody>${row(g.away)}${row(g.home)}</tbody></table>`;
  }
  return `<section class="dhero" style="--a:${g.away.color || '#7c8cff'};--h:${g.home.color || '#3de0c0'}">
    <div class="dmeta"><span>${g.icon} ${esc(g.leagueName)}${g.broadcast ? ' · ' + esc(g.broadcast) : ''}</span>${status}</div>
    <div class="dmatch">${side(g.away, post && g.home.score > g.away.score)}<span class="dat">at</span>${side(g.home, post && g.away.score > g.home.score)}</div>
    ${lines}
  </section>`;
}

function detailSummary(g, d) {
  const data = d.data;
  let html = '';
  // Team stats side by side (shots, hits, rebounds ...)
  const sa = data.teamStats.find((t) => t.id === g.away.id), sh = data.teamStats.find((t) => t.id === g.home.id);
  if (sa && sh && sa.stats.length) {
    const rows = sa.stats.map((s) => {
      const o = sh.stats.find((x) => x.label === s.label);
      return o ? `<tr><td class="lt">${esc(s.label)}</td><td>${esc(s.value)}</td><td>${esc(o.value)}</td></tr>` : '';
    }).join('');
    if (rows) html += `<h2>Team stats</h2><table class="stbl dstats"><thead><tr><th class="tmh"></th><th>${esc(g.away.abbr)}</th><th>${esc(g.home.abbr)}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  html += '<h2>Scoring summary</h2>';
  html += data.scoring.length
    ? `<div class="dlist">${data.scoring.map((p) => `
        <div class="dplay scoring">
          <span class="dwhen">${esc(detailWhen(p))}</span>
          <span class="dtext">${p.team ? `<i class="dtag">${esc(p.team)}</i>` : ''}${esc(p.text)}</span>
          ${p.away !== '' && p.home !== '' ? `<span class="dnow">${esc(g.away.abbr)} ${esc(p.away)} – ${esc(p.home)} ${esc(g.home.abbr)}</span>` : ''}
        </div>`).join('')}</div>`
    : `<p class="dnone">${g.state === 'pre' ? "The game hasn't started yet." : 'No scoring yet.'}</p>`;
  return html;
}

function detailBox(g, d) {
  const data = d.data;
  let html = '';
  for (const team of [g.away, g.home]) {
    const p = data.players.find((x) => x.id === team.id);
    if (!p) continue;
    html += `<h2>${esc(team.name)}</h2>`;
    for (const grp of p.groups) {
      html += `<table class="stbl dbox"><thead><tr><th class="tmh">${esc(grp.name)}</th>${grp.labels.map((l) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>
        ${grp.rows.map((r) => `<tr><td class="lt">${esc(r.name)}${r.jersey ? ` <small>#${esc(r.jersey)}</small>` : ''}</td>${grp.labels.map((_, i) => `<td>${esc(r.stats[i] != null ? r.stats[i] : '')}</td>`).join('')}</tr>`).join('')}
        ${grp.totals.length ? `<tr class="dtotal"><td class="lt">Totals</td>${grp.labels.map((_, i) => `<td>${esc(grp.totals[i] != null ? grp.totals[i] : '')}</td>`).join('')}</tr>` : ''}
      </tbody></table>`;
    }
  }
  return html || `<p class="dnone">${g.state === 'pre' ? "The game hasn't started yet." : "ESPN doesn't have a box score for this game yet."}</p>`;
}

function detailPlays(g, d) {
  const list = d.data.plays;
  if (!list.length) return `<p class="dnone">${g.state === 'pre' ? "The game hasn't started yet." : 'No plays yet.'}</p>`;
  return `<h2>Recent plays</h2><div class="dlist">${list.map((p) => `
    <div class="dplay ${p.scoring ? 'scoring' : ''}"><span class="dwhen">${esc(detailWhen(p))}</span><span class="dtext">${p.team ? `<i class="dtag">${esc(p.team)}</i>` : ''}${esc(p.text)}</span></div>`).join('')}</div>`;
}

function paintDetail() {
  const d = state.detail;
  const g = detailGame();
  if (!d || !g) { state.detail = null; stopDetailTimer(); return renderScores(); } // the game left the feed: back to the list
  titleEl.textContent = 'Scores';
  subEl.textContent = `${g.away.name} at ${g.home.name}`;
  setActions([['sum', 'Summary'], ['box', 'Box score'], ['plays', 'Plays']], d.tab, (k) => { d.tab = k; paintDetail(); },
    { items: [['back', '← Scores']], current: null, onPick: closeDetail });

  let body;
  if (!d.data) {
    body = d.loading ? `<div class="empty"><p>Loading game details…</p></div>`
      : `<div class="empty"><h3>Details unavailable</h3><p>${esc(d.error || 'ESPN returned nothing for this game right now.')}</p><button class="cta" id="dRetry">Try again</button></div>`;
  } else {
    body = d.tab === 'box' ? detailBox(g, d) : d.tab === 'plays' ? detailPlays(g, d) : detailSummary(g, d);
  }
  const updated = d.data ? new Date(d.data.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
  const foot = d.data
    ? `<div class="dfoot"><span>${g.state === 'in' ? 'Updates every 15 seconds · ' : ''}Updated ${esc(updated)}${d.error ? ' · refresh failed, showing the last update' : ''}</span>${g.link ? `<button class="rbtn" data-open="${esc(g.link)}">Open on ESPN</button>` : ''}</div>`
    : '';
  const top = view.scrollTop; // a live refresh must not throw you back to the top
  view.innerHTML = detailHero(g, d) + `<div class="dbody">${body}</div>` + foot;
  view.scrollTop = top;
  const retry = $('#dRetry');
  if (retry) retry.onclick = () => { d.loading = true; d.error = null; paintDetail(); loadDetail(); };
  view.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => api.openLink(b.dataset.open)));
}

// Broken logos and headshots are hidden. (An inline onerror="" attribute would be blocked by the page's CSP.)
// "error" doesn't bubble, so listen in the capture phase.
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG') el.style[el.classList.contains('cimg') ? 'display' : 'visibility'] = el.classList.contains('cimg') ? 'none' : 'hidden';
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.detail && state.tab === 'scores') closeDetail(); });

/* ---------- Schedules view (day agenda / week / month) ---------- */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

state.cal = { view: 'week', date: startOfDay(new Date()).getTime() };

// Everything the UI needs to describe a game from the followed team's point of view
function perspective(g, fol) {
  const follows = shownFollows().filter((f) => f.league === g.league); // the team that is still shown is "mine"
  const mine = (fol ? fol.teamId === g.away.id : follows.some((f) => f.teamId === g.away.id)) ? g.away : g.home;
  const opp = mine === g.away ? g.home : g.away;
  const home = mine === g.home;
  let result = '', cls = '';
  if (g.state === 'post') {
    cls = mine.score > opp.score ? 'W' : mine.score < opp.score ? 'L' : 'T';
    result = `${cls} ${mine.score}–${opp.score}`;
  } else if (g.state === 'in') {
    cls = 'live';
    result = `${g.label} · ${mine.score}–${opp.score}`;
  }
  return { mine, opp, home, result, cls, time: timeOf(g.date) };
}

// Full-detail entry: used in the day agenda and the week columns
function gameEntry(g, compact) {
  const p = perspective(g);
  const tip = `${g.away.name} at ${g.home.name} · ${new Date(g.date).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} ${p.time}`;
  return `<div class="ev ${g.state} ${compact ? 'compact' : ''}" style="--c:${p.mine.color || '#7c8cff'}" title="${esc(tip)}">
    <img src="${esc(p.mine.logo)}" alt="" />
    <div>
      <b>${esc(p.mine.abbr)} ${p.home ? 'vs' : '@'} ${esc(p.opp.abbr)}</b>
      <em>${esc(p.time)} · <span class="ha ${p.home ? 'home' : 'away'}">${p.home ? 'HOME' : 'AWAY'}</span></em>
      ${p.result ? `<em class="res ${p.cls}">${esc(p.result)}</em>` : ''}
    </div>
  </div>`;
}

function agendaRow(g) {
  const p = perspective(g);
  return `<div class="arow ${g.state}" style="--c:${p.mine.color || '#7c8cff'}">
    <time>${esc(p.time)}</time>
    <img src="${esc(p.mine.logo)}" alt="" />
    <div class="amain">
      <b>${esc(p.mine.name)} ${p.home ? 'vs' : '@'} ${esc(p.opp.name)}</b>
      <span>${g.icon} ${esc(g.leagueName)} · <span class="ha ${p.home ? 'home' : 'away'}">${p.home ? 'HOME' : 'AWAY'}</span></span>
    </div>
    <div class="aside">${p.result ? `<em class="res ${p.cls}">${esc(p.result)}</em>` : g.state === 'pre' ? `<em>${esc(whenText(g.date).rel)}</em>` : ''}</div>
  </div>`;
}

function calRange() {
  const d = new Date(state.cal.date);
  const view = state.cal.view;
  if (view === 'day') return { start: startOfDay(d), end: addDays(startOfDay(d), 1) };
  if (view === 'week') { const s = addDays(startOfDay(d), -d.getDay()); return { start: s, end: addDays(s, 7) }; }
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return { start: first, end: new Date(d.getFullYear(), d.getMonth() + 1, 1) };
}

function calTitle() {
  const d = new Date(state.cal.date);
  const { start, end } = calRange();
  if (state.cal.view === 'day') return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (state.cal.view === 'week') {
    const last = addDays(end, -1);
    const f = (x, y) => x.toLocaleDateString([], { month: 'short', day: 'numeric', ...(y ? { year: 'numeric' } : {}) });
    return `${f(start)} – ${f(last, true)}`;
  }
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

async function renderSchedule() {
  titleEl.textContent = 'Schedules';
  const shown = shownFollows();
  const n = shown.length;
  subEl.textContent = n ? `Games for ${n === state.settings.follows.length ? `all ${n}` : n} of your teams` : '';

  if (!state.settings.follows.length) {
    view.innerHTML = `<div class="empty"><h3>Pick your teams</h3><p>Follow a few teams and every one of their games shows up here.</p>
      <button class="cta" id="goTeams">Choose teams</button></div>`;
    $('#goTeams').onclick = () => setTab('teams');
    return;
  }
  if (!n) return showAllHidden('Schedules');

  const cal = state.cal;
  setActions([['day', 'Day'], ['week', 'Week'], ['month', 'Month']], cal.view, (k) => { cal.view = k; renderSchedule(); });
  const controls = `<div class="calbar">
      <button class="cbtn" id="prevM" title="Previous">‹</button>
      <div class="calname">${esc(calTitle())}</div>
      <button class="cbtn" id="nextM" title="Next">›</button>
      <button class="cbtn txt" id="todayM">Today</button>
    </div>`;
  const wire = () => {
    const step = (dir) => {
      const d = new Date(cal.date);
      if (cal.view === 'day') d.setDate(d.getDate() + dir);
      else if (cal.view === 'week') d.setDate(d.getDate() + 7 * dir);
      else { d.setDate(1); d.setMonth(d.getMonth() + dir); }
      cal.date = startOfDay(d).getTime();
      renderSchedule();
    };
    $('#prevM').onclick = () => step(-1);
    $('#nextM').onclick = () => step(1);
    $('#todayM').onclick = () => { cal.date = startOfDay(new Date()).getTime(); renderSchedule(); };
    view.querySelectorAll('[data-goday]').forEach((el) => (el.onclick = () => { cal.date = +el.dataset.goday; cal.view = 'day'; renderSchedule(); }));
  };

  view.innerHTML = controls + `<div class="empty"><p>Loading schedule…</p></div>`;
  wire();

  const { start, end } = calRange();
  const stamp = `${cal.view}:${cal.date}`;
  let result;
  try {
    result = await api.schedule(start.getTime(), end.getTime());
  } catch (e) {
    result = { games: [], errors: [e.message], failed: true };
  }
  if (state.tab !== 'schedule' || `${cal.view}:${cal.date}` !== stamp) return; // user moved on

  if (result.failed) {
    view.innerHTML = controls + `<div class="empty"><h3>Couldn't load the schedule</h3><p>${esc(result.errors.join('; ') || 'Check your connection and try again.')}</p>
      <button class="cta" id="retry">Try again</button></div>`;
    wire();
    $('#retry').onclick = () => renderSchedule();
    return;
  }

  // only keep games that actually fall inside the visible range (the fetch pads a day each side)
  const games = result.games.filter((g) => { const t = new Date(g.date); return t >= start && t < end && gameShown(g, shown); });
  const byDay = new Map();
  for (const g of games) {
    const k = dayKey(new Date(g.date));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(g);
  }
  const todayKey = dayKey(new Date());
  const warn = result.errors.length ? `<div class="calnote warn">Some games may be missing: ${esc(result.errors.join('; '))}</div>` : '';
  let body = '';

  if (cal.view === 'day') {
    body = games.length
      ? `<div class="agenda">${games.map(agendaRow).join('')}</div>`
      : `<div class="empty"><h3>No games</h3><p>None of your teams play on this day.</p></div>`;
  } else if (cal.view === 'week') {
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const list = byDay.get(dayKey(d)) || [];
      cells += `<div class="wday ${dayKey(d) === todayKey ? 'today' : ''}">
        <div class="whead" data-goday="${d.getTime()}"><span>${DOWS[d.getDay()]}</span><b>${d.getDate()}</b></div>
        ${list.length ? list.map((g) => gameEntry(g)).join('') : '<div class="none">No games</div>'}
      </div>`;
    }
    body = `<div class="week">${cells}</div>`;
  } else {
    const d0 = new Date(cal.date);
    const y = d0.getFullYear(), m = d0.getMonth();
    const days = new Date(y, m + 1, 0).getDate();
    let cells = DOWS.map((d) => `<div class="dow">${d}</div>`).join('');
    for (let i = 0; i < new Date(y, m, 1).getDay(); i++) cells += `<div class="day blank"></div>`;
    for (let d = 1; d <= days; d++) {
      const day = new Date(y, m, d);
      const list = byDay.get(dayKey(day)) || [];
      const shown = list.slice(0, 3).map((g) => gameEntry(g, true)).join('');
      const more = list.length > 3 ? `<div class="more" data-goday="${day.getTime()}">+${list.length - 3} more</div>` : '';
      cells += `<div class="day ${dayKey(day) === todayKey ? 'today' : ''}"><span class="dn" data-goday="${day.getTime()}">${d}</span>${shown}${more}</div>`;
    }
    body = `<div class="cal">${cells}</div>`;
  }

  const count = games.length;
  const note = cal.view === 'day' ? '' : `<div class="calnote">${count ? `${count} game${count > 1 ? 's' : ''}` : 'No games found for your teams (the league may be in its off-season).'}</div>`;
  view.innerHTML = controls + warn + note + body;
  wire();
}

/* ---------- Teams view ---------- */
async function renderTeams() {
  titleEl.textContent = 'Teams';
  subEl.textContent = 'Choose who to follow and what you want to hear about';

  state.pickLeague = validLeague(state.pickLeague, visibleLeagues());
  const key = state.pickLeague;
  if (!state.teamCache[key]) {
    view.innerHTML = `<div class="empty"><p>Loading teams…</p></div>`;
    const stale = () => state.tab !== 'teams' || state.pickLeague !== key; // user moved on while we waited
    try {
      state.teamCache[key] = await api.teams(key);
    } catch (e) {
      if (stale()) return;
      setActions(null, null, null, { items: visibleLeagues().map((l) => [l.key, `${l.icon} ${esc(l.name)}`]), current: key, onPick: (k) => { state.pickLeague = k; state.teamQuery = ''; renderTeams(); } });
      view.innerHTML = `<div class="empty"><h3>Couldn't load teams</h3><p>Check your connection and try again.</p></div>`;
      return;
    }
    if (stale()) return;
  }

  const following = state.settings.follows
    .map((f, idx) => {
      const lg = leagueOf(f.league);
      // NBA has no per-basket alerts (too frequent); it reports at each quarter break instead
      const toggles = ALERT_TYPES.filter(([k]) => !(f.league === 'nba' && k === 'score')).map(
        ([k, label]) => `<button class="tg ${f.alerts[k] ? 'on' : ''}" data-i="${idx}" data-k="${k}">${label}</button>`
      ).join('');
      return `<div class="follow">
        <img src="${esc(f.logo)}" alt="" />
        <div class="who"><b>${esc(f.name)}</b><span>${lg ? lg.icon + ' ' + esc(lg.name) : ''}</span></div>
        <div class="toggles">${toggles}</div>
        <button class="x" data-rm="${idx}" title="Unfollow">✕</button>
      </div>`;
    })
    .join('');

  setActions(null, null, null, {
    items: visibleLeagues().map((l) => [l.key, `${l.icon} ${esc(l.name)}`]),
    current: key,
    onPick: (k) => { state.pickLeague = k; state.teamQuery = ''; renderTeams(); }
  });

  const tiles = state.teamCache[key]
    .map(
      (t) => `<div class="team ${isFollowed(key, t.teamId) ? 'on' : ''}" data-id="${t.teamId}">
        <img src="${esc(t.logo)}" alt="" />${esc(t.name)}</div>`
    )
    .join('');

  const mins = [5, 10, 15, 30, 60]
    .map((m) => `<option value="${m}" ${state.settings.reminderMinutes === m ? 'selected' : ''}>${m} minutes</option>`)
    .join('');

  view.innerHTML = `
    ${following ? `<h2>Following</h2>
      <div class="settings">Send reminders <select id="mins">${mins}</select> before puck drop, first pitch or kickoff</div>
      ${following}` : ''}
    <h2>Add teams</h2>
    <input id="tq" class="search" type="search" placeholder="Search teams" value="${esc(state.teamQuery)}" style="margin:10px 0" />
    <div class="teamgrid">${tiles}</div>`;

  const filterTeams = () => {
    const q = $('#tq').value.trim().toLowerCase();
    state.teamQuery = $('#tq').value;
    view.querySelectorAll('.team').forEach((el) => { el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  };
  $('#tq').oninput = filterTeams;
  if (state.teamQuery) filterTeams();

  view.querySelectorAll('.team').forEach((el) => {
    el.onclick = async () => {
      const t = state.teamCache[key].find((x) => x.teamId === el.dataset.id);
      const i = state.settings.follows.findIndex((f) => f.league === key && f.teamId === t.teamId);
      if (i >= 0) state.settings.follows.splice(i, 1);
      else state.settings.follows.push({ ...t, alerts: { ...state.defaults } });
      await persist();
      refreshPlayoffStatus();
      refreshOutStatus(); // a newly followed team may already be out
      const top = view.scrollTop;
      await renderTeams();
      view.scrollTop = top;
    };
  });
  view.querySelectorAll('.tg').forEach((b) => {
    b.onclick = async () => {
      const f = state.settings.follows[+b.dataset.i];
      f.alerts[b.dataset.k] = !f.alerts[b.dataset.k];
      b.classList.toggle('on', f.alerts[b.dataset.k]);
      await persist();
    };
  });
  view.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = async () => {
      state.settings.follows.splice(+b.dataset.rm, 1);
      await persist();
      refreshPlayoffStatus();
      const top = view.scrollTop;
      await renderTeams();
      view.scrollTop = top;
    };
  });
  const sel = $('#mins');
  if (sel) sel.onchange = async () => { state.settings.reminderMinutes = +sel.value; await persist(); };
}

/* ---------- Activity view ---------- */
function renderActivity() {
  titleEl.textContent = 'Activity';
  subEl.textContent = 'Every alert SportsChud has sent this session';
  if (!state.activity.length) {
    view.innerHTML = `<div class="empty"><h3>Nothing yet</h3><p>Alerts will appear here as your games start, score and finish.</p></div>`;
    return;
  }
  view.innerHTML = `<div class="log">${state.activity
    .map(
      (a) => `<div class="entry"><time>${new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><b>${esc(a.title)}</b><span>${esc(a.body)}</span></div>`
    )
    .join('')}</div>`;
}

/* ---------- Standings view ---------- */
const CLINCH = { x: 'Clinched a playoff spot', y: 'Clinched the division', z: 'Clinched the top seed', '*': 'Clinched the top seed', e: 'Eliminated' };

async function renderStandings() {
  titleEl.textContent = 'Standings';
  subEl.textContent = '';
  const stLeagues = visibleLeagues(() => true, true);
  if (!stLeagues.length) {
    if (state.settings.follows.length && shownFollows().length !== state.settings.follows.length) return showAllHidden('Standings');
    view.innerHTML = noFollowedHtml('its standings');
    $('#goTeams').onclick = () => setTab('teams');
    return;
  }
  state.standLeague = validLeague(state.standLeague, stLeagues);
  const key = state.standLeague;
  const l = leagueOf(key);
  setActions(null, null, null, {
    items: stLeagues.map((x) => [x.key, `${x.icon} ${esc(x.name)}`]),
    current: key,
    onPick: (k) => { state.standLeague = k; renderStandings(); }
  });
  const bind = () => {
    const retry = $('#stRetry');
    if (retry) retry.onclick = () => renderStandings();
  };

  view.innerHTML = `<div class="empty"><p>Loading standings…</p></div>`;
  bind();
  let data;
  try { data = await api.standings(key); } catch (e) { data = { ok: false, error: e.message, groups: [] }; }
  if (state.tab !== 'standings' || state.standLeague !== key) return;

  subEl.textContent = data.season ? `${l.name} · ${data.season} season` : l.name;
  if (!data.ok || !data.groups.length) {
    view.innerHTML = `<div class="empty"><h3>Standings unavailable</h3><p>${esc(data.error || 'ESPN returned no standings for this league right now.')}</p>
      <button class="cta" id="stRetry">Try again</button></div>`;
    bind();
    return;
  }

  const table = (g) => `
    <div class="stwrap">
      <h2>${esc(g.name)}</h2>
      <table class="stbl">
        <thead><tr><th class="rk">#</th><th class="tmh">Team</th>${l.cols.map(([label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead>
        <tbody>${g.rows.map((r, i) => `
          <tr class="${isShownFollowed(key, r.teamId) ? 'mine' : ''}">
            <td class="rk">${i + 1}</td>
            <td class="tmc"><div class="tm"><img src="${esc(r.logo)}" alt="" /><span>${esc(r.name)}</span>${r.clincher ? `<span class="cl" title="${esc(CLINCH[r.clincher] || 'Clinch status')}">${esc(r.clincher)}</span>` : ''}</div></td>
            ${l.cols.map(([, k]) => `<td>${esc(r.stats[k] != null ? r.stats[k] : '–')}</td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  view.innerHTML = `<div class="stgrid">${data.groups.map(table).join('')}</div>`;
  bind();
}

/* ---------- Playoffs view ---------- */
function seriesCard(s, i) {
  const [a, b] = s.teams;
  const mine = s.teams.some((t) => isFollowed(s.league, t.id));
  const live = !!s.live;
  const val = (t) => (s.single ? (live || s.state === 'post' ? t.score : '') : t.wins);
  const leader = s.single ? (a.score === b.score ? null : a.score > b.score ? a : b) : (a.wins === b.wins ? null : a.wins > b.wins ? a : b);
  const dim = (t) => s.completed && leader && leader.id !== t.id;
  const row = (t) => `
    <div class="row">
      <img src="${esc(t.logo)}" alt="" />
      <div class="name ${dim(t) ? 'dim' : ''}">${esc(t.name)}</div>
      <div class="score ${dim(t) ? 'dim' : ''}">${esc(val(t))}</div>
    </div>`;

  let pill;
  if (live) pill = `<span class="pill in"><span class="dot"></span>LIVE</span>`;
  else if (s.completed) pill = `<span class="pill">${s.single ? 'Final' : 'Series over'}</span>`;
  else pill = `<span class="pill">${s.single ? 'Playoff game' : `Best of ${s.bestOf || 7}`}</span>`;

  const gameTag = (n) => (n ? `Game ${n} · ` : '');
  let status = '';
  if (live) status = `${gameTag(s.live.gameNo)}${s.live.label}${s.live.clock ? ' ' + s.live.clock : ''}`;
  else if (s.next) { const t = whenText(s.next.date); status = `${gameTag(s.next.gameNo)}${t.rel ? t.rel : t.day + ' ' + t.time}`; }
  else if (s.completed) status = 'Complete';
  const left = s.single ? esc(s.round) : esc(s.summary || '');

  return `
    <article class="card series ${mine ? 'mine' : ''} ${live ? 'live' : ''}" style="--a:${a.color || '#7c8cff'};--h:${b.color || '#3de0c0'};animation-delay:${i * 40}ms">
      <div class="meta"><span>${s.icon} ${esc(s.leagueName)}</span>${pill}</div>
      ${row(a)}
      ${row(b)}
      <div class="foot"><span>${left}</span><b>${esc(status)}</b></div>
    </article>`;
}

async function renderPlayoffs() {
  titleEl.textContent = 'Playoffs';
  subEl.textContent = '';
  view.innerHTML = `<div class="empty"><p>Loading playoffs…</p></div>`;
  let data;
  try { data = await api.playoffs(); } catch (e) { data = { leagues: [], errors: [e.message] }; }
  if (state.tab !== 'playoffs') return;

  // With Autohide on, only leagues where one of your teams is still alive are shown
  const autoHide = state.settings.playoffsAutoHide !== false;
  const withSeries = data.leagues.filter((lg) => lg.series.length && (!autoHide || lg.alive));
  if (!withSeries.length) {
    subEl.textContent = '';
    view.innerHTML = `<div class="empty"><h3>No playoffs right now</h3><p>${data.errors.length ? esc(data.errors.join('; ')) : autoHide ? 'None of your teams are in the playoffs right now. When one is, its league shows up here.' : 'When a league reaches its postseason, every series shows up here.'}</p></div>`;
    return;
  }
  subEl.textContent = withSeries.map((lg) => lg.name).join(' · ');

  const warn = data.errors.length ? `<div class="calnote warn">Some playoff games may be missing: ${esc(data.errors.join('; '))}</div>` : '';
  const sections = withSeries.map((lg) => {
    // Rounds ordered by their newest game so the current round is on top
    const rounds = new Map();
    for (const s of lg.series) {
      if (!rounds.has(s.round)) rounds.set(s.round, { name: s.round, list: [], latest: 0 });
      const r = rounds.get(s.round);
      r.list.push(s);
      r.latest = Math.max(r.latest, new Date(s.lastDate).getTime());
    }
    const body = [...rounds.values()].sort((x, y) => y.latest - x.latest).map((r) => {
      r.list.sort((x, y) =>
        (y.teams.some((t) => isFollowed(y.league, t.id)) - x.teams.some((t) => isFollowed(x.league, t.id))) ||
        (!!y.live - !!x.live) || (x.completed - y.completed));
      return `<div class="round">${esc(r.name)}</div><div class="grid">${r.list.map(seriesCard).join('')}</div>`;
    }).join('');
    return `<h2>${lg.icon} ${esc(lg.name)}</h2>${body}`;
  }).join('');
  view.innerHTML = warn + sections;
}

/* ---------- Roster view ---------- */
const followKey = (f) => `${f.league}:${f.teamId}`;

async function renderRoster() {
  titleEl.textContent = 'Roster';
  subEl.textContent = '';
  const all = state.settings.follows;
  if (!all.length) {
    view.innerHTML = `<div class="empty"><h3>Pick your teams</h3><p>Follow a team and its full roster shows up here.</p>
      <button class="cta" id="goTeams">Choose teams</button></div>`;
    $('#goTeams').onclick = () => setTab('teams');
    return;
  }
  const follows = all; // Roster is the one section the Autohide settings never touch: every followed team stays here
  if (!follows.some((f) => followKey(f) === state.rosterKey)) state.rosterKey = followKey(follows[0]);
  const f = follows.find((x) => followKey(x) === state.rosterKey);
  const lg = leagueOf(f.league);

  setActions(null, null, null, {
    items: follows.map((x) => [followKey(x), `<img class="cimg" src="${esc(x.logo)}" alt="" />${esc(x.name)}`]),
    current: state.rosterKey,
    onPick: (k) => { state.rosterKey = k; renderRoster(); }
  });
  const bind = () => {
    const retry = $('#rsRetry');
    if (retry) retry.onclick = () => renderRoster();
  };

  view.innerHTML = `<div class="empty"><p>Loading roster…</p></div>`;
  bind();
  let data;
  try { data = await api.roster(f.league, f.teamId); } catch (e) { data = { ok: false, error: e.message, groups: [] }; }
  if (state.tab !== 'roster' || state.rosterKey !== followKey(f)) return;

  subEl.textContent = `${f.name}${data.ok ? ` · ${data.count} players` : ''}`;
  if (!data.ok || !data.groups.length) {
    view.innerHTML = `<div class="empty"><h3>Roster unavailable</h3><p>${esc(data.error || 'ESPN returned no roster for this team right now.')}</p>
      <button class="cta" id="rsRetry">Try again</button></div>`;
    bind();
    return;
  }

  const cell = (v) => esc(v === '' || v == null ? '–' : v);
  const group = (g) => `
    <div class="stwrap rg">
      <h2>${esc(g.title)} <span class="cnt">${g.players.length}</span></h2>
      <table class="stbl rost">
        <thead><tr><th class="rk">#</th><th class="tmh">Player</th><th>Pos</th><th>Age</th><th>Ht</th><th>Wt</th><th>Exp</th><th>Status</th></tr></thead>
        <tbody>${g.players.map((p) => `
          <tr data-n="${esc(p.name.toLowerCase())}">
            <td class="rk">${cell(p.jersey)}</td>
            <td class="tmc"><div class="tm"><img class="hs" src="${esc(p.headshot)}" alt="" />${p.link ? `<a href="#" data-open="${esc(p.link)}">${esc(p.name)}</a>` : `<span>${esc(p.name)}</span>`}</div></td>
            <td>${cell(p.pos)}</td><td>${cell(p.age)}</td><td>${cell(p.height)}</td><td>${cell(p.weight)}</td><td>${cell(p.exp)}</td>
            <td>${p.injury ? `<span class="st ${statusClass(p.injury)}">${esc(p.injury)}</span>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  view.innerHTML = `
    <div class="rhead">
      <img src="${esc(f.logo)}" alt="" />
      <div class="who"><b>${esc(f.name)}</b><span>${lg ? lg.icon + ' ' + esc(lg.name) : ''}${data.coach ? ' · Coach ' + esc(data.coach) : ''}</span></div>
      <input id="rq" class="search" type="search" placeholder="Search players" value="${esc(state.rosterQuery)}" />
    </div>
    <div class="stgrid one">${data.groups.map(group).join('')}</div>
    <div class="empty" id="rnone" style="display:none"><p>No players match that search.</p></div>`;
  bind();
  view.querySelectorAll('[data-open]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); api.openLink(a.dataset.open); }));

  const filter = () => {
    const q = $('#rq').value.trim().toLowerCase();
    state.rosterQuery = $('#rq').value;
    let any = false;
    view.querySelectorAll('.rg').forEach((g) => {
      let n = 0;
      g.querySelectorAll('tbody tr').forEach((tr) => { const show = !q || tr.dataset.n.includes(q); tr.style.display = show ? '' : 'none'; if (show) n++; });
      g.style.display = n ? '' : 'none';
      if (n) any = true;
    });
    $('#rnone').style.display = any ? 'none' : '';
  };
  $('#rq').oninput = filter;
  if (state.rosterQuery) filter();
}

/* ---------- Injuries view ---------- */
// Colour the status by how serious it is
function statusClass(s) {
  const t = String(s).toLowerCase();
  if (/(out|injured reserve|\bir\b|suspen|60-day|10-day|15-day|7-day)/.test(t)) return 'out';
  if (/(day|questionable|doubtful|probable|game-time|gtd)/.test(t)) return 'dtd';
  return '';
}
const shortDate = (s) => {
  if (!s) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s);
  return isNaN(d) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

async function renderInjuries() {
  titleEl.textContent = 'Injuries';
  subEl.textContent = '';
  const injLeagues = visibleLeagues((l) => !l.noInjuries, true); // ESPN has no injury feed for some leagues
  if (!injLeagues.length) {
    if (state.settings.follows.length && shownFollows().length !== state.settings.follows.length) return showAllHidden('Injuries');
    view.innerHTML = noFollowedHtml('its injury report');
    $('#goTeams').onclick = () => setTab('teams');
    return;
  }
  if (!injLeagues.some((l) => l.key === state.injLeague)) state.injLeague = injLeagues[0].key;
  const key = state.injLeague;
  const lg = leagueOf(key);
  const followed = (t) => isShownFollowed(key, t.teamId); // a team that is hidden by Autohide isn't "mine" here
  setActions([['mine', 'My teams'], ['all', 'Whole league']], state.injScope, (k) => { state.injScope = k; renderInjuries(); }, {
    items: injLeagues.map((x) => [x.key, `${x.icon} ${esc(x.name)}`]),
    current: key,
    onPick: (k) => { state.injLeague = k; renderInjuries(); }
  });
  const bind = () => {
    const retry = $('#injRetry');
    if (retry) retry.onclick = () => renderInjuries();
    const all = $('#injAll');
    if (all) all.onclick = () => { state.injScope = 'all'; renderInjuries(); };
  };

  view.innerHTML = `<div class="empty"><p>Loading injury reports…</p></div>`;
  bind();
  let data;
  try { data = await api.injuries(key); } catch (e) { data = { ok: false, error: e.message, teams: [] }; }
  if (state.tab !== 'injuries' || state.injLeague !== key) return;

  if (!data.ok) {
    view.innerHTML = `<div class="empty"><h3>Injuries unavailable</h3><p>${esc(data.error || 'ESPN returned no injury report right now.')}</p>
      <button class="cta" id="injRetry">Try again</button></div>`;
    bind();
    return;
  }

  let teams = data.teams;
  if (state.injScope === 'mine') teams = teams.filter(followed);
  teams = [...teams].sort((a, b) => (followed(b) - followed(a)) || a.name.localeCompare(b.name));
  const n = teams.reduce((s, t) => s + t.items.length, 0);
  subEl.textContent = `${lg.name} · ${n} player${n === 1 ? '' : 's'} on injury reports`;

  if (!teams.length) {
    const follows = shownFollows().some((f) => f.league === key);
    view.innerHTML = `<div class="empty"><h3>${follows ? 'All clear' : `No ${esc(lg.name)} teams followed`}</h3>
      <p>${follows ? `None of your ${esc(lg.name)} teams have anyone on the injury report.` : 'Follow a team on the Teams tab, or look at the whole league.'}</p>
      <button class="cta" id="injAll">Show whole league</button></div>`;
    bind();
    return;
  }

  const row = (p) => {
    const ret = shortDate(p.returnDate);
    const upd = shortDate(p.date);
    const detail = [p.kind, p.comment].filter(Boolean).join(' · ');
    return `<div class="injrow">
      <img class="hs" src="${esc(p.headshot)}" alt="" />
      <div class="ib">
        <b>${p.link ? `<a href="#" data-open="${esc(p.link)}">${esc(p.name)}</a>` : esc(p.name)} ${p.pos ? `<em>${esc(p.pos)}</em>` : ''}</b>
        <span>${esc(detail)}</span>
      </div>
      <div class="ir"><span class="st ${statusClass(p.status)}">${esc(p.status)}</span>
        <small>${ret ? 'Expected back ' + esc(ret) : upd ? 'Updated ' + esc(upd) : ''}</small></div>
    </div>`;
  };
  view.innerHTML = `<div class="injgrid">${teams.map((t) => `
    <article class="injteam ${followed(t) ? 'mine' : ''}">
      <header><img src="${esc(t.logo)}" alt="" /><b>${esc(t.name)}</b>${followed(t) ? '<span class="tag">Following</span>' : ''}<span class="cnt">${t.items.length}</span></header>
      ${t.items.map(row).join('')}
    </article>`).join('')}</div>`;
  bind();
  view.querySelectorAll('[data-open]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); api.openLink(a.dataset.open); }));
}

/* ---------- Settings view ---------- */
// Settings that are on unless explicitly saved as false (keep in sync with the defaults in main.js)
const DEFAULT_ON = ['keepInTray', 'playoffsAutoHide', 'activityAutoHide', 'checkForUpdates', 'hideOffSeason', 'hideEliminated'];

// Update banner (under the header) and the Updates row in Settings. state.update comes from main (updater.js).
function renderUpdBar() {
  const bar = $('#updbar');
  const u = state.update;
  const show = !!(u && u.supported && u.available);
  bar.hidden = !show;
  if (show) bar.textContent = u.installing ? 'The installer is open. Finish it there; SportsChud closes completely when you quit.' : u.downloading ? `Downloading SportsChud v${u.version}… ${u.progress}%` : `SportsChud v${u.version} is available. Click to open Settings and install it.`;
}
function updateRow() {
  const u = state.update;
  if (!u) return '';
  let desc;
  let btn = '';
  if (!u.supported) {
    desc = 'Updates work in the installed version of SportsChud. This copy is running from source.';
  } else if (u.installing) {
    desc = `The installer is open (Windows may ask for administrator permission). SportsChud stays open until you quit it; quitting now closes everything, including the tray icon, so the installer can finish.`;
    btn = '<button class="ubtn" id="updInstall">Open installer again</button>';
  } else if (u.downloading) {
    desc = `Downloading v${esc(u.version)}… ${u.progress}%. The installer opens when it finishes.`;
    btn = '<button class="ubtn" disabled>Downloading…</button>';
  } else if (u.available) {
    desc = `Version ${esc(u.version)} is available (you have v${esc(u.current)}). SportsChud downloads it and opens the installer; it keeps running meanwhile.${u.error ? ' ' + esc(u.error) : ''}`;
    btn = '<button class="ubtn" id="updInstall">Install update</button>';
  } else if (u.checking) {
    desc = 'Checking for updates…';
    btn = '<button class="ghost" disabled>Checking…</button>';
  } else {
    const when = u.checkedAt ? ` Last checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
    desc = u.error ? `Couldn't check for updates: ${esc(u.error)}` : `You're up to date (v${esc(u.current)}).${when}`;
    btn = '<button class="ghost" id="updCheck">Check now</button>';
  }
  return `<div class="setrow"><div><b>Updates</b><span>${desc}</span></div><div>${btn}</div></div>`;
}

function renderSettings() {
  titleEl.textContent = 'Settings';
  subEl.textContent = `How SportsChud starts and runs${state.version ? ' · v' + state.version : ''}`;
  const general = [
    ['launchAtStartup', 'Launch at startup', 'Open SportsChud automatically when you sign in to Windows.'],
    ['startSilently', 'Start silently', 'On startup, run in the background with no window. Open it from the tray icon. Needs "Keep running in tray".'],
    ['keepInTray', 'Keep running in tray', 'Closing the window hides it to the tray so alerts keep coming. Quit from the tray icon.'],
    ['overlayEnabled', 'Mini scoreboard', 'A small always-on-top window with the score and clock of your live games. Drag it anywhere; it remembers where you left it. Also in the tray menu.'],
    ['checkForUpdates', 'Check for updates automatically', 'Looks for a newer SportsChud on GitHub at startup and every few hours. It never installs anything until you click Install.'],
    ['showTestAlert', 'Show "Send test alert" button', 'Adds a Send test alert button to the bottom of the sidebar, for checking that Windows notifications work. Off by default.']
  ];
  const autohide = [
    ['playoffsAutoHide', 'Autohide Playoffs', 'Only show the Playoffs tab while one of your teams is still alive in a postseason. It disappears if your teams missed the playoffs or are eliminated. Turn off to always show it.'],
    ['activityAutoHide', 'Autohide Activity', 'Only show the Activity tab once the first alert of the session has been sent. Turn off to always show it.'],
    ['hideOffSeason', 'Autohide out of season sports', 'When a sport\'s season and playoffs are over (no games in the last couple of days or the next week and a half), take that sport and your teams in it out of Scores, Recaps, Standings, Schedules and Injuries. Roster and Teams still list them, and alerts keep working.'],
    ['hideEliminated', 'Autohide teams that are out', 'When one of your teams is out of the season or the playoffs (it lost its last playoff series, missed the playoffs, or ESPN marks it eliminated), take that team out of Scores, Recaps, Standings, Schedules and Injuries. If that was your only team in a sport, the sport goes too. Roster and Teams still list it, and alerts keep working.'],
    ['overlayAutoHide', 'Autohide Mini scoreboard', 'Only show the mini scoreboard while one of your teams is playing a live game. Turn off to keep it on screen with a "No live games" message. Needs "Mini scoreboard" turned on.']
  ];
  const isOn = (k) => (DEFAULT_ON.includes(k) ? state.settings[k] !== false : !!state.settings[k]); // always the current settings: persist() replaces the object
  const row = ([k, title, desc]) => `
    <div class="setrow">
      <div><b>${title}</b><span>${desc}</span></div>
      <button class="switch ${isOn(k) ? 'on' : ''}" data-set="${k}" role="switch" aria-checked="${isOn(k)}" aria-label="${title}"></button>
    </div>`;
  view.innerHTML = `<div class="setlist">
    ${updateRow()}
    ${general.map(row).join('')}
    <h3 class="sethead">Autohide</h3>
    ${autohide.map(row).join('')}
    <div class="setrow danger">
      <div><b>Clear all app data</b><span>Removes your teams, alert choices, sidebar layout, startup settings and cached data, then closes SportsChud. The next time you open it, it's like a fresh install.</span></div>
      <div id="resetbox"><button class="dbtn" id="resetBtn">Clear data…</button></div>
    </div></div>`;
  if ($('#updCheck')) $('#updCheck').onclick = () => api.checkUpdate();
  if ($('#updInstall')) $('#updInstall').onclick = () => api.installUpdate();
  $('#resetBtn').onclick = () => {
    $('#resetbox').innerHTML = `<button class="ghost" id="resetNo">Cancel</button> <button class="dbtn" id="resetYes">Yes, erase everything</button>`;
    $('#resetNo').onclick = () => renderSettings();
    $('#resetYes').onclick = async () => {
      $('#resetbox').innerHTML = '<span>Clearing…</span>';
      await api.resetApp();
    };
  };
  view.querySelectorAll('[data-set]').forEach((b) => {
    b.onclick = async () => {
      const k = b.dataset.set;
      const st = state.settings;
      if (k === 'overlayEnabled') {
        // The main process owns this one (the tray menu changes it too), so ask it rather than saving it here
        st[k] = await api.setOverlay(!isOn(k));
        renderSettings();
        return;
      }
      st[k] = !isOn(k);
      if (k === 'startSilently' && st[k]) st.keepInTray = true;   // silent start needs the tray
      if (k === 'keepInTray' && !st[k]) st.startSilently = false; // and can't run without it
      await persist();
      if (k === 'playoffsAutoHide' || k === 'activityAutoHide') buildNav();
      if (k === 'hideOffSeason' && st[k]) await refreshSeasonStatus();
      if (k === 'hideEliminated' && st[k]) await refreshOutStatus();
      if (k === 'showTestAlert') applyTestButton();
      renderSettings();
    };
  });
}

/* ---------- Sidebar (reorderable + lockable) ---------- */
const NAV_ITEMS = {
  scores: ['◉', 'Scores'],
  recaps: ['▶', 'Recaps'],
  standings: ['≡', 'Standings'],
  playoffs: ['❖', 'Playoffs'],
  roster: ['☰', 'Roster'],
  injuries: ['✚', 'Injuries'],
  schedule: ['▦', 'Schedules'],
  teams: ['★', 'Teams'],
  activity: ['✦', 'Activity']
};

// Playoffs only shows while a league is in its postseason, unless autohide is switched off
// state.playoffLeagues = leagues in their postseason where a followed team is still alive
const playoffsVisible = () => state.settings.playoffsAutoHide === false || state.playoffLeagues.length > 0;
// Activity stays hidden until the first alert of the session has been sent, unless autohide is switched off
const activityVisible = () => state.settings.activityAutoHide === false || state.activity.length > 0;
const navVisible = (k) => (k !== 'playoffs' || playoffsVisible()) && (k !== 'activity' || activityVisible());

async function refreshPlayoffStatus() {
  try { state.playoffLeagues = await api.playoffStatus(); } catch (_) { return; }
  buildNav();
  if (state.tab === 'playoffs' && !playoffsVisible()) setTab('scores');
}

function navOrder() {
  const known = Object.keys(NAV_ITEMS);
  const saved = (state.settings.navOrder || []).filter((k) => known.includes(k));
  return [...saved, ...known.filter((k) => !saved.includes(k))];
}

function buildNav() {
  const order = navOrder().filter(navVisible);
  const locked = state.settings.navLocked !== false;
  $('#nav').innerHTML = order.map((k, i) => `
    <div class="navrow">
      <button class="nav ${state.tab === k ? 'active' : ''}" data-view="${k}"><i>${NAV_ITEMS[k][0]}</i> ${NAV_ITEMS[k][1]}</button>
      ${locked ? '' : `<span class="mv">
        <button data-mv="${k}" data-d="-1" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
        <button data-mv="${k}" data-d="1" ${i === order.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
      </span>`}
    </div>`).join('');
  const lock = $('#navlock');
  lock.textContent = locked ? '🔒 Sidebar locked' : '🔓 Reorder, then lock';
  lock.classList.toggle('open', !locked);
  $('#nav').querySelectorAll('.nav').forEach((n) => (n.onclick = () => setTab(n.dataset.view)));
  $('#nav').querySelectorAll('[data-mv]').forEach((b) => {
    b.onclick = async () => {
      const o = navOrder();
      const vis = o.filter(navVisible); // swap with the neighbour you can actually see
      const vi = vis.indexOf(b.dataset.mv);
      const vj = vi + +b.dataset.d;
      if (vj < 0 || vj >= vis.length) return;
      const i = o.indexOf(vis[vi]);
      const j = o.indexOf(vis[vj]);
      [o[i], o[j]] = [o[j], o[i]];
      state.settings.navOrder = o;
      buildNav();
      await persist();
    };
  });
}

$('#navlock').onclick = async () => {
  state.settings.navLocked = state.settings.navLocked === false;
  buildNav();
  await persist();
};

/* ---------- Recap video links ---------- */
// Each league's official YouTube channel, searched for the followed team so the latest uploads show first.
const LEAGUE_CHANNEL = { nhl: 'NHL', nba: 'NBA', mlb: 'MLB', nfl: 'NFL' }; // others (NCAAF) use a general YouTube search
function videoLink(g, fol) {
  const ch = LEAGUE_CHANNEL[g.league];
  const team = perspective(g, fol).mine;
  // Team plus the game date (e.g. "Maple Leafs Oct 6, 2026") puts that exact game's video first
  const date = new Date(g.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (!ch) return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${team.name} football highlights ${date}`)}`;
  return `https://www.youtube.com/@${ch}/search?query=${encodeURIComponent(`${team.nick || team.name} ${date}`)}`;
}

/* ---------- Recaps view ---------- */
const RECAP_GAMES = 3;          // finals shown per followed team
const RECAP_LOOKBACK_DAYS = 35; // how far back to search for them
async function renderRecaps() {
  titleEl.textContent = 'Recaps';
  if (!state.settings.follows.length) {
    subEl.textContent = '';
    view.innerHTML = `<div class="empty"><h3>Pick your teams</h3><p>Follow a few teams and their latest final scores and recaps show up here.</p>
      <button class="cta" id="goTeams">Choose teams</button></div>`;
    $('#goTeams').onclick = () => setTab('teams');
    return;
  }
  const shown = shownFollows();
  if (!shown.length) { subEl.textContent = ''; return showAllHidden('Recaps'); }
  subEl.textContent = `Last ${RECAP_GAMES} finals for each of your teams`;
  view.innerHTML = `<div class="empty"><p>Loading recaps…</p></div>`;
  // Look back far enough that weekly sports (NFL, NCAAF, with a bye) still have 3 finals to show
  const end = Date.now() + 86400000;
  const start = end - RECAP_LOOKBACK_DAYS * 86400000;
  let result;
  try { result = await api.schedule(start, end); } catch (e) { result = { games: [], errors: [e.message], failed: true }; }
  if (state.tab !== 'recaps') return;
  if (result.failed) {
    view.innerHTML = `<div class="empty"><h3>Couldn't load recaps</h3><p>${esc(result.errors.join('; ') || 'Check your connection and try again.')}</p>
      <button class="cta" id="retry">Try again</button></div>`;
    $('#retry').onclick = () => renderRecaps();
    return;
  }
  const finals = result.games.filter((g) => g.state === 'post').sort((a, b) => new Date(b.date) - new Date(a.date));
  // Newest RECAP_GAMES finals per followed team; By status shows the union of those games
  const keep = new Set();
  const perTeam = new Map();
  for (const f of shown) {
    const list = gamesOfTeam(f, finals).slice(0, RECAP_GAMES);
    perTeam.set(f, list);
    list.forEach((g) => keep.add(g.id));
  }
  const games = finals.filter((g) => keep.has(g.id));
  if (!games.length) {
    view.innerHTML = `<div class="empty"><h3>No recent finals</h3><p>None of your teams have a finished game in the last ${RECAP_LOOKBACK_DAYS} days.</p></div>`;
    return;
  }
  const card = (g, fol) => {
    const p = perspective(g, fol);
    const d = new Date(g.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return `<article class="rcard" style="--c:${p.mine.color || '#7c8cff'}">
      <div class="rhead"><span>${g.icon} ${esc(g.leagueName)} · ${esc(d)}</span><span class="rbadge ${p.cls}">${p.cls === 'W' ? 'WIN' : p.cls === 'L' ? 'LOSS' : 'FINAL'}</span></div>
      <div class="rscore">
        <div class="rt"><img src="${esc(g.away.logo)}" alt="" /><b>${esc(g.away.name)}</b><em>${g.away.score}</em></div>
        <div class="rt"><img src="${esc(g.home.logo)}" alt="" /><b>${esc(g.home.name)}</b><em>${g.home.score}</em></div>
      </div>
      <div class="rfoot">
        <span>${esc(g.detail || 'Final')}${g.broadcast ? ' · ' + esc(g.broadcast) : ''}</span>
        <div class="rlinks">
          ${g.link ? `<button class="rbtn" data-open="${esc(g.link)}">Stats</button>` : ''}
          ${videoLink(g, fol) ? `<button class="rbtn hi" data-open="${esc(videoLink(g, fol))}">Recap videos</button>` : ''}
        </div>
      </div>
    </article>`;
  };
  const warn = result.errors.length ? `<div class="calnote warn">Some games may be missing: ${esc(result.errors.join('; '))}</div>` : '';
  pickGroup(renderRecaps);
  if (groupMode() === 'team') {
    const blocks = shown.map((f) => ({ f, list: perTeam.get(f) })).filter((b) => b.list.length);
    view.innerHTML = warn + blocks.map((b) => `${teamHead(b.f)}<div class="rgrid">${b.list.map((g) => card(g, b.f)).join('')}</div>`).join('');
  } else {
    view.innerHTML = warn + `<div class="rgrid">${games.map((g) => card(g)).join('')}</div>`;
  }
  view.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => api.openLink(b.dataset.open)));
}

/* ---------- Routing ---------- */
function render() {
  $('#hact').innerHTML = '';
  if (state.tab === 'scores') renderScores();
  else if (state.tab === 'schedule') renderSchedule();
  else if (state.tab === 'standings') renderStandings();
  else if (state.tab === 'playoffs') renderPlayoffs();
  else if (state.tab === 'roster') renderRoster();
  else if (state.tab === 'injuries') renderInjuries();
  else if (state.tab === 'recaps') renderRecaps();
  else if (state.tab === 'teams') renderTeams();
  else if (state.tab === 'settings') renderSettings();
  else renderActivity();
}

function setTab(tab) {
  if (state.detail) { stopDetailTimer(); state.detail = null; } // leaving Scores (or clicking it again) closes an open game
  state.tab = tab;
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active', n.dataset.view === tab));
  render();
}

$('#navSettings').onclick = () => setTab('settings');
$('#test').onclick = () => api.testNotification();
// The test button is only in the sidebar while "Show Send test alert button" is on (off by default)
function applyTestButton() { $('#test').hidden = !settingOn('showTestAlert'); }

/* ---------- Boot ---------- */
(async function init() {
  [state.leagues, state.defaults, state.settings, state.games, state.activity] = await Promise.all([
    api.leagues(), api.defaults(), api.getSettings(), api.getGames(), api.getActivity()
  ]);
  // Make sure older saved teams have every alert key
  state.settings.follows.forEach((f) => (f.alerts = { ...state.defaults, ...f.alerts }));
  // Drop teams from leagues that are no longer supported (e.g. soccer)
  const kept = state.settings.follows.filter((f) => leagueOf(f.league));
  if (kept.length !== state.settings.follows.length) {
    state.settings.follows = kept;
    persist();
  }

  applyTestButton();
  try { state.version = await api.version(); } catch (_) {}
  try { state.update = await api.updateState(); } catch (_) {}
  $('#updbar').onclick = () => setTab('settings');
  api.onUpdate((u) => {
    state.update = u;
    renderUpdBar();
    if (state.tab === 'settings') renderSettings();
  });
  renderUpdBar();
  buildNav();
  refreshPlayoffStatus();
  setInterval(refreshPlayoffStatus, 30 * 60000);
  refreshSeasonStatus();
  setInterval(refreshSeasonStatus, 3 * 3600000);
  refreshOutStatus();
  setInterval(refreshOutStatus, 30 * 60000);

  api.onGames((g) => {
    state.games = g;
    if (state.tab === 'scores') renderScores();
  });
  // The mini scoreboard was switched from the tray menu or closed with its own ✕
  api.onOverlay((on) => {
    state.settings.overlayEnabled = on;
    if (state.tab === 'settings') renderSettings();
  });
  api.onActivity((a) => {
    state.activity.unshift(a);
    if (state.activity.length === 1) buildNav(); // first alert: the Activity tab appears
    if (state.tab === 'activity') renderActivity();
  });
  setInterval(() => state.tab === 'scores' && renderScores(), 30000); // keep countdowns fresh

  setTab(state.settings.follows.length ? 'scores' : 'teams');
})();
