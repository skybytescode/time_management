const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const MIN_MINUTES = 1;
const MAX_MINUTES = 240;
const STEP = 5;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const R = 94; // the gold progress fills the whole dial; matches #disc in index.html

// ---- Language (English / Romanian) ----

let lang = (() => {
  try {
    return localStorage.getItem("lang") === "ro" ? "ro" : "en";
  } catch {
    return "en";
  }
})();

// The locale used for dates and times follows the chosen language.
const L = () => (lang === "ro" ? "ro-RO" : "en-GB");

// Every user-facing string, with an English and a Romanian form. A value may be a function
// when it takes arguments (times, counts, names) interpolated at call time.
const STR = {
  // Tabs and the language switch.
  tab_session: { en: "Session", ro: "Sesiune" },
  tab_goals: { en: "Goals", ro: "Ținte" },
  tab_history: { en: "History", ro: "Istoric" },
  tab_activity: { en: "Activity", ro: "Activitate" },
  tab_blocked: { en: "Blocked", ro: "Blocate" },
  tab_ask: { en: "Ask", ro: "Întreabă" },
  switch_language: { en: "Read in Romanian", ro: "Citește în engleză" },

  // Shared labels and buttons.
  today: { en: "Today", ro: "Astăzi" },
  worked: { en: "Worked", ro: "Lucrat" },
  breaks: { en: "Breaks", ro: "Pauze" },
  total: { en: "Total", ro: "Total" },
  goal: { en: "Goal", ro: "Țintă" },
  objectives: { en: "Objectives", ro: "Obiective" },
  objectives_word: { en: "Objectives", ro: "Obiective" },
  notes: { en: "Notes", ro: "Notițe" },
  edit: { en: "Edit", ro: "Editează" },
  delete: { en: "Delete", ro: "Șterge" },
  save: { en: "Save", ro: "Salvează" },
  cancel: { en: "Cancel", ro: "Anulează" },
  add: { en: "Add", ro: "Adaugă" },
  confirm: { en: "Confirm", ro: "Confirmă" },
  confirm_delete: { en: "Click again to delete", ro: "Apasă din nou pentru a șterge" },
  now: { en: "now", ro: "acum" },

  // Session setup.
  task_ph: { en: "Session title: what are you working on?", ro: "Titlul sesiunii: la ce lucrezi?" },
  mode_open: { en: "Open", ro: "Deschisă" },
  mode_timed: { en: "Timer", ro: "Cronometru" },
  minus_aria: { en: "Remove minutes", ro: "Scade minute" },
  plus_aria: { en: "Add minutes", ro: "Adaugă minute" },
  min: { en: "min", ro: "min" },
  objectives_ph: { en: "What should this session achieve?", ro: "Ce ar trebui să realizeze această sesiune?" },
  edit_title_ph: { en: "Session title", ro: "Titlul sesiunii" },
  start: { en: "Start", ro: "Pornește" },
  stop: { en: "Stop", ro: "Oprește" },
  break: { en: "Break", ro: "Pauză" },
  resume: { en: "Resume", ro: "Reia" },
  no_objectives: { en: "No objectives written for this session.", ro: "Niciun obiectiv scris pentru această sesiune." },
  no_goal: { en: "No goal", ro: "Fără țintă" },

  // The running session's times.
  started_at: { en: (time) => `Started ${time}`, ro: (time) => `Pornită la ${time}` },
  ends_at: { en: (time) => `Ends ${time}`, ro: (time) => `Se termină la ${time}` },
  on_break: { en: (dur) => `On break ${dur}`, ro: (dur) => `În pauză de ${dur}` },
  session_finished: { en: "Work session finished.", ro: "Sesiunea de lucru s-a încheiat." },
  no_sessions_today: { en: "No sessions yet today.", ro: "Nicio sesiune astăzi încă." },

  // Assistant feed.
  kind_greeting: { en: "Hello", ro: "Salut" },
  kind_start: { en: "Started", ro: "Pornită" },
  kind_technical: { en: "Tip", ro: "Sfat" },
  kind_motivational: { en: "Motivation", ro: "Motivație" },
  kind_break: { en: "Break advice", ro: "Sfat pauză" },
  kind_break_over: { en: "Break over", ro: "Pauză încheiată" },
  kind_finished: { en: "Done", ro: "Gata" },
  saw: { en: (obs) => `Saw: ${obs}`, ro: (obs) => `Am văzut: ${obs}` },

  // Notes.
  edited: { en: "edited", ro: "editat" },
  note_ph: { en: "Add a note… (Ctrl+Enter)", ro: "Adaugă o notiță… (Ctrl+Enter)" },
  add_note: { en: "Add note", ro: "Adaugă notiță" },

  // History.
  hist_list: { en: "List", ro: "Listă" },
  hist_calendar: { en: "Calendar", ro: "Calendar" },
  range_today: { en: "Today", ro: "Astăzi" },
  range_week: { en: "7 days", ro: "7 zile" },
  range_month: { en: "30 days", ro: "30 zile" },
  range_all: { en: "All", ro: "Tot" },
  from: { en: "From", ro: "De la" },
  to: { en: "To", ro: "Până la" },
  search_ph: { en: "Search titles, objectives and notes", ro: "Caută titluri, obiective și notițe" },
  no_sessions_found: { en: "No sessions found.", ro: "Nicio sesiune găsită." },
  worked_lc: { en: "worked", ro: "lucrat" },
  breaks_lc: { en: "breaks", ro: "pauze" },
  work_lc: { en: "work", ro: "lucru" },
  break_lc: { en: "break", ro: "pauză" },
  total_lc: { en: "total", ro: "total" },
  of_plan: { en: (min) => ` of ${min}m`, ro: (min) => ` din ${min}m` },
  ask_claude: { en: "Ask Claude", ro: "Întreabă Claude" },
  goal_prefix: { en: (title) => `Goal: ${title}`, ro: (title) => `Țintă: ${title}` },
  break_span: { en: (a, b) => `Break ${a}–${b}`, ro: (a, b) => `Pauză ${a}–${b}` },

  // Calendar.
  prev_month_aria: { en: "Previous month", ro: "Luna anterioară" },
  next_month_aria: { en: "Next month", ro: "Luna următoare" },
  cal_mon: { en: "Mon", ro: "Lun" },
  cal_tue: { en: "Tue", ro: "Mar" },
  cal_wed: { en: "Wed", ro: "Mie" },
  cal_thu: { en: "Thu", ro: "Joi" },
  cal_fri: { en: "Fri", ro: "Vin" },
  cal_sat: { en: "Sat", ro: "Sâm" },
  cal_sun: { en: "Sun", ro: "Dum" },
  no_sessions_month: { en: "No sessions this month.", ro: "Nicio sesiune luna aceasta." },
  day_work: { en: (str) => `Work ${str}`, ro: (str) => `Lucru ${str}` },
  day_breaks: { en: (str) => `Breaks ${str}`, ro: (str) => `Pauze ${str}` },

  // Activity.
  prev_day_aria: { en: "Previous day", ro: "Ziua anterioară" },
  next_day_aria: { en: "Next day", ro: "Ziua următoare" },
  timeline: { en: "Timeline", ro: "Cronologie" },
  act_now: { en: (app, title) => `Now: ${app} — ${title}`, ro: (app, title) => `Acum: ${app} — ${title}` },
  tracked: { en: (str) => `${str} tracked`, ro: (str) => `${str} urmărit` },
  nothing_tracked: { en: "Nothing tracked.", ro: "Nimic urmărit." },
  unknown: { en: "Unknown", ro: "Necunoscut" },

  // Goals.
  goal_title_ph: { en: "A goal, e.g. Finish the time management app", ro: "O țintă, ex. Termină aplicația de time management" },
  goal_details_ph: { en: "Details (optional)", ro: "Detalii (opțional)" },
  by: { en: "By", ro: "Până la" },
  add_goal: { en: "Add goal", ro: "Adaugă țintă" },
  goals_active: { en: "Active", ro: "Active" },
  goals_done: { en: "Done", ro: "Finalizate" },
  goals_all: { en: "All", ro: "Toate" },
  no_active_goals: { en: "No active goals. Add one above.", ro: "Nicio țintă activă. Adaugă una mai sus." },
  no_done_goals: { en: "No goals completed yet.", ro: "Nicio țintă finalizată încă." },
  no_goals: { en: "No goals yet.", ro: "Nicio țintă încă." },
  mark_active: { en: "Mark as active", ro: "Marchează ca activă" },
  mark_done: { en: "Mark as done", ro: "Marchează ca finalizată" },
  due_by: { en: (date) => `by ${date}`, ro: (date) => `până la ${date}` },

  // Blocked sites.
  always_block_label: { en: "Block these sites whenever the app is running", ro: "Blochează aceste site-uri cât timp aplicația rulează" },
  reason_ph: { en: "Why do you need this? (Ctrl+Enter)", ro: "De ce ai nevoie de asta? (Ctrl+Enter)" },
  site_ph: { en: "Add a site, e.g. reddit.com", ro: "Adaugă un site, ex. reddit.com" },
  blocking_active: { en: "Blocking is active — these sites are unreachable now.", ro: "Blocarea este activă — aceste site-uri sunt inaccesibile acum." },
  blocking_inactive: {
    en: "Not blocking right now. Turn on the switch above, or it starts with a session.",
    ro: "Nu blochează acum. Pornește comutatorul de sus, sau începe odată cu o sesiune.",
  },
  allowed_badge: { en: "Allowed", ro: "Permis" },
  block_btn: { en: "Block", ro: "Blochează" },
  allow_btn: { en: "Allow", ro: "Permite" },
  remove: { en: "Remove", ro: "Elimină" },
  allow_prompt: { en: (d) => `Allow ${d} — why do you need it now?`, ro: (d) => `Permite ${d} — de ce ai nevoie de el acum?` },
  no_block_sites: { en: "No sites in the block list.", ro: "Niciun site în lista de blocare." },
  turn_off_prompt: { en: "Turn off blocking entirely — why?", ro: "Oprești complet blocarea — de ce?" },
  asking_claude: { en: "Asking Claude…", ro: "Se întreabă Claude…" },
  claude_says: { en: (op) => `Claude: ${op}`, ro: (op) => `Claude: ${op}` },
  sites_not_blocked: { en: (err) => `Sites not blocked: ${err}`, ro: (err) => `Site-uri neblocate: ${err}` },

  // Ask.
  scope_all: { en: "All sessions", ro: "Toate sesiunile" },
  ask_all_btn: { en: "Ask about all sessions", ro: "Întreabă despre toate sesiunile" },
  new_chat: { en: "New chat", ro: "Conversație nouă" },
  question_ph: { en: "Ask Claude about your sessions and notes… (Ctrl+Enter)", ro: "Întreabă Claude despre sesiunile și notițele tale… (Ctrl+Enter)" },
  ask_btn: { en: "Ask", ro: "Întreabă" },
  thinking: { en: "Thinking…", ro: "Se gândește…" },
  chat_hint: {
    en: "Ask about what you worked on, what your notes say, or what to do next.",
    ro: "Întreabă despre ce ai lucrat, ce spun notițele tale, sau ce să faci în continuare.",
  },
  scope_session: { en: (task, day) => `Session: ${task} (${day})`, ro: (task, day) => `Sesiune: ${task} (${day})` },
};

