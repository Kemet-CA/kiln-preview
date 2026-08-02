/* ============================================================
   Compositor — draws the state of the timeline at time t onto a 2D context.

   The preview and the exporter call the same function. That is the whole
   point: what you see while scrubbing is produced by the code that writes the
   file, so the export cannot drift away from the preview.
   ============================================================ */
import { clipAt, clipEnd, mediaOf, valueAt, clamp } from "./model.js";
import { stage, needsStage } from "./keyer.js";

/* CSS filter string for a clip's colour correction */
export function filterOf(c) {
  const f = [];
  if (c.brightness !== 1) f.push(`brightness(${c.brightness})`);
  if (c.contrast !== 1) f.push(`contrast(${c.contrast})`);
  if (c.saturate !== 1) f.push(`saturate(${c.saturate})`);
  if (c.hue) f.push(`hue-rotate(${c.hue}deg)`);
  if (c.blur) f.push(`blur(${c.blur}px)`);
  if (c.sepia) f.push(`sepia(${c.sepia})`);
  if (c.grayscale) f.push(`grayscale(${c.grayscale})`);
  return f.join(" ") || "none";
}

/* how far a clip is into a transition at time t: 0 = not in one, 1 = fully across */
function transitionProgress(clip, t) {
  const inD = clip.transIn?.dur || 0, outD = clip.transOut?.dur || 0;
  if (inD && t < clip.start + inD) return { edge: "in", k: (t - clip.start) / inD, def: clip.transIn };
  if (outD && t > clipEnd(clip) - outD) return { edge: "out", k: (clipEnd(clip) - t) / outD, def: clip.transOut };
  return null;
}

/* source rectangle after cropping, in the media's own pixels */
function sourceRect(clip, sw, sh) {
  const { l, t, r, b } = clip.crop;
  const x = sw * l, y = sh * t;
  return { sx: x, sy: y, sw: Math.max(1, sw * (1 - l - r)), sh: Math.max(1, sh * (1 - t - b)) };
}

/* one visual clip, with its transform, colour and opacity applied */
function drawClip(ctx, project, clip, t, sources, alphaMul = 1, slide = { x: 0, y: 0 }, zoomMul = 1) {
  const W = project.w, H = project.h;
  // see renderFrame: the context may already carry the preview's scale
  const opacity = clamp(valueAt(clip, "opacity", t) * alphaMul, 0, 1);
  if (opacity <= 0.001) return;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.filter = filterOf(clip);

  const x = valueAt(clip, "x", t), y = valueAt(clip, "y", t);
  const scale = valueAt(clip, "scale", t) * zoomMul;
  const rot = valueAt(clip, "rot", t);
  ctx.translate(W / 2 + x + slide.x * W, H / 2 + y + slide.y * H);
  ctx.rotate(rot * Math.PI / 180);
  ctx.scale(scale * (clip.flipH ? -1 : 1), scale * (clip.flipV ? -1 : 1));

  if (clip.kind === "text" || clip.kind === "sticker") {
    drawText(ctx, clip, W, H);
  } else {
    const raw = sources.get(clip.id);
    /* Chroma key and masks need the pixels, which a 2D context cannot reach.
       They happen off to the side and come back as something drawable. */
    const src = (raw && needsStage(clip) && stage(raw, clip)) || raw;
    if (src && (src.videoWidth || src.width)) {
      const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
      const { sx, sy, sw: cw, sh: ch } = sourceRect(clip, sw, sh);
      // fit the cropped source inside the frame, keeping its aspect
      const k = Math.min(W / cw, H / ch);
      const dw = cw * k, dh = ch * k;
      try { ctx.drawImage(src, sx, sy, cw, ch, -dw / 2, -dh / 2, dw, dh); } catch { /* frame not ready */ }
    }
  }
  ctx.restore();
}

