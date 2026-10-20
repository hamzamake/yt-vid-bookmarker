const list = document.getElementById("list");
const search = document.getElementById("search");
const count = document.getElementById("count");
const undoBar = document.getElementById("undo");
const refreshBtn = document.getElementById("refresh");
const syncLine = document.getElementById("sync-status");
const PREFIX = "bm:";

let removed = null; // bookmarks removed last, so they can be restored
let undoTimer = 0;

function formatTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
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

async function getBookmarks() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((key) => key.startsWith(PREFIX))
    .map((key) => all[key]);
}

// Remove bookmarks, with a few seconds to undo.
async function remove(items, label) {
  removed = items;
  await chrome.storage.local.remove(items.map((b) => PREFIX + b.id));
  document.getElementById("undo-text").textContent = label;
  undoBar.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { undoBar.hidden = true; removed = null; }, 6_000);
}

document.getElementById("undo-btn").addEventListener("click", async () => {
  if (!removed) return;
  await chrome.storage.local.set(Object.fromEntries(removed.map((b) => [PREFIX + b.id, b])));
  removed = null;
  undoBar.hidden = true;
});

// Switch to the tab that already has this video open, or open a new one.
async function open(b, url) {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
  const tab = tabs.find((t) => {
    try { return new URL(t.url).searchParams.get("v") === b.id; } catch { return false; }
  });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

async function render() {
  const all = (await getBookmarks()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const query = search.value.trim().toLowerCase();
  const items = query ? all.filter((b) => (b.title || "").toLowerCase().includes(query)) : all;

  count.textContent = all.length ? ` (${all.length})` : "";
  search.hidden = all.length < 2;
  list.textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = all.length ? "No bookmarks match your search." : "No bookmarks yet. Watch a video past 0:10.";
    list.appendChild(empty);
    return;
  }

  for (const b of items) {
    const li = document.createElement("li");

    const link = document.createElement("a");
    // No &t= here: the extension itself jumps to the bookmark when the video opens.
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(b.id)}`;
    link.target = "_blank";
    link.addEventListener("click", (e) => {
      if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey) return; // let new-tab clicks through
      e.preventDefault();
      open(b, link.href);
    });

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.src = `https://i.ytimg.com/vi/${encodeURIComponent(b.id)}/mqdefault.jpg`;
    img.alt = "";
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.style.width = `${b.duration ? Math.min(100, (b.time / b.duration) * 100) : 0}%`;
    bar.appendChild(fill);
    thumb.append(img, bar);

    const info = document.createElement("div");
    info.className = "info";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = b.title;
    title.title = b.title;

    const time = document.createElement("div");
    time.className = "time";
    // Videos added on the website have no length until you watch them here.
    time.textContent = b.duration ? `${formatTime(b.time)} / ${formatTime(b.duration)}` : formatTime(b.time);
    const meta = document.createElement("span");
    meta.className = "meta";
    const left = b.duration > b.time ? `${formatTime(b.duration - b.time)} left` : "";
    meta.textContent = [left, timeAgo(b.updatedAt)].filter(Boolean).map((s) => ` · ${s}`).join("");
    time.appendChild(meta);

    info.append(title, time);
    link.append(thumb, info);

    const del = document.createElement("button");
    del.className = "delete";
    del.textContent = "×";
    del.title = "Remove bookmark";
    del.addEventListener("click", () => remove([b], "Bookmark removed"));

    li.append(link, del);
    list.appendChild(li);
  }
}

document.getElementById("clear").addEventListener("click", async () => {
  const items = await getBookmarks();
  if (items.length) remove(items, `Cleared ${items.length} bookmark${items.length === 1 ? "" : "s"}`);
});

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// Show how the last sync to your server went, so you can see that it happened.
async function renderSync(note = "") {
  const { sync, syncStatus: status } = await chrome.storage.local.get(["sync", "syncStatus"]);
  syncLine.className = "";
  if (!sync?.enabled) {
    syncLine.textContent = note;
    syncLine.hidden = !note;
    return;
  }
  syncLine.hidden = false;
  if (!status) {
    syncLine.textContent = "Not synced yet";
  } else if (status.ok) {
    syncLine.className = "ok";
    syncLine.textContent = `✓ Synced ${status.count} bookmark${status.count === 1 ? "" : "s"} ${timeAgo(status.at)}`;
  } else {
    syncLine.className = "error";
    syncLine.textContent = `✗ Sync failed ${timeAgo(status.at)}: ${status.error}`;
  }
}

refreshBtn.addEventListener("click", async () => {
  if (refreshBtn.classList.contains("spinning")) return;
  refreshBtn.classList.add("spinning");
  render();
  // Spin for at least a moment, or a fast sync looks like nothing happened.
  const minSpin = new Promise((resolve) => setTimeout(resolve, 600));
  try {
    await chrome.runtime.sendMessage({ type: "syncNow" });
  } catch (err) {
    console.warn("sync request failed", err);
  }
  await minSpin;
  refreshBtn.classList.remove("spinning");
  renderSync("Sync is off. Turn it on in Settings ⚙");
});

search.addEventListener("input", render);

// Re-render whenever bookmarks change, so the list stays live while it's open.
chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((key) => key.startsWith(PREFIX))) render();
  if ("sync" in changes || "syncStatus" in changes) renderSync();
});
render();
renderSync();
