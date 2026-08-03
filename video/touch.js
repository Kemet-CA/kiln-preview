/* ============================================================
   Kiln touch — the same editor, with a finger or a pen.

   Most of this codebase was already written against pointer events, which is
   why scrubbing, trimming and painting mostly worked on a tablet already. Two
   things did not, and they are the two this file is about.

   ---- 1. Dragging something onto something else ----

   The HTML5 drag-and-drop API — `draggable="true"`, dragstart, dataTransfer —
   has no touch implementation. Not a partial one: a touch never fires a single
   drag event, on any browser, on any tablet. Dragging media from the library
   onto the timeline, reordering PDF pages, reordering layers: all of it was
   mouse-only, and no amount of CSS was going to fix that.

   So internal drags are done with pointer events instead, which is the one
   input API that speaks mouse, touch and pen with the same vocabulary. That
   also removes the browser's own drag machinery from the picture on desktop,
   where it was competing with our pointer handlers anyway.

   The hard part is not the dragging, it is telling a drag apart from a scroll.
   A finger moving down a list means "scroll" almost every time, and it means
   "pick this up" occasionally, and the browser has already started scrolling
   by the time you could ask. The answer everyone converges on, because it is
   the only one that works:

     mouse       a drag starts as soon as the pointer moves a few pixels
     touch/pen   a drag starts after holding still for a moment; moving before
                 then means it was a scroll, and we get out of the way

   Once a touch drag has started, `touchmove` is cancelled so the list stops
   scrolling under it — which needs a non-passive listener, and needs the drag
   to have started before the scroll did. That is exactly what the hold buys.

   ---- 2. The pen ----

   `pointerType` says whether it was a finger or a stylus, and a stylus brings
   `pressure` with it. Two things follow, and only one of them is obvious:

     pressure    an Apple Pencil or S Pen reports 0..1 with real dynamics; a
                 mouse reports a flat 0.5, which is why the brush treats 0.5 as
                 "no information" rather than "half pressure"
     the palm    a hand resting on the glass is a touch, and it arrives while
                 the pen is drawing. Once a pen has been seen, touches on the
                 canvas are ignored for a moment — otherwise a stroke gets a
                 second stroke smeared across it from the side of the hand

   Coalesced events matter here too: a pen samples faster than the screen
   refreshes, and the browser hands over the samples it collected between
   frames only if you ask for them. A stroke drawn from those is smooth; one
   drawn from a single event per frame has corners in it.
   ============================================================ */
