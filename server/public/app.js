const loginView = document.getElementById("login");
const appView = document.getElementById("app");
const list = document.getElementById("list");
const search = document.getElementById("search");
const count = document.getElementById("count");
const synced = document.getElementById("synced");
const loginError = document.getElementById("login-error");
const addForm = document.getElementById("add-form");
const addError = document.getElementById("add-error");
const REFRESH_MS = 15_000;

let bookmarks = [];
let edits = {};        // id -> pending edit the extension hasn't picked up yet
let syncedAt = null;
let refreshTimer = 0;
let editingId = null;  // bookmark whose time is being edited

function formatTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// "12:34", "1:02:03" or plain seconds. null if it isn't a time.
function parseTime(text) {
  const parts = text.trim().split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

function timeAgo(ms) {
  if (!ms) return "";
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function showLogin() {
  clearInterval(refreshTimer);
  editingId = null;
  appView.hidden = true;
  loginView.hidden = false;
  document.getElementById("passkey").focus();
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  load();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
}

async function load() {
  const { status, body } = await api("/api/bookmarks");
  if (status === 401) return showLogin();
  if (status !== 200) return;
  bookmarks = body.bookmarks;
  edits = body.edits || {};
  syncedAt = body.syncedAt;
  if (!editingId) render(); // don't throw away a time you're typing
}

function closeEditor() {
  editingId = null;
  render();
}

function render() {
  const all = [...bookmarks].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const query = search.value.trim().toLowerCase();
  const items = query ? all.filter((b) => (b.title || "").toLowerCase().includes(query)) : all;

  count.textContent = all.length ? ` (${all.length})` : "";
  synced.textContent = syncedAt ? `Synced ${timeAgo(syncedAt)}` : "Never synced";
  synced.title = syncedAt ? new Date(syncedAt).toLocaleString() : "Turn on syncing in the extension's Settings";
  list.textContent = "";

  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = all.length ? "No bookmarks match your search."
      : syncedAt ? "No bookmarks yet. Watch a video past 0:10."
      : "Nothing here yet. Turn on syncing in the extension's Settings.";
    list.appendChild(empty);
    return;
  }

  for (const b of items) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(b.id)}&t=${b.time}s`;
    link.target = "_blank";
    link.rel = "noopener";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.src = `https://i.ytimg.com/vi/${encodeURIComponent(b.id)}/mqdefault.jpg`;
    img.alt = "";
    img.loading = "lazy";
    const badge = document.createElement("span");
    badge.className = "badge";
    // Videos added here have no length until you watch them in Chrome.
    badge.textContent = b.duration ? `${formatTime(b.time)} / ${formatTime(b.duration)}` : formatTime(b.time);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.style.width = `${b.duration ? Math.min(100, (b.time / b.duration) * 100) : 0}%`;
    bar.appendChild(fill);
    thumb.append(img, badge, bar);

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = b.title;
    title.title = b.title;

    link.append(thumb, title);
    li.append(link, b.id === editingId ? timeEditor(b) : metaRow(b));
    list.appendChild(li);
  }
}

function metaRow(b) {
  const meta = document.createElement("div");
  meta.className = "meta";
  const text = document.createElement("span");
  const left = b.duration > b.time ? `${formatTime(b.duration - b.time)} left` : "";
  // Changed here, but Chrome hasn't picked it up yet (it's off, or within a minute).
  const waiting = edits[b.id] ? "waiting for Chrome" : "";
  text.textContent = [left, timeAgo(b.updatedAt), waiting].filter(Boolean).join(" · ");

  const edit = document.createElement("button");
  edit.className = "edit";
  edit.textContent = "Edit time";
  edit.addEventListener("click", () => {
    editingId = b.id;
    render();
    list.querySelector(".edit-time input")?.select();
  });
  const remove = document.createElement("button");
  remove.className = "edit";
  remove.textContent = "Remove";
  remove.addEventListener("click", async () => {
    if (!confirm(`Remove "${b.title}"?`)) return;
    remove.disabled = true;
    const { status, body } = await api("/api/bookmarks", { method: "DELETE", body: JSON.stringify({ id: b.id }) });
    if (status === 401) return showLogin();
    if (status !== 200) {
      remove.disabled = false;
      alert(body.error || "Something went wrong");
      return;
    }
    load();
  });

  const buttons = document.createElement("div");
  buttons.className = "buttons";
  buttons.append(edit, remove);
  meta.append(text, buttons);
  return meta;
}

function timeEditor(b) {
  const form = document.createElement("form");
  form.className = "edit-time";
  const input = document.createElement("input");
  input.value = formatTime(b.time);
  input.autocomplete = "off";
  input.setAttribute("aria-label", "New time");
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "save";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const error = document.createElement("div");
  error.className = "error";
  error.setAttribute("role", "alert");

  cancel.addEventListener("click", closeEditor);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") closeEditor(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const time = parseTime(input.value);
    if (time == null) {
      error.textContent = "Type a time like 12:34 or 1:02:03";
      return;
    }
    if (b.duration && time > b.duration) {
      error.textContent = `The video is only ${formatTime(b.duration)} long`;
      return;
    }
    save.disabled = true;
    error.textContent = "";
    const { status, body } = await api("/api/bookmarks", {
      method: "PATCH",
      body: JSON.stringify({ id: b.id, time }),
    });
    if (status === 401) return showLogin();
    if (status !== 200) {
      save.disabled = false;
      error.textContent = body.error || "Something went wrong";
      return;
    }
    editingId = null;
    load();
  });

  form.append(input, save, cancel, error);
  return form;
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("passkey");
  loginError.textContent = "";
  const { status, body } = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ passkey: input.value }),
  });
  if (status === 200) {
    input.value = "";
    showApp();
  } else {
    loginError.textContent = body.error || "Something went wrong";
    input.select();
  }
});

document.getElementById("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  bookmarks = [];
  list.textContent = "";
  showLogin();
});

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = document.getElementById("add-url");
  const start = document.getElementById("add-time");
  const button = addForm.querySelector("button");
  addError.textContent = "";
  // Blank start time: use the link's own ?t= if it has one (the server reads it).
  const time = start.value.trim() ? parseTime(start.value) : undefined;
  if (time === null) {
    addError.textContent = "Type a start time like 12:34 or 1:02:03, or leave it empty";
    return;
  }
  button.disabled = true;
  const { status, body } = await api("/api/bookmarks", {
    method: "POST",
    body: JSON.stringify({ url: url.value, time }),
  });
  button.disabled = false;
  if (status === 401) return showLogin();
  if (status !== 200) {
    addError.textContent = body.error || "Something went wrong";
    return;
  }
  url.value = "";
  start.value = "";
  load();
});

search.addEventListener("input", render);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !appView.hidden) load(); });

api("/api/session").then(({ body }) => (body.authed ? showApp() : showLogin()));
