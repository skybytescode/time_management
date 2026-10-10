const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const MIN_MINUTES = 1;
const MAX_MINUTES = 240;
const STEP = 5;
const R = 80; // radius of the remaining-time disc, matches index.html

const $ = (id) => document.getElementById(id);
const toggle = $("toggle");
const setter = $("setter");
const minutesInput = $("minutes");
const disc = $("disc");
const wedge = $("wedge");
const hand = $("hand");
const remainingText = $("remaining");
const times = $("times");
const status = $("status");

let minutes = 25;
let session = null; // { start_ms, end_ms, block_error } while running

const clamp = (m) => Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, m));
const clockTime = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function duration(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function drawTicks() {
  const ticks = $("ticks");
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const a = (i / 60) * 2 * Math.PI;
    const [r1, r2] = major ? [83, 93] : [87, 93];
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", 100 + r1 * Math.sin(a));
    line.setAttribute("y1", 100 - r1 * Math.cos(a));
    line.setAttribute("x2", 100 + r2 * Math.sin(a));
    line.setAttribute("y2", 100 - r2 * Math.cos(a));
    line.setAttribute("class", major ? "tick major" : "tick");
    ticks.appendChild(line);
  }
}

// Remaining time as a red sector starting at 12 o'clock, like a kitchen countdown timer.
function drawDial(fraction) {
  const full = fraction >= 0.9999;
  const a = fraction * 2 * Math.PI;
  const x = 100 + R * Math.sin(a);
  const y = 100 - R * Math.cos(a);
  disc.style.display = full ? "" : "none";
  wedge.style.display = full || fraction <= 0 ? "none" : "";
  wedge.setAttribute("d", `M100 100 L100 ${100 - R} A${R} ${R} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y} Z`);
  hand.setAttribute("x2", x);
  hand.setAttribute("y2", y);
}

function tick() {
  if (session) {
    const left = Math.max(0, session.end_ms - Date.now());
    drawDial(left / (session.end_ms - session.start_ms));
    remainingText.textContent = duration(left);
  } else {
    drawDial(1);
    remainingText.textContent = duration(minutes * 60_000);
  }
}

function render() {
  const active = session !== null;
  toggle.textContent = active ? "Stop" : "Start";
  toggle.classList.toggle("active", active);
  setter.hidden = active;
  times.hidden = !active;
  if (active) {
    times.textContent = `Started ${clockTime(session.start_ms)} · Ends ${clockTime(session.end_ms)}`;
  }
  minutesInput.value = minutes;
  tick();
}

function setMinutes(m) {
  minutes = clamp(Number.isFinite(m) ? Math.round(m) : minutes);
  render();
}

$("plus").addEventListener("click", () => setMinutes(Math.floor(minutes / STEP) * STEP + STEP));
$("minus").addEventListener("click", () => setMinutes(Math.ceil(minutes / STEP) * STEP - STEP));
minutesInput.addEventListener("change", () => setMinutes(minutesInput.valueAsNumber));

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try {
    if (session) {
      session = null;
      status.textContent = "";
      await invoke("stop_session");
    } else {
      session = await invoke("start_session", { minutes });
      status.textContent = session.block_error ? `Sites not blocked: ${session.block_error}` : "";
    }
  } catch (e) {
    status.textContent = String(e);
  } finally {
    toggle.disabled = false;
    render();
  }
});

listen("session-finished", () => {
  session = null;
  status.textContent = "Work session finished successfully — take a rest.";
  render();});

window.addEventListener("DOMContentLoaded", async () => {
  drawTicks();
  session = await invoke("get_session");
  render();
  setInterval(tick, 250);
});
