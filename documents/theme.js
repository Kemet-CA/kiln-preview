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
  const THEMES = [
    { id: "ember", name: "Ember", dark: "#0B0A09", light: "#F2EEE8", accent: "#E2622A" },
    { id: "neo", name: "Neo Pop", dark: "#131316", light: "#F6EFDF", accent: "#F2BE22" },
    { id: "retro", name: "Retro OS", dark: "#3A3A3A", light: "#008080", accent: "#C0C0C0" },
    { id: "ocean", name: "Deep Ocean", dark: "#071019", light: "#EDF4F8", accent: "#19A7BE" },
    { id: "mono", name: "Monochrome", dark: "#101010", light: "#F4F4F4", accent: "#8A8A8A" },
  ];
  const KEY_T = "kiln-theme", KEY_M = "kiln-mode";
  const root = document.documentElement;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  let theme = THEMES.some(t => t.id === store.get(KEY_T)) ? store.get(KEY_T) : "ember";
  let mode = ["dark", "light"].includes(store.get(KEY_M)) ? store.get(KEY_M) : null;

  function apply() {
    root.dataset.theme = theme;
    // no explicit choice yet → follow the operating system
    root.dataset.mode = mode || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }
  apply();
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (!mode) apply(); });

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
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountHome);
  else mountHome();

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
      b.chip.style.background = `linear-gradient(120deg,${bg} 55%,${t.accent} 55%)`;
      b.themeBtn.title = `Theme: ${t.name} — click for ${n.name}`;
      b.themeBtn.setAttribute("aria-label", `Theme ${t.name}, click to switch to ${n.name}`);
      b.modeBtn.title = root.dataset.mode === "light" ? "Switch to dark" : "Switch to light";
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
       <button class="ktb-btn" data-ktb-theme><span class="ktb-chip"></span></button>`;
    host.appendChild(bar);
    const rec = {
      modeBtn: bar.querySelector("[data-ktb-mode]"),
      themeBtn: bar.querySelector("[data-ktb-theme]"),
      chip: bar.querySelector(".ktb-chip"),
    };
    bars.push(rec);
    rec.modeBtn.addEventListener("click", () => {
      mode = root.dataset.mode === "light" ? "dark" : "light";
      store.set(KEY_M, mode);
      apply(); refresh();
      note(mode === "light" ? "Light mode" : "Dark mode");
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
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();

  window.KilnTheme = {
    THEMES, mountAll,
    get theme() { return theme; },
    get mode() { return root.dataset.mode; },
    cycle() { theme = next().id; store.set(KEY_T, theme); apply(); refresh(); },
  };
})();
