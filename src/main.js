const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const MIN_MINUTES = 1;
const MAX_MINUTES = 240;
const STEP = 5;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const R = 80; // radius of the dial's disc, matches index.html

const KIND_LABELS = {
  greeting: "Hello",
  start: "Started",
  technical: "Tip",
  motivational: "Motivation",
  break: "Break advice",
  "break-over": "Break over",
  finished: "Done",
};

const $ = (id) => document.getElementById(id);
const toggle = $("toggle");
const breakButton = $("break");
const setup = $("setup");
const setter = $("setter");
const taskInput = $("task");
const minutesInput = $("minutes");
const currentTask = $("current-task");
const dial = $("dial");
const disc = $("disc");
const wedge = $("wedge");
const hand = $("hand");
const remainingText = $("remaining");
const times = $("times");
const status = $("status");
const feed = $("feed");
const currentNotes = $("current-notes");

let minutes = 25;
let session = null; // see `Session` in lib.rs
let messages = [];

const clamp = (m) => Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, m));
const timed = () => document.querySelector('input[name="mode"]:checked').value === "timed";
const clockTime = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function duration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function hoursMinutes(ms) {
  const total = Math.round(ms / 60_000);
  const h = Math.floor(total / 60);
  return h > 0 ? `${h}h ${total % 60}m` : `${total}m`;
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

// A gold sector from 12 o'clock: time left on a timer, or the current hour of an open session.
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

const breakMs = (s, now) => s.break_ms + (s.break_start_ms ? now - s.break_start_ms : 0);

function tick() {
  const now = Date.now();
  dial.classList.toggle("paused", Boolean(session?.break_start_ms));
  if (!session) {
    drawDial(timed() ? 1 : 0);
    remainingText.textContent = duration(timed() ? minutes * 60_000 : 0);
  } else if (session.end_ms) {
    const left = Math.max(0, session.end_ms - now);
    drawDial(left / (session.end_ms - session.start_ms));
    remainingText.textContent = duration(left);
  } else {
    const elapsed = now - session.start_ms;
    drawDial((elapsed % HOUR_MS) / HOUR_MS);
    remainingText.textContent = duration(elapsed);
  }
  if (session) {
    const worked = now - session.start_ms - breakMs(session, now);
    const parts = [`Started ${clockTime(session.start_ms)}`];
    if (session.end_ms) parts.push(`Ends ${clockTime(session.end_ms)}`);
    parts.push(session.break_start_ms ? `On break ${duration(now - session.break_start_ms)}` : `Worked ${hoursMinutes(worked)}`);
    times.textContent = parts.join(" · ");
  }
}

function renderFeed() {
  feed.replaceChildren(...messages.map(messageItem).reverse());
}

function messageItem(message) {
  const item = el("li", `message ${message.kind}`);
  const head = el("div", "message-head");
  head.append(el("span", "kind", KIND_LABELS[message.kind] ?? message.kind), el("span", "at", clockTime(message.at_ms)));
  item.append(head, el("p", "text", message.text));
  if (message.observation) item.append(el("p", "observation", `Saw: ${message.observation}`));
  return item;
}

// A session's notes with add, edit and delete; `notes` is updated in place.
function notesEditor(sessionId, notes, onChange = () => {}) {
  const box = el("div", "notes");
  const list = el("ul", "note-list");
  const error = el("p", "note-error");
  const fail = (e) => (error.textContent = String(e));

  const area = (text = "") => {
    const textarea = el("textarea", "note-input");
    textarea.rows = 2;
    textarea.value = text;
    return textarea;
  };
  const onCtrlEnter = (textarea, action) =>
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) action();
    });
  const show = () => {
    list.replaceChildren(...notes.map(noteItem));
    onChange(notes);
  };

  function noteItem(note) {
    const item = el("li", "note");
    const head = el("div", "note-head");
    const when = new Date(note.created_ms).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    head.append(el("span", null, note.updated_ms !== note.created_ms ? `${when} · edited` : when));
    const actions = el("span", "note-actions");
    const edit = el("button", "link", "Edit");
    const remove = el("button", "link danger", "Delete");
    actions.append(edit, remove);
    head.append(actions);
    item.append(head, el("p", "note-text", note.text));

    edit.addEventListener("click", () => {
      const textarea = area(note.text);
      const save = el("button", "small", "Save");
      const cancel = el("button", "link", "Cancel");
      const row = el("div", "note-buttons");
      row.append(save, cancel);
      item.replaceChildren(textarea, row);
      textarea.focus();
      const submit = async () => {
        try {
          Object.assign(note, await invoke("update_note", { id: note.id, text: textarea.value }));
          error.textContent = "";
          show();
        } catch (e) {
          fail(e);
        }
      };
      save.addEventListener("click", submit);
      onCtrlEnter(textarea, submit);
      cancel.addEventListener("click", show);
    });

    // A second click within a few seconds confirms.
    remove.addEventListener("click", async () => {
      if (!remove.classList.contains("confirm")) {
        remove.classList.add("confirm");
        remove.textContent = "Click again to delete";
        setTimeout(() => {
          remove.classList.remove("confirm");
          remove.textContent = "Delete";
        }, 3000);
        return;
      }
      try {
        await invoke("delete_note", { id: note.id });
        notes.splice(notes.indexOf(note), 1);
        show();
      } catch (e) {
        fail(e);
      }
    });
    return item;
  }

  const input = area();
  input.placeholder = "Add a note… (Ctrl+Enter)";
  const add = el("button", "small", "Add note");
  const addNote = async () => {
    if (!input.value.trim()) return;
    try {
      notes.push(await invoke("add_note", { sessionId, text: input.value }));
      input.value = "";
      error.textContent = "";
      show();
    } catch (e) {
      fail(e);
    }
  };
  add.addEventListener("click", addNote);
  onCtrlEnter(input, addNote);
  const row = el("div", "note-buttons");
  row.append(add);

  box.append(list, input, row, error);
  show();
  return box;
}

