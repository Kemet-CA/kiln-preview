/* ============================================================
   Kiln projects — one way to keep work, in every workspace.

   Each workspace used to remember things its own way. The video editor
   downloaded a .kilnvid, the photo editor downloaded a .kiln, and the other
   seven remembered nothing you could name or come back to. Same idea, seven
   answers, and no answer at all in most of them.

   This is the one answer. A project is a named thing you can save, close,
   reopen and find again, and it means the same thing in every workspace.

   ---- what a project is ----

   A record, versioned, with the document separated from the files it needs:

     { v, id, app, kind, schema, name, created, modified,
       doc,                       the workspace's own state — it owns the shape
       assets: [{id,name,type,size}],   what the doc refers to
       history }                  undo stack, when the workspace can spare it

   `doc` is opaque here on purpose. A project system that understands layers
   also has an opinion about layers, and then every workspace has to argue with
   it. This one holds the envelope and lets each workspace fill it.

   Assets are stored separately and content-keyed by the id the workspace gave
   them, so the same photo in three projects is stored once, and a 200 MB video
   never has to survive a trip through JSON.

   ---- where it goes ----

   IndexedDB, in its own database, behind a five-method interface: list, read,
   write, remove, and the two asset calls. That interface is the whole point of
   the indirection — see the note above `useStore`.

   ---- and how it leaves ----

   `download()` writes a real ZIP: project.json plus assets/<id>, stored
   uncompressed because a .mp4 does not deflate. It opens in any unzip tool,
   which is the difference between a file you own and a blob you hope still
   works next year. That is what makes a project portable between machines.
   ============================================================ */
