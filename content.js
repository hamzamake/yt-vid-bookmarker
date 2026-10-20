// Auto-bookmarks the current timestamp of a YouTube video once playback
// passes 10 seconds, keeps it updated as you watch, jumps back to it when you
// reopen the video, and deletes it when the video finishes. Shorts are ignored.
// Jumping far from the bookmark only moves it once you keep watching there.
// Press B to jump back to the bookmark.
//
// Each bookmark is stored under its own key ("bm:<videoId>") so a save is a
// single write that goes out immediately, even while the tab is closing.

(() => {
const MIN_VIDEO_TIME = 10;   // video time (seconds) that must be passed before bookmarking
const SAVE_EVERY_MS = 2_000; // how often to update the bookmark afterwards
const TICK_MS = 1_000;
const RESUME_GUARD_MS = 5_000; // after resuming, keep overriding YouTube's own resume this long
const MAX_CORRECTIONS = 3;     // stop fighting after this many re-seeks (e.g. SponsorBlock skips)
const JUMP_DISTANCE = 30;      // seconds away from the bookmark that count as a big jump
const JUMP_CONFIRM = 10;       // seconds you must keep watching after a big jump before it's saved

let currentId = null;
let active = false;       // saving updates for this video
let last = null;          // latest position seen for the current video
let title = "";           // last known title of the current video
let linkTime = null;      // start time in the URL this video was opened with (?t= / ?start=)
let markerTime = null;    // bookmarked time to show on the progress bar
let lastSave = 0;
let lookupDone = false;   // finished checking storage for an existing bookmark
let resumeTo = null;      // saved time to jump to, while resuming
let resumeDuration = 0;   // saved duration, to make sure the player has the right video
let resumeSeeked = false; // already jumped to resumeTo
let resumeUntil = 0;      // end of the guard window (0 = not counting down yet)
let resumeLastTime = null; // where the video was at the last check while guarding the resume
let corrections = 0;
let mismatchSince = 0;    // when the player's video length first didn't match the bookmark
let finished = false;     // video played to the end and its bookmark was deleted
let removed = false;      // bookmark was removed elsewhere (website, popup): don't bring it back
let prevTime = null;      // video time at the last record, to measure uninterrupted watching
let watched = 0;          // seconds actually watched since the last seek
let pendingJump = false;  // jumped far from the bookmark, waiting to see if you stay there
let toastTimer = 0;

const log = (...args) => console.log("[YT Bookmarker]", ...args);
const keyFor = (id) => `bm:${id}`;

// When the extension is reloaded or updated, a fresh copy of this script is
// injected into open tabs. The old copy can no longer reach storage, so it
// steps aside: only the newest copy (whose token is on <html>) does anything.
const instance = Math.random().toString(36).slice(2);
document.documentElement.dataset.ytbInstance = instance;
let dead = false;
function alive() {
  if (dead) return false;
  let ok = document.documentElement.dataset.ytbInstance === instance;
  try { ok = ok && !!chrome.runtime?.id; } catch { ok = false; }
  if (!ok) {
    dead = true;
    clearInterval(timer);
    log("stopped (a newer copy of the extension took over)");
  }
  return ok;
}
// Add an event listener that only runs while this copy is alive.
function on(target, type, fn, capture = false) {
  target.addEventListener(type, (e) => { if (alive()) fn(e); }, capture);
}

function inMiniplayer() {
  const player = document.querySelector("#movie_player");
  return !!player && !!player.closest("ytd-miniplayer");
}

// Regular /watch pages, plus the miniplayer while you browse. Shorts never count.
function getVideoId() {
  if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v");
  if (inMiniplayer()) {
    const flexy = document.querySelector("ytd-watch-flexy");
    return (flexy && flexy.getAttribute("video-id")) || null;
  }
  return null;
}

function getPlayer() {
  const player = document.querySelector("ytd-watch-flexy #movie_player") ||
                 document.querySelector("#movie_player");
  // Never use the Shorts player, even if YouTube left it in the page.
  if (!player || player.closest("ytd-shorts, ytd-reel-video-renderer")) return null;
  return player;
}

function getVideo() {
  const player = getPlayer();
  return player && player.querySelector("video.html5-main-video, video");
}

function isAdPlaying() {
  const player = getPlayer();
  return !!player && (player.classList.contains("ad-showing") ||
                      player.classList.contains("ad-interrupting"));
}

// Right after switching videos the URL changes before the player does, so make
// sure the player is really on this video (stops the old video's time leaking in).
function playerIsOn(id) {
  const flexy = document.querySelector("ytd-watch-flexy");
  const playing = flexy && flexy.getAttribute("video-id");
  return !playing || playing === id;
}

// The real video (not an ad, not the previous video) is loaded and seekable.
function videoReady(video) {
  return !!video && !!currentId && getVideoId() === currentId && !isAdPlaying() &&
         playerIsOn(currentId) && video.readyState >= 1 &&
         isFinite(video.duration) && video.duration > 0;
}

function readTitle() {
  if (location.pathname !== "/watch") return "";
  const el = document.querySelector("ytd-watch-metadata h1 yt-formatted-string") ||
             document.querySelector("h1.ytd-watch-metadata") ||
             document.querySelector("h1.title");
  return (el && el.textContent.trim()) ||
         document.title.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "").trim();
}

function storageError(err) {
  log("storage failed", err);
}

async function readBookmark(id) {
  try {
    const result = await chrome.storage.local.get(keyFor(id));
    return result[keyFor(id)];
  } catch (err) {
    storageError(err);
  }
}

function writeBookmark(b) {
  try {
    chrome.storage.local.set({ [keyFor(b.id)]: b }).catch(storageError);
  } catch (err) {
    storageError(err);
  }
}

function removeBookmark(id) {
  try {
    chrome.storage.local.remove(keyFor(id)).catch(storageError);
  } catch (err) {
    storageError(err);
  }
}

// Remember where the current video is. Runs on every timeupdate, which keeps
// firing in background tabs (unlike timers, which Chrome slows way down).
function record() {
  const video = getVideo();
  if (!videoReady(video) || !lookupDone || resumeTo != null || finished) return;
  trackWatching(video);
  const t = readTitle();
  if (t && t !== "YouTube") title = t;
  last = {
    id: currentId,
    title: title || "YouTube video",
    time: Math.floor(video.currentTime),
    duration: Math.floor(video.duration),
    link: linkTime,
  };
}

// Count how long you've watched without seeking (in real seconds, so 2x speed
// still means 10 real seconds). Normal playback moves forward a little each
// update; going backwards or leaping ahead was a seek.
function trackWatching(video) {
  const t = video.currentTime;
  const rate = video.playbackRate || 1;
  const step = prevTime == null ? -1 : t - prevTime;
  if (step >= 0 && step < 5 * rate) watched += step / rate;
  else watched = 0;
  prevTime = t;
}

// Far away from the bookmark and not watched there long enough to count yet.
function isUnconfirmedJump(time) {
  return markerTime != null && Math.abs(time - markerTime) > JUMP_DISTANCE &&
         watched < JUMP_CONFIRM;
}

// Write the latest recorded position to storage.
function flush() {
  if (!active || !last) return;
  if (last.id === currentId && isUnconfirmedJump(last.time)) return;
  writeBookmark({ ...last, updatedAt: Date.now() });
  lastSave = Date.now();
  if (last.id === currentId) markerTime = last.time;
}

// Record the position and save it when it's time to.
function update() {
  record();
  if (!last || last.id !== currentId || finished || removed) return;
  if (!active && last.time > MIN_VIDEO_TIME) {
    active = true;
    log(`bookmarking ${currentId} at ${formatTime(last.time)}`);
    flush();
  } else if (active) {
    const pending = isUnconfirmedJump(last.time);
    if (pending !== pendingJump) {
      pendingJump = pending;
      if (pending) {
        toast(`Bookmark kept at ${formatTime(markerTime)} · watch ${JUMP_CONFIRM}s here to move it · B to go back`);
      } else if (markerTime != null && Math.abs(last.time - markerTime) > JUMP_DISTANCE) {
        toast(`Bookmark moved to ${formatTime(last.time)}`);
        flush();
      }
    }
    if (Date.now() - lastSave >= SAVE_EVERY_MS) flush();
  }
}

// Record and save right now (pause, seek, tab hidden, closing, ...).
function saveNow() {
  record();
  flush();
}

// Jump to the saved time, and keep winning for a few seconds in case YouTube
// applies its own (sometimes broken) resume position after us.
function tryResume() {
  if (resumeTo == null) return;
  const video = getVideo();
  if (!videoReady(video)) return;

  const now = Date.now();
  if (resumeDuration && Math.abs(video.duration - resumeDuration) > 2) {
    // Usually the old video is still loaded for a moment; if the length stays
    // different (e.g. the uploader edited the video), give up on resuming.
    if (!mismatchSince) mismatchSince = now;
    else if (now - mismatchSince > 5_000) endResume();
    return;
  }
  mismatchSince = 0;

  if (!resumeSeeked) {
    resumeSeeked = true;
    video.currentTime = resumeTo;
    log(`resumed ${currentId} at ${formatTime(resumeTo)}`);
    toast(`Resumed at ${formatTime(resumeTo)}`);
    return;
  }
  // Only count the guard down once the video is actually playing on screen.
  // Restored and background tabs don't start until you look at them, and
  // that's when YouTube applies its own resume position.
  if (!resumeUntil && !video.paused && !document.hidden) resumeUntil = now + RESUME_GUARD_MS;
  if ((resumeUntil && now > resumeUntil) || corrections >= MAX_CORRECTIONS) return endResume();

  // Playing on from the bookmark is fine; only a sudden jump means YouTube
  // moved it. Then put it back where it was.
  const t = video.currentTime;
  const expected = resumeLastTime ?? resumeTo;
  const step = t - expected;
  if (step < -1 || step > 5 * (video.playbackRate || 1)) {
    corrections++;
    video.currentTime = expected;
    log(`YouTube moved the video, jumping back to ${formatTime(Math.floor(expected))}`);
  } else {
    resumeLastTime = t;
  }
}

function endResume() {
  resumeTo = null;
  resumeSeeked = false;
  resumeUntil = 0;
  resumeLastTime = null;
  mismatchSince = 0;
}

// Blue marker on the progress bar at the bookmarked time. Re-drawn every tick
// because YouTube rebuilds the progress bar (ads, chapters, SponsorBlock, ...).
function drawMarker() {
  const player = getPlayer();
  const video = getVideo();
  const bar = player && player.querySelector(".ytp-progress-bar");
  let marker = document.querySelector(".ytb-bookmark-marker");

  const duration = video && video.duration;
  if (markerTime == null || !currentId || !bar || isAdPlaying() || !isFinite(duration) || duration <= 0) {
    if (marker) marker.remove();
    return;
  }
  if (!marker || marker.parentElement !== bar) {
    if (marker) marker.remove();
    marker = document.createElement("div");
    marker.className = "ytb-bookmark-marker";
    bar.appendChild(marker);
  }
  marker.style.left = `${Math.min(100, (markerTime / duration) * 100)}%`;
  marker.title = `Bookmarked at ${formatTime(markerTime)}`;
}

// Blue time display ("3:21 / 10:05"). The flag lives on <html> so YouTube
// re-rendering the player can't wipe it.
function setTimeDisplayBlue(on) {
  document.documentElement.toggleAttribute("data-ytb-bookmarked", on);
}

// Amber time display while a big jump is waiting to be confirmed.
function setTimeDisplayPending(on) {
  document.documentElement.toggleAttribute("data-ytb-pending", on);
}

// Short message in the corner of the player.
function toast(text) {
  const player = getPlayer();
  if (!player) return;
  let el = player.querySelector(".ytb-toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "ytb-toast";
    player.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("ytb-show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("ytb-show"), 4_000);
}

// B: jump back to the bookmark (e.g. after skipping ahead by accident).
function jumpToBookmark() {
  const video = getVideo();
  if (markerTime == null || !videoReady(video)) return false;
  endResume();
  video.currentTime = markerTime;
  toast(`Back to bookmark at ${formatTime(markerTime)}`);
  return true;
}

function formatTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function switchTo(id) {
  // Save exactly where the previous video was left.
  flush();

  currentId = id;
  active = false;
  finished = false;
  removed = false;
  last = null;
  title = "";
  markerTime = null;
  lastSave = 0;
  lookupDone = false;
  corrections = 0;
  prevTime = null;
  watched = 0;
  pendingJump = false;
  endResume();
  if (!id) return;

  const params = new URLSearchParams(location.search);
  linkTime = params.get("t") || params.get("start");

  readBookmark(id).then((b) => {
    if (id !== currentId || dead) return;
    if (b) {
      // Already bookmarked: keep it updated from the start.
      active = true;
      title = b.title || "";
      markerTime = b.time;
      // A link with its own start time (e.g. ...&t=90s) wins over the bookmark,
      // but only if it's a new link. A restored, reloaded or back-navigated tab
      // still has the link it was first opened with, so the bookmark wins there.
      const newLink = linkTime != null && linkTime !== b.link;
      if (!newLink && b.time > 0) {
        resumeTo = b.time;
        resumeDuration = b.duration;
        tryResume();
      }
    }
    lookupDone = true;
  });
}

// Started watching again after it finished (replay or rewind).
function checkReplay() {
  const video = getVideo();
  if (finished && videoReady(video) && video.currentTime < video.duration - 5) finished = false;
}

function tick() {
  if (!alive()) return;
  const id = getVideoId();
  if (id !== currentId) switchTo(id);
  if (id) {
    tryResume();
    checkReplay();
    update();
  }
  setTimeDisplayBlue(!!id && !finished && (active || markerTime != null));
  setTimeDisplayPending(!!id && !finished && pendingJump);
  drawMarker();
}

// YouTube is a single-page app, so react to its navigation events
// and also run on a timer.
const timer = setInterval(tick, TICK_MS);
on(document, "yt-navigate-finish", tick);
tick();
log("loaded");

// Video events don't bubble, so listen in the capture phase.
for (const type of ["loadedmetadata", "canplay", "playing"]) {
  on(document, type, (e) => {
    if (resumeTo != null && e.target === getVideo()) tryResume();
  }, true);
}
on(document, "timeupdate", (e) => {
  if (e.target !== getVideo()) return;
  if (getVideoId() !== currentId) return tick();
  tryResume();
  checkReplay();
  update();
}, true);

// If you seek yourself while we're resuming, stop overriding you.
on(document, "mousedown", (e) => {
  if (resumeSeeked && e.target.closest && e.target.closest(".ytp-progress-bar-container")) endResume();
}, true);
on(document, "keydown", (e) => {
  if (resumeSeeked) endResume();
  // B jumps back to the bookmark, unless you're typing somewhere.
  const t = e.target;
  const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if (e.key?.toLowerCase() !== "b" || typing || e.ctrlKey || e.altKey || e.metaKey) return;
  if (jumpToBookmark()) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// This video's bookmark was changed somewhere else while it's open here.
chrome.storage.onChanged.addListener((changes) => {
  if (!alive() || !currentId) return;
  const change = changes[keyFor(currentId)];
  if (!change) return;
  const b = change.newValue;

  // Removed (on the website or in the popup): stop saving it, or the next save
  // would bring it right back. Opening the video again starts over.
  if (!b) {
    if (finished || removed || !active) return;
    removed = true;
    active = false;
    last = null;
    markerTime = null;
    pendingJump = false;
    endResume();
    removeBookmark(currentId); // in case a save from this tab slipped in after
    toast("Bookmark removed · reopen the video to bookmark it again");
    return;
  }
  // Put back (the popup's Undo): carry on saving.
  if (removed) {
    removed = false;
    active = true;
    markerTime = b.time;
    return;
  }
  // Added or re-timed on the website: go to that time, or this tab would save
  // its old position right over it.
  if (!b.editedAt || b.editedAt === change.oldValue?.editedAt) return;
  active = true;
  last = null; // the old position, don't save it
  markerTime = b.time;
  pendingJump = false;
  endResume();
  resumeTo = b.time;
  resumeDuration = b.duration;
  tryResume();
  toast(`Bookmark changed on the website, moved to ${formatTime(b.time)}`);
});

// Any seek starts the "kept watching" count over.
on(document, "seeking", (e) => {
  if (e.target === getVideo()) { prevTime = null; watched = 0; }
}, true);

// Video finished: delete its bookmark.
on(document, "ended", (e) => {
  const video = getVideo();
  if (e.target !== video || !videoReady(video)) return;
  if (video.duration - video.currentTime > 1) return;
  finished = true;
  active = false;
  last = null;
  markerTime = null;
  pendingJump = false;
  endResume();
  removeBookmark(currentId);
  log(`finished ${currentId}, bookmark deleted`);
}, true);

// Save right away when pausing, seeking, switching tabs, minimizing or closing.
on(document, "pause", (e) => { if (e.target === getVideo()) saveNow(); }, true);
on(document, "seeked", (e) => { if (e.target === getVideo()) saveNow(); }, true);
on(document, "visibilitychange", () => { if (document.hidden) saveNow(); });
on(window, "pagehide", saveNow);
on(window, "beforeunload", saveNow);

})();
