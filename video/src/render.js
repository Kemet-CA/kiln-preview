/* ============================================================
   Compositor — draws the state of the timeline at time t onto a 2D context.

   The preview and the exporter call the same function. That is the whole
   point: what you see while scrubbing is produced by the code that writes the
   file, so the export cannot drift away from the preview.
   ============================================================ */
import { clipAt, clipEnd, mediaOf, valueAt, clamp, transitionById, normaliseTransition } from "./model.js";
import { stage, needsStage } from "./keyer.js";

/* CSS filter string for a clip's colour correction */
export function filterOf(c, t = null) {
  // every effect group can be switched off without losing what was set
  if (!c.fxColor) return "none";
  // at a time, animated values win; without one, the plain settings
  const v = p => (t === null ? c[p] : valueAt(c, p, t));
  const f = [];
  const brightness = v("brightness"), contrast = v("contrast"), saturate = v("saturate");
  const hue = v("hue"), blur = v("blur");
  if (brightness !== 1) f.push(`brightness(${brightness})`);
  if (contrast !== 1) f.push(`contrast(${contrast})`);
  if (saturate !== 1) f.push(`saturate(${saturate})`);
  if (hue) f.push(`hue-rotate(${hue}deg)`);
  if (blur) f.push(`blur(${blur}px)`);
  if (c.sepia) f.push(`sepia(${c.sepia})`);
  if (c.grayscale) f.push(`grayscale(${c.grayscale})`);
  return f.join(" ") || "none";
}

/* how far a clip is into a transition at time t: 0 = not in one, 1 = fully across */
function transitionProgress(clip, t) {
  // normalise so a project saved with the old display names still plays
  const tin = normaliseTransition(clip.transIn), tout = normaliseTransition(clip.transOut);
  const inD = tin?.dur || 0, outD = tout?.dur || 0;
  if (inD && t < clip.start + inD) return { edge: "in", k: (t - clip.start) / inD, def: tin };
  if (outD && t > clipEnd(clip) - outD) return { edge: "out", k: (clipEnd(clip) - t) / outD, def: tout };
  return null;
}

/* source rectangle after cropping, in the media's own pixels */
function sourceRect(clip, sw, sh) {
  const { l, t, r, b } = clip.crop;
  const x = sw * l, y = sh * t;
  return { sx: x, sy: y, sw: Math.max(1, sw * (1 - l - r)), sh: Math.max(1, sh * (1 - t - b)) };
}