(function () {
  "use strict";

  const APP = () => document.documentElement.dataset.kilnApp || "app";
  const uid = p => (p || "p") + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const now = () => Date.now();

  /* ============================================================
     The store

     Five methods and two for assets. Everything above this line talks to that
     interface and nothing else — no direct IndexedDB calls leak upward.

     This is deliberate groundwork. Accounts and sync are not being built now,
     but when they are, they arrive as a second implementation of this
     interface rather than as a rewrite: a remote store that fetches, and a
     wrapper that writes to both and reconciles. What makes that possible is
     already in the record and not bolted on later —

       id          a random string, not a row number, so a project made
                   offline on one machine cannot collide with one made
                   offline on another
       modified    a timestamp on every record, which is what any
                   last-writer-wins or conflict-detecting merge needs first
       v           an envelope version, so an old client meeting a new record
                   can say so instead of guessing
       assets      content-keyed and separate from the document, so syncing
                   a small edit does not re-upload the footage

     None of that costs anything today. It is just the shape that does not
     have to be undone later.
     ============================================================ */
  const DB = "kiln-projects", VER = 1, P = "projects", A = "assets", KV = "keyval";
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(P)) d.createObjectStore(P, { keyPath: "id" });
        if (!d.objectStoreNames.contains(A)) d.createObjectStore(A);
        if (!d.objectStoreNames.contains(KV)) d.createObjectStore(KV);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = async (store, mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const q = fn(t.objectStore(store));
      t.oncomplete = () => res(q ? q.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };

  const localStore = {
    name: "this browser",
    async list() {
      const all = await tx(P, "readonly", s => s.getAll());
      return all.filter(r => r.app === APP())
        .map(({ doc, history, ...meta }) => meta)          // never load documents to draw a list
        .sort((a, b) => b.modified - a.modified);
    },
    read: id => tx(P, "readonly", s => s.get(id)).then(r => r || null),
    write: rec => tx(P, "readwrite", s => s.put(rec)).then(() => rec),
    remove: id => tx(P, "readwrite", s => s.delete(id)),
    putAsset: (id, blob) => tx(A, "readwrite", s => s.put(blob, id)),
    getAsset: id => tx(A, "readonly", s => s.get(id)).then(b => b || null),
    hasAsset: id => tx(A, "readonly", s => s.getKey(id)).then(k => k !== undefined),
    /* Assets outlive the save that wrote them. A video file keeps one id for
       its whole life, so it is written once and shared; a photo layer is a
       different picture every time it is painted on, so each save writes a new
       blob and the old one is nobody's. Rather than make every workspace track
       that difference, nothing is deleted at save time and orphans are swept
       afterwards — across every project, because two of them can share a file. */
    async sweep() {
      const keep = new Set();
      for (const r of await tx(P, "readonly", s => s.getAll())) for (const a of r.assets || []) keep.add(a.id);
      for (const v of await tx(KV, "readonly", s => s.getAll())) for (const a of v?.assets || []) keep.add(a.id);
      const dead = (await tx(A, "readonly", s => s.getAllKeys())).filter(k => !keep.has(k));
      for (const k of dead) await tx(A, "readwrite", s => s.delete(k));
      return dead.length;
    },
    kv: {
      get: k => tx(KV, "readonly", s => s.get(APP() + ":" + k)).then(v => v ?? null),
      set: (k, v) => tx(KV, "readwrite", s => s.put(v, APP() + ":" + k)),
      del: k => tx(KV, "readwrite", s => s.delete(APP() + ":" + k)),
    },
  };
  let store = localStore;
  /* Swap the whole backing store — the seam an account-backed or cloud store
     would use. Nothing above calls IndexedDB directly, so a replacement only
     has to answer these methods. */
  function useStore(next) { store = next; }

  /* ============================================================
     A ZIP, so a project is a file and not a hostage
     ============================================================ */
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return buf => {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 255] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    };
  })();
  const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

  /* Entries are stored, not deflated: the assets are already compressed
     formats and the JSON is small next to them. Stored entries also mean the
     reader below is twenty lines instead of a decompressor. */
  async function zip(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const when = new Date();
    for (const e of entries) {
      const nameB = enc.encode(e.name);
      const data = new Uint8Array(e.data instanceof Blob ? await e.data.arrayBuffer() : e.data);
      const crc = CRC(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true);
      lh.setUint16(8, 0, true);                              // stored
      lh.setUint16(10, dosTime(when), true); lh.setUint16(12, dosDate(when), true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nameB, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint16(8, 0, true); cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime(when), true); cd.setUint16(14, dosDate(when), true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameB.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameB);
      offset += 30 + nameB.length + data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true);
    eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(eo.buffer)], { type: "application/zip" });
  }

  async function unzip(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(buf.buffer);
    let eo = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eo = i; break; }
    }
    if (eo < 0) throw new Error("not a zip");
    const count = view.getUint16(eo + 10, true);
    let p = view.getUint32(eo + 16, true);
    const dec = new TextDecoder();
    const out = new Map();
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
      const lNameLen = view.getUint16(local + 26, true);
      const lExtraLen = view.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      let bytes = buf.subarray(start, start + size);
      /* We only ever write stored entries, but a project file that has been
         through someone else's zip tool may come back deflated. */
      if (method === 8) {
        const ds = new DecompressionStream("deflate-raw");
        bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
      } else if (method !== 0) throw new Error("unsupported compression in project file");
      out.set(name, bytes);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /* ============================================================
     The workspace's half of the deal
     ============================================================ */
  let A_ = null;                                     // the registered adapter
  const S = {
    id: null, name: "", created: 0, savedAt: 0, dirtyAt: 0,
    auto: 0,                                          // minutes; 0 = off
    lastAuto: 0, busy: false, recovered: false,
  };

  const dirty = () => S.dirtyAt > S.savedAt;
  const SET = "kiln-project-" + (document.documentElement.dataset.kilnApp || "app");
  const readSet = () => { try { return JSON.parse(localStorage.getItem(SET) || "{}"); } catch { return {}; } };
  const writeSet = patch => {
    try { localStorage.setItem(SET, JSON.stringify({ ...readSet(), ...patch })); } catch {}
  };

  function register(a) {
    A_ = {
      kind: APP(), schema: 1, newName: "Untitled project",
      snapshot: () => ({ doc: {}, assets: [], history: null }),
      restore: () => {}, reset: () => {},
      ...a,
    };
    const s = readSet();
    S.auto = s.auto || 0;
    S.name = A_.newName;
    S.id = s.id || null;
    armAuto();
    render();
    boot();
    return API;
  }

  /* The workspace tells us it changed. Everything else — the dot, the
     recovery copy, the auto-save clock — hangs off this one call. */
  let recTimer = 0, touched = false;
  /* Booting is not editing. Several workspaces draw themselves by calling the
     same function an edit calls, and a page that marks itself unsaved before
     anyone has touched it produces a leave-the-page warning nobody earned and
     a recovery offer for work that was never done. Nothing counts until the
     first real interaction. */
  for (const ev of ["pointerdown", "keydown", "drop", "paste"]) {
    addEventListener(ev, () => { touched = true; }, { capture: true, once: true });
  }
  function touch() {
    if (!A_ || !touched) return;
    S.dirtyAt = now();
    paint();
    clearTimeout(recTimer);
    recTimer = setTimeout(() => keepRecovery().catch(() => {}), 1500);
  }

  /* ---------------- saving ---------------- */
  async function snapshot() {
    const s = await A_.snapshot();
    return { doc: s.doc ?? {}, assets: s.assets || [], history: s.history || null };
  }

  async function save(opts = {}) {
    if (!A_ || S.busy) return null;
    S.busy = true; paint();
    try {
      const snap = await snapshot();
      const id = opts.as || !S.id ? uid("proj") : S.id;
      const stamp = now();
      /* Write the bytes first. If the tab dies between the assets and the
         record, the worst case is an orphaned blob; the other order loses a
         project that says it has footage it does not have. */
      for (const a of snap.assets) {
        if (!a.blob) continue;
        if (opts.as || !(await store.hasAsset(a.id))) await store.putAsset(a.id, a.blob);
      }
      const rec = {
        v: 1, id, app: APP(), kind: A_.kind, schema: A_.schema,
        name: S.name || A_.newName,
        created: opts.as || !S.created ? stamp : S.created,
        modified: stamp,
        doc: snap.doc,
        assets: snap.assets.map(a => ({ id: a.id, name: a.name || "", type: a.type || "", size: a.size || 0 })),
        history: snap.history,
      };
      await store.write(rec);
      sweepSoon();
      S.id = id; S.created = rec.created; S.savedAt = stamp; S.dirtyAt = 0;
      writeSet({ id });
      await store.kv.del("recover");
      paint(); renderList();
      if (!opts.quiet) say(`Saved “${rec.name}”`);
      else status(`Auto-saved ${clock(stamp)}`);
      return rec;
    } catch (e) {
      say("Could not save — " + (e.name === "QuotaExceededError" ? "the browser is out of room" : e.message), "bad");
      return null;
    } finally { S.busy = false; paint(); }
  }

  async function saveAs() {
    const name = await ask("Save project as", S.name || A_.newName);
    if (name == null) return null;
    S.name = name.trim() || A_.newName;
    return save({ as: true });
  }

  /* Swept after the record is written and never before it: an asset with no
     project pointing at it is only rubbish once the new record exists. */
  let sweepTimer = 0;
  function sweepSoon() {
    if (!store.sweep) return;
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => store.sweep().catch(() => {}), 3000);
  }

  /* ---------------- opening ---------------- */
  async function open(id) {
    const rec = await store.read(id);
    if (!rec) { say("That project is no longer here", "bad"); return null; }
    return restore(rec, id => store.getAsset(id));
  }

  async function restore(rec, fetchAsset) {
    if (rec.v > 1) { say("This project was made by a newer version of Kiln", "bad"); return null; }
    if (A_.kind && rec.kind && rec.kind !== A_.kind) {
      say(`That is a ${rec.kind} project — open it in that workspace`, "bad");
      return null;
    }
    const assets = new Map();
    let missing = 0;
    for (const a of rec.assets || []) {
      const blob = await fetchAsset(a.id);
      if (blob) assets.set(a.id, blob instanceof Blob ? blob : new Blob([blob], { type: a.type || "" }));
      else missing++;
    }
    await A_.restore(rec.doc, assets, rec);
    S.id = rec.id; S.name = rec.name; S.created = rec.created || now();
    S.savedAt = rec.modified || now(); S.dirtyAt = 0;
    writeSet({ id: S.id });
    paint(); close();
    if (missing) say(`Opened, but ${missing} file${missing > 1 ? "s" : ""} could not be found`, "warn");
    else say(`Opened “${rec.name}”`);
    return rec;
  }

  async function neu() {
    if (dirty() && !(await confirmDrop())) return;
    await A_.reset();
    S.id = null; S.created = 0; S.savedAt = 0; S.dirtyAt = 0;
    S.name = A_.newName;
    writeSet({ id: null });
    await store.kv.del("recover");
    paint(); close();
    say("New project");
  }

  async function remove(id) {
    await store.remove(id);
    if (id === S.id) { S.id = null; writeSet({ id: null }); }
    renderList(); paint();
  }

  /* ---------------- to and from a file ---------------- */
  async function download() {
    if (!A_) return;
    const snap = await snapshot();
    const rec = {
      v: 1, id: S.id || uid("proj"), app: APP(), kind: A_.kind, schema: A_.schema,
      name: S.name || A_.newName, created: S.created || now(), modified: now(),
      doc: snap.doc, history: snap.history,
      assets: snap.assets.map(a => ({ id: a.id, name: a.name || "", type: a.type || "", size: a.size || 0 })),
    };
    const entries = [{ name: "project.json", data: new TextEncoder().encode(JSON.stringify(rec, null, 1)) }];
    for (const a of snap.assets) {
      const blob = a.blob || await store.getAsset(a.id);
      if (blob) entries.push({ name: "assets/" + a.id, data: blob });
    }
    const blob = await zip(entries);
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = (rec.name || "project").replace(/[\\/:*?"<>|]/g, "-") + ".kiln";
    el.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    say(`Wrote ${el.download} — ${(blob.size / 1048576).toFixed(1)} MB, assets included`);
    close();
  }

  async function openFile(file) {
    if (!file) return null;
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (head[0] === 0x50 && head[1] === 0x4B) {                     // "PK"
        const files = await unzip(file);
        const json = files.get("project.json");
        if (!json) throw new Error("no project.json inside");
        const rec = JSON.parse(new TextDecoder().decode(json));
        /* Bring the assets in with it: a project opened from a file should
           save, close and reopen like any other, which means its files have
           to live here now too. */
        for (const a of rec.assets || []) {
          const bytes = files.get("assets/" + a.id);
          if (bytes) await store.putAsset(a.id, new Blob([bytes], { type: a.type || "" }));
        }
        return restore(rec, id => store.getAsset(id));
      }
      /* Older single-file projects, from before this existed. They are still
         somebody's work. */
      const text = await file.text();
      const legacy = JSON.parse(text);
      if (A_.legacy) {
        await A_.legacy(legacy);
        S.id = null; S.savedAt = 0; S.dirtyAt = now();
        S.name = legacy.name || file.name.replace(/\.[^.]+$/, "");
        paint(); close();
        say("Opened an older project file — save it to keep it here");
        return legacy;
      }
      throw new Error("unrecognised project file");
    } catch (e) {
      say("Could not open that project — " + e.message, "bad");
      return null;
    }
  }

  /* ============================================================
     Auto save, and the copy that survives a crash

     Two different promises, which is why they are two mechanisms.

     Auto save is a promise about the project: every N minutes the named
     project on disk catches up with the screen. It only runs when something
     changed, so an idle tab writes nothing.

     The recovery copy is a promise about the work: whatever happens, the last
     minute and a half of it is written down somewhere, even if the project has
     never been saved and has no name yet. It is kept apart from the project
     records so a crash can never leave a half-written one behind, and it is
     dropped the moment a real save makes it redundant.
     ============================================================ */
  let autoTimer = 0;
  function armAuto() {
    clearInterval(autoTimer);
    if (!S.auto) return;
    autoTimer = setInterval(() => {
      if (!dirty() || S.busy) return;
      save({ quiet: true });
    }, S.auto * 60000);
  }
  function setAuto(min) {
    S.auto = min | 0;
    writeSet({ auto: S.auto });
    armAuto(); render();
    say(S.auto ? `Auto save on — every ${S.auto} minute${S.auto > 1 ? "s" : ""}` : "Auto save off");
  }

  async function keepRecovery() {
    if (!A_ || !dirty()) return;
    const snap = await snapshot();
    for (const a of snap.assets) {
      if (a.blob && !(await store.hasAsset(a.id))) await store.putAsset(a.id, a.blob);
    }
    await store.kv.set("recover", {
      v: 1, id: S.id, app: APP(), kind: A_.kind, schema: A_.schema,
      name: S.name, created: S.created, modified: now(),
      at: now(), savedAt: S.savedAt,
      doc: snap.doc, history: snap.history,
      assets: snap.assets.map(a => ({ id: a.id, name: a.name || "", type: a.type || "", size: a.size || 0 })),
    });
  }

  async function checkRecovery() {
    let rec = null;
    try { rec = await store.kv.get("recover"); } catch { return; }
    if (!rec || !(rec.at > (rec.savedAt || 0))) return;
    S.recovered = true;
    const bar = document.createElement("div");
    bar.className = "kproj-recover";
    bar.innerHTML = `<span class="kproj-rdot"></span>
      <span>Kiln has unsaved work from <b>${clock(rec.at)}</b>${rec.name ? ` — “${esc(rec.name)}”` : ""}.</span>
      <button class="kproj-rgo">Restore it</button>
      <button class="kproj-rno">Discard</button>`;
    document.body.appendChild(bar);
    bar.querySelector(".kproj-rgo").onclick = async () => {
      bar.remove();
      await restore(rec, id => store.getAsset(id));
      S.savedAt = 0; S.dirtyAt = now();                 // recovered, not saved
      paint();
    };
    bar.querySelector(".kproj-rno").onclick = async () => {
      bar.remove();
      await store.kv.del("recover");
    };
  }

  /* The last chance to write anything down. Best effort by definition: a tab
     being killed does not wait for IndexedDB. The debounced copy above is what
     actually does the work; this only narrows the window. */
  addEventListener("pagehide", () => { if (dirty()) keepRecovery().catch(() => {}); });
  /* No "are you sure you want to leave" prompt. It is the obvious thing to add
     here and it is the wrong one: the browser's dialog cannot say what would be
     lost, it fires on a reload as readily as on a close, and it asks the person
     to be the backup. The copy above already survives the tab going away, and
     the offer to restore it is waiting when they come back — which is the same
     promise without the interruption. */

  /* ============================================================
     The button, the name, and the menu behind them
     ============================================================ */
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clock = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const when = t => {
    const d = (now() - t) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return Math.round(d / 60) + " min ago";
    if (d < 86400) return Math.round(d / 3600) + " h ago";
    return new Date(t).toLocaleDateString();
  };
  const T = (key, fallback) => window.KilnLang?.t?.(key) || fallback;
  const say = (msg, kind) => (window.toast ? window.toast(msg, kind === "bad" ? "bad" : kind === "warn" ? "warn" : "") : status(msg));
  function status(msg) {
    const el = host?.querySelector(".kproj-note");
    if (!el) return;
    el.textContent = msg;
    clearTimeout(status.t);
    status.t = setTimeout(() => { el.textContent = ""; }, 4000);
  }

  const AUTOS = [0, 1, 5, 10, 15, 30];
  let host = null, drop = null;

  function styles() {
    if (document.getElementById("kproj-css")) return;
    const s = document.createElement("style");
    s.id = "kproj-css";
    s.textContent = `
.kproj{display:flex;align-items:center;gap:6px;position:relative;font:inherit}
.kproj-name{background:none;border:1px solid transparent;color:var(--t2,#888);font-size:12.5px;
  width:168px;padding:3px 7px;border-radius:6px;font-family:inherit;text-overflow:ellipsis}
.kproj-name:hover{background:var(--s2,#222);color:var(--text,#fff)}
.kproj-name:focus{background:var(--s2,#222);color:var(--text,#fff);border-color:var(--line,#333);outline:0}
.kproj-dot{width:6px;height:6px;border-radius:50%;background:transparent;flex:none;transition:background .2s}
.kproj.is-dirty .kproj-dot{background:var(--accent,#e2622a)}
.kproj-note{font-size:11px;color:var(--t3,#777);max-width:180px;overflow:hidden;white-space:nowrap}
.kproj-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:7px;
  border:1px solid var(--line,#333);background:var(--s2,#1c1c1c);color:var(--text,#eee);
  font-size:12px;font-family:inherit;cursor:pointer;transition:background .15s,border-color .15s}
.kproj-btn:hover{background:var(--s3,#282828);border-color:var(--t3,#555)}
.kproj-btn[disabled]{opacity:.5;cursor:default}
.kproj-car{padding:0 6px}
.kproj-drop{position:absolute;top:calc(100% + 6px);right:0;z-index:9000;min-width:262px;
  background:var(--s1,#141414);border:1px solid var(--line,#333);border-radius:10px;padding:5px;
  box-shadow:0 18px 44px rgba(0,0,0,.42)}
.kproj-drop[hidden]{display:none}
.kproj-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;border:0;border-radius:6px;
  background:none;color:var(--text,#eee);font-size:12.5px;font-family:inherit;text-align:start;cursor:pointer}
.kproj-row:hover{background:var(--s3,#262626)}
.kproj-row .k{margin-inline-start:auto;color:var(--t3,#777);font-size:11px}
.kproj-sep{height:1px;background:var(--line,#333);margin:5px 3px}
.kproj-head{padding:5px 9px 3px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--t3,#777)}
.kproj-recent{max-height:158px;overflow:auto}
.kproj-recent .kproj-row b{font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
.kproj-x{margin-inline-start:auto;opacity:0;border:0;background:none;color:var(--t3,#777);cursor:pointer;font-size:13px;padding:0 3px}
.kproj-row:hover .kproj-x{opacity:1}
.kproj-x:hover{color:var(--bad,#e5484d)}
.kproj-empty{padding:5px 9px 8px;font-size:11.5px;color:var(--t3,#777)}
.kproj-autos{display:flex;flex-wrap:wrap;gap:4px;padding:3px 6px 6px}
.kproj-auto{padding:4px 8px;border-radius:999px;border:1px solid var(--line,#333);background:none;
  color:var(--t2,#999);font-size:11px;font-family:inherit;cursor:pointer}
.kproj-auto:hover{color:var(--text,#eee);border-color:var(--t3,#555)}
.kproj-auto.on{background:var(--accent,#e2622a);border-color:transparent;color:#fff}
.kproj-recover{position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:9500;
  display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:11px;
  background:var(--s1,#141414);border:1px solid var(--line,#333);color:var(--text,#eee);
  font-size:12.5px;box-shadow:0 20px 48px rgba(0,0,0,.5)}
.kproj-rdot{width:7px;height:7px;border-radius:50%;background:var(--accent,#e2622a);flex:none}
.kproj-recover button{border:1px solid var(--line,#333);background:var(--s2,#1e1e1e);color:var(--text,#eee);
  border-radius:7px;padding:4px 10px;font-size:12px;font-family:inherit;cursor:pointer}
.kproj-recover .kproj-rgo{background:var(--accent,#e2622a);border-color:transparent;color:#fff}
.kproj-modal{position:fixed;inset:0;z-index:9600;display:grid;place-items:center;background:rgba(0,0,0,.45)}
.kproj-card{background:var(--s1,#151515);border:1px solid var(--line,#333);border-radius:13px;padding:16px;
  min-width:320px;color:var(--text,#eee);box-shadow:0 26px 60px rgba(0,0,0,.5)}
.kproj-card h4{margin:0 0 10px;font-size:13.5px;font-weight:600}
.kproj-card input{width:100%;background:var(--s2,#1e1e1e);border:1px solid var(--line,#333);border-radius:7px;
  color:var(--text,#eee);padding:7px 9px;font-size:13px;font-family:inherit}
.kproj-card .r{display:flex;justify-content:flex-end;gap:7px;margin-top:13px}`;
    document.head.appendChild(s);
  }

  function mount(el) {
    if (!el || el === document.documentElement || el === document.body || el.dataset.ready) return;
    el.dataset.ready = "1";
    styles();
    host = el;
    el.classList.add("kproj");
    el.innerHTML = `<span class="kproj-dot" title="Unsaved changes"></span>
      <input class="kproj-name" spellcheck="false" aria-label="Project name">
      <span class="kproj-note"></span>
      <button class="kproj-btn kproj-save" data-i18n="proj.save">Save</button>
      <button class="kproj-btn kproj-car" aria-label="Project menu" aria-haspopup="true">▾</button>
      <div class="kproj-drop" hidden></div>`;
    drop = el.querySelector(".kproj-drop");

    const nameEl = el.querySelector(".kproj-name");
    nameEl.addEventListener("input", () => { S.name = nameEl.value; touch(); });
    nameEl.addEventListener("keydown", e => { if (e.key === "Enter") nameEl.blur(); });
    el.querySelector(".kproj-save").onclick = () => save();
    el.querySelector(".kproj-car").onclick = e => { e.stopPropagation(); toggle(); };
    document.addEventListener("click", e => { if (host && !host.contains(e.target)) close(); });
    render();
  }

  const isOpen = () => drop && !drop.hidden;
  function close() { if (drop) drop.hidden = true; }
  function toggle() {
    if (!drop) return;
    drop.hidden = !drop.hidden;
    if (!drop.hidden) renderList();
  }

  const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
  function render() {
    if (!drop) return;
    drop.innerHTML = `
      <button class="kproj-row" data-p="new">${T("proj.new", "New project")}<span class="k">${MOD}⇧N</span></button>
      <button class="kproj-row" data-p="open">${T("proj.open", "Open project…")}<span class="k">${MOD}O</span></button>
      <button class="kproj-row" data-p="save">${T("proj.save", "Save")}<span class="k">${MOD}S</span></button>
      <button class="kproj-row" data-p="saveas">${T("proj.saveas", "Save as…")}<span class="k">${MOD}⇧S</span></button>
      <div class="kproj-sep"></div>
      <div class="kproj-head">${T("proj.recent", "Recent projects")}</div>
      <div class="kproj-recent"></div>
      <div class="kproj-sep"></div>
      <div class="kproj-head">${T("proj.auto", "Auto save")}</div>
      <div class="kproj-autos">${AUTOS.map(m => `<button class="kproj-auto${S.auto === m ? " on" : ""}" data-min="${m}">${
        m === 0 ? T("proj.off", "Off") : T("proj.every", "Every") + " " + m + " " + T("proj.min", "min")}</button>`).join("")}</div>
      <div class="kproj-sep"></div>
      <button class="kproj-row" data-p="download">${T("proj.download", "Save a copy to disk…")}</button>
      <button class="kproj-row" data-p="fromdisk">${T("proj.fromdisk", "Open from disk…")}</button>`;
    drop.onclick = e => {
      const auto = e.target.closest(".kproj-auto");
      if (auto) return setAuto(+auto.dataset.min);
      const row = e.target.closest(".kproj-row");
      if (!row) return;
      const p = row.dataset.p;
      if (p === "new") neu();
      else if (p === "open") pickProject();
      else if (p === "save") { save(); close(); }
      else if (p === "saveas") saveAs();
      else if (p === "download") download();
      else if (p === "fromdisk") pickFile();
      else if (p === "recent") open(row.dataset.id);
    };
    paint();
    renderList();
  }

  async function renderList() {
    const box = drop?.querySelector(".kproj-recent");
    if (!box) return;
    let list = [];
    try { list = await store.list(); } catch {}
    if (!list.length) {
      box.innerHTML = `<div class="kproj-empty">${T("proj.none", "Nothing saved yet.")}</div>`;
      return;
    }
    box.innerHTML = list.slice(0, 6).map(r =>
      `<button class="kproj-row" data-p="recent" data-id="${esc(r.id)}"><b>${esc(r.name)}</b>
        <span class="k">${when(r.modified)}</span>
        <span class="kproj-x" data-del="${esc(r.id)}" title="Delete">✕</span></button>`).join("");
    box.querySelectorAll("[data-del]").forEach(x => x.onclick = async e => {
      e.stopPropagation();
      if (await confirmBox(T("proj.delq", "Delete this project?"), x.dataset.del)) remove(x.dataset.del);
    });
  }

  function paint() {
    /* One name, several places it can be shown or changed — the toolbar here,
       a Project panel in the video editor. Anything that mirrors it listens. */
    dispatchEvent(new CustomEvent("kiln-project", {
      detail: { id: S.id, name: S.name, dirty: dirty(), busy: S.busy },
    }));
    if (!host) return;
    host.classList.toggle("is-dirty", dirty());
    const n = host.querySelector(".kproj-name");
    if (n && document.activeElement !== n) n.value = S.name || A_?.newName || "";
    const b = host.querySelector(".kproj-save");
    if (b) {
      b.disabled = S.busy;
      b.textContent = S.busy ? T("proj.saving", "Saving…") : T("proj.save", "Save");
      b.title = S.savedAt ? `Last saved ${clock(S.savedAt)}` : "Not saved yet";
    }
  }

  /* ---------------- the small dialogs ---------------- */
  function modal(inner) {
    const wrap = document.createElement("div");
    wrap.className = "kproj-modal";
    wrap.innerHTML = `<div class="kproj-card">${inner}</div>`;
    document.body.appendChild(wrap);
    return wrap;
  }
  function ask(title, value) {
    return new Promise(res => {
      const w = modal(`<h4>${esc(title)}</h4><input value="${esc(value)}">
        <div class="r"><button class="kproj-btn" data-no>Cancel</button>
        <button class="kproj-btn" data-yes>Save</button></div>`);
      const input = w.querySelector("input");
      input.select(); input.focus();
      const done = v => { w.remove(); res(v); };
      w.querySelector("[data-yes]").onclick = () => done(input.value);
      w.querySelector("[data-no]").onclick = () => done(null);
      input.onkeydown = e => { if (e.key === "Enter") done(input.value); if (e.key === "Escape") done(null); };
    });
  }
  function confirmBox(title, detail) {
    return new Promise(res => {
      const w = modal(`<h4>${esc(title)}</h4>
        <div class="r"><button class="kproj-btn" data-no>Cancel</button>
        <button class="kproj-btn" data-yes>Yes</button></div>`);
      const done = v => { w.remove(); res(v); };
      w.querySelector("[data-yes]").onclick = () => done(true);
      w.querySelector("[data-no]").onclick = () => done(false);
    });
  }
  const confirmDrop = () => confirmBox(T("proj.dropq", "There are unsaved changes. Start a new project anyway?"));

  async function pickProject() {
    let list = [];
    try { list = await store.list(); } catch {}
    const rows = list.map(r => `<button class="kproj-row" data-id="${esc(r.id)}"><b>${esc(r.name)}</b>
      <span class="k">${when(r.modified)} · ${(r.assets || []).length} file${(r.assets || []).length === 1 ? "" : "s"}</span></button>`).join("");
    const w = modal(`<h4>${T("proj.open", "Open project…")}</h4>
      <div class="kproj-recent" style="max-height:280px;min-width:300px">${rows ||
        `<div class="kproj-empty">${T("proj.none", "Nothing saved yet.")}</div>`}</div>
      <div class="r"><button class="kproj-btn" data-no>Cancel</button></div>`);
    w.querySelector("[data-no]").onclick = () => w.remove();
    w.onclick = e => {
      if (e.target === w) return w.remove();
      const row = e.target.closest("[data-id]");
      if (row) { w.remove(); open(row.dataset.id); }
    };
  }

  function pickFile() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".kiln,.kilnvid,application/zip,application/json";
    inp.onchange = () => inp.files[0] && openFile(inp.files[0]);
    inp.click();
  }

  /* ---------------- boot ----------------
     Called from register(), which a workspace may run before or after the
     document is ready; the guard is so the second call only mounts. */
  let booted = false;
  function boot() {
    document.querySelectorAll("[data-kiln-project]").forEach(mount);
    if (booted) return;
    booted = true;
    checkRecovery().catch(() => {});
    addEventListener("kiln-lang", render);
    addEventListener("keydown", e => {
      if (!(e.metaKey || e.ctrlKey) || !A_) return;
      const k = e.key.toLowerCase();
      if (k === "s") { e.preventDefault(); e.shiftKey ? saveAs() : save(); }
      else if (k === "o") { e.preventDefault(); pickProject(); }
      else if (k === "n" && e.shiftKey) { e.preventDefault(); neu(); }
    });
  }

  const API = {
    register, touch, save, saveAs, open, openFile, download, neu, remove,
    setAuto, useStore, list: () => store.list(),
    get state() {
      return { id: S.id, name: S.name, dirty: dirty(), auto: S.auto, savedAt: S.savedAt, busy: S.busy };
    },
    rename(name) { S.name = name; paint(); touch(); },
    /* the tests and the workspaces both need these */
    _zip: zip, _unzip: unzip, _store: () => store,
  };
  window.KilnProject = API;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { if (A_) boot(); });
})();
