const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const MIN_MINUTES = 1;
const MAX_MINUTES = 240;
const STEP = 5;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const R = 94; // the gold progress fills the whole dial; matches #disc in index.html

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
const remainingText = $("remaining");
const times = $("times");
const status = $("status");
const feed = $("feed");
const currentNotes = $("current-notes");
const sessionTotals = $("session-totals");
const sessionGoal = $("session-goals");
const runningGoal = $("running-goals");

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
}

const breakMs = (s, now) => s.break_ms + (s.break_start_ms ? now - s.break_start_ms : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Break and work time of a history record; a running one counts up to `now`.
const recordBreakMs = (r, now) => r.breaks.reduce((sum, b) => sum + (b.end_ms ?? r.end_ms ?? now) - b.start_ms, 0);
const recordWorkedMs = (r, now) => (r.end_ms ?? now) - r.start_ms - recordBreakMs(r, now);

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
    const parts = [`Started ${clockTime(session.start_ms)}`];
    if (session.end_ms) parts.push(`Ends ${clockTime(session.end_ms)}`);
    if (session.break_start_ms) parts.push(`On break ${duration(now - session.break_start_ms)}`);
    times.textContent = parts.join(" · ");
    const breaks = session.breaks + (session.break_start_ms ? 1 : 0);
    $("session-total").textContent = hoursMinutes(now - session.start_ms);
    $("session-worked").textContent = hoursMinutes(now - session.start_ms - breakMs(session, now));
    $("session-breaks").textContent = `${hoursMinutes(breakMs(session, now))} (${breaks})`;
  }
  // The Today column counts up with the running session, once a second is enough.
  const second = Math.floor(now / 1000);
  if (second !== lastTodaySecond) {
    lastTodaySecond = second;
    updateToday(now);
  }
}

// ---- Today column ----

let todayRecords = [];
let todayFields = []; // [record, worked element, breaks element]
let lastTodaySecond = 0;

async function loadToday() {
  const from_ms = new Date().setHours(0, 0, 0, 0);
  try {
    todayRecords = await invoke("history", { filter: { from_ms, to_ms: null, query: null } });
  } catch (e) {
    status.textContent = String(e);
  }
  renderToday();
}

function updateToday(now) {
  const worked = todayRecords.reduce((sum, r) => sum + recordWorkedMs(r, now), 0);
  const breaks = todayRecords.reduce((sum, r) => sum + recordBreakMs(r, now), 0);
  $("today-total").textContent = hoursMinutes(worked + breaks);
  $("today-worked").textContent = hoursMinutes(worked);
  $("today-breaks").textContent = hoursMinutes(breaks);
  for (const [r, totalField, workedField, breaksField] of todayFields) {
    totalField.textContent = `Total ${hoursMinutes((r.end_ms ?? now) - r.start_ms)}`;
    workedField.textContent = `Worked ${hoursMinutes(recordWorkedMs(r, now))}`;
    breaksField.textContent = `Breaks ${hoursMinutes(recordBreakMs(r, now))} (${r.breaks.length})`;
  }
}

// Newest first; the times are filled in by updateToday.
function renderToday() {
  todayFields = [];
  const items = todayRecords.map((r) => {
    const item = el("li", r.end_ms ? "today-session" : "today-session running");
    const head = el("div", "record-head");
    head.append(el("span", "when", `${clockTime(r.start_ms)}–${r.end_ms ? clockTime(r.end_ms) : "now"}`));
    item.append(head, el("p", "today-title", r.task));
    const totals = el("div", "today-totals");
    const totalField = el("span");
    const workedField = el("span");
    const breaksField = el("span");
    totals.append(workedField, breaksField, totalField);
    todayFields.push([r, totalField, workedField, breaksField]);
    item.append(totals);
    if (r.objectives) item.title = r.objectives;
    return item;
  });
  if (!items.length) items.push(el("li", "chat-hint", "No sessions yet today."));
  $("today-sessions").replaceChildren(...items);
  updateToday(Date.now());
}

// ---- Objectives ----

