/* ============================================================
   Kiln panels — every edge is a grip, and it remembers.

   A workspace lays itself out with CSS custom properties: --lw for the left
   pane, --rw for the right, --tlh for a timeline. So resizing is not layout
   code, it is setting a number, and one small file can do it for every
   workspace instead of each one growing its own splitter.

   Declare a grip inside the panel it resizes:

     <div class="krz krz-x" data-kiln-grip data-var="--rw"
          data-edge="start" data-min="200" data-max="640"></div>

     data-edge="start"  the grip is on the panel's leading edge, so dragging
                        towards the start makes it bigger (right-hand panels,
                        and anything docked to the bottom)
     data-edge="end"    the opposite (left-hand panes, top-docked things)

   Sizes are kept per workspace, so a panel is where you left it when you come
   back — see packages/session for the rest of that idea.
   ============================================================ */
(function () {
  "use strict";

  const KEY = () => "kiln-panels-" + (document.documentElement.dataset.kilnApp || "app");
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY()) || "{}"); } catch { return {}; } };
  const write = v => { try { localStorage.setItem(KEY(), JSON.stringify(v)); } catch {} };
  const px = v => Math.round(v) + "px";

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function apply(name, value) {
    document.body.style.setProperty(name, px(value));
    // some workspaces need to redraw at the new size; a resize event is the
    // signal they already listen for
    dispatchEvent(new Event("resize"));
  }

  function restore() {
    const saved = read();
    for (const [name, value] of Object.entries(saved)) {
      if (typeof value === "number" && value > 0) document.body.style.setProperty(name, px(value));
    }
    if (Object.keys(saved).length) dispatchEvent(new Event("resize"));
  }

  function mount(grip) {
    if (grip.dataset.kilnGripReady) return;
    grip.dataset.kilnGripReady = "1";
    const name = grip.dataset.var;
    const axis = grip.classList.contains("krz-y") ? "y" : "x";
    const edge = grip.dataset.edge || "start";
    const min = Number(grip.dataset.min || 120);
    const max = Number(grip.dataset.max || 900);
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", axis === "x" ? "vertical" : "horizontal");
    grip.tabIndex = 0;

    const current = () => {
      const v = parseFloat(getComputedStyle(document.body).getPropertyValue(name));
      return isFinite(v) && v > 0 ? v : (axis === "x" ? 280 : 200);
    };

    let start = 0, from = 0;
    const move = e => {
      const now = axis === "x" ? e.clientX : e.clientY;
      const delta = now - start;
      const next = clamp(from + (edge === "start" ? -delta : delta), min, max);
      apply(name, next);
    };
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
      document.body.classList.remove("krz-dragging");
      const saved = read();
      saved[name] = current();
      write(saved);
    };
    grip.addEventListener("pointerdown", e => {
      e.preventDefault();
      start = axis === "x" ? e.clientX : e.clientY;
      from = current();
      document.body.classList.add("krz-dragging");
      addEventListener("pointermove", move);
      addEventListener("pointerup", stop);
    });
    // a keyboard can move it too, which is the only way on some machines
    grip.addEventListener("keydown", e => {
      const step = e.shiftKey ? 40 : 10;
      const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const sign = edge === "start" ? -1 : 1;
      apply(name, clamp(current() + dir * step * sign, min, max));
      const saved = read();
      saved[name] = current();
      write(saved);
    });
    // double-click puts it back where it started
    grip.addEventListener("dblclick", () => {
      document.body.style.removeProperty(name);
      const saved = read();
      delete saved[name];
      write(saved);
      dispatchEvent(new Event("resize"));
    });
  }

  function mountAll() {
    restore();
    document.querySelectorAll("[data-kiln-grip]").forEach(mount);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();

  /* the phone buttons: the panels are sheets there, and these open them */
  document.addEventListener("click", e => {
    const b = e.target.closest('[data-act="mobLeft"],[data-act="mobRight"]');
    if (b) {
      const side = b.dataset.act === "mobLeft" ? "show-left" : "show-right";
      const other = side === "show-left" ? "show-right" : "show-left";
      document.body.classList.remove(other);
      document.body.classList.toggle(side);
      document.querySelectorAll(".kmob button").forEach(x =>
        x.classList.toggle("on", x === b && document.body.classList.contains(side)));
      dispatchEvent(new Event("resize"));
      return;
    }
    // tapping the work area puts a sheet away again
    if (window.innerWidth <= 760 && !e.target.closest("#panels,.pane-l,.pick,.pool,.insp,.kmob")) {
      if (document.body.classList.contains("show-left") || document.body.classList.contains("show-right")) {
        document.body.classList.remove("show-left", "show-right");
        document.querySelectorAll(".kmob button").forEach(x => x.classList.remove("on"));
      }
    }
  });

  window.KilnPanels = { mountAll, reset() { write({}); location.reload(); } };
})();
