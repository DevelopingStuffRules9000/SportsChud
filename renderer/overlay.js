// Mini scoreboard page. It only reads data: the same live feed as the main window (games:get / games:update)
// plus the followed teams (to tint them). The window is sized by main.js from the height reported below.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let games = [];
let follows = [];

const isFollowed = (g, team) => follows.some((f) => f.league === g.league && String(f.teamId) === team.id);

// "2nd Period" -> "2nd", "3rd Quarter" -> "3rd", "Overtime" -> "OT": the window is narrow
function periodText(g) {
  return String(g.label || '')
    .replace(/ Period| Quarter/, '')
    .replace(/^End of /, 'End ')
    .replace('Overtime', 'OT')
    .replace('Shootout', 'SO');
}

function liveBlock(g) {
  const clock = g.kind !== 'baseball' && !g.isBreak && g.clock ? g.clock : ''; // baseball has no game clock
  const away = g.away.score, home = g.home.score;
  const team = (t, other) => `
    <div class="t ${isFollowed(g, t) ? 'fol' : ''}">
      <img src="${esc(t.logo)}" alt="" />
      <span class="ab">${esc(t.abbr)}</span>
      <b class="sc ${t.score > other ? 'lead' : ''}">${esc(t.score)}</b>
    </div>`;
  return `<div class="g">
    <div class="teams">${team(g.away, home)}${team(g.home, away)}</div>
    <div class="st"><span class="lbl"><i class="dot"></i>${esc(periodText(g))}</span>${clock ? `<span class="clk">${esc(clock)}</span>` : ''}</div>
  </div>`;
}

// The next game still to start, shown when nothing is live
function nextText() {
  const next = games
    .filter((g) => g.state === 'pre' && new Date(g.date) > Date.now())
    .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  if (!next) return '';
  const d = new Date(next.date);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const when = d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `Next: ${next.away.abbr} @ ${next.home.abbr} · ${when}`;
}

function render() {
  const live = games.filter((g) => g.state === 'in').sort((a, b) => new Date(a.date) - new Date(b.date));
  $('#games').innerHTML = live.length
    ? live.map(liveBlock).join('')
    : `<div class="empty"><b>No live games</b>${esc(nextText())}</div>`;
  // A logo that fails to load is just hidden (inline handlers are blocked by the page's CSP)
  $('#games').querySelectorAll('img').forEach((img) => { img.onerror = () => { img.style.visibility = 'hidden'; }; });
}

async function loadFollows() {
  try { follows = (await api.getSettings()).follows || []; } catch (_) {}
}

// Tell main.js how tall the content is so the window hugs it
let sizeQueued = false;
function reportSize() {
  if (sizeQueued) return;
  sizeQueued = true;
  requestAnimationFrame(() => {
    sizeQueued = false;
    api.overlaySize(Math.ceil($('#card').getBoundingClientRect().height));
  });
}

(async function init() {
  $('#open').onclick = () => api.showMain();
  $('#close').onclick = () => api.setOverlay(false);
  await loadFollows();
  try { games = await api.getGames(); } catch (_) {}
  render();
  new ResizeObserver(reportSize).observe($('#card'));
  reportSize();
  api.onGames(async (g) => {
    games = g;
    await loadFollows(); // picks up teams followed or unfollowed since the last update
    render();
  });
  setInterval(render, 60000); // keeps the "Next:" time current when nothing is live
})();