function t(key, ...args) {
  const entry = STR[key];
  if (!entry) return key;
  const value = entry[lang] ?? entry.en;
  return typeof value === "function" ? value(...args) : value;
}

// Romanian pluralises differently, so the known words carry both forms.
const PLURALS = {
  note: { en: ["note", "notes"], ro: ["notiță", "notițe"] },
  message: { en: ["message", "messages"], ro: ["mesaj", "mesaje"] },
  break: { en: ["break", "breaks"], ro: ["pauză", "pauze"] },
  session: { en: ["session", "sessions"], ro: ["sesiune", "sesiuni"] },
};

const KIND_KEY = {
  greeting: "kind_greeting",
  start: "kind_start",
  technical: "kind_technical",
  motivational: "kind_motivational",
  break: "kind_break",
  "break-over": "kind_break_over",
  finished: "kind_finished",
};
const kindLabel = (kind) => (KIND_KEY[kind] ? t(KIND_KEY[kind]) : kind);

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
const sessionGoal = $("session-goal");
const runningGoal = $("running-goal");

let minutes = 25;
let session = null; // see `Session` in lib.rs
let messages = [];

const clamp = (m) => Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, m));
const timed = () => document.querySelector('input[name="mode"]:checked').value === "timed";
const clockTime = (ms) =>
  new Date(ms).toLocaleTimeString(L(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

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
const plural = (n, word) => {
  const forms = (PLURALS[word] ?? {})[lang] ?? PLURALS[word]?.en ?? [word, `${word}s`];
  return `${n} ${n === 1 ? forms[0] : forms[1]}`;
};

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
    const parts = [t("started_at", clockTime(session.start_ms))];
    if (session.end_ms) parts.push(t("ends_at", clockTime(session.end_ms)));
    if (session.break_start_ms) parts.push(t("on_break", duration(now - session.break_start_ms)));
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
    totalField.textContent = `${t("total")} ${hoursMinutes((r.end_ms ?? now) - r.start_ms)}`;
    workedField.textContent = `${t("worked")} ${hoursMinutes(recordWorkedMs(r, now))}`;
    breaksField.textContent = `${t("breaks")} ${hoursMinutes(recordBreakMs(r, now))} (${r.breaks.length})`;
  }
}

