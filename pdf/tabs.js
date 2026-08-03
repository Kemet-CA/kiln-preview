/* ============================================================
   Kiln tabs — more than one thing open at a time.

   A workspace holds one document. That is a reasonable thing for a workspace
   to believe, and it is why every app here is written around a single `Doc` or
   `App.project`: one image, one timeline, one PDF. Opening a second one meant
   losing the first.

   Tabs do not change that belief. They keep several of those single documents
   side by side and swap the live one in and out, which is why this is a few
   hundred lines rather than a rewrite of eight editors.

   ---- how a switch works ----

     capture()   the workspace hands over its live state — the actual objects,
                 canvases and decoded media, not a copy of them
     park        that state is stored on the tab being left
     adopt()     the target tab's state is handed back to the workspace

   Nothing is serialised. A photo tab keeps its canvases, a video tab keeps its
   decoded elements, and switching costs an object assignment rather than a PNG
   encode of every layer. The saving path in project.js is still the one that
   serialises, and it is unchanged.

   A workspace joins by answering two more questions in its existing register()
   call — capture and adopt — and by saying where the strip goes. Nothing else
   about it changes.

   ---- what a tab is ----

   One document, with its own project identity — its own name, its own saved
   state, its own unsaved-changes dot. Switching tabs swaps the project system's
   idea of "the current project" along with the document, so Save in tab three
   saves tab three.

   ---- what tabs are not ----

   They are not restored across a reload. Every open tab would have to be
   serialised, footage and all, to survive one; the recovery copy covers the
   document you were actually in, which is the one whose loss would hurt.
   ============================================================ */