const objectivesInput = $("objectives-input");
const objectivesView = $("objectives-view");
const objectivesForm = $("objectives-form");
const objectivesActions = $("objectives-actions");
const objectivesDelete = $("objectives-delete");
const objectivesError = $("objectives-error");
let editingObjectives = false;

function renderObjectives() {
  if (!session) editingObjectives = false;
  objectivesInput.hidden = Boolean(session);
  objectivesView.hidden = !session || editingObjectives;
  objectivesForm.hidden = !editingObjectives;
  objectivesActions.hidden = !session || editingObjectives;
  if (!session) return;
  $("objectives-title").textContent = session.task;
  const text = $("objectives-text");
  text.textContent = session.objectives || "No objectives written for this session.";
  text.classList.toggle("empty", !session.objectives);
  objectivesDelete.hidden = !session.objectives;
}

async function saveSessionInfo(task, objectives) {
  try {
    session = await invoke("update_session_info", { task, objectives });
    editingObjectives = false;
    objectivesError.textContent = "";
    loadToday();
  } catch (e) {
    objectivesError.textContent = String(e);
  }
  render();
}

$("objectives-edit").addEventListener("click", () => {
  editingObjectives = true;
  $("edit-title").value = session.task;
  $("edit-objectives").value = session.objectives;
  render();
  $("edit-objectives").focus();
});
$("objectives-cancel").addEventListener("click", () => {
  editingObjectives = false;
  objectivesError.textContent = "";
  render();
});
$("objectives-save").addEventListener("click", () => saveSessionInfo($("edit-title").value, $("edit-objectives").value));
$("edit-objectives").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) $("objectives-save").click();
});
// A second click within a few seconds confirms.
objectivesDelete.addEventListener("click", () => {
  if (!objectivesDelete.classList.contains("confirm")) {
    objectivesDelete.classList.add("confirm");
    objectivesDelete.textContent = "Click again to delete";
    setTimeout(() => {
      objectivesDelete.classList.remove("confirm");
      objectivesDelete.textContent = "Delete";
    }, 3000);
    return;
  }
  saveSessionInfo(session.task, "");
});

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

// A dropdown of checkboxes for linking a session to zero or more goals. `onChange(ids)` fires on
// every tick; `load(ids)` fills it from the current goals and marks `ids` as selected.
function goalMultiSelect(root, onChange = () => {}) {
  const summary = root.querySelector(".goal-summary");
  const options = root.querySelector(".goal-options");
  let selected = new Set();
  let titles = new Map();

  const refreshSummary = () => {
    const chosen = [...selected].map((id) => titles.get(id)).filter(Boolean);
    summary.textContent = chosen.length ? chosen.join(", ") : "No goals";
  };

  async function load(selectedIds) {
    selected = new Set(selectedIds ?? []);
    let goals = [];
    try {
      goals = await invoke("get_goals");
    } catch (e) {
      /* leave it empty */
    }
    // Active goals, plus any already-linked goal even if it has since been marked done.
    const choices = goals.filter((g) => !g.done || selected.has(g.id));
    titles = new Map(choices.map((g) => [g.id, g.title]));
    if (!choices.length) {
      options.replaceChildren(el("p", "goal-empty", "No goals yet — add some in the Goals tab."));
    } else {
      options.replaceChildren(
        ...choices.map((g) => {
          const label = el("label", "goal-option");
          const check = el("input");
          check.type = "checkbox";
          check.checked = selected.has(g.id);
          check.addEventListener("change", () => {
            if (check.checked) selected.add(g.id);
            else selected.delete(g.id);
            refreshSummary();
            onChange([...selected]);
          });
          label.append(check, el("span", null, g.title));
          return label;
        }),
      );
    }
    refreshSummary();
  }

  return { load, get selected() { return [...selected]; } };
}

