const enabledInput = document.getElementById("enabled");
const urlInput = document.getElementById("url");
const passkeyInput = document.getElementById("passkey");
const message = document.getElementById("message");
const statusEl = document.getElementById("status");
const SYNC_KEY = "sync";
const STATUS_KEY = "syncStatus";

function timeAgo(ms) {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function say(text, kind = "") {
  message.textContent = text;
  message.className = kind;
}

// "localhost:3000/" -> "http://localhost:3000". Returns null if it isn't a web link.
function cleanUrl(value) {
  let text = value.trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const u = new URL(text);
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// Chrome has to allow the extension to talk to the server. Must be the first
// thing a click does, or Chrome won't show the prompt.
function askPermission(url) {
  const u = new URL(url);
  return chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
}

// Check the link and passkey, then ask for permission. Returns the clean link or null.
async function checkForm() {
  const url = cleanUrl(urlInput.value);
  if (!url) {
    say("Enter your server link, e.g. http://localhost:3000", "error");
    return null;
  }
  const granted = await askPermission(url);
  if (!granted) {
    say("Chrome needs your permission to send bookmarks to that server.", "error");
    return null;
  }
  if (!passkeyInput.value) {
    say("Enter your server's passkey.", "error");
    return null;
  }
  return url;
}

async function save() {
  say("");
  const enabled = enabledInput.checked;
  let url = cleanUrl(urlInput.value);
  if (enabled) {
    url = await checkForm();
    if (!url) {
      enabledInput.checked = false;
      return;
    }
  }
  urlInput.value = url || "";
  await chrome.storage.local.set({
    [SYNC_KEY]: { enabled, url: url || "", passkey: passkeyInput.value },
  });
  say(enabled ? "Saved. Syncing now…" : "Saved. Sync is off.", "ok");
}

async function test() {
  say("");
  const url = await checkForm();
  if (!url) return;
  say("Testing…");
  try {
    const res = await fetch(`${url}/api/ping`, { headers: { Authorization: `Bearer ${passkeyInput.value}` } });
    const body = await res.json().catch(() => ({}));
    if (res.ok) say(`Connected! The server has ${body.count} bookmark${body.count === 1 ? "" : "s"}.`, "ok");
    else if (res.status === 404) say("That server doesn't look like a bookmark server. Check the link.", "error");
    else say(body.error || `Server error (${res.status})`, "error");
  } catch {
    say("Can't reach the server. Is it running, and is the link right?", "error");
  }
}

async function renderStatus() {
  const { [SYNC_KEY]: sync, [STATUS_KEY]: status } = await chrome.storage.local.get([SYNC_KEY, STATUS_KEY]);
  statusEl.textContent = "";
  if (!sync?.enabled) {
    statusEl.textContent = "Sync is off.";
    return;
  }
  if (!status) {
    statusEl.textContent = "Not synced yet.";
    return;
  }
  const line = document.createElement("span");
  if (status.ok) {
    line.className = "ok";
    line.textContent = `✓ Synced ${status.count} bookmark${status.count === 1 ? "" : "s"} ${timeAgo(status.at)}`;
  } else {
    line.className = "error";
    line.textContent = `✗ Last sync failed ${timeAgo(status.at)}: ${status.error}`;
  }
  const link = document.createElement("a");
  link.href = sync.url;
  link.target = "_blank";
  link.textContent = "Open website";
  statusEl.append(line, " · ", link);
}

async function load() {
  const { [SYNC_KEY]: sync } = await chrome.storage.local.get(SYNC_KEY);
  enabledInput.checked = !!sync?.enabled;
  urlInput.value = sync?.url || "";
  passkeyInput.value = sync?.passkey || "";
  renderStatus();
}

document.getElementById("show").addEventListener("click", (e) => {
  const hidden = passkeyInput.type === "password";
  passkeyInput.type = hidden ? "text" : "password";
  e.target.textContent = hidden ? "Hide" : "Show";
});
enabledInput.addEventListener("change", save);
document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
for (const input of [urlInput, passkeyInput]) {
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

chrome.storage.onChanged.addListener((changes) => {
  if (SYNC_KEY in changes || STATUS_KEY in changes) renderStatus();
});
setInterval(renderStatus, 30_000); // keep "2m ago" fresh
load();
