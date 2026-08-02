/* ============================================================
   Kiln session — a workspace should be where you left it.

   Nothing here needs a server. There never was one: the reason a workspace
   reset was that nothing was written down, not that something had to be
   fetched. So it is written down.

   Two stores, because the things being kept are two different sizes:

     small   settings, text, which panel was open, where the playhead was —
             localStorage, written on a debounce, read on boot.
     large   audio and file bytes — IndexedDB, because localStorage is a few
             megabytes of string and a minute of audio is five.

   Both are per workspace and per browser. Nothing is uploaded, and clearing
   the browser's data for this site clears it.
   ============================================================ */
(function () {
  "use strict";

  const APP = () => document.documentElement.dataset.kilnApp || "app";
  const KEY = () => "kiln-session-" + APP();

  /* ---------------- small: localStorage ---------------- */
  const readState = () => {
    try { return JSON.parse(localStorage.getItem(KEY()) || "{}"); } catch { return {}; }
  };
  let pending = null, timer = 0;
  function saveState(patch) {
    pending = { ...(pending || readState()), ...patch };
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { localStorage.setItem(KEY(), JSON.stringify(pending)); } catch (e) {
        // a quota error is worth saying out loud rather than losing quietly
        console.warn("Kiln: could not keep the session —", e.name);
      }
      pending = null;
    }, 400);
  }
  function flush() {
    if (!pending) return;
    clearTimeout(timer);
    try { localStorage.setItem(KEY(), JSON.stringify(pending)); } catch {}
    pending = null;
  }
  // leaving the tab is exactly when the write must not be still waiting
  addEventListener("pagehide", flush);
  addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

  /* ---------------- large: IndexedDB ---------------- */
  const DB = "kiln", STORE = "blobs";
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function put(key, value) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(value, APP() + ":" + key);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  }
  async function get(key) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, "readonly");
      const q = t.objectStore(STORE).get(APP() + ":" + key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function del(key) {
    const d = await db();
    return new Promise(res => {
      const t = d.transaction(STORE, "readwrite");
      t.objectStore(STORE).delete(APP() + ":" + key);
      t.oncomplete = res;
    });
  }

  /* ---------------- the bits every workspace shares ----------------
     Which panel tab was open, and whether a pane was folded. Restored before
     the app paints, so nothing jumps. */
  function restoreChrome() {
    const s = readState();
    if (s.tab) {
      const tab = document.querySelector(`.ptab[data-pt="${s.tab}"]`);
      if (tab) {
        document.querySelectorAll(".ptab").forEach(t => t.classList.toggle("on", t === tab));
        document.querySelectorAll(".pbody").forEach(b => b.classList.toggle("on", b.id === s.tab));
      }
    }
    for (const cls of ["foldL", "foldR", "nopanels", "wrap"]) {
      if (s[cls]) document.body.classList.add(cls);
    }
  }
  function watchChrome() {
    document.addEventListener("click", e => {
      const tab = e.target.closest(".ptab");
      if (tab) saveState({ tab: tab.dataset.pt });
      // body classes are toggled by the apps themselves; read them after
      setTimeout(() => saveState({
        foldL: document.body.classList.contains("foldL"),
        foldR: document.body.classList.contains("foldR"),
        nopanels: document.body.classList.contains("nopanels"),
        wrap: document.body.classList.contains("wrap"),
      }), 0);
    });
  }

  function boot() { restoreChrome(); watchChrome(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.KilnSession = {
    get state() { return pending || readState(); },
    save: saveState,
    flush,
    put, get, del,
    clear() { try { localStorage.removeItem(KEY()); } catch {} },
  };
})();
