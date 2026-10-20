chrome.runtime.onInstalled.addListener(async () => {
  await migrateOldBookmarks();
  await injectIntoOpenTabs();
  await updateBadge();
  startSync();
});
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  startSync();
});

// Show how many bookmarks you have on the toolbar icon. Only recount when one
// is added or removed, not on every position update.
chrome.storage.onChanged.addListener((changes) => {
  const addedOrRemoved = Object.entries(changes).some(([key, c]) =>
    key.startsWith("bm:") && (c.oldValue === undefined || c.newValue === undefined));
  if (addedOrRemoved) updateBadge();
});

async function updateBadge() {
  const all = await chrome.storage.local.get(null);
  const n = Object.keys(all).filter((key) => key.startsWith("bm:")).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#3ea6ff" });
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
}

// Older versions kept every bookmark in one "bookmarks" object. Move them to
// one key per video ("bm:<videoId>").
async function migrateOldBookmarks() {
  const { bookmarks } = await chrome.storage.local.get("bookmarks");
  if (!bookmarks) return;

  const current = await chrome.storage.local.get(null);
  const moved = {};
  for (const [id, b] of Object.entries(bookmarks)) {
    // Don't overwrite a newer bookmark saved by the new version.
    if (!current[`bm:${id}`]) moved[`bm:${id}`] = b;
  }
  await chrome.storage.local.set(moved);
  await chrome.storage.local.remove("bookmarks");
}

// After an install, update or reload, YouTube tabs that were already open are
// still running the old script, which can't save anymore. Give them the new
// one so you don't have to refresh them.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  for (const tab of tabs) {
    if (tab.discarded) continue; // gets the script normally when reopened
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (err) {
      console.warn("could not inject into tab", tab.id, err);
    }
  }
}

// ---- Server sync ----
// When it's turned on in Settings, the full list of bookmarks is sent to your
// own server (see the server folder) so you can see it on its website. It's
// sent a few seconds after bookmarks change, and every minute in case the
// server was down. Videos you add, remove or re-time on the website come back
// the same way.

const SYNC_KEY = "sync";         // { enabled, url, passkey }
const STATUS_KEY = "syncStatus"; // { ok, at, count, error }
const APPLIED_KEY = "editsApplied"; // { id: at } website changes already handled here
const PUSH_DELAY_MS = 5_000;     // wait this long after a change, so watching sends every 5s at most
const PUSH_EVERY_MIN = 1;       // also how soon a time changed on the website shows up here

let pushTimer = 0;
let pushing = null; // the push in progress, so a manual sync can wait for it
let pushAgain = false;

function startSync() {
  chrome.alarms.create("sync", { periodInMinutes: PUSH_EVERY_MIN });
  pushNow();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") pushNow();
});

chrome.storage.onChanged.addListener((changes) => {
  if (SYNC_KEY in changes) pushNow(); // settings changed: send right away
  else if (Object.keys(changes).some((key) => key.startsWith("bm:"))) schedulePush();
});

// The popup's refresh button. Answers once the push is done, so the popup
// knows when to stop spinning (the result itself is in syncStatus).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "syncNow") return;
  syncNow().finally(() => sendResponse());
  return true; // the answer comes later
});

async function syncNow() {
  // A push that's already running may have started before the latest change,
  // so let it finish and then send again.
  if (pushing) await pushing.catch(() => {});
  await pushNow();
}

function schedulePush() {
  if (!pushTimer) pushTimer = setTimeout(pushNow, PUSH_DELAY_MS);
}

function pushNow() {
  clearTimeout(pushTimer);
  pushTimer = 0;
  if (pushing) {
    pushAgain = true;
    return pushing;
  }
  pushing = push().finally(() => {
    pushing = null;
    if (pushAgain) {
      pushAgain = false;
      schedulePush();
    }
  });
  return pushing;
}

async function push() {
  const all = await chrome.storage.local.get(null);
  const sync = all[SYNC_KEY];
  if (!sync?.enabled || !sync.url || !sync.passkey) return;

  let status;
  try {
    const applied = await pullEdits(sync, all);
    const bookmarks = Object.keys(all).filter((key) => key.startsWith("bm:")).map((key) => all[key]);
    const res = await fetch(`${sync.url}/api/bookmarks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sync.passkey}` },
      body: JSON.stringify({ bookmarks, applied }),
    });
    const body = await res.json().catch(() => ({}));
    status = res.ok ? { ok: true, count: body.count ?? bookmarks.length }
                    : { ok: false, error: body.error || `Server error (${res.status})` };
  } catch (err) {
    status = { ok: false, error: "Can't reach the server" };
    console.warn("sync failed", err);
  }
  await chrome.storage.local.set({ [STATUS_KEY]: { ...status, at: Date.now() } });
}

// Bring in videos added, removed or re-timed on the website, unless you've
// watched that video here since. Each change is handled once and then listed
// as handled when uploading, which is what tells the server to forget it.
// editedAt lets an open tab of that video notice the new time.
async function pullEdits(sync, all) {
  const res = await fetch(`${sync.url}/api/bookmarks`, {
    headers: { Authorization: `Bearer ${sync.passkey}` },
  });
  if (!res.ok) return all[APPLIED_KEY] || {}; // the upload right after reports the error
  const { bookmarks = [], edits = {} } = await res.json();
  const done = all[APPLIED_KEY] || {};
  const applied = {}; // only changes the server still has, so this doesn't grow forever
  const changed = {};
  const removed = [];
  for (const [id, edit] of Object.entries(edits)) {
    applied[id] = edit.at;
    if (done[id] === edit.at) continue;
    const key = `bm:${id}`;
    const b = all[key];
    if (b && b.updatedAt > edit.at) continue; // watched here after the change
    if (edit.deleted) {
      if (b) removed.push(key);
    } else if (edit.bookmark && Number.isFinite(edit.bookmark.time)) {
      changed[key] = { ...(b || edit.bookmark), time: edit.bookmark.time, updatedAt: edit.at, editedAt: edit.at };
    }
  }
  // Lengths the server looked up for videos added on the website.
  for (const sb of bookmarks) {
    const key = `bm:${sb.id}`;
    const b = changed[key] || all[key];
    if (b && !b.duration && sb.duration > 0) changed[key] = { ...b, duration: sb.duration };
  }
  if (removed.length) {
    await chrome.storage.local.remove(removed);
    for (const key of removed) delete all[key];
  }
  if (Object.keys(changed).length) {
    await chrome.storage.local.set(changed);
    Object.assign(all, changed);
  }
  await chrome.storage.local.set({ [APPLIED_KEY]: applied });
  return applied;
}
