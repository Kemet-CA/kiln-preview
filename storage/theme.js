/* ============================================================
   Kiln shared theme controller.
   Two buttons, both single-click:
     ☾/☀  toggles dark <-> light
     chip cycles to the next theme family
   Applies data-theme + data-mode to <html> and remembers both.
   Load in <head> so the palette is set before first paint.
   ============================================================ */
(function () {
  "use strict";

  // cycle order — the chip button steps through this list
  // Three that are actually different from one another. Deep Ocean and
  // Monochrome were Ember with the warmth turned down, so they are gone; a
  // reader who wants either has the light/dark switch.
  const THEMES = [
    { id: "ember", name: "Ember", dark: "#0B0A09", light: "#F2EEE8", accent: "#E2622A" },
    { id: "neo", name: "Neo Pop", dark: "#131316", light: "#F6EFDF", accent: "#F2BE22" },
    { id: "retro", name: "Retro OS", dark: "#3A3A3A", light: "#008080", accent: "#C0C0C0" },
  ];
  const KEY_T = "kiln-theme", KEY_M = "kiln-mode";
  const root = document.documentElement;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  let theme = THEMES.some(t => t.id === store.get(KEY_T)) ? store.get(KEY_T) : "ember";
  let mode = ["dark", "light"].includes(store.get(KEY_M)) ? store.get(KEY_M) : null;

  /* ------------------------------------------------------------
     Automatic mode follows the clock where the reader is: light through the
     working day, dark after dusk. It uses the device's own local time, so it
     is right in every region without asking for a location. A manual choice
     always wins, and stays until it is cleared.
     ------------------------------------------------------------ */
  const DAY_START = 7, DAY_END = 19;                 // 07:00 → 18:59 is daylight
  const modeForHour = h => (h >= DAY_START && h < DAY_END) ? "light" : "dark";
  const autoMode = () => modeForHour(new Date().getHours());

  function apply() {
    root.dataset.theme = theme;
    root.dataset.mode = mode || autoMode();
  }
  apply();
  // while a page is left open, dusk should still change it
  setInterval(() => { if (!mode && root.dataset.mode !== autoMode()) { apply(); refresh(); } }, 60_000);

  /* ------------------------------------------------------------
     The mark and the coffee button, mounted wherever a page asks for them.
     The mark is one drawing shared by every page; the coffee link is in the
     chrome on purpose, where it is always in view without being in the way.
     ------------------------------------------------------------ */
  const MARK = size => `<svg class="kmark" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">
      <path class="body" d="M7 3.6h18a3.4 3.4 0 0 1 3.4 3.4v18A3.4 3.4 0 0 1 25 28.4H7A3.4 3.4 0 0 1 3.6 25V7A3.4 3.4 0 0 1 7 3.6z"/>
      <path class="arch" d="M16 8.4a6.6 6.6 0 0 1 6.6 6.6v9.4H9.4V15A6.6 6.6 0 0 1 16 8.4z"/>
      <path class="fire" d="M16 12.6c1.7 1.5 2.6 3 2.6 4.5A2.6 2.6 0 0 1 16 19.7a2.6 2.6 0 0 1-2.6-2.6c0-1.5.9-3 2.6-4.5z"/>
    </svg>`;
  function mountMarks() {
    for (const el of document.querySelectorAll(".mark")) {
      if (el.dataset.kilnMark) continue;
      el.dataset.kilnMark = "1";
      const size = Math.round(el.getBoundingClientRect().width) || 18;
      el.innerHTML = MARK(size);
      el.style.background = "none";
      el.style.borderRadius = "0";
    }
  }
  const COFFEE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/>
      <path d="M17 10h1.6a2.4 2.4 0 0 1 0 4.8H17"/><path d="M7 3v2.5M11 3v2.5"/></svg>`;
  function mountCoffee() {
    for (const slot of document.querySelectorAll("[data-kiln-coffee]")) {
      if (slot.querySelector(".kcoffee")) continue;
      const a = document.createElement("a");
      a.className = "kcoffee";
      a.href = "https://buymeacoffee.com/kemetca";
      a.target = "_blank";
      a.rel = "noopener";
      a.title = "Buy us a coffee — it keeps this free";
      a.innerHTML = COFFEE + `<span class="lbl">Buy us a coffee</span>`;
      slot.appendChild(a);
    }
  }

  /* ------------------------------------------------------------
     Home button. Mounted into any [data-kiln-home] element, on every page
     that has one, so a workspace always has a way back to the homepage.
     The href is worked out from where the page sits: a workspace in its own
     folder (/pdf/, /video/) goes up one; a page that is a file at the root
     (editor.html) stays put.
     ------------------------------------------------------------ */
  function mountHome() {
    const slots = document.querySelectorAll("[data-kiln-home]");
    if (!slots.length) return;
    const last = location.pathname.split("/").filter(Boolean).pop() || "";
    const href = last.includes(".") ? "./" : "../";
    for (const slot of slots) {
      if (slot.querySelector(".ktb-home")) continue;
      const a = document.createElement("a");
      a.className = "ktb-home";
      a.href = href;
      a.title = "All workspaces (Home)";
      a.setAttribute("aria-label", "Home — all workspaces");
      a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 9-7 9 7"/>' +
        '<path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>';
      slot.appendChild(a);
    }
  }

  /* ------------------------------------------------------------
     The "now" strip: local time and the region it belongs to. It sits next to
     the light/dark control on every page, so wherever you are in the suite —
     an image, a PDF, a video — the time and place are in the same corner as
     the mode they explain.

     The region comes from the browser's own IANA zone (Europe/Berlin -> Berlin),
     which is the same clock the automatic light/dark rule reads, so the two can
     never disagree. Ticks on the minute; a second hand on a tool page is noise.
     ------------------------------------------------------------ */
  const zoneId = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } };
  const zoneLabel = () => {
    const z = zoneId();
    if (z) return z.split("/").pop().replace(/_/g, " ");
    const off = -new Date().getTimezoneOffset() / 60;      // fall back to the raw offset
    return "GMT" + (off >= 0 ? "+" : "") + (Math.round(off * 10) / 10);
  };

  const nows = [];
  function makeNow(slot) {
    let el = slot.querySelector(".ktb-now");
    if (el) return el;
    el = document.createElement("div");
    el.className = "ktb-now";
    el.innerHTML = '<time class="ktb-clock"></time><span class="ktb-zone"></span>';
    slot.appendChild(el);
    return el;
  }
  function mountClock() {
    // an explicit slot wins (the homepage puts one before the search box);
    // otherwise the strip rides along with the theme buttons
    const slots = document.querySelectorAll("[data-kiln-clock]");
    const hosts = slots.length ? slots : bars.map(b => b.bar);
    for (const host of hosts) {
      const el = makeNow(host);
      if (!slots.length) host.insertBefore(el, host.firstChild);
      if (!nows.includes(el)) nows.push(el);
    }
    tick();
  }
  let clockTimer = 0;
  function tick() {
    if (!nows.length) return;
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const zone = zoneLabel(), id = zoneId();
    const full = now.toLocaleString([], { dateStyle: "full", timeStyle: "short" });
    for (const el of nows) {
      const t = el.querySelector(".ktb-clock"), z = el.querySelector(".ktb-zone");
      t.textContent = time;
      t.dateTime = now.toISOString();
      z.textContent = zone;
      el.title = `${full}${id ? " · " + id : ""} — ${mode ? mode + " mode (your choice)" : "automatic: " + root.dataset.mode + " until " + (root.dataset.mode === "light" ? DAY_START + ":00" : DAY_END + ":00")}`;
    }
    // land the next update on the minute boundary
    clearTimeout(clockTimer);
    clockTimer = setTimeout(tick, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 20);
  }

  /* ------------------------------------------------------------
     Phones: a menubar too wide for the screen scrolls sideways, which would
     clip an absolutely-positioned dropdown. The small-screen stylesheet drops
     those to position:fixed instead, and needs to know where the bar ends.
     ------------------------------------------------------------ */
  function measureBar() {
    const bar = document.querySelector(".menubar, .chrome");
    if (bar) root.style.setProperty("--menubar-b", Math.round(bar.getBoundingClientRect().bottom) + "px");
  }
  addEventListener("resize", measureBar);

  const idx = () => THEMES.findIndex(t => t.id === theme);
  const cur = () => THEMES[idx()];
  const next = () => THEMES[(idx() + 1) % THEMES.length];

  const SUN = '<svg class="ktb-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg class="ktb-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>';

  const bars = [];
  function refresh() {
    const t = cur(), n = next();
    const bg = root.dataset.mode === "light" ? t.light : t.dark;
    for (const b of bars) {
      // the swatch is now a dot on the palette rather than the whole button,
      // so the button reads as "themes" before it reads as "orange"
      b.chip.style.background = t.accent;
      b.themeBtn.title = `Theme: ${t.name} — click for ${n.name}`;
      b.themeBtn.setAttribute("aria-label", `Theme ${t.name}, click to switch to ${n.name}`);
      b.modeBtn.title = mode === null
        ? `Automatic — following your local time (${root.dataset.mode} now). Click for ${root.dataset.mode === "light" ? "dark" : "light"}`
        : mode === "light" ? "Light mode, kept until you change it. Click for dark · ⌥-click to follow your local time"
        : "Dark mode, kept until you change it. Click for light · ⌥-click to follow your local time";
      b.modeBtn.classList.toggle("ktb-auto", mode === null);
    }
  }
  const note = msg => { if (typeof window.toast === "function") window.toast(msg); };

  function mount(host) {
    if (host.dataset.ktbReady) return;
    host.dataset.ktbReady = "1";
    const bar = document.createElement("div");
    bar.className = "ktb";
    bar.innerHTML =
      `<button class="ktb-btn" data-ktb-mode title="Light / dark">${MOON}${SUN}</button>
       <button class="ktb-btn" data-ktb-theme>
         <svg class="ktb-pal" viewBox="0 0 24 24" fill="none" aria-hidden="true">
           <path d="M12 3.4a8.6 8.6 0 1 0 0 17.2c1.1 0 1.8-.8 1.8-1.7 0-.8-.6-1.4-.6-2.2 0-.8.7-1.5 1.6-1.5h1.5A5.3 5.3 0 0 0 21.6 10c0-3.7-4.3-6.6-9.6-6.6z"
             stroke="currentColor" stroke-width="1.7"/>
           <circle class="d1" cx="7.6" cy="12.4" r="1.35"/><circle class="d2" cx="9.4" cy="8.2" r="1.35"/>
           <circle class="d3" cx="14" cy="7.1" r="1.35"/>
         </svg>
         <span class="ktb-chip"></span></button>`;
    host.appendChild(bar);
    const rec = {
      bar,
      modeBtn: bar.querySelector("[data-ktb-mode]"),
      themeBtn: bar.querySelector("[data-ktb-theme]"),
      chip: bar.querySelector(".ktb-chip"),
    };
    bars.push(rec);
    rec.modeBtn.addEventListener("click", e => {
      // A choice is a choice: the button flips to the opposite of what is
      // showing and that stays, through reloads, until it is changed again.
      // The clock only decides for a reader who has never chosen.
      if (e.altKey) {                                  // the way back to automatic
        mode = null;
        try { localStorage.removeItem(KEY_M); } catch {}
      } else {
        mode = root.dataset.mode === "light" ? "dark" : "light";
        store.set(KEY_M, mode);
      }
      apply(); refresh(); tick();
      note(mode === null ? `Automatic — ${autoMode()} until ${autoMode() === "light" ? DAY_END + ":00" : DAY_START + ":00"}`
        : mode === "light" ? "Light mode — kept until you change it" : "Dark mode — kept until you change it");
    });
    rec.themeBtn.addEventListener("click", () => {
      theme = next().id;
      store.set(KEY_T, theme);
      apply(); refresh();
      note(cur().name);
    });
    refresh();
  }

  const mountAll = () => document.querySelectorAll("[data-kiln-themebar]").forEach(mount);
  const boot = () => { mountHome(); mountCoffee(); mountAll(); mountClock(); mountMarks(); measureBar(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.KilnTheme = {
    THEMES, mountAll, mountClock, mountCoffee, mountMarks, modeForHour, autoMode, zoneLabel, DAY_START, DAY_END,
    get theme() { return theme; },
    get mode() { return root.dataset.mode; },        // what is showing
    get choice() { return mode; },                   // "light" | "dark" | null when following the clock
    cycle() { theme = next().id; store.set(KEY_T, theme); apply(); refresh(); },
  };
})();