/* one visual clip, with its transform, colour and opacity applied */
function drawClip(ctx, project, clip, t, sources, alphaMul = 1, slide = { x: 0, y: 0 }, zoomMul = 1, extra = null) {
  const W = project.w, H = project.h;
  // see renderFrame: the context may already carry the preview's scale
  const opacity = clamp(valueAt(clip, "opacity", t) * alphaMul, 0, 1);
  if (opacity <= 0.001) return;

  ctx.save();
  ctx.globalAlpha = opacity;
  const base = filterOf(clip, t);
  ctx.filter = extra?.blur ? `${base === "none" ? "" : base + " "}blur(${extra.blur}px)`.trim() : base;

  const on = !!clip.fxTransform;
  const x = on ? valueAt(clip, "x", t) : 0, y = on ? valueAt(clip, "y", t) : 0;
  const scale = (on ? valueAt(clip, "scale", t) : 1) * zoomMul;
  const rot = on ? valueAt(clip, "rot", t) : 0;
  ctx.translate(W / 2 + x + slide.x * W, H / 2 + y + slide.y * H);
  ctx.rotate((rot + (extra?.rot || 0)) * Math.PI / 180);
  ctx.scale(scale * (on && clip.flipH ? -1 : 1), scale * (on && clip.flipV ? -1 : 1));

  if (clip.kind === "text" || clip.kind === "sticker") {
    drawText(ctx, clip, W, H, t);
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

function drawText(ctx, clip, W, H, t = null) {
  const size = (t === null ? clip.size : valueAt(clip, "size", t)) || 64;
  ctx.font = `${clip.weight || 700} ${size}px ${clip.font}`;
  const align = clip.align || "center";
  ctx.textAlign = align === "left" ? "left" : align === "right" ? "right" : "center";
  ctx.textBaseline = "middle";
  const lines = String(clip.text || "").split("\n");
  const lh = size * (clip.lineHeight || 1.2);
  const totalH = lh * lines.length;
  const widest = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
  // the box hugs the text, and the text sits inside it the way it is aligned
  const padX = size * (clip.pad ?? .3), padY = size * (clip.pad ?? .3) * .55;
  const x0 = align === "left" ? 0 : align === "right" ? 0 : 0;
  if (clip.bg) {
    const bx = align === "left" ? -padX : align === "right" ? -widest - padX : -widest / 2 - padX;
    ctx.fillStyle = clip.bg;
    ctx.fillRect(bx, -totalH / 2 - padY, widest + padX * 2, totalH + padY * 2);
  }
  lines.forEach((line, i) => {
    const ly = -totalH / 2 + lh * (i + .5);
    /* A drop shadow is what separates a title from whatever is behind it —
       without one, white text on a bright frame simply disappears. */
    if (clip.shadow > 0) {
      ctx.save();
      /* Chrome ignores shadowBlur while ctx.filter is set, and the compositor
         sets a filter on every clip for colour correction — so the shadow pass
         clears it. The shadow is black; not colour-correcting it changes
         nothing anyone can see. */
      ctx.filter = "none";
      ctx.shadowColor = "rgba(0,0,0,.75)";
      ctx.shadowBlur = clip.shadow;
      ctx.shadowOffsetY = clip.shadow * .25;
      ctx.fillStyle = clip.color;
      ctx.fillText(line, x0, ly);
      ctx.restore();
    }
    if (clip.stroke > 0) {
      ctx.lineWidth = clip.stroke;
      ctx.strokeStyle = clip.strokeColor;
      ctx.lineJoin = "round";
      ctx.strokeText(line, x0, ly);
    }
    ctx.fillStyle = clip.color;
    ctx.fillText(line, x0, ly);
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
    drawWithTransition(ctx, project, track, clip, t, sources, tr, W, H);
  }
}

/* ------------------------------------------------------------
   One clip, plus whatever its transition is doing to it. Every transition is
   one of a handful of primitives — the library in model.js only picks which
   and tunes it, so a new transition costs a row of data, not a branch here.
   ------------------------------------------------------------ */
function neighbourOf(track, clip, edge) {
  return track.clips.find(c => c !== clip &&
    (edge === "in" ? Math.abs(clipEnd(c) - clip.start) < .001
                   : Math.abs(c.start - clipEnd(clip)) < .001));
}

function drawWithTransition(ctx, project, track, clip, t, sources, tr, W, H) {
  const def = tr ? transitionById(tr.def.type) : null;
  if (!tr || !def || def.id === "none" || !def.kind) {
    drawClip(ctx, project, clip, t, sources, 1);
    return;
  }
  const k = clamp(tr.k, 0, 1);                 // 0 at the cut, 1 fully arrived
  const o = def.o || {};
  const under = () => {
    const other = neighbourOf(track, clip, tr.edge);
    if (other) drawClip(ctx, project, other, t, sources, 1);
  };

  switch (def.kind) {
    case "fade":
      under();
      drawClip(ctx, project, clip, t, sources, k);
      break;

    case "dip": {
      drawClip(ctx, project, clip, t, sources, 1);
      ctx.save();
      const sharp = o.sharp || 1;
      ctx.globalAlpha = clamp(Math.pow(1 - k, sharp), 0, 1);
      ctx.fillStyle = o.color || "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      break;
    }

    case "blur":
      under();
      drawClip(ctx, project, clip, t, sources, k, { x: 0, y: 0 }, 1,
        { blur: (1 - k) * (o.amount || 30) });
      break;

    case "wipe": {
      under();
      ctx.save();
      ctx.beginPath();
      const d = o.dir;
      if (d === "left") ctx.rect(W - W * k, 0, W * k, H);
      else if (d === "right") ctx.rect(0, 0, W * k, H);
      else if (d === "up") ctx.rect(0, H - H * k, W, H * k);
      else ctx.rect(0, 0, W, H * k);
      ctx.clip();
      drawClip(ctx, project, clip, t, sources, 1);
      ctx.restore();
      break;
    }

    case "iris": {
      under();
      const max = Math.hypot(W, H) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, max * (o.invert ? 1 - k : k), 0, Math.PI * 2);
      ctx.clip();
      drawClip(ctx, project, clip, t, sources, 1);
      ctx.restore();
      break;
    }

    case "box": {
      under();
      ctx.save();
      ctx.beginPath();
      ctx.rect(W / 2 - (W / 2) * k, H / 2 - (H / 2) * k, W * k, H * k);
      ctx.clip();
      drawClip(ctx, project, clip, t, sources, 1);
      ctx.restore();
      break;
    }

    case "split": {
      // two halves opening from the middle line
      under();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, H / 2 - (H / 2) * k, W, H * k);
      ctx.clip();
      drawClip(ctx, project, clip, t, sources, 1);
      ctx.restore();
      break;
    }

    case "slide":
      under();
      drawClip(ctx, project, clip, t, sources, 1,
        { x: (o.x || 0) * (1 - k), y: (o.y || 0) * (1 - k) });
      break;

    case "zoom": {
      under();
      const from = o.from ?? .6;
      const scale = from + (1 - from) * k;
      drawClip(ctx, project, clip, t, sources, o.fade === false ? 1 : k,
        { x: 0, y: 0 }, scale, o.blur ? { blur: (1 - k) * o.blur } : null);
      break;
    }

    case "spin": {
      under();
      const from = o.from ?? 1;
      drawClip(ctx, project, clip, t, sources, k, { x: 0, y: 0 },
        from + (1 - from) * k, { rot: (1 - k) * 360 * (o.turns || 1) });
      break;
    }

    case "shake": {
      /* A judder that settles. The two axes run at different frequencies and
         it pulses slightly, so there is no moment where the shake happens to
         be exactly nothing — a sine on its own crosses zero four times and the
         effect vanishes on those frames. */
      const amp = (1 - k) * .045;
      drawClip(ctx, project, clip, t, sources, 1,
        { x: amp * Math.sin(k * Math.PI * 9), y: amp * .6 * Math.cos(k * Math.PI * 7) },
        1 + (1 - k) * .03);
      break;
    }

    default:
      drawClip(ctx, project, clip, t, sources, 1);
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
    // anything that shows the neighbour underneath needs that neighbour ready
    const kind = tr ? transitionById(tr.def.type).kind : null;
    if (kind && kind !== "dip" && kind !== "shake") {
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