// Newest first; the times are filled in by updateToday.
function renderToday() {
  todayFields = [];
  const items = todayRecords.map((r) => {
    const item = el("li", r.end_ms ? "today-session" : "today-session running");
    const head = el("div", "record-head");
    head.append(el("span", "when", `${clockTime(r.start_ms)}–${r.end_ms ? clockTime(r.end_ms) : t("now")}`));
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
  if (!items.length) items.push(el("li", "chat-hint", t("no_sessions_today")));
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
  text.textContent = session.objectives || t("no_objectives");
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
    objectivesDelete.textContent = t("confirm_delete");
    setTimeout(() => {
      objectivesDelete.classList.remove("confirm");
      objectivesDelete.textContent = t("delete");
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
  head.append(el("span", "kind", kindLabel(message.kind)), el("span", "at", clockTime(message.at_ms)));
  item.append(head, el("p", "text", message.text));
  if (message.observation) item.append(el("p", "observation", t("saw", message.observation)));
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
    const when = new Date(note.created_ms).toLocaleString(L(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    head.append(el("span", null, note.updated_ms !== note.created_ms ? `${when} · ${t("edited")}` : when));
    const actions = el("span", "note-actions");
    const edit = el("button", "link", t("edit"));
    const remove = el("button", "link danger", t("delete"));
    actions.append(edit, remove);
    head.append(actions);
    item.append(head, el("p", "note-text", note.text));

    edit.addEventListener("click", () => {
      const textarea = area(note.text);
      const save = el("button", "small", t("save"));
      const cancel = el("button", "link", t("cancel"));
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
        remove.textContent = t("confirm_delete");
        setTimeout(() => {
          remove.classList.remove("confirm");
          remove.textContent = t("delete");
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
  input.placeholder = t("note_ph");
  const add = el("button", "small", t("add_note"));
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

function optionEl(value, label, selected) {
  const opt = el("option", null, label);
  opt.value = value;
  if (selected) opt.selected = true;
  return opt;
}

// Fills a goal <select> with "No goal" plus active goals (and the chosen one even if done).
async function fillGoalSelect(select, selectedId) {
  let goals = [];
  try {
    goals = await invoke("get_goals");
  } catch (e) {
    /* leave just "No goal" */
  }
  const choices = goals.filter((g) => !g.done || g.id === selectedId);
  select.replaceChildren(
    optionEl("", t("no_goal"), selectedId == null),
    ...choices.map((g) => optionEl(String(g.id), g.title, g.id === selectedId)),
  );
}

function render() {
  const active = session !== null;
  toggle.textContent = active ? t("stop") : t("start");
  toggle.classList.toggle("active", active);
  breakButton.hidden = !active;
  breakButton.textContent = session?.break_start_ms ? t("resume") : t("break");
  setup.hidden = active;
  setter.hidden = !timed();
  currentTask.hidden = !active;
  currentTask.textContent = session?.task ?? "";
  $("session-goal-row").hidden = !active;
  if (active) fillGoalSelect(runningGoal, session.goal_id ?? null);
  else fillGoalSelect(sessionGoal, null);
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
        goalId: sessionGoal.value ? Number(sessionGoal.value) : null,
      });
      messages = [];
      renderFeed();
      taskInput.value = "";
      objectivesInput.value = "";
      status.textContent = session.block_error ? t("sites_not_blocked", session.block_error) : "";
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

runningGoal.addEventListener("change", async () => {
  try {
    session = await invoke("set_session_goal", { goalId: runningGoal.value ? Number(runningGoal.value) : null });
  } catch (e) {
    status.textContent = String(e);
  }
});

listen("session-finished", () => {
  session = null;
  showCurrentNotes();
  status.textContent = t("session_finished");
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
  if (view === "session-view" && !session) fillGoalSelect(sessionGoal, null);
  if (view === "goals-view") loadGoals();
  if (view === "activity-view") loadActivity();
  if (view === "blocked-view") loadBlocking();
  if (view === "ask-view") question.focus();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => showView(tab.dataset.view));
}

// ---- Language ----

const langButton = $("lang-toggle");

// Re-apply every string: the static labels from data-i18n, then the dynamic views that are open.
function applyLang() {
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-ph]")) node.placeholder = t(node.dataset.i18nPh);
  for (const node of document.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", t(node.dataset.i18nAria));
  langButton.textContent = lang === "en" ? "RO" : "EN";
  langButton.title = t("switch_language");
  render();
  renderFeed();
  renderToday();
  renderChat();
  showCurrentNotes();
  if (!$("history-view").hidden) refreshHistory();
  if (!$("goals-view").hidden) loadGoals();
  if (!$("activity-view").hidden) loadActivity();
  if (!$("blocked-view").hidden) loadBlocking();
}

langButton.addEventListener("click", () => {
  lang = lang === "en" ? "ro" : "en";
  try {
    localStorage.setItem("lang", lang);
  } catch {
    /* private mode: the choice just won't persist */
  }
  applyLang();
});

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
    ? `${plural(records.length, "session")} · ${hoursMinutes(total)} ${t("worked_lc")} · ${plural(breaks, "break")}`
    : t("no_sessions_found");
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
  const day = new Date(record.start_ms).toLocaleDateString(L(), { weekday: "short", day: "numeric", month: "short" });
  const span = `${day} · ${clockTime(record.start_ms)}–${record.end_ms ? clockTime(record.end_ms) : t("now")}`;
  const plan = record.planned_minutes ? t("of_plan", record.planned_minutes) : "";
  const total = end - record.start_ms;
  const bits = [`${hoursMinutes(worked)} ${t("work_lc")}`];
  if (record.breaks.length) bits.push(`${hoursMinutes(recordBreakMs(record, now))} ${t("break_lc")}`);
  bits.push(`${hoursMinutes(total)} ${t("total_lc")}${plan}`);
  head.append(el("span", "when", span), el("span", "worked", bits.join(" · ")));
  const taskRow = el("div", "record-task-row");
  const ask = el("button", "link", t("ask_claude"));
  ask.addEventListener("click", () => askAbout(record));
  taskRow.append(el("p", "record-task", record.task), ask);
  main.append(head, taskRow);
  if (record.goal_title) main.append(el("p", "record-goal", t("goal_prefix", record.goal_title)));
  if (record.objectives) main.append(el("p", "record-objectives", record.objectives));

  // Work in gold, breaks in grey, and a dot for each thing the assistant said.
  const timeline = el("div", "timeline");
  const at = (ms) => `${(100 * (ms - record.start_ms)) / Math.max(1, end - record.start_ms)}%`;
  for (const b of record.breaks) {
    const segment = el("div", "segment");
    segment.style.left = at(b.start_ms);
    segment.style.right = `calc(100% - ${at(b.end_ms ?? end)})`;
    segment.title = t("break_span", clockTime(b.start_ms), b.end_ms ? clockTime(b.end_ms) : t("now"));
    timeline.append(segment);
  }
  for (const m of record.messages) {
    const dot = el("div", `dot ${m.kind}`);
    dot.style.left = at(m.at_ms);
    dot.title = `${clockTime(m.at_ms)} ${kindLabel(m.kind)}: ${m.text}`;
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
  pie.title = `${hoursMinutes(total)} ${t("total_lc")} · ${hoursMinutes(worked)} ${t("work_lc")} · ${hoursMinutes(breakTotal)} ${t("break_lc")}`;
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
  $("month-label").textContent = calendarMonth.toLocaleDateString(L(), { month: "long", year: "numeric" });
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
    ? `${plural(records.length, "session")} · ${t("worked_lc")} ${hoursMinutes(sum(records, recordWorkedMs))} · ${t("breaks_lc")} ${hoursMinutes(sum(records, recordBreakMs))}`
    : t("no_sessions_month");

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
      const chip = el("li", "chip", `${clockTime(r.start_ms)}–${r.end_ms ? clockTime(r.end_ms) : t("now")}`);
      chip.dataset.title = r.task;
      list.append(chip);
    }
    td.append(
      list,
      el("div", "day-sum", t("day_work", hoursMinutes(sum(sessions, recordWorkedMs)))),
      el("div", "day-sum breaks", t("day_breaks", hoursMinutes(sum(sessions, recordBreakMs)))),
    );
  }
  $("calendar-body").replaceChildren(...rows);
}

// ---- Activity ----

let activityDay = new Date().setHours(0, 0, 0, 0);

function prettyApp(app) {
  if (!app) return t("unknown");
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
    ? t("today")
    : new Date(activityDay).toLocaleDateString(L(), { weekday: "long", day: "numeric", month: "long" });
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
  $("act-current").textContent = current ? t("act_now", prettyApp(current.app), current.title) : "";
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
  $("act-total").textContent = rows.length ? t("tracked", hoursMinutes(total)) : t("nothing_tracked");
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
        el("span", "act-when", `${clockTime(r.start_ms)}–${r.end_ms ? clockTime(r.end_ms) : t("now")}`),
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
    const hint = { active: t("no_active_goals"), done: t("no_done_goals"), all: t("no_goals") }[goalFilter];
    goalList.append(el("li", "chat-hint", hint));
  }
}

function goalItem(goal) {
  const item = el("li", goal.done ? "goal done" : "goal");

  const check = el("input");
  check.type = "checkbox";
  check.className = "goal-check";
  check.checked = goal.done;
  check.title = goal.done ? t("mark_active") : t("mark_done");
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
    head.append(el("span", `goal-due${overdue ? " overdue" : ""}`, t("due_by", new Date(goal.due_ms).toLocaleDateString(L(), { day: "numeric", month: "short", year: "numeric" }))));
  }
  body.append(head);
  if (goal.details) body.append(el("p", "goal-details-text", goal.details));

  const actions = el("span", "goal-actions");
  const edit = el("button", "link", t("edit"));
  const remove = el("button", "link danger", t("delete"));
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
    const save = el("button", "small", t("save"));
    const cancel = el("button", "link", t("cancel"));
    const buttons = el("div", "note-buttons");
    const dueLabel = el("label", "goal-due-label");
    dueLabel.append(document.createTextNode(`${t("by")} `), dueIn);
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
      remove.textContent = t("confirm_delete");
      setTimeout(() => {
        remove.classList.remove("confirm");
        remove.textContent = t("delete");
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
  blockOpinion.textContent = t("asking_claude");
  try {
    const state = await confirmFn(reason);
    closeReason();
    renderBlocking(state);
    blockOpinion.textContent = state.opinion ? t("claude_says", state.opinion) : "";
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
  blockStatus.textContent = state.active ? t("blocking_active") : t("blocking_inactive");
  blockStatus.classList.toggle("active", state.active);
  siteList.replaceChildren(
    ...state.sites.map((site) => {
      const item = el("li", site.allowed ? "site allowed" : "site");
      item.append(el("span", "site-name", site.domain));
      const actions = el("span", "site-actions");
      if (state.active && site.allowed) {
        actions.append(el("span", "allowed-badge", t("allowed_badge")));
        const block = el("button", "link", t("block_btn"));
        block.addEventListener("click", async () => {
          try {
            renderBlocking(await invoke("reblock_site", { domain: site.domain }));
          } catch (e) {
            blockError.textContent = String(e);
          }
        });
        actions.append(block);
      } else if (state.active) {
        const allow = el("button", "link", t("allow_btn"));
        allow.addEventListener("click", () =>
          openReason(t("allow_prompt", site.domain), (reason) =>
            invoke("allow_site", { domain: site.domain, reason }),
          ),
        );
        actions.append(allow);
      }
      const remove = el("button", "link danger", t("remove"));
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
  if (!state.sites.length) siteList.append(el("li", "chat-hint", t("no_block_sites")));
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
  openReason(t("turn_off_prompt"), (reason) =>
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
  scopeLabel.textContent = conversation.sessionId === null ? t("scope_all") : conversation.label;
  scopeAll.hidden = conversation.sessionId === null;
  const items = conversation.turns.map((turn) => el("li", `turn ${turn.role}`, turn.text));
  if (pending) items.push(el("li", "turn assistant pending", t("thinking")));
  if (!items.length) items.push(el("li", "chat-hint", t("chat_hint")));
  chat.replaceChildren(...items);
  chat.lastElementChild.scrollIntoView({ block: "end" });
}

function startChat(sessionId, label) {
  conversation = { sessionId, label, turns: [] };
  renderChat();
}

function askAbout(record) {
  const day = new Date(record.start_ms).toLocaleDateString(L(), { weekday: "short", day: "numeric", month: "short" });
  startChat(record.id, t("scope_session", record.task, day));
  showView("ask-view");
}

scopeAll.addEventListener("click", () => startChat(null, t("scope_all")));
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
  applyLang();
  loadToday();
  // Picks up a new day and sessions changed elsewhere (e.g. notes in History).
  setInterval(loadToday, 60_000);
  renderChat();
  setInterval(tick, 250);
});
