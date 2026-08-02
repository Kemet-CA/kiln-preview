/* ============================================================
   Timeline — the track view and every gesture that happens on it.

   Drawn as DOM (one element per clip) rather than canvas, so clips can carry
   labels, thumbnails and focus rings without hand-rolling hit-testing, and so
   the whole thing stays keyboard-reachable.
   ============================================================ */
import { clamp, clipEnd, duration, findClip, trackOf, moveClip, trimClip, mediaOf, allKeys } from "./model.js";

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
    this.renderHeads(p);
    this.syncPlayhead();
  }

  /* One row per track, beside the lanes: what it is, whether it is heard or
     seen, and a way to throw it away. */
  renderHeads(p) {
    const heads = document.getElementById("tlHeads");
    if (!heads) return;
    const eye = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.6 12S6.4 5.6 12 5.6 21.4 12 21.4 12 17.6 18.4 12 18.4 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.6"/></svg>`;
    const speaker = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 9.4h3.4L12 5.6v12.8L7.4 14.6H4z"/><path d="M15.6 9.6a4 4 0 0 1 0 4.8"/></svg>`;
    const bin = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 6.6h14.8M9.4 6.6V4.8h5.2v1.8"/><path d="M6.6 6.6 7.6 19a1.4 1.4 0 0 0 1.4 1.2h6a1.4 1.4 0 0 0 1.4-1.2l1-12.4"/><path d="M10.4 10.4v6M13.6 10.4v6"/></svg>`;
    // a stretch arrow: the clearest picture of "make this longer or shorter"
    const stretch = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16"/><path d="M7 8.5 3.5 12 7 15.5"/><path d="M17 8.5 20.5 12 17 15.5"/><path d="M12 6.5v11"/></svg>`;
    heads.innerHTML = `<div class="spacer"></div>` + p.tracks.map(t => `
      <div class="thead${t.kind === "audio" ? " audio" : ""}" data-thead="${t.id}">
        <span class="nm" title="${esc(t.name)}">${esc(t.name)}</span>
        <button class="tbtn" data-track-speed="${t.id}" title="Stretch or shrink the clips on this track">${stretch}</button>
        <button class="tbtn${t.hidden || t.muted ? "" : " on"}" data-track-toggle="${t.id}"
          title="${t.kind === "audio" ? "Mute this track" : "Hide this track"}">
          ${t.kind === "audio" ? speaker : eye}</button>
        <button class="tbtn del" data-track-del="${t.id}" title="Delete this track and everything on it">${bin}</button>
      </div>`).join("");
  }

  clipHtml(c, track) {
    const left = this.timeToPx(c.start), w = Math.max(6, this.timeToPx(c.dur));
    const sel = this.app.selection?.includes(c.id) ? " sel" : "";
    const media = mediaOf(this.project, c);
    /* A filmstrip if the media has one: scaled so it covers the whole media,
       then slid by the in-point, which puts every frame where it happens. */
    let thumb = "";
    if (c.kind !== "text" && c.kind !== "sticker" && media) {
      if (media.strip && media.dur) {
        const full = w * (media.dur / Math.max(c.dur * (c.speed || 1), .001));
        const offset = -(c.in || 0) / media.dur * full;
        thumb = `<span class="cthumb strip" style="background-image:url(${media.strip});` +
          `background-size:${full.toFixed(1)}px 100%;background-position:${offset.toFixed(1)}px 0"></span>`;
      } else if (media.poster) {
        thumb = `<span class="cthumb" style="background-image:url(${media.poster})"></span>`;
      }
    }
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
      ${this.keyMarkers(c, w)}
      <button class="cdel" data-del="${c.id}" title="Delete this clip">✕</button>
      <span class="ch right" data-edge="right"></span>
    </div>`;
  }

  /* Keyframes live on the clip, coloured by what they animate — blue for the
     transform, amber for colour, pink for opacity, purple for text, green for
     audio. Seeing them means you can move one without opening a panel to find
     out it was there. */
  keyMarkers(c, w) {
    const keys = allKeys(c);
    if (!keys.length || w < 26) return "";
    return `<span class="kfrow">` + keys.map(k =>
      `<i class="kf" style="left:${(k.t * 100).toFixed(3)}%;--kfc:${k.color}"
          data-kf="${c.id}" data-kf-prop="${k.prop}" data-kf-i="${k.i}"
          title="${k.prop} ${typeof k.v === "number" ? k.v.toFixed(2) : k.v} — drag to move it"></i>`).join("") +
      `</span>`;
  }

  /* Drag a keyframe along its clip. The stored position is 0..1 across the
     clip, so this is the pixel offset turned back into that. */
  dragKey(e, el) {
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.add("dragging");
    const clip = findClip(this.project, el.dataset.kf);
    const prop = el.dataset.kfProp, i = +el.dataset.kfI;
    const list = clip?.keys?.[prop];
    if (!list || !list[i]) return;
    const width = Math.max(1, this.timeToPx(clip.dur));
    const startX = e.clientX, from = list[i].t;
    let moved = false;
    const move = ev => {
      const t = Math.max(0, Math.min(1, from + (ev.clientX - startX) / width));
      if (Math.abs(t - list[i].t) < .0005) return;
      list[i].t = t;
      moved = true;
      el.style.left = (t * 100).toFixed(3) + "%";
      this.app.onChange({ silent: true, noTimeline: true });
    };
    const up = () => {
      document.body.classList.remove("dragging");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (moved) { this.app.commit("Move keyframe"); this.render(); this.app.onChange(); }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  /* Drag on empty timeline space to rubber-band a selection. */
  marquee(e) {
    e.preventDefault();
    document.body.classList.add("dragging");
    const startX = e.clientX, startY = e.clientY;
    const box = document.createElement("div");
    box.className = "tl-marquee";
    /* On the host, not the body: selecting re-renders the body, which would
       destroy the rectangle the pointer is still drawing. */
    this.host.appendChild(box);
    const bodyRect = () => this.host.getBoundingClientRect();
    let picked = [];
    const move = ev => {
      const r = bodyRect();
      const x1 = Math.min(startX, ev.clientX), x2 = Math.max(startX, ev.clientX);
      const y1 = Math.min(startY, ev.clientY), y2 = Math.max(startY, ev.clientY);
      box.style.left = (x1 - r.left + this.host.scrollLeft) + "px";
      box.style.top = (y1 - r.top + this.host.scrollTop) + "px";
      box.style.width = (x2 - x1) + "px";
      box.style.height = (y2 - y1) + "px";
      picked = [...this.body.querySelectorAll(".tl-clip")].filter(el => {
        const c = el.getBoundingClientRect();
        return c.right > x1 && c.left < x2 && c.bottom > y1 && c.top < y2;
      }).map(el => el.dataset.clip);
      this.app.onSelect(picked);
    };
    const up = () => {
      document.body.classList.remove("dragging");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      box.remove();
      if (!picked.length) this.app.onSelect([]);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
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
      /* preventDefault stops the browser starting a text selection: dragging
         the playhead was highlighting every label it passed over. */
      e.preventDefault();
      this.ruler.setPointerCapture(e.pointerId);
      document.body.classList.add("dragging");
      scrub(e);
      const move = ev => scrub(ev);
      const up = () => {
        document.body.classList.remove("dragging");
        this.ruler.removeEventListener("pointermove", move);
        this.ruler.removeEventListener("pointerup", up);
      };
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
      const kf = e.target.closest("[data-kf]");
      if (kf) { this.dragKey(e, kf); return; }
      let clipEl = e.target.closest(".tl-clip");
      if (e.target.closest("[data-del]")) return;
      if (!clipEl) { this.marquee(e); return; }
      const id = clipEl.dataset.clip;
      const clip = findClip(this.project, id);
      const track = trackOf(this.project, id);
      if (!clip || track.locked) return;

      const multi = e.shiftKey || e.metaKey || e.ctrlKey;
      const already = (this.app.selection || []).includes(id);
      // dragging one of several selected clips moves the whole set, so a
      // shift-click before a drag does not throw the selection away
      if (multi) this.app.onSelect(already
        ? (this.app.selection || []).filter(x => x !== id)
        : [...new Set([...(this.app.selection || []), id])]);
      else if (!already) this.app.onSelect([id], true);   // and show it

      e.preventDefault();                 // no text selection while dragging a clip
      document.body.classList.add("dragging");
      const edge = e.target.dataset.edge;
      const startX = e.clientX, startY = e.clientY;
      const orig = { start: clip.start, dur: clip.dur, in: clip.in };
      const media = mediaOf(this.project, clip);
      let moved = false;
      /* Everything selected travels together. Their offsets from the clip
         under the pointer are fixed at the start of the gesture, so the set
         keeps its shape however far it is dragged. */
      const group = (this.app.selection || [])
        .filter(x => x !== id)
        .map(x => {
          const c = findClip(this.project, x);
          const t = trackOf(this.project, x);
          return c && t && !t.locked ? { id: x, clip: c, offset: c.start - clip.start, trackId: t.id } : null;
        })
        .filter(Boolean);

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
          for (const g of group) moveClip(this.project, g.id, g.trackId, Math.max(0, want + g.offset));
          if (group.length) this.render();
          if (toId !== track.id) {                      // a track change does need a re-render
            this.render();
            const again = this.body.querySelector(`[data-clip="${id}"]`);
            if (again) clipEl = again;
          } else paint();
        }
        this.app.onChange({ silent: true, noTimeline: true });
      };
      const up = () => {
        document.body.classList.remove("dragging");
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        if (moved) this.app.commit(edge ? "Trim clip" : "Move clip");
        this.render();
        this.app.onChange();
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });

    /* Double-click splits a clip — except a title or a sticker, where the
       obvious meaning is "let me change what it says". Splitting a two-word
       caption is not something anyone has ever wanted to do by accident. */
    this.body.addEventListener("dblclick", e => {
      /* Selecting on the first click re-renders the lanes, so the second click
         lands on a different node and the browser dispatches dblclick on their
         common ancestor — the body — with no clip in sight. Asking the document
         what is under the pointer is the reliable answer. */
      const el = e.target.closest(".tl-clip") ||
        document.elementFromPoint(e.clientX, e.clientY)?.closest(".tl-clip");
      if (!el) return;
      const clip = findClip(this.project, el.dataset.clip);
      if (clip && (clip.kind === "text" || clip.kind === "sticker")) this.app.onEditText?.(clip.id);
      else this.app.onSplit(el.dataset.clip);
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
