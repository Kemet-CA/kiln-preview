/* ============================================================
   Kiln Video — stabilisation.

   Handheld footage moves in two ways at once: the shot the person meant, and
   the shake they could not help. Stabilising is separating them, and then
   cancelling the second one.

   How it works here:

     1  sample the clip at a low rate and a small size — shake is a whole-frame
        movement, and 160 px wide is plenty to measure it, while being ~80×
        cheaper than reading full frames
     2  estimate the shift between neighbouring samples by finding the offset
        with the smallest difference, coarse first and then refined
     3  add those up into the path the camera actually took
     4  smooth that path — what is left after subtracting the smooth version
        is the shake
     5  write the negative of it as x/y keyframes and zoom in slightly, so the
        empty edges the correction exposes stay out of frame

   The output is ordinary keyframes on the clip, which means the preview, the
   inspector and the exporter need to know nothing about any of this, and the
   user can see and hand-edit what it did.
   ============================================================ */

const W = 160, H = 90;                      // analysis size

const scratch = document.createElement("canvas");
scratch.width = W; scratch.height = H;
const sctx = scratch.getContext("2d", { willReadFrequently: true });

/* one frame as a small grey picture */
function grab(src) {
  sctx.drawImage(src, 0, 0, W, H);
  const d = sctx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0, p = 0; i < g.length; i++, p += 4)
    g[i] = d[p] * .2126 + d[p + 1] * .7152 + d[p + 2] * .0722;
  return g;
}

/* mean absolute difference between two frames at a given offset, over the
   part that overlaps — sampled every other pixel, which is as accurate here
   and four times quicker */
function sad(a, b, dx, dy, step = 2) {
  const x0 = Math.max(0, -dx), x1 = Math.min(W, W - dx);
  const y0 = Math.max(0, -dy), y1 = Math.min(H, H - dy);
  if (x1 - x0 < W / 3 || y1 - y0 < H / 3) return Infinity;
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += step) {
    const ra = y * W, rb = (y + dy) * W + dx;
    for (let x = x0; x < x1; x += step) {
      sum += Math.abs(a[ra + x] - b[rb + x]);
      n++;
    }
  }
  return n ? sum / n : Infinity;
}

/* the offset that lines b up with a: a coarse sweep, then a fine one around
   the winner. Exported because it is the one piece worth testing on its own. */
export function estimateShift(a, b, range = 12) {
  let best = { dx: 0, dy: 0, cost: Infinity };
  for (let dy = -range; dy <= range; dy += 2)
    for (let dx = -range; dx <= range; dx += 2) {
      const c = sad(a, b, dx, dy, 3);
      if (c < best.cost) best = { dx, dy, cost: c };
    }
  const c0 = { ...best };
  for (let dy = c0.dy - 2; dy <= c0.dy + 2; dy++)
    for (let dx = c0.dx - 2; dx <= c0.dx + 2; dx++) {
      const c = sad(a, b, dx, dy, 1);
      if (c < best.cost) best = { dx, dy, cost: c };
    }
  return { dx: best.dx, dy: best.dy };
}

const seek = (el, t) => new Promise(res => {
  if (Math.abs(el.currentTime - t) < .001) return res();
  const done = () => { el.removeEventListener("seeked", done); res(); };
  el.addEventListener("seeked", done);
  el.currentTime = t;
  setTimeout(done, 1200);                    // never hang on a stubborn decoder
});

/* a moving average is the smooth camera path — wide enough to lose the shake,
   narrow enough to keep a real pan */
function smoothPath(path, window) {
  const out = new Float32Array(path.length);
  const r = Math.max(1, Math.round(window / 2));
  for (let i = 0; i < path.length; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(path.length - 1, i + r); j++) { sum += path[j]; n++; }
    out[i] = sum / n;
  }
  return out;
}

/* ------------------------------------------------------------
   Measure a clip and return keyframes that cancel its shake.
   `media.el` must be a <video>; images and audio have nothing to stabilise.
   ------------------------------------------------------------ */
export async function analyse(media, clip, { fps = 10, onProgress } = {}) {
  const el = media.el;
  if (!el || media.kind !== "video") throw new Error("Only video clips can be stabilised");
  const wasPaused = el.paused, wasAt = el.currentTime;
  if (!wasPaused) el.pause();

  const span = Math.max(.2, clip.dur * (clip.speed || 1));
  const n = Math.max(2, Math.min(600, Math.round(span * fps)));
  const rawX = new Float32Array(n), rawY = new Float32Array(n);
  let prev = null, cx = 0, cy = 0;

  for (let i = 0; i < n; i++) {
    await seek(el, Math.min(media.dur - .01, (clip.in || 0) + (span * i) / (n - 1)));
    let frame;
    try { frame = grab(el); } catch { break; }
    if (prev) {
      const { dx, dy } = estimateShift(prev, frame);
      cx += dx; cy += dy;                    // the path the camera took
    }
    rawX[i] = cx; rawY[i] = cy;
    prev = frame;
    onProgress?.((i + 1) / n);
  }

  el.currentTime = wasAt;
  if (!wasPaused) el.play().catch(() => {});

  // half a second of smoothing keeps deliberate movement and drops the rest
  const win = Math.max(2, Math.round(fps * .6));
  const sx = smoothPath(rawX, win), sy = smoothPath(rawY, win);

  /* The measurements are in analysis pixels; the compositor works in project
     pixels. One analysis pixel is the whole frame divided by W. */
  const kx = (media.w || W) / W, ky = (media.h || H) / H;
  const keysX = [], keysY = [];
  let maxX = 0, maxY = 0;
  for (let i = 0; i < n; i++) {
    const ox = (sx[i] - rawX[i]) * kx, oy = (sy[i] - rawY[i]) * ky;
    maxX = Math.max(maxX, Math.abs(ox));
    maxY = Math.max(maxY, Math.abs(oy));
    const t = i / (n - 1);
    keysX.push({ t, v: (clip.x || 0) + ox });
    keysY.push({ t, v: (clip.y || 0) + oy });
  }
  // zoom just enough to cover the edges the shift exposes
  const zoom = Math.min(1.25, 1 + 2 * Math.max(maxX / (media.w || 1920), maxY / (media.h || 1080)));
  return { x: keysX, y: keysY, zoom, samples: n, shake: Math.round(Math.max(maxX, maxY)) };
}