function drawText(ctx, clip, W, H) {
  const size = clip.size || 64;
  ctx.font = `${clip.weight || 700} ${size}px ${clip.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = String(clip.text || "").split("\n");
  const lh = size * 1.2;
  const totalH = lh * lines.length;
  if (clip.bg) {
    const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
    ctx.fillStyle = clip.bg;
    ctx.fillRect(-widest / 2 - size * .3, -totalH / 2 - size * .16, widest + size * .6, totalH + size * .32);
  }
  lines.forEach((line, i) => {
    const ly = -totalH / 2 + lh * (i + .5);
    if (clip.stroke > 0) {
      ctx.lineWidth = clip.stroke;
      ctx.strokeStyle = clip.strokeColor;
      ctx.lineJoin = "round";
      ctx.strokeText(line, 0, ly);
    }
    ctx.fillStyle = clip.color;
    ctx.fillText(line, 0, ly);
  });
}

/* ------------------------------------------------------------
   Render the whole frame. `sources` maps clip id → something drawImage can
   take (a <video>, an ImageBitmap, a canvas). The caller decides how those
   are produced: live elements for preview, seeked frames for export.
   ------------------------------------------------------------ */
export function renderFrame(ctx, project, t, sources) {
  const W = project.w, H = project.h;
  /* The caller may have scaled the context — the preview composites at the
     size it is shown rather than at the project's resolution. So "reset the
     transform" means back to whatever the caller set, not to identity. */
  const base = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  const rebase = () => { if (base) ctx.setTransform(base); else ctx.setTransform(1, 0, 0, 1, 0, 0); };
  ctx.save();
  rebase();
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.fillStyle = project.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  for (const track of [...project.tracks].reverse()) {      // bottom track drawn first
    if (track.kind !== "video" || track.hidden) continue;
    const clip = clipAt(track, t);
    if (!clip) continue;
    const tr = transitionProgress(clip, t);
    if (!tr || tr.def.type === "none" || tr.def.type === "crossfade") {
      const alpha = tr ? clamp(tr.k, 0, 1) : 1;
      // the outgoing neighbour keeps playing underneath a crossfade
      if (tr && tr.def.type === "crossfade") {
        const other = track.clips.find(c => c !== clip &&
          (tr.edge === "in" ? Math.abs(clipEnd(c) - clip.start) < .001 : Math.abs(c.start - clipEnd(clip)) < .001));
        if (other) drawClip(ctx, project, other, t, sources, 1 - alpha);
      }
      drawClip(ctx, project, clip, t, sources, alpha);
    } else if (tr.def.type === "dip to black" || tr.def.type === "dip to white") {
      drawClip(ctx, project, clip, t, sources, 1);
      ctx.save();
      ctx.globalAlpha = clamp(1 - tr.k, 0, 1);
      ctx.fillStyle = tr.def.type === "dip to black" ? "#000" : "#fff";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    } else if (tr.def.type.startsWith("wipe")) {
      const k = clamp(tr.k, 0, 1);
      ctx.save();
      ctx.beginPath();
      const w = W * k;
      tr.def.type === "wipe left" ? ctx.rect(W - w, 0, w, H) : ctx.rect(0, 0, w, H);
      ctx.clip();
      drawClip(ctx, project, clip, t, sources, 1);
      ctx.restore();
    } else if (tr.def.type === "slide up") {
      drawClip(ctx, project, clip, t, sources, 1, { x: 0, y: (1 - clamp(tr.k, 0, 1)) });
    } else if (tr.def.type === "zoom") {
      const k = clamp(tr.k, 0, 1);
      drawClip(ctx, project, clip, t, sources, k, { x: 0, y: 0 }, .6 + .4 * k);
    } else {
      drawClip(ctx, project, clip, t, sources, 1);
    }
  }
}

/* which clips need a frame at time t, so the caller knows what to prepare */
export function visualClipsAt(project, t) {
  const out = [];
  for (const track of project.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    const c = clipAt(track, t);
    if (!c) continue;
    out.push(c);
    const tr = transitionProgress(c, t);
    if (tr?.def?.type === "crossfade") {
      const other = track.clips.find(x => x !== c &&
        (tr.edge === "in" ? Math.abs(clipEnd(x) - c.start) < .001 : Math.abs(x.start - clipEnd(c)) < .001));
      if (other) out.push(other);
    }
  }
  return out;
}

/* source time inside a media item for a clip at timeline time t */
export const sourceTime = (clip, t) => clip.in + (t - clip.start) * clip.speed;

export function audibleClipsAt(project, t) {
  const out = [];
  for (const track of project.tracks) {
    if (track.muted) continue;
    const c = clipAt(track, t);
    if (c && !c.muted && c.kind !== "text" && c.kind !== "sticker") out.push({ clip: c, track });
  }
  return out;
}

/* clip gain at time t, including its fades and any volume keyframes */
export function gainAt(clip, t) {
  let g = valueAt(clip, "volume", t);
  const into = t - clip.start, left = clipEnd(clip) - t;
  if (clip.fadeIn > 0) g *= clamp(into / clip.fadeIn, 0, 1);
  if (clip.fadeOut > 0) g *= clamp(left / clip.fadeOut, 0, 1);
  return clamp(g, 0, 4);
}

export { mediaOf };