(function () {
  "use strict";

  const HOLD = 320;        // ms a finger must stay put before it is a drag
  const SLOP = 10;         // px it may wander in that time and still count
  const MOUSE_SLOP = 4;    // a mouse drag needs no patience, just intent

  /* ---------------- the ghost ---------------- */
  function styles() {
    if (document.getElementById("ktouch-css")) return;
    const s = document.createElement("style");
    s.id = "ktouch-css";
    s.textContent = `
.kdrag-ghost{position:fixed;z-index:9800;pointer-events:none;left:0;top:0;
  padding:6px 11px;border-radius:9px;font-size:12px;font-weight:600;
  background:var(--accent,#e2622a);color:#fff;box-shadow:0 12px 30px rgba(0,0,0,.4);
  transform:translate(-50%,-140%);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.kdrag-lift{opacity:.55}
/* A tap must not be read as a double-tap-to-zoom, and holding a control must
   not raise iOS's selection callout over the top of it. */
html.coarse button,html.coarse .chip,html.coarse .tb,html.coarse .itab,html.coarse .ktab,
html.coarse .ptab,html.coarse [role="switch"]{touch-action:manipulation;-webkit-touch-callout:none}
html.coarse canvas{touch-action:none;-webkit-touch-callout:none}`;
    document.head.appendChild(s);
  }

  /* Coarse pointer means a finger is the main way in. It is not the same
     question as "is this a small screen" — a tablet is neither phone-sized nor
     mouse-driven, and it is the device this is really for. */
  function markInput() {
    const coarse = matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
    document.documentElement.classList.toggle("coarse", coarse);
  }

  /* ---------------- the drag ----------------
     One live drag at a time, which is a deliberate limit: two fingers dragging
     two clips is a feature nobody asked for and a source of bugs everybody
     gets. A second pointer while one is down is ignored. */
  let live = null;

  function wire(opts) {
    const host = typeof opts.from === "string" ? document.querySelector(opts.from) : opts.from;
    if (!host || host.dataset.kdrag) return;
    host.dataset.kdrag = "1";
    styles();

    host.addEventListener("pointerdown", e => {
      if (live || e.button > 0) return;
      const item = e.target.closest(opts.item);
      if (!item || !host.contains(item)) return;
      if (opts.ignore && e.target.closest(opts.ignore)) return;
      const payload = opts.data(item);
      if (payload == null) return;

      const touch = e.pointerType !== "mouse";
      live = {
        opts, item, payload, id: e.pointerId, touch,
        x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
        armed: false, ghost: null,
        timer: touch ? setTimeout(() => arm(), HOLD) : 0,
      };
      /* Not preventDefault here: on a mouse this would kill the click that
         selects the item, and on a touch it would kill scrolling before we
         know which one this is. */
    }, { passive: true });

    /* Non-passive, because stopping the list scrolling under a started drag is
       the whole point and a passive listener cannot. */
    host.addEventListener("touchmove", e => {
      if (live && live.armed) e.preventDefault();
    }, { passive: false });
  }

  function arm() {
    if (!live || live.armed) return;
    live.armed = true;
    const { opts, item } = live;
    item.classList.add("kdrag-lift");
    const ghost = document.createElement("div");
    ghost.className = "kdrag-ghost";
    ghost.textContent = opts.label ? opts.label(item) : (item.textContent || "").trim().slice(0, 40);
    document.body.appendChild(ghost);
    live.ghost = ghost;
    move(live.x, live.y);
    if (navigator.vibrate) navigator.vibrate(8);      // the same tick a phone gives a long press
  }

  function move(x, y) {
    if (!live?.armed) return;
    live.ghost.style.translate = `${x}px ${y}px`;
    /* The pointer is captured, so the event's own target stops changing —
       what is under the finger has to be asked for directly. */
    const under = document.elementFromPoint(x, y);
    live.opts.over?.(x, y, live.payload, under);
  }

  addEventListener("pointermove", e => {
    if (!live || e.pointerId !== live.id) return;
    live.x = e.clientX; live.y = e.clientY;
    if (!live.armed) {
      const far = Math.hypot(e.clientX - live.x0, e.clientY - live.y0);
      if (live.touch) {
        // moved before the hold finished: this was a scroll, let it be one
        if (far > SLOP) cancel();
      } else if (far > MOUSE_SLOP) arm();
      return;
    }
    move(e.clientX, e.clientY);
  }, { passive: true });

  addEventListener("pointerup", e => {
    if (!live || e.pointerId !== live.id) return;
    const l = live;
    finish();
    if (!l.armed) return;                    // a tap, not a drag — leave the click alone
    const under = document.elementFromPoint(e.clientX, e.clientY);
    l.opts.drop?.(e.clientX, e.clientY, l.payload, under);
  }, { passive: true });

  addEventListener("pointercancel", () => cancel(), { passive: true });

  function finish() {
    if (!live) return;
    clearTimeout(live.timer);
    live.ghost?.remove();
    live.item.classList.remove("kdrag-lift");
    live.opts.end?.();
    live = null;
  }
  const cancel = () => finish();

  /* ---------------- the pen ---------------- */
  let lastPen = 0;
  const PALM_WINDOW = 700;      // ms after a pen sample that touches are ignored

  const Pen = {
    /* 0.5 exactly is what a mouse reports and what a pen reports when it has
       nothing to say; both mean "no pressure information", not "half". */
    pressure(e) {
      if (e.pointerType === "pen" && e.pressure > 0 && e.pressure !== .5) return e.pressure;
      if (e.pointerType === "touch" && e.pressure > 0 && e.pressure !== .5 && e.pressure !== 1) return e.pressure;
      return null;
    },
    isPen: e => e.pointerType === "pen",
    seen(e) { if (e.pointerType === "pen") lastPen = performance.now(); },
    /* A palm is a touch that arrives while a pen is working. Rejecting it is
       the difference between a drawing and a drawing with a smear across it. */
    isPalm(e) {
      if (e.pointerType !== "touch") return false;
      return performance.now() - lastPen < PALM_WINDOW;
    },
    /* Every sample the browser collected since the last frame. A pen reports
       far faster than the screen redraws, and a stroke built from one event
       per frame has corners a stroke built from these does not. */
    samples(e) {
      if (typeof e.getCoalescedEvents !== "function") return [e];
      const all = e.getCoalescedEvents();
      return all && all.length ? all : [e];
    },
    /* Tilt, for brushes that want an angle. Reported in degrees from vertical
       on each axis; null when the device does not measure it. */
    tilt(e) {
      if (!e.tiltX && !e.tiltY) return null;
      return { x: e.tiltX, y: e.tiltY, angle: Math.atan2(e.tiltY, e.tiltX) * 180 / Math.PI };
    },
  };

  markInput();
  matchMedia("(pointer: coarse)").addEventListener?.("change", markInput);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", styles);
  else styles();

  window.KilnDrag = { wire, get dragging() { return !!live?.armed; } };
  window.KilnPen = Pen;
})();