const sessionGoals = goalMultiSelect(sessionGoal);
const runningGoals = goalMultiSelect(runningGoal, async (ids) => {
  try {
    session = await invoke("set_session_goals", { goalIds: ids });
  } catch (e) {
    status.textContent = String(e);
  }
});

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
  $("session-goal-row").hidden = !active;
  if (active) runningGoals.load(session.goals.map((g) => g.id));
  else sessionGoals.load([]);
  times.hidden = !active;
  sessionTotals.hidden = !active;
  minutesInput.value = minutes;
  renderObjectives();
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
      session = await invoke("start_session", {
        task: taskInput.value,
        objectives: objectivesInput.value,
        minutes: timed() ? minutes : null,
        goalIds: sessionGoals.selected,
      });
      messages = [];
      renderFeed();
      taskInput.value = "";
      objectivesInput.value = "";
      status.textContent = session.block_error ? `Sites not blocked: ${session.block_error}` : "";
    }
    showCurrentNotes();
  } catch (e) {
    status.textContent = String(e);
  } finally {
    toggle.disabled = false;
    render();
    loadToday();
    if (!$("blocked-view").hidden) loadBlocking();
  }
});

breakButton.addEventListener("click", async () => {
  try {
    session = await invoke("set_break", { on: !session.break_start_ms });
  } catch (e) {
    status.textContent = String(e);
  }
  render();
  loadToday();
});

listen("session-finished", () => {
  session = null;
  showCurrentNotes();
  status.textContent = "Work session finished.";
  render();
  loadToday();
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
  if (view === "history-view") refreshHistory();
  if (view === "session-view" && !session) sessionGoals.load([]);
  if (view === "goals-view") loadGoals();
  if (view === "activity-view") loadActivity();
  if (view === "blocked-view") loadBlocking();
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
  const worked = (r) => recordWorkedMs(r, now);
  const total = records.reduce((sum, r) => sum + worked(r), 0);
  const breaks = records.reduce((sum, r) => sum + r.breaks.length, 0);
  summary.textContent = records.length
    ? `${records.length} session${records.length === 1 ? "" : "s"} · ${hoursMinutes(total)} worked · ${breaks} break${breaks === 1 ? "" : "s"}`
    : "No sessions found.";
  sessionsList.replaceChildren(...records.map((r) => sessionItem(r, worked(r), now)));
}

// A clock-like pie: the session runs from 12 o'clock clockwise, work in gold and each break as a
// grey wedge at the position in time it actually happened.
function timePie(record, now) {
  const start = record.start_ms;
  const end = record.end_ms ?? now;
  const total = Math.max(1, end - start);
  const pie = el("div", "record-pie");
  const pt = (frac) => {
    const a = frac * 2 * Math.PI;
    return [22 + 20 * Math.sin(a), 22 - 20 * Math.cos(a)];
  };
  let wedges = "";
  for (const b of record.breaks) {
    const f0 = (b.start_ms - start) / total;
    const f1 = ((b.end_ms ?? end) - start) / total;
    if (f1 <= f0) continue;
    const [x0, y0] = pt(f0);
    const [x1, y1] = pt(f1);
    wedges += `<path d="M22 22 L${x0.toFixed(2)} ${y0.toFixed(2)} A20 20 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z" class="pie-break" />`;
  }
  pie.innerHTML = `<svg width="110" height="110" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20" class="pie-work" />${wedges}</svg>`;
  return pie;
}

function sessionItem(record, worked, now) {
  const end = record.end_ms ?? now;
  const item = el("li", "record");
  const main = el("div", "record-main");

  const head = el("div", "record-head");
  const day = new Date(record.start_ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const span = `${day} · ${clockTime(record.start_ms)}–${record.end_ms ? clockTime(record.end_ms) : "now"}`;
  const plan = record.planned_minutes ? ` of ${record.planned_minutes}m` : "";
  const total = end - record.start_ms;
  const bits = [`${hoursMinutes(worked)} work`];
  if (record.breaks.length) bits.push(`${hoursMinutes(recordBreakMs(record, now))} break`);
  bits.push(`${hoursMinutes(total)} total${plan}`);
  head.append(el("span", "when", span), el("span", "worked", bits.join(" · ")));
  const taskRow = el("div", "record-task-row");
  const ask = el("button", "link", "Ask Claude");
  ask.addEventListener("click", () => askAbout(record));
  taskRow.append(el("p", "record-task", record.task), ask);
  main.append(head, taskRow);
  if (record.goals.length) {
    const label = record.goals.length === 1 ? "Goal" : "Goals";
    main.append(el("p", "record-goal", `${label}: ${record.goals.map((g) => g.title).join(", ")}`));
  }
  if (record.objectives) main.append(el("p", "record-objectives", record.objectives));

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
  main.append(timeline);

  const details = el("details");
  const heading = el("summary");
  const describe = (notes) =>
    (heading.textContent = [plural(notes.length, "note"), plural(record.messages.length, "message"), plural(record.breaks.length, "break")].join(" · "));
  details.append(heading, notesEditor(record.id, record.notes, describe));
  if (record.messages.length) {
    const list = el("ul", "feed");
    list.append(...record.messages.map(messageItem));
    details.append(list);
  }
  main.append(details);

  const breakTotal = recordBreakMs(record, now);
  const pie = timePie(record, now);
  pie.title = `${hoursMinutes(total)} total · ${hoursMinutes(worked)} work · ${hoursMinutes(breakTotal)} break`;
  item.append(main, pie);
  return item;
}

// ---- History sub-tabs and calendar ----

let historyPane = "history-list";
for (const button of document.querySelectorAll("[data-history]")) {
  button.addEventListener("click", () => {
    historyPane = button.dataset.history;
    for (const other of document.querySelectorAll("[data-history]")) {
      other.classList.toggle("active", other === button);
      $(other.dataset.history).hidden = other !== button;
    }
    refreshHistory();
  });
}

function refreshHistory() {
  if (historyPane === "history-calendar") loadCalendar();
  else loadHistory();
}

let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
$("month-prev").addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  loadCalendar();
});
$("month-next").addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  loadCalendar();
});

