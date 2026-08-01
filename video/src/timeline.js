/* ============================================================
   Timeline — the track view and every gesture that happens on it.

   Drawn as DOM (one element per clip) rather than canvas, so clips can carry
   labels, thumbnails and focus rings without hand-rolling hit-testing, and so
   the whole thing stays keyboard-reachable.
   ============================================================ */
import { clamp, clipEnd, duration, findClip, trackOf, moveClip, trimClip, mediaOf } from "./model.js";

const SNAP_PX = 7;

export class Timeline {
  constructor(host, app) {
    this.host = host;               // the scrolling element
    this.app = app;                 // { project, onChange, onSelect, onSeek, commit }
    this.pxPerSec = 60;
    this.drag = null;
    this.build();
    this.wire();
  }

  get project() { return this.app.project; }
  timeToPx(t) { return t * this.pxPerSec; }
  pxToTime(x) { return x / this.pxPerSec; }

  build() {
    this.host.innerHTML = `
      <div class="tl-ruler" id="tlRuler"></div>
      <div class="tl-body" id="tlBody"></div>
      <div class="tl-play" id="tlPlay"></div>`;
    this.ruler = this.host.querySelector("#tlRuler");
    this.body = this.host.querySelector("#tlBody");
    this.playhead = this.host.querySelector("#tlPlay");
  }

  /* ---------------- rendering ---------------- */
  render() {
    const p = this.project;
    const total = Math.max(duration(p) + 5, 20);
    const width = this.timeToPx(total);
    this.host.style.setProperty("--tl-w", width + "px");

    // ruler: a tick every 1s, a label every 5s, thinning out as you zoom out
    const step = this.pxPerSec > 90 ? 1 : this.pxPerSec > 40 ? 2 : this.pxPerSec > 18 ? 5 : 10;
    let ticks = "";
    for (let s = 0; s <= total; s += step) {
      const x = this.timeToPx(s);
      ticks += `<span class="tk" style="left:${x}px">${fmtTime(s)}</span>`;
    }
    this.ruler.innerHTML = ticks;
    this.ruler.style.width = width + "px";

    this.body.style.width = width + "px";
    this.body.innerHTML = p.tracks.map(track => `
      <div class="tl-track${track.kind === "audio" ? " audio" : ""}" data-track="${track.id}">
        ${track.clips.map(c => this.clipHtml(c, track)).join("")}
      </div>`).join("");
    this.syncPlayhead();
  }

  clipHtml(c, track) {
    const left = this.timeToPx(c.start), w = Math.max(6, this.timeToPx(c.dur));
    const sel = this.app.selection?.includes(c.id) ? " sel" : "";
    const media = mediaOf(this.project, c);
    const thumb = media?.poster && c.kind !== "text" && c.kind !== "sticker"
      ? `<span class="cthumb" style="background-image:url(${media.poster})"></span>` : "";
    const label = c.kind === "text" ? (c.text?.split("\n")[0] || "Text")
      : c.kind === "sticker" ? (c.text || "Sticker") : (c.name || media?.name || "Clip");
    const badges = [
      c.speed !== 1 ? `${c.speed}×` : "",
      c.muted ? "muted" : "",
      c.transOut ? "→" : "",
    ].filter(Boolean).join(" ");
    return `<div class="tl-clip k-${c.kind}${sel}" data-clip="${c.id}" style="left:${left}px;width:${w}px"
        title="${esc(label)}" tabindex="0">
      <span class="ch left" data-edge="left"></span>
      ${thumb}<span class="clabel">${esc(label)}</span>
      ${badges ? `<span class="cbadge">${esc(badges)}</span>` : ""}
      ${c.kind === "audio" ? `<span class="cwave"></span>` : ""}
      <button class="cdel" data-del="${c.id}" title="Delete this clip">✕</button>
      <span class="ch right" data-edge="right"></span>
    </div>`;
  }

  syncPlayhead() {
    const x = this.timeToPx(this.app.playhead);
    this.playhead.style.transform = `translateX(${x}px)`;
    this.playhead.style.height = (this.body.offsetHeight + 22) + "px";
  }

  zoom(mult, anchorTime = this.app.playhead) {
    const before = this.timeToPx(anchorTime) - this.host.scrollLeft;
    this.pxPerSec = clamp(this.pxPerSec * mult, 4, 400);
    this.render();
    this.host.scrollLeft = this.timeToPx(anchorTime) - before;
  }
  zoomToFit() {
    const total = Math.max(duration(this.project), 1);
    this.pxPerSec = clamp((this.host.clientWidth - 40) / total, 4, 400);
    this.render();
  }

