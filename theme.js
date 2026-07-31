/* ============================================================
   Kiln shared theme controller.
   Two buttons: dark/light toggle + theme-family picker.
   Applies data-theme + data-mode to <html> and remembers both.
   Load in <head> so the palette is set before first paint.
   ============================================================ */
(function () {
  "use strict";

  const THEMES = [
    { id: "ember", name: "Ember", dark: "#0B0A09", light: "#F2EEE8", accent: "#E2622A" },
    { id: "neo", name: "Neo Pop", dark: "#131316", light: "#F6EFDF", accent: "#F2BE22" },
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
    // no explicit mode yet → follow the operating system
    root.dataset.mode = mode || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }
  apply();

  // follow the OS while the user hasn't chosen a mode
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (!mode) apply(); });

  const SUN = '<svg class="ktb-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg class="ktb-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>';
  const PALETTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-.8-.5-1.2-.5-2 0-1 .8-1.8 2-1.8h1.9A3.8 3.8 0 0 0 21 12c0-5-4-9-9-9z"/><circle cx="7.5" cy="11" r="1.1" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1.1" fill="currentColor"/><circle cx="15" cy="7.8" r="1.1" fill="currentColor"/></svg>';

  function mount(host) {
    if (host.dataset.ktbReady) return;
    host.dataset.ktbReady = "1";
    const bar = document.createElement("div");
    bar.className = "ktb";
    bar.innerHTML =
      `<button class="ktb-btn" id="ktbMode" title="Light / dark" aria-label="Toggle light or dark">${MOON}${SUN}</button>
       <button class="ktb-btn" id="ktbTheme" title="Theme" aria-label="Choose theme" aria-haspopup="true">${PALETTE}</button>
       <div class="ktb-pop" id="ktbPop" role="menu"></div>`;
    host.appendChild(bar);

    const pop = bar.querySelector("#ktbPop");
    const paint = () => {
      pop.innerHTML = THEMES.map(t => {
        const bg = (root.dataset.mode === "light" ? t.light : t.dark);
        return `<button class="ktb-item" data-kt="${t.id}" role="menuitem">
          <span class="ktb-sw" style="background:linear-gradient(120deg,${bg} 55%,${t.accent} 55%)"></span>
          ${t.name}${t.id === theme ? '<span class="ktb-tick">✓</span>' : ""}</button>`;
      }).join("");
      pop.querySelectorAll("[data-kt]").forEach(b => b.addEventListener("click", () => {
        theme = b.dataset.kt;
        store.set(KEY_T, theme);
        apply(); paint();
        note(THEMES.find(t => t.id === theme).name);
      }));
    };
    paint();

    bar.querySelector("#ktbMode").addEventListener("click", () => {
      mode = (root.dataset.mode === "light") ? "dark" : "light";
      store.set(KEY_M, mode);
      apply(); paint();
      note(mode === "light" ? "Light mode" : "Dark mode");
    });
    bar.querySelector("#ktbTheme").addEventListener("click", e => {
      e.stopPropagation();
      pop.classList.toggle("on");
      paint();
    });
    document.addEventListener("click", e => {
      if (!e.target.closest("#ktbPop") && !e.target.closest("#ktbTheme")) pop.classList.remove("on");
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") pop.classList.remove("on"); });
  }
  // pages may provide their own notifier
  const note = msg => { if (typeof window.toast === "function") window.toast(msg); };

  const mountAll = () => document.querySelectorAll("[data-kiln-themebar]").forEach(mount);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();

  window.KilnTheme = { THEMES, get theme() { return theme; }, get mode() { return root.dataset.mode; }, mountAll };
})();