// A month grid from Monday to Sunday: each day's sessions, worked and break time.
async function loadCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const from_ms = calendarMonth.getTime();
  const to_ms = new Date(year, month + 1, 1).getTime();
  $("month-label").textContent = calendarMonth.toLocaleDateString([], { month: "long", year: "numeric" });
  let records;
  try {
    records = await invoke("history", { filter: { from_ms, to_ms, query: null } });
  } catch (e) {
    $("month-totals").textContent = String(e);
    return;
  }
  const now = Date.now();
  const byDay = new Map();
  for (const r of [...records].reverse()) {
    const day = new Date(r.start_ms).getDate();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const sum = (list, f) => list.reduce((total, r) => total + f(r, now), 0);
  $("month-totals").textContent = records.length
    ? `${plural(records.length, "session")} · worked ${hoursMinutes(sum(records, recordWorkedMs))} · breaks ${hoursMinutes(sum(records, recordBreakMs))}`
    : "No sessions this month.";

  const today = new Date();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const offset = (calendarMonth.getDay() + 6) % 7; // Monday first
  const rows = [];
  let row;
  for (let cell = 0; cell < Math.ceil((offset + daysInMonth) / 7) * 7; cell++) {
    if (cell % 7 === 0) rows.push((row = el("tr")));
    const day = cell - offset + 1;
    const td = el("td");
    row.append(td);
    if (day < 1 || day > daysInMonth) {
      td.className = "outside";
      continue;
    }
    if (year === today.getFullYear() && month === today.getMonth() && day === today.getDate()) td.className = "today";
    td.append(el("div", "day-number", String(day)));
    const sessions = byDay.get(day) ?? [];
    if (!sessions.length) continue;
    const list = el("ul", "day-sessions");
    for (const r of sessions) {
      const chip = el("li", "chip", `${clockTime(r.start_ms)}–${r.end_ms ? clockTime(r.end_ms) : "now"}`);
      chip.dataset.title = r.task;
      list.append(chip);
    }
    td.append(
      list,
      el("div", "day-sum", `Work ${hoursMinutes(sum(sessions, recordWorkedMs))}`),
      el("div", "day-sum breaks", `Breaks ${hoursMinutes(sum(sessions, recordBreakMs))}`),
    );
  }
  $("calendar-body").replaceChildren(...rows);
}

// ---- Activity ----

let activityDay = new Date().setHours(0, 0, 0, 0);