(function () {
  "use strict";

  const T = {
    tabs: [], i: 0,
    busy: false,               // the tab system is driving; apps must not react
    adapter: null, P: null, host: null, seq: 0,
  };

  const uid = () => "tab_" + Math.random().toString(36).slice(2, 9);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const label = () => T.adapter?.tabName || "Untitled";
  const nextName = () => `${label()} ${++T.seq}`;

  const mkTab = name => ({ key: uid(), name: name || nextName(), live: null, state: null });
  const freshState = name => ({ id: null, name, created: 0, savedAt: 0, dirtyAt: 0 });

  /* ---------------- parking and unparking ----------------

     Both of these are synchronous, and that is a requirement rather than an
     optimisation. A workspace calls spawn() in the middle of opening a file —

         function newDoc(w, h, name) {
           if (Doc.open) KilnTabs.spawn({ name });     // park the old one
           Doc.open = true; Doc.layers = [];           // fill the new one
           ...

     — so if parking were to finish a microtask later, it would capture a
     document the caller had already begun overwriting. Everything up to the
     reset is plain function calls for that reason.

     Which is why capture/adopt are required of a workspace rather than
     optional: a serialising fallback could not be synchronous, and a path
     nothing exercises is a path nothing tests. */
  const park = () => {
    const cur = T.tabs[T.i];
    if (!cur) return;
    cur.live = T.adapter.capture();
    cur.state = T.P._state();
    cur.name = cur.state.name || cur.name;
  };
  const unpark = tab => {
    T.adapter.adopt(tab.live);
    T.P._adopt(tab.state || freshState(tab.name));
  };

  /* ---------------- the public moves ---------------- */
  function select(key) {
    const to = T.tabs.findIndex(t => t.key === key);
    if (to < 0 || to === T.i || T.busy || !T.adapter) return;
    T.busy = true;
    try { park(); T.i = to; unpark(T.tabs[to]); }
    finally { T.busy = false; render(); }
  }

  /* Park what is open and start a new tab.

     `reset: true` clears the workspace, which is what the + button wants.
     Without it the caller is a workspace part-way through loading a file into
     the tab it just asked for, and clearing first would only make it flicker. */
  function spawn(opts = {}) {
    if (!T.adapter || T.busy) return null;
    T.busy = true;
    try {
      park();
      const t = mkTab(opts.name);
      T.tabs.push(t);
      T.i = T.tabs.length - 1;
      T.P._adopt(freshState(t.name));
      if (opts.reset) Promise.resolve(T.adapter.reset()).then(render);
      return t.key;
    } finally { T.busy = false; render(); }
  }

  async function close(key) {
    const at = T.tabs.findIndex(t => t.key === key);
    if (at < 0 || T.busy) return;
    const tab = T.tabs[at];
    const st = at === T.i ? T.P._state() : tab.state;
    if (st && st.dirtyAt > st.savedAt) {
      const go = await T.P._confirm(`“${st.name || tab.name}” has unsaved changes. Close it anyway?`);
      if (!go) return;
    }
    /* The last tab closing leaves an empty workspace rather than no workspace:
       a window with no document in it is a state nothing here knows how to
       draw, and "close the only tab" almost always means "start again". */
    if (T.tabs.length === 1) {
      T.busy = true;
      try {
        await T.adapter.reset();
        T.tabs[0] = mkTab();
        T.P._adopt(freshState(T.tabs[0].name));
      } finally { T.busy = false; render(); }
      return;
    }
    T.tabs.splice(at, 1);
    if (at === T.i) {
      T.i = Math.min(at, T.tabs.length - 1);
      T.busy = true;
      try { unpark(T.tabs[T.i]); } finally { T.busy = false; }
    } else if (at < T.i) T.i--;
    render();
  }

  /* ---------------- the strip ---------------- */
  function styles() {
    if (document.getElementById("ktabs-css")) return;
    const s = document.createElement("style");
    s.id = "ktabs-css";
    s.textContent = `
.ktabs{grid-area:tabs;display:flex;align-items:stretch;gap:3px;padding:3px 8px 0;overflow-x:auto;
  background:var(--s1,#141414);border-bottom:1px solid var(--line,#2a2a2a);scrollbar-width:none}
.ktabs::-webkit-scrollbar{display:none}
.ktab{display:inline-flex;align-items:center;gap:7px;padding:0 8px 0 10px;height:25px;flex:none;
  max-width:190px;border:1px solid transparent;border-bottom:0;border-radius:7px 7px 0 0;
  background:none;color:var(--t3,#777);font:inherit;font-size:12px;cursor:pointer;
  transition:background .14s,color .14s}
.ktab:hover{background:var(--s2,#1e1e1e);color:var(--t2,#aaa)}
.ktab.on{background:var(--s3,#242424);border-color:var(--line,#2a2a2a);color:var(--text,#eee)}
.ktab-n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ktab-d{width:6px;height:6px;border-radius:50%;background:var(--accent,#e2622a);flex:none;opacity:0}
.ktab.dirty .ktab-d{opacity:1}
.ktab-x{border:0;background:none;color:inherit;font-size:13px;line-height:1;padding:1px 3px;border-radius:4px;
  opacity:0;cursor:pointer;flex:none}
.ktab:hover .ktab-x,.ktab.on .ktab-x{opacity:.65}
.ktab-x:hover{opacity:1;background:var(--s1,#141414)}
.ktabs-add{flex:none;align-self:center;margin-inline-start:2px;width:23px;height:23px;border-radius:6px;
  border:1px solid var(--line,#2a2a2a);background:none;color:var(--t2,#999);font-size:15px;line-height:1;
  cursor:pointer;font-family:inherit}
.ktabs-add:hover{background:var(--s3,#242424);color:var(--text,#eee)}
.ktabs-n{margin-inline-start:auto;align-self:center;padding-inline-start:10px;font-size:11px;color:var(--t3,#777);flex:none}`;
    document.head.appendChild(s);
  }

  function mount() {
    if (T.host) return;
    const el = document.querySelector("[data-kiln-tabs]");
    if (!el) return;
    styles();
    T.host = el;
    el.classList.add("ktabs");
    el.addEventListener("click", e => {
      const x = e.target.closest(".ktab-x");
      if (x) { e.stopPropagation(); return close(x.closest(".ktab").dataset.k); }
      if (e.target.closest(".ktabs-add")) return spawn({ reset: true });
      const tab = e.target.closest(".ktab");
      if (tab) select(tab.dataset.k);
    });
    /* Double-click a tab to rename it — the same name the project bar shows,
       reached from whichever of the two is closer to hand. */
    el.addEventListener("dblclick", e => {
      const tab = e.target.closest(".ktab");
      if (!tab || tab.dataset.k !== T.tabs[T.i]?.key) return;
      const name = prompt("Name this " + label().toLowerCase(), T.P._state().name || "");
      if (name != null && name.trim()) T.P.rename(name.trim());
    });
  }

  function render() {
    if (!T.host) return;
    const live = T.P?._state();
    T.host.innerHTML = T.tabs.map((t, n) => {
      const st = n === T.i ? live : t.state;
      const name = (st?.name || t.name);
      const dirty = st ? st.dirtyAt > st.savedAt : false;
      return `<button class="ktab${n === T.i ? " on" : ""}${dirty ? " dirty" : ""}" data-k="${t.key}"
        title="${esc(name)}"><span class="ktab-d"></span><span class="ktab-n">${esc(name)}</span>
        <span class="ktab-x" role="button" aria-label="Close">✕</span></button>`;
    }).join("") +
      `<button class="ktabs-add" title="New ${label().toLowerCase()} (${
        navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+"}T)" aria-label="New tab">＋</button>` +
      (T.tabs.length > 1 ? `<span class="ktabs-n">${T.tabs.length} open</span>` : "");
  }

  /* ---------------- wiring ---------------- */
  function attach(adapter, P) {
    T.adapter = adapter;
    T.P = P;
    T.seq = 0;
    if (!T.tabs.length) T.tabs = [mkTab()];
    mount();
    render();
    addEventListener("kiln-project", () => {
      const t = T.tabs[T.i];
      if (t && !T.busy) t.name = T.P._state().name || t.name;
      render();
    });
    addEventListener("keydown", e => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "t") { e.preventDefault(); spawn({ reset: true }); }
      else if (k === "w" && T.tabs.length > 1) { e.preventDefault(); close(T.tabs[T.i].key); }
      /* ⌥⌘→ / ⌥⌘← walks the strip, the way a browser does */
      else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        const step = e.key === "ArrowRight" ? 1 : -1;
        const to = (T.i + step + T.tabs.length) % T.tabs.length;
        select(T.tabs[to].key);
      }
    });
  }

  window.KilnTabs = {
    attach, spawn, select, close, render,
    get busy() { return T.busy; },
    get count() { return T.tabs.length; },
    get active() { return T.i; },
    list: () => T.tabs.map((t, n) => ({
      key: t.key, name: (n === T.i ? T.P._state().name : t.state?.name) || t.name, active: n === T.i,
    })),
  };
})();