async function showCurrentNotes() {
  currentNotes.querySelector(".notes")?.remove();
  currentNotes.hidden = !session;
  if (!session) return;
  try {
    currentNotes.append(notesEditor(session.id, await invoke("get_notes", { sessionId: session.id })));
  } catch (e) {
    status.textContent = String(e);
  }
}

function render() {
  const active = session !== null;
  toggle.textContent = active ? "Stop" : "Start";
  toggle.classList.toggle("active", active);
  breakButton.hidden = !active;
  breakButton.textContent = session?.break_start_ms ? "Resume" : "Break";
  setup.hidden = active;
  setter.hidden = !timed();
  currentTask.hidden = !active;
  currentTask.textContent = session?.task ?? "";
  times.hidden = !active;
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
for (const radio of document.querySelectorAll('input[name="mode"]')) radio.addEventListener("change", render);
taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !session) toggle.click();
});

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try {
    if (session) {
      session = null;
      status.textContent = "";
      await invoke("stop_session");
    } else {
      session = await invoke("start_session", { task: taskInput.value, minutes: timed() ? minutes : null });
      messages = [];
      renderFeed();
      taskInput.value = "";
      status.textContent = session.block_error ? `Sites not blocked: ${session.block_error}` : "";
    }
    showCurrentNotes();
  } catch (e) {
    status.textContent = String(e);
  } finally {
    toggle.disabled = false;
    render();
  }
});

breakButton.addEventListener("click", async () => {
  try {
    session = await invoke("set_break", { on: !session.break_start_ms });
  } catch (e) {
    status.textContent = String(e);
  }
  render();
});

listen("session-finished", () => {
  session = null;
  showCurrentNotes();
  status.textContent = "Work session finished.";
  render();
});

listen("assistant-message", ({ payload }) => {
  // A message for a session that's no longer shown (e.g. the end of one) still belongs in the feed.
  if (!messages.some((m) => m.at_ms === payload.at_ms && m.kind === payload.kind)) {
    messages.push(payload);
    renderFeed();
  }
});

// ---- Tabs ----

function showView(view) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === view);
    $(tab.dataset.view).hidden = tab.dataset.view !== view;
  }
  if (view === "history-view") loadHistory();
  if (view === "ask-view") question.focus();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => showView(tab.dataset.view));
}

// ---- History ----

const fromInput = $("from");
const toInput = $("to");
const searchInput = $("search");
const summary = $("summary");
const sessionsList = $("sessions");

const dateValue = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const startOfDay = (value) => new Date(`${value}T00:00`).getTime();

function setRange(range) {
  const today = startOfDay(dateValue(Date.now()));
  const days = { today: 0, week: 6, month: 29 }[range];
  fromInput.value = days === undefined ? "" : dateValue(today - days * DAY_MS);
  toInput.value = "";
  for (const button of document.querySelectorAll("[data-range]")) {
    button.classList.toggle("active", button.dataset.range === range);
  }
  loadHistory();
}

function clearRange() {
  for (const button of document.querySelectorAll("[data-range]")) button.classList.remove("active");
}

for (const button of document.querySelectorAll("[data-range]")) {
  button.addEventListener("click", () => setRange(button.dataset.range));
}
fromInput.addEventListener("change", () => (clearRange(), loadHistory()));
toInput.addEventListener("change", () => (clearRange(), loadHistory()));
let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 250);
});

async function loadHistory() {
  const filter = {
    from_ms: fromInput.value ? startOfDay(fromInput.value) : null,
    to_ms: toInput.value ? startOfDay(toInput.value) + DAY_MS : null,
    query: searchInput.value.trim() || null,
  };
  let records;
  try {
    records = await invoke("history", { filter });
  } catch (e) {
    summary.textContent = String(e);
    return;
  }
  const now = Date.now();
  const worked = (r) => {
    const end = r.end_ms ?? now;
    const breaks = r.breaks.reduce((sum, b) => sum + (b.end_ms ?? end) - b.start_ms, 0);
    return end - r.start_ms - breaks;
  };
  const total = records.reduce((sum, r) => sum + worked(r), 0);
  const breaks = records.reduce((sum, r) => sum + r.breaks.length, 0);
  summary.textContent = records.length
    ? `${records.length} session${records.length === 1 ? "" : "s"} · ${hoursMinutes(total)} worked · ${breaks} break${breaks === 1 ? "" : "s"}`
    : "No sessions found.";
  sessionsList.replaceChildren(...records.map((r) => sessionItem(r, worked(r), now)));
}