function prettyApp(app) {
  if (!app) return "Unknown";
  const base = app.includes(".") ? app.slice(app.lastIndexOf(".") + 1) : app;
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

$("act-prev").addEventListener("click", () => {
  activityDay -= DAY_MS;
  loadActivity();
});
$("act-next").addEventListener("click", () => {
  if (activityDay + DAY_MS <= new Date().setHours(0, 0, 0, 0)) {
    activityDay += DAY_MS;
    loadActivity();
  }
});

const viewingToday = () => activityDay === new Date().setHours(0, 0, 0, 0);

async function loadActivity() {
  const isToday = viewingToday();
  $("act-label").textContent = isToday
    ? "Today"
    : new Date(activityDay).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  $("act-next").disabled = isToday;
  let rows;
  try {
    rows = await invoke("activities", { fromMs: activityDay, toMs: activityDay + DAY_MS });
  } catch (e) {
    $("act-total").textContent = String(e);
    return;
  }

  const now = Date.now();
  const current = rows.find((r) => isToday && (r.end_ms ?? now) >= now - 2000);
  $("act-current").textContent = current ? `Now: ${prettyApp(current.app)} — ${current.title}` : "";
  $("act-current").hidden = !current;

  // Total time per app, most used first.
  const perApp = new Map();
  let total = 0;
  for (const r of rows) {
    const ms = (r.end_ms ?? now) - r.start_ms;
    total += ms;
    perApp.set(r.app, (perApp.get(r.app) ?? 0) + ms);
  }
  const apps = [...perApp.entries()].sort((a, b) => b[1] - a[1]);
  $("act-total").textContent = rows.length ? `${hoursMinutes(total)} tracked` : "Nothing tracked.";
  const max = apps.length ? apps[0][1] : 1;
  $("act-apps").replaceChildren(
    ...apps.map(([app, ms]) => {
      const item = el("li", "act-app");
      item.append(el("span", "act-app-name", prettyApp(app)));
      const bar = el("div", "act-bar");
      const fill = el("div", "act-bar-fill");
      fill.style.width = `${(100 * ms) / max}%`;
      bar.append(fill);
      item.append(bar, el("span", "act-app-time", hoursMinutes(ms)));
      return item;
    }),
  );

  // Interval list, newest first (rows already arrive that way).
  $("act-timeline").replaceChildren(
    ...rows.map((r) => {
      const item = el("li", "act-interval");
      const end = r.end_ms ?? now;
      item.append(
        el("span", "act-when", `${clockTime(r.start_ms)}–${r.end_ms ? clockTime(r.end_ms) : "now"}`),
        el("span", "act-dur", hoursMinutes(end - r.start_ms)),
        el("span", "act-app-name", prettyApp(r.app)),
        el("span", "act-title", r.title),
      );
      return item;
    }),
  );
}

let activityRefresh;
listen("activity-changed", () => {
  if ($("activity-view").hidden || !viewingToday()) return;
  // Coalesce bursts of focus changes.
  clearTimeout(activityRefresh);
  activityRefresh = setTimeout(loadActivity, 500);
});

// ---- Goals ----

const goalForm = $("goal-form");
const goalTitle = $("goal-title");
const goalDetails = $("goal-details");
const goalDue = $("goal-due");
const goalError = $("goal-error");
const goalList = $("goal-list");
let goalRecords = [];
let goalFilter = "active";

for (const button of document.querySelectorAll("[data-goals]")) {
  button.addEventListener("click", () => {
    goalFilter = button.dataset.goals;
    for (const other of document.querySelectorAll("[data-goals]")) {
      other.classList.toggle("active", other === button);
    }
    renderGoals();
  });
}

async function loadGoals() {
  try {
    goalRecords = await invoke("get_goals");
  } catch (e) {
    goalError.textContent = String(e);
  }
  renderGoals();
}

const dueDateValue = (ms) => (ms == null ? null : dateValue(ms));

function renderGoals() {
  const list = goalRecords.filter((g) => goalFilter === "all" || (goalFilter === "done") === g.done);
  goalList.replaceChildren(...list.map(goalItem));
  if (!list.length) {
    const hint = { active: "No active goals. Add one above.", done: "No goals completed yet.", all: "No goals yet." }[goalFilter];
    goalList.append(el("li", "chat-hint", hint));
  }
}

function goalItem(goal) {
  const item = el("li", goal.done ? "goal done" : "goal");

  const check = el("input");
  check.type = "checkbox";
  check.className = "goal-check";
  check.checked = goal.done;
  check.title = goal.done ? "Mark as active" : "Mark as done";
  check.addEventListener("change", async () => {
    try {
      Object.assign(goal, await invoke("set_goal_done", { id: goal.id, done: check.checked }));
      goalError.textContent = "";
      loadGoals();
    } catch (e) {
      goalError.textContent = String(e);
      check.checked = goal.done;
    }
  });

  const body = el("div", "goal-body");
  const head = el("div", "goal-head");
  head.append(el("span", "goal-title-text", goal.title));
  if (goal.due_ms != null && !goal.done) {
    const overdue = goal.due_ms < Date.now();
    head.append(el("span", `goal-due${overdue ? " overdue" : ""}`, `by ${new Date(goal.due_ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`));
  }
  body.append(head);
  if (goal.details) body.append(el("p", "goal-details-text", goal.details));

  const actions = el("span", "goal-actions");
  const edit = el("button", "link", "Edit");
  const remove = el("button", "link danger", "Delete");
  actions.append(edit, remove);

  edit.addEventListener("click", () => {
    const titleIn = el("input", "goal-edit-title");
    titleIn.type = "text";
    titleIn.maxLength = 200;
    titleIn.value = goal.title;
    const detailsIn = el("textarea", "note-input");
    detailsIn.rows = 2;
    detailsIn.value = goal.details;
    const dueIn = el("input");
    dueIn.type = "date";
    if (goal.due_ms != null) dueIn.value = dueDateValue(goal.due_ms);
    const save = el("button", "small", "Save");
    const cancel = el("button", "link", "Cancel");
    const buttons = el("div", "note-buttons");
    const dueLabel = el("label", "goal-due-label");
    dueLabel.append(document.createTextNode("By "), dueIn);
    buttons.append(dueLabel, save, cancel);
    const form = el("div", "goal-edit");
    form.append(titleIn, detailsIn, buttons);
    item.replaceChildren(form);
    titleIn.focus();
    save.addEventListener("click", async () => {
      try {
        Object.assign(goal, await invoke("update_goal", {
          id: goal.id,
          title: titleIn.value,
          details: detailsIn.value,
          dueMs: dueIn.value ? startOfDay(dueIn.value) : null,
        }));
        goalError.textContent = "";
        renderGoals();
      } catch (e) {
        goalError.textContent = String(e);
      }
    });
    cancel.addEventListener("click", renderGoals);
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
      await invoke("delete_goal", { id: goal.id });
      goalRecords = goalRecords.filter((g) => g !== goal);
      renderGoals();
    } catch (e) {
      goalError.textContent = String(e);
    }
  });

  item.append(check, body, actions);
  return item;
}

goalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!goalTitle.value.trim()) return;
  try {
    const goal = await invoke("add_goal", {
      title: goalTitle.value,
      details: goalDetails.value,
      dueMs: goalDue.value ? startOfDay(goalDue.value) : null,
    });
    goalRecords.unshift(goal);
    goalTitle.value = "";
    goalDetails.value = "";
    goalDue.value = "";
    goalError.textContent = "";
    goalFilter = "active";
    for (const b of document.querySelectorAll("[data-goals]")) b.classList.toggle("active", b.dataset.goals === "active");
    loadGoals();
  } catch (e) {
    goalError.textContent = String(e);
  }
});

// ---- Blocked sites ----

const alwaysBlock = $("always-block");
const blockStatus = $("block-status");
const blockError = $("block-error");
const blockOpinion = $("block-opinion");
const siteInput = $("site-input");
const siteList = $("site-list");
const reasonBox = $("reason-box");
const reasonInput = $("reason-input");

// A reason is required before any block is lifted. `confirmFn(reason)` returns the new state.
let reasonConfirm = null;
function openReason(label, confirmFn) {
  $("reason-prompt").textContent = label;
  reasonInput.value = "";
  blockError.textContent = "";
  blockOpinion.textContent = "";
  reasonBox.hidden = false;
  reasonConfirm = confirmFn;
  reasonInput.focus();
}
function closeReason() {
  reasonBox.hidden = true;
  reasonConfirm = null;
}