  /* ---------------- snapping ---------------- */
  snapPoints(exceptId) {
    const pts = [0, this.app.playhead];
    for (const t of this.project.tracks)
      for (const c of t.clips) {
        if (c.id === exceptId) continue;
        pts.push(c.start, clipEnd(c));
      }
    return pts;
  }
  snap(t, exceptId) {
    if (!this.app.snapping) return t;
    const tol = this.pxToTime(SNAP_PX);
    let best = t, bestD = tol;
    for (const p of this.snapPoints(exceptId)) {
      const d = Math.abs(p - t);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  /* ---------------- gestures ---------------- */
  wire() {
    // scrub on the ruler
    const scrub = e => {
      const r = this.ruler.getBoundingClientRect();
      this.app.onSeek(Math.max(0, this.pxToTime(e.clientX - r.left)));
    };
    this.ruler.addEventListener("pointerdown", e => {
      this.ruler.setPointerCapture(e.pointerId);
      scrub(e);
      const move = ev => scrub(ev);
      const up = () => { this.ruler.removeEventListener("pointermove", move); this.ruler.removeEventListener("pointerup", up); };
      this.ruler.addEventListener("pointermove", move);
      this.ruler.addEventListener("pointerup", up);
    });

    // the ✕ on a selected clip, and right-click anywhere on one
    this.body.addEventListener("click", e => {
      const del = e.target.closest("[data-del]");
      if (del) { e.stopPropagation(); this.app.onDelete(del.dataset.del); }
    });
    this.body.addEventListener("contextmenu", e => {
      const el = e.target.closest(".tl-clip");
      if (!el) return;
      e.preventDefault();
      this.app.onContext(el.dataset.clip, e.clientX, e.clientY);
    });

    this.body.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      let clipEl = e.target.closest(".tl-clip");
      if (e.target.closest("[data-del]")) return;
      if (!clipEl) { this.app.onSelect([]); return; }
      const id = clipEl.dataset.clip;
      const clip = findClip(this.project, id);
      const track = trackOf(this.project, id);
      if (!clip || track.locked) return;

      const multi = e.shiftKey || e.metaKey || e.ctrlKey;
      this.app.onSelect(multi ? [...new Set([...(this.app.selection || []), id])] : [id]);

      const edge = e.target.dataset.edge;
      const startX = e.clientX, startY = e.clientY;
      const orig = { start: clip.start, dur: clip.dur, in: clip.in };
      const media = mediaOf(this.project, clip);
      let moved = false;

      /* Only the dragged element moves while the pointer is down. Re-rendering
         the whole timeline mid-drag would destroy the node under the pointer —
         which loses the gesture — and makes dragging visibly stutter. */
      const paint = () => {
        clipEl.style.left = this.timeToPx(clip.start) + "px";
        clipEl.style.width = Math.max(6, this.timeToPx(clip.dur)) + "px";
      };
      const move = ev => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 3 && Math.abs(ev.clientY - startY) < 3) return;
        moved = true;
        if (edge) {
          Object.assign(clip, orig);
          const delta = this.pxToTime(dx);
          if (edge === "left") {
            const target = this.snap(orig.start + delta, id);
            trimClip(clip, "left", target - orig.start, media);
          } else {
            const target = this.snap(orig.start + orig.dur + delta, id);
            trimClip(clip, "right", target - (orig.start + orig.dur), media);
          }
          paint();
        } else {
          const overTrack = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".tl-track");
          const toId = overTrack?.dataset.track || track.id;
          const want = this.snap(Math.max(0, orig.start + this.pxToTime(dx)), id);
          moveClip(this.project, id, toId, want);
          if (toId !== track.id) {                      // a track change does need a re-render
            this.render();
            const again = this.body.querySelector(`[data-clip="${id}"]`);
            if (again) clipEl = again;
          } else paint();
        }
        this.app.onChange({ silent: true, noTimeline: true });
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        if (moved) this.app.commit(edge ? "Trim clip" : "Move clip");
        this.render();
        this.app.onChange();
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });

    // double-click a clip to split it at the playhead
    this.body.addEventListener("dblclick", e => {
      const el = e.target.closest(".tl-clip");
      if (el) this.app.onSplit(el.dataset.clip);
    });

    // ⌘/ctrl + wheel zooms, like every timeline
    this.host.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = this.ruler.getBoundingClientRect();
      this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, this.pxToTime(e.clientX - r.left + this.host.scrollLeft));
    }, { passive: false });
  }
}

export const fmtTime = s => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), sec = Math.floor(s % 60), f = Math.floor((s % 1) * 100);
  return `${m}:${String(sec).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