function sessionItem(record, worked, now) {
  const end = record.end_ms ?? now;
  const item = el("li", "record");

  const head = el("div", "record-head");
  const day = new Date(record.start_ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const span = `${day} · ${clockTime(record.start_ms)}–${record.end_ms ? clockTime(record.end_ms) : "now"}`;
  const plan = record.planned_minutes ? ` of ${record.planned_minutes}m` : "";
  head.append(el("span", "when", span), el("span", "worked", `${hoursMinutes(worked)}${plan}`));
  const taskRow = el("div", "record-task-row");
  const ask = el("button", "link", "Ask Claude");
  ask.addEventListener("click", () => askAbout(record));
  taskRow.append(el("p", "record-task", record.task), ask);
  item.append(head, taskRow);

  // Work in gold, breaks in grey, and a dot for each thing the assistant said.
  const timeline = el("div", "timeline");
  const at = (ms) => `${(100 * (ms - record.start_ms)) / Math.max(1, end - record.start_ms)}%`;
  for (const b of record.breaks) {
    const segment = el("div", "segment");
    segment.style.left = at(b.start_ms);
    segment.style.right = `calc(100% - ${at(b.end_ms ?? end)})`;
    segment.title = `Break ${clockTime(b.start_ms)}–${b.end_ms ? clockTime(b.end_ms) : "now"}`;
    timeline.append(segment);
  }
  for (const m of record.messages) {
    const dot = el("div", `dot ${m.kind}`);
    dot.style.left = at(m.at_ms);
    dot.title = `${clockTime(m.at_ms)} ${KIND_LABELS[m.kind] ?? m.kind}: ${m.text}`;
    timeline.append(dot);
  }
  item.append(timeline);

  const details = el("details");
  const heading = el("summary");
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const describe = (notes) =>
    (heading.textContent = [plural(notes.length, "note"), plural(record.messages.length, "message"), plural(record.breaks.length, "break")].join(" · "));
  details.append(heading, notesEditor(record.id, record.notes, describe));
  if (record.messages.length) {
    const list = el("ul", "feed");
    list.append(...record.messages.map(messageItem));
    details.append(list);
  }
  item.append(details);
  return item;
}

// ---- Ask ----

const chat = $("chat");
const question = $("question");
const askButton = $("ask");
const scopeLabel = $("scope-label");
const scopeAll = $("scope-all");
let conversation = { sessionId: null, label: "All sessions", turns: [] };

function renderChat(pending = false) {
  scopeLabel.textContent = conversation.label;
  scopeAll.hidden = conversation.sessionId === null;
  const items = conversation.turns.map((turn) => el("li", `turn ${turn.role}`, turn.text));
  if (pending) items.push(el("li", "turn assistant pending", "Thinking…"));
  if (!items.length) items.push(el("li", "chat-hint", "Ask about what you worked on, what your notes say, or what to do next."));
  chat.replaceChildren(...items);
  chat.lastElementChild.scrollIntoView({ block: "end" });
}

function startChat(sessionId, label) {
  conversation = { sessionId, label, turns: [] };
  renderChat();
}

function askAbout(record) {
  const day = new Date(record.start_ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  startChat(record.id, `Session: ${record.task} (${day})`);
  showView("ask-view");
}

scopeAll.addEventListener("click", () => startChat(null, "All sessions"));
$("new-chat").addEventListener("click", () => startChat(conversation.sessionId, conversation.label));
question.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) $("ask-form").requestSubmit();
});

$("ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = question.value.trim();
  if (!text || askButton.disabled) return;
  const asked = conversation;
  asked.turns.push({ role: "user", text });
  question.value = "";
  askButton.disabled = true;
  renderChat(true);
  try {
    const turns = asked.turns.filter((turn) => turn.role !== "error");
    const answer = await invoke("ask_notes", { sessionId: asked.sessionId, conversation: turns });
    asked.turns.push({ role: "assistant", text: answer });
  } catch (e) {
    asked.turns.push({ role: "error", text: String(e) });
  } finally {
    askButton.disabled = false;
    if (asked === conversation) renderChat();
  }
});

window.addEventListener("DOMContentLoaded", async () => {
  drawTicks();
  fromInput.value = dateValue(Date.now() - 6 * DAY_MS);
  session = await invoke("get_session");
  messages = await invoke("get_messages");
  renderFeed();
  render();
  showCurrentNotes();
  renderChat();
  setInterval(tick, 250);
});