async function submitReason() {
  const reason = reasonInput.value.trim();
  if (!reason || !reasonConfirm) return;
  const confirmFn = reasonConfirm;
  $("reason-confirm").disabled = true;
  blockOpinion.textContent = "Asking Claude…";
  try {
    const state = await confirmFn(reason);
    closeReason();
    renderBlocking(state);
    blockOpinion.textContent = state.opinion ? `Claude: ${state.opinion}` : "";
  } catch (e) {
    blockError.textContent = String(e);
    blockOpinion.textContent = "";
  } finally {
    $("reason-confirm").disabled = false;
  }
}

$("reason-confirm").addEventListener("click", submitReason);
$("reason-cancel").addEventListener("click", () => {
  closeReason();
  loadBlocking();
});
reasonInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) submitReason();
});

function renderBlocking(state) {
  alwaysBlock.checked = state.always_block;
  blockStatus.textContent = state.active
    ? "Blocking is active — these sites are unreachable now."
    : "Not blocking right now. Turn on the switch above, or it starts with a session.";
  blockStatus.classList.toggle("active", state.active);
  siteList.replaceChildren(
    ...state.sites.map((site) => {
      const item = el("li", site.allowed ? "site allowed" : "site");
      item.append(el("span", "site-name", site.domain));
      const actions = el("span", "site-actions");
      if (state.active && site.allowed) {
        actions.append(el("span", "allowed-badge", "Allowed"));
        const block = el("button", "link", "Block");
        block.addEventListener("click", async () => {
          try {
            renderBlocking(await invoke("reblock_site", { domain: site.domain }));
          } catch (e) {
            blockError.textContent = String(e);
          }
        });
        actions.append(block);
      } else if (state.active) {
        const allow = el("button", "link", "Allow");
        allow.addEventListener("click", () =>
          openReason(`Allow ${site.domain} — why do you need it now?`, (reason) =>
            invoke("allow_site", { domain: site.domain, reason }),
          ),
        );
        actions.append(allow);
      }
      const remove = el("button", "link danger", "Remove");
      remove.addEventListener("click", async () => {
        try {
          renderBlocking(await invoke("remove_blocked_site", { domain: site.domain }));
        } catch (e) {
          blockError.textContent = String(e);
        }
      });
      actions.append(remove);
      item.append(actions);
      return item;
    }),
  );
  if (!state.sites.length) siteList.append(el("li", "chat-hint", "No sites in the block list."));
}

async function loadBlocking() {
  closeReason();
  blockOpinion.textContent = "";
  try {
    renderBlocking(await invoke("get_blocking"));
  } catch (e) {
    blockStatus.textContent = String(e);
  }
}

alwaysBlock.addEventListener("change", async () => {
  if (alwaysBlock.checked) {
    try {
      renderBlocking(await invoke("set_always_block", { on: true, reason: null }));
    } catch (e) {
      blockError.textContent = String(e);
      alwaysBlock.checked = false;
    }
    return;
  }
  // Turning the block off needs a reason; keep it checked until confirmed.
  alwaysBlock.checked = true;
  openReason("Turn off blocking entirely — why?", (reason) =>
    invoke("set_always_block", { on: false, reason }),
  );
});

$("add-site-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const domain = siteInput.value.trim();
  if (!domain) return;
  try {
    renderBlocking(await invoke("add_blocked_site", { domain }));
    siteInput.value = "";
    blockError.textContent = "";
  } catch (e) {
    blockError.textContent = String(e);
  }
});

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
  loadToday();
  // Picks up a new day and sessions changed elsewhere (e.g. notes in History).
  setInterval(loadToday, 60_000);
  renderChat();
  setInterval(tick, 250);
});
