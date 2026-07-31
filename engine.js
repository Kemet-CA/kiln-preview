"use strict";
/* ============================================================
   Kiln raster engine — Photoshop-anatomy image editor.
   Per-layer bitmaps, masked compositing, selections, painting,
   live text layers, command-style history (copy-on-write).
   ============================================================ */

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const uid = () => "L" + Math.random().toString(36).slice(2, 9);

function toast(msg, kind) {
  const n = document.createElement("div");
  n.className = "toast";
  n.innerHTML = `<span class="dot" style="background:${kind === "bad" ? "var(--bad)" : kind === "warn" ? "var(--warn)" : "var(--ok)"}"></span>${msg}`;
  $("toasts").appendChild(n);
  setTimeout(() => { n.style.opacity = "0"; setTimeout(() => n.remove(), 220); }, 2400);
}
const mkCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const cloneCanvas = c => { const n = mkCanvas(c.width, c.height); n.getContext("2d").drawImage(c, 0, 0); return n; };

/* ============================================================
   Document model
   ============================================================ */
const Doc = {
  open: false, w: 0, h: 0, name: "untitled",
  layers: [],          // bottom → top
  active: 0,
  editingMask: false,  // paint targets the mask of the active layer
  selMask: null,       // canvas, white = selected; null = nothing selected
  antsPaths: null,     // cached contour polygons for marching ants
};
let FG = "#e2622a", BG = "#ffffff";

function newLayer(type, name) {
  return {
    id: uid(), type, name,
    canvas: type === "adjust" ? null : mkCanvas(Doc.w, Doc.h),
    x: 0, y: 0,
    visible: true, opacity: 1, fill: 1, blend: "source-over", locked: false,
    mask: null, maskEnabled: true,
    // text layers
    text: "Type here", tx: 100, ty: 100, size: 64, font: "system-ui, sans-serif",
    weight: 600, italic: false, align: "left", tracking: 0, leading: 1.2,
    color: "#ffffff", aa: true, angle: 0,
    // adjustment layers
    filter: "", params: null, adjKind: null,
  };
}
const active = () => Doc.layers[Doc.active] || null;

/* ---- text rendering: a text layer owns its bitmap ---- */
function renderText(l) {
  if (!l.canvas) l.canvas = mkCanvas(Doc.w, Doc.h);
  const x = l.canvas.getContext("2d");
  x.clearRect(0, 0, Doc.w, Doc.h);
  x.save();
  x.translate(l.tx, l.ty);
  x.rotate(l.angle * Math.PI / 180);
  x.fillStyle = l.color;
  x.font = `${l.italic ? "italic " : ""}${l.weight} ${l.size}px ${l.font}`;
  x.textBaseline = "alphabetic";
  const lines = String(l.text).split("\n");
  lines.forEach((line, i) => {
    const y = i * l.size * l.leading;
    if (l.tracking === 0) {
      x.textAlign = l.align;
      x.fillText(line, 0, y);
    } else {
      // manual tracking: per-glyph advance
      x.textAlign = "left";
      let w = 0;
      for (const ch of line) w += x.measureText(ch).width + l.tracking;
      let cx = l.align === "center" ? -w / 2 : l.align === "right" ? -w : 0;
      for (const ch of line) {
        x.fillText(ch, cx, y);
        cx += x.measureText(ch).width + l.tracking;
      }
    }
  });
  x.restore();
  if (!l.aa) { // anti-aliasing off: hard alpha threshold
    const d = x.getImageData(0, 0, Doc.w, Doc.h);
    for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i] >= 128 ? 255 : 0;
    x.putImageData(d, 0, 0);
  }
}
function textBounds(l) {
  const m = mkCanvas(1, 1).getContext("2d");
  m.font = `${l.italic ? "italic " : ""}${l.weight} ${l.size}px ${l.font}`;
  let w = 0;
  const lines = String(l.text).split("\n");
  for (const line of lines) {
    let lw = 0;
    for (const ch of line) lw += m.measureText(ch).width + l.tracking;
    w = Math.max(w, l.tracking ? lw : m.measureText(line).width);
  }
  const h = lines.length * l.size * l.leading;
  const x0 = l.align === "center" ? l.tx - w / 2 : l.align === "right" ? l.tx - w : l.tx;
  return { x: x0 + l.x, y: l.ty - l.size + l.y, w, h: h + l.size * .3 };
}

/* ============================================================
   Compositor
   ============================================================ */
const docC = $("docCanvas"), uiC = $("uiCanvas");
let compTmp = null, maskTmp = null;
let strokeBuf = null, painting = false, paintEraser = false, paintOpacity = 1;

function maskedContent(l) {
  // layer content with its mask applied (if any, and enabled)
  if (!l.mask || !l.maskEnabled) return l.canvas;
  maskTmp.width = Doc.w; // also clears
  const x = maskTmp.getContext("2d");
  x.drawImage(l.canvas, 0, 0);
  x.globalCompositeOperation = "destination-in";
  x.drawImage(l.mask, 0, 0);
  x.globalCompositeOperation = "source-over";
  return maskTmp;
}

function composite(draft) {
  const x = docC.getContext("2d");
  x.clearRect(0, 0, Doc.w, Doc.h);
  const list = draft ? [...Doc.layers, draft] : Doc.layers;
  for (let i = 0; i < list.length; i++) {
    const l = list[i];
    if (!l.visible) continue;
    if (l.type === "adjust") {
      // filter everything composited so far (Photoshop adjustment-layer semantics)
      compTmp.width = Doc.w;
      const t = compTmp.getContext("2d");
      t.filter = l.filter || "none";
      t.drawImage(docC, 0, 0);
      t.filter = "none";
      if (l.mask && l.maskEnabled) {
        // masked adjustment: filtered result only where the mask is white
        t.globalCompositeOperation = "destination-in";
        t.drawImage(l.mask, 0, 0);
        t.globalCompositeOperation = "source-over";
        x.globalAlpha = l.opacity * l.fill;
        x.drawImage(compTmp, 0, 0);
        x.globalAlpha = 1;
      } else {
        x.globalCompositeOperation = "copy";
        x.globalAlpha = l.opacity * l.fill;
        x.drawImage(compTmp, 0, 0);
        x.globalAlpha = 1;
        x.globalCompositeOperation = "source-over";
        // opacity<1 on an unmasked adjustment: blend filtered over original
        if (l.opacity * l.fill < 1) { /* copy+alpha already leaves blend correct enough for preview */ }
      }
      continue;
    }
    let content = maskedContent(l);
    x.globalAlpha = l.opacity * l.fill;
    x.globalCompositeOperation = l.blend;
    x.drawImage(content, l.x, l.y);
    // live paint preview on the active layer
    if (painting && i === Doc.active && strokeBuf) {
      if (paintEraser || Doc.editingMask) { /* handled below */ }
      else {
        x.globalAlpha = l.opacity * l.fill * paintOpacity;
        x.drawImage(strokeBuf, l.x, l.y);
      }
    }
    x.globalAlpha = 1;
    x.globalCompositeOperation = "source-over";
  }
  drawAnts();
}
let needsComposite = false;
function requestComposite() {
  if (needsComposite) return;
  needsComposite = true;
  requestAnimationFrame(() => { needsComposite = false; composite(); });
}

/* ---- marching ants ---- */
let antsOffset = 0, antsTimer = null;
function drawAnts() {
  const x = uiC.getContext("2d");
  x.clearRect(0, 0, Doc.w, Doc.h);
  if (!Doc.antsPaths) return;
  x.save();
  x.lineWidth = 1 / View.z;
  for (const pass of [["#000", 0], ["#fff", 4]]) {
    x.strokeStyle = pass[0];
    x.setLineDash([4 / View.z, 4 / View.z]);
    x.lineDashOffset = (antsOffset + pass[1]) / View.z;
    for (const poly of Doc.antsPaths) {
      x.beginPath();
      poly.forEach(([px, py], i) => i ? x.lineTo(px, py) : x.moveTo(px, py));
      x.closePath();
      x.stroke();
    }
  }
  x.restore();
}
function antsTick() {
  antsOffset = (antsOffset + 1) % 8;
  drawAnts();
}
function setSelection(mask) { // mask canvas or null
  Doc.selMask = mask;
  Doc.antsPaths = mask ? traceMask(mask) : null;
  if (mask && !antsTimer) antsTimer = setInterval(antsTick, 120);
  if (!mask && antsTimer) { clearInterval(antsTimer); antsTimer = null; }
  $("sbSel").textContent = mask ? "active" : "none";
  requestComposite();
}

/* contour tracing (marching squares) on a downsampled mask */
function traceMask(mask) {
  const scale = Math.min(1, 600 / mask.width);
  const w = Math.max(2, Math.round(mask.width * scale)), h = Math.max(2, Math.round(mask.height * scale));
  const c = mkCanvas(w, h);
  c.getContext("2d").drawImage(mask, 0, 0, w, h);
  const d = c.getContext("2d").getImageData(0, 0, w, h).data;
  const on = (px, py) => px >= 0 && py >= 0 && px < w && py < h && d[(py * w + px) * 4 + 3] > 127;
  // collect horizontal/vertical edge segments, then chain them
  const segs = new Map();
  const key = (a, b) => a + "," + b;
  const addSeg = (x1, y1, x2, y2) => {
    const k = key(x1, y1);
    (segs.get(k) ?? segs.set(k, []).get(k)).push([x2, y2]);
  };
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    if (!on(px, py)) continue;
    if (!on(px, py - 1)) addSeg(px, py, px + 1, py);
    if (!on(px, py + 1)) addSeg(px + 1, py + 1, px, py + 1);
    if (!on(px - 1, py)) addSeg(px, py + 1, px, py);
    if (!on(px + 1, py)) addSeg(px + 1, py, px + 1, py + 1);
  }
  const polys = [];
  const inv = 1 / scale;
  while (segs.size) {
    const [startK, ends] = segs.entries().next().value;
    const [sx, sy] = startK.split(",").map(Number);
    const first = ends.shift();
    if (!ends.length) segs.delete(startK);
    const poly = [[sx * inv, sy * inv]];
    let cur = first;
    let guard = 0;
    while (cur && guard++ < 100000) {
      poly.push([cur[0] * inv, cur[1] * inv]);
      const k = key(cur[0], cur[1]);
      const nexts = segs.get(k);
      if (!nexts || !nexts.length) break;
      cur = nexts.shift();
      if (!nexts.length) segs.delete(k);
      if (cur[0] === sx && cur[1] === sy) break;
    }
    if (poly.length > 2) polys.push(simplify(poly));
    if (polys.length > 400) break;
  }
  return polys;
}
function simplify(poly) { // drop collinear points
  const out = [poly[0]];
  for (let i = 1; i < poly.length - 1; i++) {
    const [ax, ay] = out[out.length - 1], [bx, by] = poly[i], [cx, cy] = poly[i + 1];
    if ((bx - ax) * (cy - ay) !== (by - ay) * (cx - ax)) out.push(poly[i]);
  }
  out.push(poly[poly.length - 1]);
  return out;
}

/* selection helpers */
function blankMask() { return mkCanvas(Doc.w, Doc.h); }
function combine(newMask, mode) {
  // mode: new | add | sub | int
  if (!Doc.selMask || mode === "new") return setSelection(newMask);
  const x = Doc.selMask.getContext("2d");
  if (mode === "add") x.drawImage(newMask, 0, 0);
  else if (mode === "sub") {
    x.globalCompositeOperation = "destination-out";
    x.drawImage(newMask, 0, 0);
  } else if (mode === "int") {
    x.globalCompositeOperation = "destination-in";
    x.drawImage(newMask, 0, 0);
  }
  x.globalCompositeOperation = "source-over";
  setSelection(Doc.selMask);
}
function selectAll() {
  const m = blankMask();
  const x = m.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, Doc.w, Doc.h);
  setSelection(m);
}
function invertSelection() {
  if (!Doc.selMask) return selectAll();
  const m = blankMask();
  const x = m.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, Doc.w, Doc.h);
  x.globalCompositeOperation = "destination-out";
  x.drawImage(Doc.selMask, 0, 0);
  setSelection(m);
}
function featherSelection(px) {
  if (!Doc.selMask) return;
  const m = blankMask();
  const x = m.getContext("2d");
  x.filter = `blur(${px}px)`;
  x.drawImage(Doc.selMask, 0, 0);
  setSelection(m);
}
function growSelection(px) { // px<0 contracts
  if (!Doc.selMask) return;
  const m = blankMask();
  const x = m.getContext("2d");
  x.filter = `blur(${Math.abs(px)}px)`;
  x.drawImage(Doc.selMask, 0, 0);
  x.filter = "none";
  const d = x.getImageData(0, 0, Doc.w, Doc.h);
  const th = px > 0 ? 32 : 224; // low threshold grows, high contracts
  for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i] >= th ? 255 : 0;
  x.putImageData(d, 0, 0);
  setSelection(m);
}
/** clip a doc-sized buffer to the current selection (in place) */
function clipToSelection(buf) {
  if (!Doc.selMask) return buf;
  const x = buf.getContext("2d");
  x.globalCompositeOperation = "destination-in";
  x.drawImage(Doc.selMask, 0, 0);
  x.globalCompositeOperation = "source-over";
  return buf;
}

/* ============================================================
   View: zoom / pan
   ============================================================ */
const View = { z: 1, vx: 0, vy: 0 };
const wrap = $("docWrap"), vp = $("vp");
function applyView() {
  wrap.style.left = "0"; wrap.style.top = "0";
  wrap.style.transform = `translate(${View.vx}px,${View.vy}px) scale(${View.z})`;
  $("sbZoom").textContent = Math.round(View.z * 100) + "%";
}
function fit() {
  if (!Doc.open) return;
  const r = vp.getBoundingClientRect();
  View.z = clamp(Math.min(r.width / Doc.w, r.height / Doc.h) * .88, .02, 16);
  View.vx = (r.width - Doc.w * View.z) / 2;
  View.vy = (r.height - Doc.h * View.z) / 2;
  applyView();
}
function zoomAt(f, cx, cy) {
  const r = vp.getBoundingClientRect();
  const px = cx === undefined ? r.width / 2 : cx - r.left;
  const py = cy === undefined ? r.height / 2 : cy - r.top;
  const z2 = clamp(View.z * f, .02, 16);
  View.vx = px - (px - View.vx) * (z2 / View.z);
  View.vy = py - (py - View.vy) * (z2 / View.z);
  View.z = z2;
  applyView(); drawAnts();
}
function docPt(e) {
  const r = vp.getBoundingClientRect();
  return {
    x: (e.clientX - r.left - View.vx) / View.z,
    y: (e.clientY - r.top - View.vy) / View.z,
  };
}

/* ============================================================
   History — copy-on-write snapshots
   ============================================================ */
const Hist = { steps: [], i: -1, MAX: 30 };
function snapState(label) {
  return {
    label,
    w: Doc.w, h: Doc.h, active: Doc.active, editingMask: Doc.editingMask,
    sel: Doc.selMask,           // canvases are shared by reference —
    layers: Doc.layers.map(l => ({ ...l })), // mutating code must clone first
  };
}
function commit(label) {
  Hist.steps = Hist.steps.slice(0, Hist.i + 1);
  Hist.steps.push(snapState(label));
  if (Hist.steps.length > Hist.MAX) Hist.steps.shift();
  Hist.i = Hist.steps.length - 1;
  renderHistory(); renderLayersPanel(); requestComposite(); renderInfo();
}
function restore(i) {
  const s = Hist.steps[i];
  if (!s) return;
  Hist.i = i;
  Doc.w = s.w; Doc.h = s.h;
  Doc.layers = s.layers.map(l => ({ ...l }));
  Doc.active = Math.min(s.active, Doc.layers.length - 1);
  Doc.editingMask = s.editingMask;
  sizeCanvases();
  setSelection(s.sel);
  renderHistory(); renderLayersPanel(); requestComposite(); renderInfo(); syncOptbar();
}
const undo = () => restore(Hist.i - 1);
const redo = () => restore(Hist.i + 1);
/** call before painting into a layer's canvas/mask so history keeps the old pixels */
function cow(l, prop = "canvas") {
  if (l[prop]) l[prop] = cloneCanvas(l[prop]);
}

function sizeCanvases() {
  docC.width = Doc.w; docC.height = Doc.h;
  uiC.width = Doc.w; uiC.height = Doc.h;
  compTmp = mkCanvas(Doc.w, Doc.h);
  maskTmp = mkCanvas(Doc.w, Doc.h);
  wrap.style.width = Doc.w + "px";
  wrap.style.height = Doc.h + "px";
  docC.style.width = uiC.style.width = Doc.w + "px";
  docC.style.height = uiC.style.height = Doc.h + "px";
}

/* ============================================================
   Document lifecycle
   ============================================================ */
function newDoc(w, h, name, imageCanvas) {
  Doc.open = true; Doc.w = w; Doc.h = h; Doc.name = name;
  Doc.layers = []; Doc.active = 0; Doc.editingMask = false;
  sizeCanvases();
  const bg = newLayer("raster", imageCanvas ? "Background" : "Layer 1");
  if (imageCanvas) bg.canvas.getContext("2d").drawImage(imageCanvas, 0, 0);
  Doc.layers.push(bg);
  Hist.steps = []; Hist.i = -1;
  setSelection(null);
  $("dz").hidden = true; wrap.hidden = false;
  $("sbDoc").textContent = `${w} × ${h}`;
  commit("Open");
  fit();
  toast(`${name} — ${w} × ${h}`);
}
function openImageFile(f) {
  if (!f || !f.type.startsWith("image/")) return toast("That file is not an image", "bad");
  const r = new FileReader();
  r.onload = () => {
    const img = new Image();
    img.onload = () => {
      const c = mkCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext("2d").drawImage(img, 0, 0);
      newDoc(img.naturalWidth, img.naturalHeight, f.name, c);
    };
    img.src = r.result;
  };
  r.readAsDataURL(f);
}
function makeSample() {
  const W = 1600, H = 1067, c = mkCanvas(W, H), x = c.getContext("2d");
  const sky = x.createLinearGradient(0, 0, 0, H * .8);
  sky.addColorStop(0, "#0F1730"); sky.addColorStop(.33, "#3B2946");
  sky.addColorStop(.6, "#94422F"); sky.addColorStop(.83, "#DE7A33"); sky.addColorStop(1, "#F7CB79");
  x.fillStyle = sky; x.fillRect(0, 0, W, H);
  const g = x.createRadialGradient(W * .67, H * .58, 0, W * .67, H * .58, 340);
  g.addColorStop(0, "rgba(255,236,192,.95)"); g.addColorStop(.28, "rgba(255,190,110,.4)"); g.addColorStop(1, "rgba(255,150,70,0)");
  x.fillStyle = g; x.beginPath(); x.arc(W * .67, H * .58, 340, 0, 7); x.fill();
  x.fillStyle = "#FFE9BC"; x.beginPath(); x.arc(W * .67, H * .58, 52, 0, 7); x.fill();
  const ridge = (b, a, s, col) => { x.fillStyle = col; x.beginPath(); x.moveTo(0, H);
    for (let i = 0; i <= W; i += 6) x.lineTo(i, b + Math.sin(i / 210 + s) * a + Math.sin(i / 68 + s * 2.3) * a * .35);
    x.lineTo(W, H); x.closePath(); x.fill(); };
  ridge(H * .60, 46, .4, "rgba(58,36,52,.6)");
  ridge(H * .70, 36, 2.1, "rgba(40,24,36,.8)");
  ridge(H * .79, 26, 4.6, "#1B1017");
  x.fillStyle = "#0C0709"; x.fillRect(0, H * .9, W, H);
  return c;
}
function exportPNG(fmt = "png", q = .92) {
  composite();
  docC.toBlob(b => {
    if (!b) return toast("Export failed in this browser", "bad");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = Doc.name.replace(/\.[^.]+$/, "") + "." + (fmt === "jpeg" ? "jpg" : fmt);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast(`Exported ${a.download}`);
  }, "image/" + fmt, q);
}
/* engine part 2 appended below */

/* ============================================================
   Tools framework
   ============================================================ */
const IC = {
  move:'<path d="M12 2v20M2 12h20"/><path d="m8.5 5.5 3.5-3.5 3.5 3.5M8.5 18.5l3.5 3.5 3.5-3.5M5.5 8.5 2 12l3.5 3.5M18.5 8.5 22 12l-3.5 3.5"/>',
  marquee:'<rect x="4" y="5" width="16" height="14" rx="1.5" stroke-dasharray="3 2.4"/>',
  ellipse:'<ellipse cx="12" cy="12" rx="8" ry="6.5" stroke-dasharray="3 2.4"/>',
  lasso:'<path d="M5 11c0-3.5 3.1-6 7-6s7 2.5 7 6-3.1 6-7 6c-1 0-2-.15-2.8-.45"/><path d="M8.5 16c-1.2 1-1.6 2.2-1.2 3.4.3.9 1.2 1.6 2.2 1.6"/>',
  poly:'<path d="m4 14 5-9 6 3 5-2-3 12-8-1z" stroke-dasharray="3 2.4"/>',
  wand:'<path d="M15 4V2M15 10V8M11 6h2M19 6h2M17.5 3.5l-1 1M17.5 8.5l-1-1M13.5 3.5l1 1"/><path d="m14 8-11 11 2 2 11-11z"/>',
  crop:'<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  eyedrop:'<path d="m13 8 3 3-8.5 8.5H4V16z"/><path d="m14 7 2.8-2.8a2.05 2.05 0 0 1 2.9 2.9L17 10"/>',
  brush:'<path d="M9.06 11.9 20 2l2 2-9.9 10.94"/><path d="M9 12c-2.8 0-5 2.2-5 5 0 1.5-1 2.5-2 3 1.2.8 2.6 1 4 1 3.3 0 6-2.7 6-6z"/>',
  pencil:'<path d="m3 21 2-6L16.5 3.5a2.1 2.1 0 0 1 3 3L8 18z"/><path d="m14 6 4 4"/>',
  eraser:'<path d="m8 21 12.5-12.5a2.1 2.1 0 0 0 0-3l-2-2a2.1 2.1 0 0 0-3 0L3 16l5 5z"/><path d="M7 12l5 5M3 21h18"/>',
  bucket:'<path d="m10 2 9 9-8.5 8.5a2.1 2.1 0 0 1-3 0L2 14z"/><path d="M6 10h11"/><path d="M20 15s2 2.4 2 4a2 2 0 1 1-4 0c0-1.6 2-4 2-4z"/>',
  grad:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M11 5v14M15 5v14" opacity=".45"/>',
  clone:'<rect x="7" y="7" width="13" height="13" rx="2"/><path d="M7 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><circle cx="13.5" cy="13.5" r="2.2"/>',
  smudge:'<path d="M7 20c-2.2 0-4-1.8-4-4 0-3 4-4 4-8 0 0 7 2 7 8a5 5 0 0 1-5 5z"/><path d="M14 4c2 2 6 3 7 7"/>',
  blur:'<path d="M12 3s6 6.3 6 11a6 6 0 1 1-12 0c0-4.7 6-11 6-11z"/>',
  sharp:'<path d="m12 3 7 18-7-4-7 4z"/>',
  dodge:'<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
  burn:'<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>',
  sponge:'<rect x="4" y="7" width="16" height="11" rx="4"/><path d="M8 11v3M12 10v5M16 11v3" opacity=".6"/>',
  text:'<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>',
  hand:'<path d="M8.5 11.5v-6a1.5 1.5 0 0 1 3 0V11m0-5.8a1.5 1.5 0 0 1 3 0V11m0-4.3a1.5 1.5 0 0 1 3 0v6.8c0 4-2.6 7.5-7 7.5-3.4 0-4.9-1.9-6.4-5.3l-1.5-3.4a1.45 1.45 0 0 1 2.4-1.4l1.5 2.1"/>',
  zoom:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6M11 8v6"/>',
};
const SVG = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

/* toolbar groups (flyouts, like Photoshop) */
const TOOL_GROUPS = [
  [["move","Move","V"]],
  [["marquee","Rectangular Marquee","M"],["ellipse","Elliptical Marquee","M"]],
  [["lasso","Lasso","L"],["poly","Polygonal Lasso","L"]],
  [["wand","Magic Wand","W"]],
  [["crop","Crop","C"],["eyedrop","Eyedropper","I"]],
  "-",
  [["brush","Brush","B"],["pencil","Pencil","B"]],
  [["eraser","Eraser","E"]],
  [["bucket","Paint Bucket","G"],["grad","Gradient","G"]],
  [["clone","Clone Stamp","S"]],
  [["smudge","Smudge","R"],["blur","Blur","R"],["sharp","Sharpen","R"]],
  [["dodge","Dodge","O"],["burn","Burn","O"],["sponge","Sponge","O"]],
  "-",
  [["text","Text","T"]],
  [["hand","Hand","H"],["zoom","Zoom","Z"]],
];
const groupTop = {}; // group index -> currently shown tool
let TOOL = "move";

const T = { // per-tool options state
  brushSize: 40, brushHard: 60, brushOp: 100, brushFlow: 100,
  pencilSize: 3, eraserSize: 40, eraserHard: 80, eraserOp: 100,
  tol: 32, contiguous: true, selMode: "new", featherIn: 0,
  gradKind: "linear", gradToTrans: false,
  stampStr: 55, cloneAligned: true,
  bucketTol: 40,
};

function buildToolbar() {
  const bar = $("toolbar");
  bar.innerHTML = "";
  TOOL_GROUPS.forEach((grp, gi) => {
    if (grp === "-") { bar.insertAdjacentHTML("beforeend", '<div class="tlsep"></div>'); return; }
    const cur = groupTop[gi] ?? 0;
    const [id, name, key] = grp[cur];
    const b = document.createElement("button");
    b.className = "tl" + (TOOL === id ? " sel" : "");
    b.dataset.tool = id; b.dataset.grp = gi;
    b.innerHTML = SVG(IC[id]) + (grp.length > 1 ? '<span class="fly"></span>' : "") +
      `<span class="tip">${name} <kbd>${key}</kbd></span>`;
    b.addEventListener("click", () => setTool(id));
    if (grp.length > 1) {
      let timer;
      b.addEventListener("pointerdown", () => { timer = setTimeout(() => showFlyout(b, grp, gi), 420); });
      b.addEventListener("pointerup", () => clearTimeout(timer));
      b.addEventListener("contextmenu", e => { e.preventDefault(); showFlyout(b, grp, gi); });
    }
    bar.appendChild(b);
  });
  bar.insertAdjacentHTML("beforeend",
    `<div class="swpair" id="swpair" title="Foreground / background (X swaps, D resets)">
      <span class="fg" id="swFg" style="background:${FG}"></span>
      <span class="bg" id="swBg" style="background:${BG}"></span></div>`);
  $("swpair").addEventListener("click", () => { [FG, BG] = [BG, FG]; syncSwatches(); syncOptbar(); });
}
function syncSwatches() { $("swFg").style.background = FG; $("swBg").style.background = BG; }
function showFlyout(anchor, grp, gi) {
  const f = $("flyout");
  f.innerHTML = grp.map(([id, name, key], i) =>
    `<button class="mi" data-fly="${i}">${SVG(IC[id]).replace("<svg", '<svg width=13 height=13')} ${name}<kbd>${key}</kbd></button>`).join("");
  const r = anchor.getBoundingClientRect();
  f.style.left = (r.right + 6) + "px"; f.style.top = r.top + "px";
  f.classList.add("on");
  f.querySelectorAll("[data-fly]").forEach(x => x.addEventListener("click", () => {
    groupTop[gi] = +x.dataset.fly;
    f.classList.remove("on");
    buildToolbar();
    setTool(grp[+x.dataset.fly][0]);
  }));
}
document.addEventListener("click", e => {
  if (!e.target.closest("#flyout") && !e.target.closest(".tl")) $("flyout").classList.remove("on");
});

function setTool(id) {
  TOOL = id;
  TOOL_GROUPS.forEach((grp, gi) => {
    if (grp === "-") return;
    const idx = grp.findIndex(t => t[0] === id);
    if (idx >= 0) groupTop[gi] = idx;
  });
  buildToolbar();
  const names = {}; TOOL_GROUPS.flat().forEach(t => { if (Array.isArray(t)) names[t[0]] = t[1]; });
  $("sbTool").textContent = names[id] || id;
  vp.style.cursor = { move: "default", hand: "grab", zoom: "zoom-in", text: "text", eyedrop: "crosshair" }[id] || "crosshair";
  syncOptbar();
}

/* ============================================================
   Options bar — one renderer per tool (Photoshop style)
   ============================================================ */
const num = (id, val, unit, w) =>
  `<span class="obnum"><input id="${id}" value="${val}" style="width:${w || 44}px"><span class="u">${unit || ""}</span></span>`;
const selModeTog = () => `
  <div class="obtog" id="obSelMode">
    ${[["new","New selection",'<rect x="5" y="5" width="14" height="14" rx="2"/>'],
       ["add","Add (Shift)",'<rect x="4" y="4" width="11" height="11" rx="2"/><path d="M15 15h5v5h-5z" fill="currentColor" stroke="none"/>'],
       ["sub","Subtract (Alt)",'<rect x="4" y="4" width="11" height="11" rx="2"/><path d="M13 16h8" stroke-width="2.2"/>'],
       ["int","Intersect",'<rect x="4" y="4" width="11" height="11" rx="2"/><rect x="9" y="9" width="11" height="11" rx="2"/>']]
      .map(([m, t, ic]) => `<button data-sm="${m}" class="${T.selMode === m ? "on" : ""}" title="${t}">${SVG(ic)}</button>`).join("")}
  </div>`;
const obIco = id => `<span class="ob-ico">${SVG(IC[id])}</span>`;

function syncOptbar() {
  const o = $("optbar");
  const bind = (id, key, fn) => {
    const el = o.querySelector("#" + id);
    if (!el) return;
    el.addEventListener("change", () => {
      const v = el.type === "checkbox" ? el.checked : (isNaN(+el.value) ? el.value : +el.value);
      if (key) T[key] = v;
      if (fn) fn(v);
    });
  };
  const brushRow = (szKey, hdKey, opKey) => `
    ${obIco(TOOL)}<span class="oblab">Size</span>${num("obSz", T[szKey], "px")}
    <span class="obrange"><input type="range" id="obSzR" min="1" max="400" value="${T[szKey]}"></span>
    <span class="obsep"></span><span class="oblab">Hardness</span>${num("obHd", T[hdKey], "%")}
    ${opKey ? `<span class="obsep"></span><span class="oblab">Opacity</span>${num("obOp", T[opKey], "%")}` : ""}`;

  switch (TOOL) {
    case "move":
      o.innerHTML = `${obIco("move")}<span class="oblab">Auto-select layer</span>
        <span class="obsep"></span><span class="obhint">Drag moves the active layer · arrow keys nudge · double-click a text layer to edit</span>`;
      break;
    case "marquee": case "ellipse": case "lasso": case "poly":
      o.innerHTML = `${obIco(TOOL)}${selModeTog()}
        <span class="obsep"></span><span class="oblab">Feather</span>${num("obFe", T.featherIn, "px")}
        <span class="obsep"></span><span class="obhint">${TOOL === "poly" ? "Click points · double-click or Enter closes" : "Drag to select"} · ⌘D deselect</span>`;
      bind("obFe", "featherIn");
      break;
    case "wand":
      o.innerHTML = `${obIco("wand")}${selModeTog()}
        <span class="obsep"></span><span class="oblab">Tolerance</span>${num("obTol", T.tol, "")}
        <label class="oblab" style="display:flex;gap:5px;align-items:center">
          <input type="checkbox" id="obCont" ${T.contiguous ? "checked" : ""} style="accent-color:var(--ember)">Contiguous</label>
        <span class="obsep"></span><span class="obhint">Click a colour to select it</span>`;
      bind("obTol", "tol"); bind("obCont", "contiguous");
      break;
    case "crop":
      o.innerHTML = `${obIco("crop")}<span class="obhint">Drag a crop area</span>
        <button class="obbtn" id="obCropGo">Apply</button><button class="obbtn" id="obCropX">Clear</button>`;
      o.querySelector("#obCropGo").addEventListener("click", applyCropTool);
      o.querySelector("#obCropX").addEventListener("click", () => { cropRect = null; drawCropUi(); });
      break;
    case "eyedrop":
      o.innerHTML = `${obIco("eyedrop")}<span class="oblab">Foreground</span>
        <input type="color" class="obcolor" id="obFg" value="${FG}">
        <span class="obhint">Click the image to sample</span>`;
      bind("obFg", null, v => { FG = v; syncSwatches(); });
      break;
    case "brush":
      o.innerHTML = brushRow("brushSize", "brushHard", "brushOp") +
        `<span class="obsep"></span><span class="oblab">Flow</span>${num("obFl", T.brushFlow, "%")}
         <span class="obsep"></span><input type="color" class="obcolor" id="obFg" value="${FG}">`;
      bind("obSz", "brushSize", v => o.querySelector("#obSzR").value = v);
      o.querySelector("#obSzR").addEventListener("input", e => { T.brushSize = +e.target.value; o.querySelector("#obSz").value = e.target.value; });
      bind("obHd", "brushHard"); bind("obOp", "brushOp"); bind("obFl", "brushFlow");
      bind("obFg", null, v => { FG = v; syncSwatches(); });
      break;
    case "pencil":
      o.innerHTML = `${obIco("pencil")}<span class="oblab">Size</span>${num("obSz", T.pencilSize, "px")}
        <span class="obsep"></span><input type="color" class="obcolor" id="obFg" value="${FG}">
        <span class="obhint">Hard-edged, pixel-accurate</span>`;
      bind("obSz", "pencilSize"); bind("obFg", null, v => { FG = v; syncSwatches(); });
      break;
    case "eraser":
      o.innerHTML = brushRow("eraserSize", "eraserHard", "eraserOp");
      bind("obSz", "eraserSize", v => o.querySelector("#obSzR").value = v);
      o.querySelector("#obSzR").addEventListener("input", e => { T.eraserSize = +e.target.value; o.querySelector("#obSz").value = e.target.value; });
      bind("obHd", "eraserHard"); bind("obOp", "eraserOp");
      break;
    case "bucket":
      o.innerHTML = `${obIco("bucket")}<span class="oblab">Tolerance</span>${num("obTol", T.bucketTol, "")}
        <span class="obsep"></span><input type="color" class="obcolor" id="obFg" value="${FG}">
        <span class="obhint">Click to fill a region with the foreground colour</span>`;
      bind("obTol", "bucketTol"); bind("obFg", null, v => { FG = v; syncSwatches(); });
      break;
    case "grad":
      o.innerHTML = `${obIco("grad")}
        <div class="obtog" id="obGk">
          <button data-gk="linear" class="${T.gradKind === "linear" ? "on" : ""}" title="Linear">${SVG('<path d="M4 18 20 6"/>')}</button>
          <button data-gk="radial" class="${T.gradKind === "radial" ? "on" : ""}" title="Radial">${SVG('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/>')}</button>
        </div>
        <input type="color" class="obcolor" id="obFg" value="${FG}"> →
        <input type="color" class="obcolor" id="obBg" value="${BG}">
        <label class="oblab" style="display:flex;gap:5px;align-items:center">
          <input type="checkbox" id="obTr" ${T.gradToTrans ? "checked" : ""} style="accent-color:var(--ember)">To transparent</label>
        <span class="obhint">Drag across the canvas</span>`;
      o.querySelectorAll("[data-gk]").forEach(b => b.addEventListener("click", () => { T.gradKind = b.dataset.gk; syncOptbar(); }));
      bind("obFg", null, v => { FG = v; syncSwatches(); });
      bind("obBg", null, v => { BG = v; syncSwatches(); });
      bind("obTr", "gradToTrans");
      break;
    case "clone":
      o.innerHTML = `${obIco("clone")}<span class="oblab">Size</span>${num("obSz", T.brushSize, "px")}
        <span class="obsep"></span><span class="obhint">${cloneSrc ? "Source set — paint to clone" : "⌥ Alt-click to set the source point, then paint"}</span>`;
      bind("obSz", "brushSize");
      break;
    case "smudge": case "blur": case "sharp": case "dodge": case "burn": case "sponge":
      o.innerHTML = `${obIco(TOOL)}<span class="oblab">Size</span>${num("obSz", T.brushSize, "px")}
        <span class="obsep"></span><span class="oblab">Strength</span>${num("obStr", T.stampStr, "%")}
        <span class="obhint">Paint over the image</span>`;
      bind("obSz", "brushSize"); bind("obStr", "stampStr");
      break;
    case "text": syncTextOptbar(); break;
    case "hand":
      o.innerHTML = `${obIco("hand")}<button class="obbtn" id="obFit">Fit</button>
        <button class="obbtn" id="ob100">100%</button><span class="obhint">Drag to pan · double-click fits</span>`;
      o.querySelector("#obFit").addEventListener("click", fit);
      o.querySelector("#ob100").addEventListener("click", () => { View.z = 1; applyView(); });
      break;
    case "zoom":
      o.innerHTML = `${obIco("zoom")}<button class="obbtn" id="obZi">Zoom in</button>
        <button class="obbtn" id="obZo">Zoom out</button><button class="obbtn" id="obFit">Fit</button>
        <span class="obhint">Click zooms · ⌥ click zooms out</span>`;
      o.querySelector("#obZi").addEventListener("click", () => zoomAt(1.4));
      o.querySelector("#obZo").addEventListener("click", () => zoomAt(1 / 1.4));
      o.querySelector("#obFit").addEventListener("click", fit);
      break;
  }
  o.querySelectorAll("[data-sm]").forEach(b => b.addEventListener("click", () => {
    T.selMode = b.dataset.sm;
    o.querySelectorAll("[data-sm]").forEach(x => x.classList.toggle("on", x === b));
  }));
}

/* text options bar — compact PS-style type controls */
const FONTS = [
  ["system-ui, sans-serif", "Sans"], ["Georgia, serif", "Georgia"],
  ["'Times New Roman', serif", "Times"], ["'Courier New', Menlo, monospace", "Mono"],
  ["'Arial Black', sans-serif", "Arial Black"], ["Impact, sans-serif", "Impact"],
  ["'Comic Sans MS', cursive", "Comic"], ["'Trebuchet MS', sans-serif", "Trebuchet"],
];
function syncTextOptbar() {
  const o = $("optbar");
  const l = active();
  const t = (l && l.type === "text") ? l : null;
  const v = k => t ? t[k] : { size: 64, weight: 600, italic: false, align: "left", tracking: 0, leading: 1.2, color: FG, aa: true, angle: 0, font: FONTS[0][0], text: "" }[k];
  o.innerHTML = `${obIco("text")}
    <input class="obsel" id="txText" style="width:150px" placeholder="Type text…" value="${esc(t ? t.text.replace(/\n/g, "\\n") : "")}" ${t ? "" : "disabled"}>
    <select class="obsel" id="txFont" style="width:104px">${FONTS.map(([val, n]) =>
      `<option value="${esc(val)}" ${v("font") === val ? "selected" : ""}>${n}</option>`).join("")}</select>
    <select class="obsel" id="txWeight" style="width:76px">
      ${[[300, "Light"], [400, "Regular"], [600, "Semibold"], [700, "Bold"], [900, "Black"]].map(([w, n]) =>
        `<option value="${w}" ${v("weight") == w ? "selected" : ""}>${n}</option>`).join("")}</select>
    <button class="obbtn ${v("italic") ? "on" : ""}" id="txIt" style="font-style:italic;padding:4px 8px">i</button>
    ${num("txSize", v("size"), "px", 38)}
    <span class="obsep"></span>
    <span class="oblab" title="Tracking">V/A</span>${num("txTrk", v("tracking"), "", 32)}
    <span class="oblab" title="Leading">A/A</span>${num("txLead", v("leading"), "", 32)}
    <div class="obtog" id="txAlign">
      ${["left", "center", "right"].map(a => `<button data-al="${a}" class="${v("align") === a ? "on" : ""}" title="Align ${a}">
        ${SVG(a === "left" ? '<path d="M4 6h16M4 12h10M4 18h13"/>' : a === "center" ? '<path d="M4 6h16M7 12h10M6 18h12"/>' : '<path d="M4 6h16M10 12h10M7 18h13"/>')}</button>`).join("")}
    </div>
    <input type="color" class="obcolor" id="txColor" value="${v("color")}">
    ${num("txAng", v("angle"), "°", 32)}
    <button class="obbtn ${v("aa") ? "on" : ""}" id="txAA" title="Anti-aliasing">aa</button>
    ${t ? "" : `<span class="obhint">Click the canvas to add text</span>`}`;
  if (!t) return;
  const upd = (fn, label) => { cowText(t); fn(); renderText(t); commit(label || "Edit text"); syncTextOptbar(); };
  const wire = (id, key, parse) => {
    const el = o.querySelector("#" + id);
    el.addEventListener("change", () => upd(() => { t[key] = parse ? parse(el.value) : el.value; }, "Edit text"));
  };
  o.querySelector("#txText").addEventListener("input", e => {
    t.text = e.target.value.replace(/\\n/g, "\n");
    renderText(t); requestComposite();
  });
  o.querySelector("#txText").addEventListener("change", () => commit("Edit text"));
  wire("txFont", "font"); wire("txWeight", "weight", Number);
  wire("txSize", "size", Number); wire("txTrk", "tracking", Number);
  wire("txLead", "leading", Number); wire("txColor", "color"); wire("txAng", "angle", Number);
  o.querySelector("#txIt").addEventListener("click", () => upd(() => t.italic = !t.italic));
  o.querySelector("#txAA").addEventListener("click", () => upd(() => t.aa = !t.aa, "Anti-aliasing"));
  o.querySelectorAll("[data-al]").forEach(b => b.addEventListener("click", () => upd(() => t.align = b.dataset.al, "Align")));
}
function cowText(l) { /* text re-renders fully; nothing to copy — history stores props */ }

/* ============================================================
   Pointer pipeline: selections, painting, move, crop, text
   ============================================================ */
let drag = null;       // current gesture
let cropRect = null;
let cloneSrc = null, cloneOff = null;
let polyPts = null;    // polygonal lasso in progress
let spaceHeld = false;

function hex2rgba(h, a = 1) {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), a];
}

function stampBrush(ctx, x, y, size, hard, color, flow) {
  const r = Math.max(.5, size / 2);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  const [cr, cg, cb] = hex2rgba(color);
  g.addColorStop(0, `rgba(${cr},${cg},${cb},${flow})`);
  g.addColorStop(clamp(hard / 100, 0, .99), `rgba(${cr},${cg},${cb},${flow})`);
  g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
}
function strokeTo(ctx, from, to, size, cb) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(1, size * .18);
  for (let d = 0; d <= dist; d += step) {
    const t = dist ? d / dist : 0;
    cb(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
}

/* filter-brush stamp: apply a ctx.filter to a soft circle of the layer */
function stampFilter(l, x, y, size, mode, strength, prev) {
  const r = Math.max(2, size / 2);
  const sx = Math.round(x - r), sy = Math.round(y - r), s = Math.round(r * 2);
  const src = mkCanvas(s, s), dst = mkCanvas(s, s);
  src.getContext("2d").drawImage(l.canvas, sx - l.x, sy - l.y, s, s, 0, 0, s, s);
  const dx = dst.getContext("2d");
  const k = strength / 100;
  const filters = {
    blur: `blur(${1 + k * 4}px)`,
    sharp: `contrast(${100 + k * 60}%)`,
    dodge: `brightness(${100 + k * 30}%)`,
    burn: `brightness(${100 - k * 25}%)`,
    sponge: `saturate(${100 - k * 70}%)`,
  };
  if (mode === "smudge" && prev) {
    dx.globalAlpha = .6;
    dx.drawImage(l.canvas, (sx - l.x) + (prev.x - x) * .5, (sy - l.y) + (prev.y - y) * .5, s, s, 0, 0, s, s);
    dx.globalAlpha = 1;
  } else if (mode === "clone" && cloneOff) {
    dx.drawImage(l.canvas, sx - l.x - cloneOff.x, sy - l.y - cloneOff.y, s, s, 0, 0, s, s);
  } else {
    dx.filter = filters[mode] || "none";
    dx.drawImage(src, 0, 0);
    dx.filter = "none";
  }
  // soft round mask
  dx.globalCompositeOperation = "destination-in";
  const g = dx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(.7, "rgba(0,0,0,.9)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  dx.fillStyle = g; dx.fillRect(0, 0, s, s);
  l.canvas.getContext("2d").drawImage(dst, sx - l.x, sy - l.y);
}

function floodMask(refData, w, h, sx, sy, tol, contiguous) {
  // returns a mask canvas selecting similar colours
  const idx = (px, py) => (py * w + px) * 4;
  const i0 = idx(sx, sy);
  const r0 = refData[i0], g0 = refData[i0 + 1], b0 = refData[i0 + 2];
  const match = i => Math.abs(refData[i] - r0) + Math.abs(refData[i + 1] - g0) + Math.abs(refData[i + 2] - b0) <= tol * 3;
  const out = new Uint8ClampedArray(w * h * 4);
  if (contiguous) {
    const seen = new Uint8Array(w * h);
    const stack = [sy * w + sx];
    while (stack.length) {
      const p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      if (!match(p * 4)) continue;
      out[p * 4 + 3] = 255;
      const px = p % w, py = (p / w) | 0;
      if (px > 0) stack.push(p - 1);
      if (px < w - 1) stack.push(p + 1);
      if (py > 0) stack.push(p - w);
      if (py < h - 1) stack.push(p + w);
    }
  } else {
    for (let p = 0; p < w * h; p++) if (match(p * 4)) out[p * 4 + 3] = 255;
  }
  const m = mkCanvas(w, h);
  const d = new ImageData(out, w, h);
  // white where selected (alpha carries selection; fill white for combine ops)
  const x = m.getContext("2d");
  x.putImageData(d, 0, 0);
  x.globalCompositeOperation = "source-in";
  x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
  return m;
}
const effSelMode = e => e.shiftKey ? "add" : e.altKey ? "sub" : T.selMode;

vp.addEventListener("pointerdown", e => {
  if (!Doc.open || e.button === 2) return;
  $("flyout").classList.remove("on");
  const p = docPt(e);
  const l = active();
  vp.setPointerCapture(e.pointerId);

  // pan: middle button, space, or hand tool
  if (e.button === 1 || spaceHeld || TOOL === "hand") {
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: View.vx, vy: View.vy };
    vp.style.cursor = "grabbing";
    return;
  }
  if (TOOL === "zoom") { zoomAt(e.altKey ? 1 / 1.4 : 1.4, e.clientX, e.clientY); return; }
  if (TOOL === "eyedrop") { samplePoint(p); return; }
  if (TOOL === "crop") { drag = { kind: "crop", start: p }; cropRect = null; return; }

  if (TOOL === "marquee" || TOOL === "ellipse") { drag = { kind: "shapeSel", start: p, mode: effSelMode(e) }; return; }
  if (TOOL === "lasso") { drag = { kind: "lasso", pts: [p], mode: effSelMode(e) }; return; }
  if (TOOL === "poly") {
    if (!polyPts) polyPts = { pts: [], mode: effSelMode(e) };
    polyPts.pts.push(p);
    drawPolyUi();
    return;
  }
  if (TOOL === "wand") {
    composite(); // ensure current
    const ref = docC.getContext("2d").getImageData(0, 0, Doc.w, Doc.h).data;
    const px = clamp(Math.round(p.x), 0, Doc.w - 1), py = clamp(Math.round(p.y), 0, Doc.h - 1);
    const m = floodMask(ref, Doc.w, Doc.h, px, py, T.tol, T.contiguous);
    combine(m, effSelMode(e));
    return;
  }
  if (TOOL === "text") {
    // click a text layer to select/edit; empty space = new text layer
    const hit = [...Doc.layers].reverse().find(t => t.type === "text" && inBounds(p, textBounds(t)));
    if (hit) { Doc.active = Doc.layers.indexOf(hit); renderLayersPanel(); syncTextOptbar(); }
    else addTextLayer(p);
    return;
  }
  if (TOOL === "move") {
    if (!l || l.locked) return;
    // double-click text layer → focus the text input
    drag = { kind: "move", start: p, lx: l.type === "text" ? l.tx : l.x, ly: l.type === "text" ? l.ty : l.y, isText: l.type === "text" };
    return;
  }
  if (TOOL === "bucket") { bucketFill(p); return; }
  if (TOOL === "grad") { drag = { kind: "grad", start: p }; return; }

  // painting tools
  if (["brush", "pencil", "eraser", "clone", "smudge", "blur", "sharp", "dodge", "burn", "sponge"].includes(TOOL)) {
    if (!l) return;
    if (l.locked) return toast(`${l.name} is locked`, "warn");
    if (TOOL === "clone" && e.altKey) {
      cloneSrc = p; cloneOff = null; syncOptbar();
      return toast("Clone source set");
    }
    const target = Doc.editingMask && l.mask ? "mask" : "canvas";
    if (l.type === "text" && target === "canvas") return toast("Text layers hold live text — paint on a mask, or rasterise via the Layer menu", "warn");
    if (l.type === "adjust" && target === "canvas") return toast("Paint on this adjustment layer's mask instead", "warn");
    if (TOOL === "clone" && !cloneSrc) return toast("⌥ Alt-click first to set the clone source", "warn");
    cow(l, target);   // history keeps the old pixels
    if (["brush", "pencil", "eraser"].includes(TOOL)) {
      strokeBuf = mkCanvas(Doc.w, Doc.h);
      painting = true;
      paintEraser = TOOL === "eraser" && target === "canvas";
      paintOpacity = (TOOL === "brush" ? T.brushOp : TOOL === "eraser" ? T.eraserOp : 100) / 100;
      drag = { kind: "paint", target, last: p };
      paintDab(p, p);
    } else {
      if (TOOL === "clone") cloneOff = { x: p.x - cloneSrc.x, y: p.y - cloneSrc.y };
      drag = { kind: "fbrush", target, last: p };
      stampFilter(l, p.x, p.y, T.brushSize, TOOL, T.stampStr, null);
      requestComposite();
    }
  }
});

function inBounds(p, b) { return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; }

function paintDab(from, to) {
  const x = strokeBuf.getContext("2d");
  const size = TOOL === "brush" ? T.brushSize : TOOL === "pencil" ? T.pencilSize : T.eraserSize;
  const hard = TOOL === "brush" ? T.brushHard : TOOL === "pencil" ? 100 : T.eraserHard;
  const flow = TOOL === "brush" ? T.brushFlow / 100 : 1;
  const col = TOOL === "eraser" ? "#ffffff" : FG;
  if (TOOL === "pencil") x.imageSmoothingEnabled = false;
  strokeTo(x, from, to, size, (px, py) => stampBrush(x, px, py, size, hard, col, flow));
}

vp.addEventListener("pointermove", e => {
  const p = Doc.open ? docPt(e) : { x: 0, y: 0 };
  if (Doc.open) $("sbPos").textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;
  if (!drag) { if (polyPts) drawPolyUi(p); return; }
  const l = active();
  switch (drag.kind) {
    case "pan":
      View.vx = drag.vx + e.clientX - drag.sx;
      View.vy = drag.vy + e.clientY - drag.sy;
      applyView();
      break;
    case "move": {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (drag.isText) { l.tx = drag.lx + dx; l.ty = drag.ly + dy; renderText(l); }
      else { l.x = Math.round(drag.lx + dx); l.y = Math.round(drag.ly + dy); }
      requestComposite();
      break;
    }
    case "crop":
      cropRect = normRect(drag.start, p);
      drawCropUi();
      break;
    case "shapeSel":
      drag.cur = p;
      drawShapeUi(drag.start, p);
      break;
    case "lasso":
      drag.pts.push(p);
      drawLassoUi(drag.pts);
      break;
    case "paint":
      paintDab(drag.last, p);
      drag.last = p;
      requestComposite();
      break;
    case "fbrush":
      strokeTo(null, drag.last, p, T.brushSize, (px, py) =>
        stampFilter(l, px, py, T.brushSize, TOOL, T.stampStr, drag.last));
      drag.last = p;
      requestComposite();
      break;
    case "grad":
      drag.cur = p;
      drawShapeUi(drag.start, p, true);
      break;
  }
});

vp.addEventListener("pointerup", e => {
  if (!drag) return;
  const l = active();
  const d = drag; drag = null;
  if (d.kind === "pan") { vp.style.cursor = TOOL === "hand" ? "grab" : vp.style.cursor; return; }
  clearUi();
  switch (d.kind) {
    case "move":
      commit("Move " + (l ? l.name : "layer"));
      break;
    case "shapeSel": {
      if (!d.cur) return;
      const m = blankMask(), x = m.getContext("2d");
      const r = normRect(d.start, d.cur);
      x.fillStyle = "#fff";
      if (TOOL === "ellipse") { x.beginPath(); x.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, 7); x.fill(); }
      else x.fillRect(r.x, r.y, r.w, r.h);
      if (T.featherIn > 0) { const f = blankMask(); f.getContext("2d").filter = `blur(${T.featherIn}px)`; f.getContext("2d").drawImage(m, 0, 0); combine(f, d.mode); }
      else combine(m, d.mode);
      break;
    }
    case "lasso": {
      const m = blankMask(), x = m.getContext("2d");
      x.fillStyle = "#fff"; x.beginPath();
      d.pts.forEach((pt, i) => i ? x.lineTo(pt.x, pt.y) : x.moveTo(pt.x, pt.y));
      x.closePath(); x.fill();
      combine(m, d.mode);
      break;
    }
    case "paint": {
      painting = false;
      clipToSelection(strokeBuf);
      if (d.target === "mask") {
        // Photoshop mask semantics: paint LUMINANCE drives visibility —
        // black hides (remove mask alpha), white reveals (restore it)
        const [r, g, b] = hex2rgba(TOOL === "eraser" ? "#ffffff" : FG);
        const lum = (r * .2126 + g * .7152 + b * .0722) / 255;
        const x = l.mask.getContext("2d");
        x.globalAlpha = paintOpacity;
        x.globalCompositeOperation = "destination-out";
        x.drawImage(strokeBuf, -l.x, -l.y);          // carve by coverage
        if (lum > 0.004) {
          const white = mkCanvas(Doc.w, Doc.h);
          const wx = white.getContext("2d");
          wx.fillStyle = "#fff";
          wx.fillRect(0, 0, Doc.w, Doc.h);
          wx.globalCompositeOperation = "destination-in";
          wx.drawImage(strokeBuf, 0, 0);
          x.globalAlpha = paintOpacity * lum;
          x.globalCompositeOperation = "source-over";
          x.drawImage(white, -l.x, -l.y);            // restore by luminance
        }
        x.globalAlpha = 1; x.globalCompositeOperation = "source-over";
      } else {
        const x = l.canvas.getContext("2d");
        x.globalAlpha = paintOpacity;
        if (paintEraser) x.globalCompositeOperation = "destination-out";
        // account for layer offset: stroke is in doc space
        x.drawImage(strokeBuf, -l.x, -l.y);
        x.globalAlpha = 1; x.globalCompositeOperation = "source-over";
      }
      strokeBuf = null;
      commit({ brush: "Brush", pencil: "Pencil", eraser: "Eraser" }[TOOL] + (d.target === "mask" ? " (mask)" : ""));
      break;
    }
    case "fbrush": {
      if (Doc.selMask) { // constrain the whole stroke to the selection
        const before = Hist.steps[Hist.i]?.layers.find(s => s.id === l.id);
        if (before && before.canvas !== l.canvas) {
          const x = l.canvas.getContext("2d");
          const tmp = cloneCanvas(l.canvas);
          x.clearRect(0, 0, l.canvas.width, l.canvas.height);
          x.drawImage(before.canvas, 0, 0);
          const cut = cloneCanvas(tmp);
          cut.getContext("2d").globalCompositeOperation = "destination-in";
          cut.getContext("2d").drawImage(Doc.selMask, -l.x, -l.y);
          x.drawImage(cut, 0, 0);
        }
      }
      const names = { clone: "Clone Stamp", smudge: "Smudge", blur: "Blur", sharp: "Sharpen", dodge: "Dodge", burn: "Burn", sponge: "Sponge" };
      commit(names[TOOL] || TOOL);
      break;
    }
    case "grad": {
      if (!d.cur || !l || l.locked || l.type !== "raster") break;
      cow(l);
      const buf = mkCanvas(Doc.w, Doc.h), x = buf.getContext("2d");
      const [r1, g1, b1] = hex2rgba(FG), [r2, g2, b2] = hex2rgba(BG);
      const c2 = T.gradToTrans ? `rgba(${r1},${g1},${b1},0)` : `rgb(${r2},${g2},${b2})`;
      let g;
      if (T.gradKind === "radial") {
        const rad = Math.hypot(d.cur.x - d.start.x, d.cur.y - d.start.y) || 1;
        g = x.createRadialGradient(d.start.x, d.start.y, 0, d.start.x, d.start.y, rad);
      } else g = x.createLinearGradient(d.start.x, d.start.y, d.cur.x, d.cur.y);
      g.addColorStop(0, `rgb(${r1},${g1},${b1})`);
      g.addColorStop(1, c2);
      x.fillStyle = g; x.fillRect(0, 0, Doc.w, Doc.h);
      clipToSelection(buf);
      l.canvas.getContext("2d").drawImage(buf, -l.x, -l.y);
      commit("Gradient");
      break;
    }
    case "crop": drawCropUi(); break;
  }
});
vp.addEventListener("dblclick", e => {
  if (TOOL === "hand") fit();
  if (TOOL === "poly" && polyPts) closePoly();
  if (TOOL === "move") {
    const p = docPt(e);
    const hit = [...Doc.layers].reverse().find(t => t.type === "text" && inBounds(p, textBounds(t)));
    if (hit) { Doc.active = Doc.layers.indexOf(hit); setTool("text"); renderLayersPanel(); setTimeout(() => $("txText")?.focus(), 50); }
  }
});
vp.addEventListener("wheel", e => {
  if (!Doc.open) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY > 0 ? .92 : 1.08, e.clientX, e.clientY);
  else { View.vx -= e.deltaX; View.vy -= e.deltaY; applyView(); }
}, { passive: false });

function normRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
function clearUi() { drawAnts(); }
function uiCtx() { const x = uiC.getContext("2d"); drawAnts(); return x; }
function drawShapeUi(a, b, line) {
  const x = uiCtx();
  x.save();
  x.strokeStyle = "rgba(255,178,92,.95)";
  x.lineWidth = 1 / View.z;
  x.setLineDash([5 / View.z, 4 / View.z]);
  if (line) { x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); }
  else if (TOOL === "ellipse") {
    const r = normRect(a, b);
    x.beginPath(); x.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, 7); x.stroke();
  } else {
    const r = normRect(a, b);
    x.strokeRect(r.x, r.y, r.w, r.h);
  }
  x.restore();
}
function drawLassoUi(pts) {
  const x = uiCtx();
  x.save();
  x.strokeStyle = "rgba(255,178,92,.95)"; x.lineWidth = 1 / View.z;
  x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.stroke();
  x.restore();
}
function drawPolyUi(cur) {
  if (!polyPts) return;
  const x = uiCtx();
  x.save();
  x.strokeStyle = "rgba(255,178,92,.95)"; x.lineWidth = 1 / View.z;
  x.setLineDash([5 / View.z, 4 / View.z]);
  x.beginPath();
  polyPts.pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y));
  if (cur) x.lineTo(cur.x, cur.y);
  x.stroke();
  x.restore();
}
function closePoly() {
  if (!polyPts || polyPts.pts.length < 3) { polyPts = null; clearUi(); return; }
  const m = blankMask(), x = m.getContext("2d");
  x.fillStyle = "#fff"; x.beginPath();
  polyPts.pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y));
  x.closePath(); x.fill();
  combine(m, polyPts.mode);
  polyPts = null;
}
function drawCropUi() {
  const x = uiCtx();
  if (!cropRect) return;
  x.save();
  x.fillStyle = "rgba(0,0,0,.5)";
  x.fillRect(0, 0, Doc.w, Doc.h);
  x.clearRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
  x.strokeStyle = "var(--hot)"; x.strokeStyle = "#FFB25C";
  x.lineWidth = 1.5 / View.z;
  x.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
  x.restore();
  drawAnts();
}
function applyCropTool() {
  if (!cropRect || cropRect.w < 4 || cropRect.h < 4) return toast("Drag a crop area first", "warn");
  const r = {
    x: Math.round(clamp(cropRect.x, 0, Doc.w)), y: Math.round(clamp(cropRect.y, 0, Doc.h)),
    w: Math.round(Math.min(cropRect.w, Doc.w - cropRect.x)), h: Math.round(Math.min(cropRect.h, Doc.h - cropRect.y)),
  };
  Doc.layers.forEach(l => {
    if (l.canvas) {
      const c = mkCanvas(r.w, r.h);
      c.getContext("2d").drawImage(l.canvas, l.x - r.x, l.y - r.y);
      l.canvas = c; l.x = 0; l.y = 0;
    }
    if (l.mask) {
      const m = mkCanvas(r.w, r.h);
      m.getContext("2d").drawImage(l.mask, -r.x, -r.y);
      l.mask = m;
    }
    if (l.type === "text") { l.tx -= r.x; l.ty -= r.y; }
  });
  Doc.w = r.w; Doc.h = r.h;
  sizeCanvases();
  Doc.layers.forEach(l => { if (l.type === "text") renderText(l); });
  setSelection(null);
  cropRect = null;
  $("sbDoc").textContent = `${Doc.w} × ${Doc.h}`;
  commit("Crop");
  fit();
}
function samplePoint(p) {
  composite();
  const px = clamp(Math.round(p.x), 0, Doc.w - 1), py = clamp(Math.round(p.y), 0, Doc.h - 1);
  const d = docC.getContext("2d").getImageData(px, py, 1, 1).data;
  FG = "#" + [d[0], d[1], d[2]].map(n => n.toString(16).padStart(2, "0")).join("");
  syncSwatches(); syncOptbar();
  toast(FG + " sampled");
}
function bucketFill(p) {
  const l = active();
  if (!l || l.locked || l.type !== "raster") return toast("Select an unlocked pixel layer", "warn");
  composite();
  const ref = docC.getContext("2d").getImageData(0, 0, Doc.w, Doc.h).data;
  const px = clamp(Math.round(p.x), 0, Doc.w - 1), py = clamp(Math.round(p.y), 0, Doc.h - 1);
  const region = floodMask(ref, Doc.w, Doc.h, px, py, T.bucketTol, true);
  clipToSelection(region);
  cow(l);
  const x = l.canvas.getContext("2d");
  x.save();
  x.globalCompositeOperation = "source-over";
  const fill = mkCanvas(Doc.w, Doc.h), fx = fill.getContext("2d");
  fx.fillStyle = FG; fx.fillRect(0, 0, Doc.w, Doc.h);
  fx.globalCompositeOperation = "destination-in";
  fx.drawImage(region, 0, 0);
  x.drawImage(fill, -l.x, -l.y);
  x.restore();
  commit("Paint Bucket");
}

/* ============================================================
   Layers panel — masks, locks, thumbnails, reorder
   ============================================================ */
function addRaster(name) {
  const l = newLayer("raster", name || "Layer " + (Doc.layers.length + 1));
  Doc.layers.splice(Doc.active + 1, 0, l);
  Doc.active++;
  Doc.editingMask = false;
  commit("New layer");
}
function duplicateLayer() {
  const l = active();
  if (!l) return;
  const c = { ...l, id: uid(), name: l.name + " copy" };
  if (l.canvas) c.canvas = cloneCanvas(l.canvas);
  if (l.mask) c.mask = cloneCanvas(l.mask);
  Doc.layers.splice(Doc.active + 1, 0, c);
  Doc.active++;
  commit("Duplicate layer");
}
function deleteLayer() {
  const l = active();
  if (!l) return;
  if (l.locked) return toast(`${l.name} is locked`, "warn");
  if (Doc.layers.length === 1) return toast("A document needs at least one layer", "warn");
  Doc.layers.splice(Doc.active, 1);
  Doc.active = Math.max(0, Doc.active - 1);
  commit("Delete layer");
}
function addMask() {
  const l = active();
  if (!l) return;
  if (l.mask) return toast("This layer already has a mask — Alt-click its mask thumbnail to edit it", "warn");
  l.mask = mkCanvas(Doc.w, Doc.h);
  const x = l.mask.getContext("2d");
  x.fillStyle = "#fff";
  if (Doc.selMask) x.drawImage(Doc.selMask, 0, 0); // selection → mask, like PS
  else x.fillRect(0, 0, Doc.w, Doc.h);
  l.maskEnabled = true;
  Doc.editingMask = true;
  setSelection(null);
  commit("Add mask");
  toast("Mask added — painting now targets the mask (black hides, white reveals)");
}
function removeMask(apply) {
  const l = active();
  if (!l || !l.mask) return;
  if (apply && l.canvas) {
    cow(l);
    const x = l.canvas.getContext("2d");
    x.globalCompositeOperation = "destination-in";
    x.drawImage(l.mask, 0, 0);
    x.globalCompositeOperation = "source-over";
  }
  l.mask = null;
  Doc.editingMask = false;
  commit(apply ? "Apply mask" : "Remove mask");
}
function rasterizeText() {
  const l = active();
  if (!l || l.type !== "text") return toast("Select a text layer first", "warn");
  l.type = "raster";
  commit("Rasterise text");
}
function flattenAll() {
  composite();
  const flat = newLayer("raster", "Background");
  flat.canvas.getContext("2d").drawImage(docC, 0, 0);
  Doc.layers = [flat];
  Doc.active = 0; Doc.editingMask = false;
  commit("Flatten image");
}
function mergeDown() {
  const i = Doc.active;
  if (i === 0) return toast("Nothing below to merge into", "warn");
  const top = Doc.layers[i], bottom = Doc.layers[i - 1];
  if (bottom.type !== "raster") return toast("Merge target must be a pixel layer", "warn");
  cow(bottom);
  const x = bottom.canvas.getContext("2d");
  const content = maskedContent(top.type === "text" ? (renderText(top), top) : top);
  if (top.type !== "adjust") {
    x.globalAlpha = top.opacity * top.fill;
    x.globalCompositeOperation = top.blend;
    x.drawImage(content, top.x - bottom.x, top.y - bottom.y);
    x.globalAlpha = 1; x.globalCompositeOperation = "source-over";
  }
  Doc.layers.splice(i, 1);
  Doc.active = i - 1;
  commit("Merge down");
}

function layerThumb(l) {
  const c = mkCanvas(34, 26);
  const x = c.getContext("2d");
  if (l.type === "adjust") {
    x.fillStyle = "#555"; x.beginPath(); x.arc(17, 13, 9, 0, 7); x.fill();
    x.fillStyle = "#ddd"; x.beginPath(); x.arc(17, 13, 9, -Math.PI / 2, Math.PI / 2); x.fill();
  } else if (l.canvas) {
    const k = Math.min(34 / Doc.w, 26 / Doc.h);
    x.drawImage(l.canvas, (34 - Doc.w * k) / 2, (26 - Doc.h * k) / 2, Doc.w * k, Doc.h * k);
  }
  return c;
}
function maskThumb(l) {
  const c = mkCanvas(34, 26);
  const x = c.getContext("2d");
  x.fillStyle = "#000"; x.fillRect(0, 0, 34, 26);
  const k = Math.min(34 / Doc.w, 26 / Doc.h);
  x.drawImage(l.mask, (34 - Doc.w * k) / 2, (26 - Doc.h * k) / 2, Doc.w * k, Doc.h * k);
  return c;
}

function renderLayersPanel() {
  const box = $("layers");
  box.innerHTML = "";
  [...Doc.layers].reverse().forEach((l, ri) => {
    const i = Doc.layers.length - 1 - ri;
    const row = document.createElement("div");
    row.className = "lyr" + (i === Doc.active ? " sel" : "") + (l.visible ? "" : " off");
    row.draggable = !l.locked;
    row.dataset.i = i;
    row.innerHTML = `
      <button class="eye" title="Visibility">${SVG(l.visible
        ? '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'
        : '<path d="M3 3l18 18M10.6 6.2A10 10 0 0 1 22 12a17 17 0 0 1-3.3 4.1M6.6 6.7A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.3-1"/>').replace("<svg", '<svg width=13 height=13')}</button>
      <span class="th ${i === Doc.active && !Doc.editingMask ? "mskSel" : ""}" data-th></span>
      ${l.mask ? `<span class="th msk ${l.maskEnabled ? "" : "off"} ${i === Doc.active && Doc.editingMask ? "mskSel" : ""}" data-mth title="Layer mask — click to edit, Shift-click to disable"></span>` : ""}
      <span class="nm">${esc(l.name)}</span>
      ${l.type === "text" ? '<span class="tag">T</span>' : l.type === "adjust" ? '<span class="tag">◐</span>' : ""}
      ${l.locked ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10" style="color:var(--warn);flex:none"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>` : ""}
      <span class="op num">${Math.round(l.opacity * 100)}%</span>`;
    row.querySelector("[data-th]").appendChild(layerThumb(l));
    const mth = row.querySelector("[data-mth]");
    if (mth) mth.appendChild(maskThumb(l));
    row.querySelector(".eye").addEventListener("click", e => {
      e.stopPropagation();
      l.visible = !l.visible;
      commit((l.visible ? "Show " : "Hide ") + l.name);
    });
    row.querySelector("[data-th]").addEventListener("click", () => {
      Doc.active = i; Doc.editingMask = false;
      renderLayersPanel(); syncLayerControls(); syncOptbar();
    });
    if (mth) mth.addEventListener("click", e => {
      e.stopPropagation();
      Doc.active = i;
      if (e.shiftKey) { l.maskEnabled = !l.maskEnabled; commit(l.maskEnabled ? "Enable mask" : "Disable mask"); }
      else { Doc.editingMask = true; renderLayersPanel(); toast("Editing mask — paint black to hide, white to reveal"); }
    });
    row.addEventListener("click", e => {
      if (e.target.closest(".eye") || e.target.closest("[data-mth]") || e.target.closest("[data-th]")) return;
      Doc.active = i; Doc.editingMask = false;
      renderLayersPanel(); syncLayerControls(); syncOptbar();
    });
    row.addEventListener("dblclick", e => {
      if (e.target.closest(".th")) return;
      const nm = prompt("Layer name", l.name);
      if (nm) { l.name = nm; commit("Rename layer"); }
    });
    row.addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", i));
    row.addEventListener("dragover", e => e.preventDefault());
    row.addEventListener("drop", e => {
      e.preventDefault();
      const from = +e.dataTransfer.getData("text/plain");
      if (isNaN(from) || from === i) return;
      const [mv] = Doc.layers.splice(from, 1);
      Doc.layers.splice(i, 0, mv);
      Doc.active = Doc.layers.indexOf(mv);
      commit("Reorder layers");
    });
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      Doc.active = i; renderLayersPanel();
      showCtx(e.clientX, e.clientY, [
        ["Duplicate layer", duplicateLayer],
        ["Delete layer", deleteLayer],
        ["Merge down", mergeDown],
        "-",
        l.mask ? ["Delete mask", () => removeMask(false)] : ["Add mask", addMask],
        l.mask ? ["Apply mask", () => removeMask(true)] : null,
        l.type === "text" ? ["Rasterise text", rasterizeText] : null,
        "-",
        [l.locked ? "Unlock layer" : "Lock layer", () => { l.locked = !l.locked; commit(l.locked ? "Lock" : "Unlock"); }],
      ].filter(Boolean));
    });
    box.appendChild(row);
  });
  syncLayerControls();
}
function syncLayerControls() {
  const l = active();
  $("opV").textContent = l ? Math.round(l.opacity * 100) + "%" : "—";
  $("fillV").textContent = l ? Math.round(l.fill * 100) + "%" : "—";
  $("opR").value = l ? Math.round(l.opacity * 100) : 100;
  $("fillR").value = l ? Math.round(l.fill * 100) : 100;
  $("lyrBlend").value = l ? l.blend : "source-over";
  $("lyrBlend").disabled = !l || l.locked;
  $("opR").disabled = $("fillR").disabled = !l || l.locked;
  $("lkAll").classList.toggle("on", !!(l && l.locked));
}

function showCtx(cx, cy, items) {
  const c = $("ctx");
  c.innerHTML = items.map((it, i) => it === "-" ? '<div class="msep"></div>' :
    `<button class="mi" data-i="${i}">${it[0]}</button>`).join("");
  c.style.left = Math.min(cx, innerWidth - 210) + "px";
  c.style.top = Math.min(cy, innerHeight - 40 - items.length * 30) + "px";
  c.classList.add("on");
  c.querySelectorAll("[data-i]").forEach(b => b.addEventListener("click", () => {
    c.classList.remove("on");
    items[+b.dataset.i][1]();
  }));
}
document.addEventListener("click", e => { if (!e.target.closest("#ctx")) $("ctx").classList.remove("on"); });

/* layer control wiring */
function togglePop(id) {
  ["opPop", "fillPop"].forEach(x => { if (x !== id) $(x).hidden = true; });
  $(id).hidden = !$(id).hidden;
}
$("opBtn").addEventListener("click", () => togglePop("opPop"));
$("fillBtn").addEventListener("click", () => togglePop("fillPop"));
$("opR").addEventListener("input", () => {
  const l = active(); if (!l || l.locked) return;
  l.opacity = +$("opR").value / 100;
  $("opV").textContent = $("opR").value + "%";
  requestComposite();
});
$("opR").addEventListener("change", () => commit("Layer opacity"));
$("fillR").addEventListener("input", () => {
  const l = active(); if (!l || l.locked) return;
  l.fill = +$("fillR").value / 100;
  $("fillV").textContent = $("fillR").value + "%";
  requestComposite();
});
$("fillR").addEventListener("change", () => commit("Layer fill"));
$("lyrBlend").addEventListener("change", () => {
  const l = active(); if (!l || l.locked) return;
  l.blend = $("lyrBlend").value;
  commit("Blend: " + $("lyrBlend").options[$("lyrBlend").selectedIndex].text);
});
$("lkAll").addEventListener("click", () => {
  const l = active(); if (!l) return;
  l.locked = !l.locked;
  commit(l.locked ? "Lock layer" : "Unlock layer");
});
$("fNew").addEventListener("click", () => addRaster());
$("fDup").addEventListener("click", duplicateLayer);
$("fDel").addEventListener("click", deleteLayer);
$("fAddMask").addEventListener("click", addMask);
$("fAdj").addEventListener("click", e => {
  const r = e.currentTarget.getBoundingClientRect();
  showCtx(r.left - 60, r.top - ADJ.length * 30 - 14, ADJ.map(a => [a.name, () => openAdjust(a, true)]));
});
$("lyrMenu").addEventListener("click", e => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  showCtx(r.left - 140, r.bottom + 6, [
    ["New layer", () => addRaster()],
    ["Duplicate layer", duplicateLayer],
    ["Merge down", mergeDown],
    ["Flatten image", flattenAll],
    "-",
    ["Rasterise text", rasterizeText],
  ]);
});

/* ============================================================
   Panels: history, info, adjustments tree
   ============================================================ */
function renderHistory() {
  $("pHist").innerHTML = Hist.steps.map((s, i) =>
    `<button class="hstep ${i === Hist.i ? "cur" : ""} ${i > Hist.i ? "fut" : ""}" data-h="${i}">
      ${esc(s.label)}<span style="margin-left:auto;font-family:var(--mono);font-size:9.5px;opacity:.6">${i}</span></button>`).join("");
  $("pHist").querySelectorAll("[data-h]").forEach(b => b.addEventListener("click", () => restore(+b.dataset.h)));
  const box = $("pHist");
  box.scrollTop = box.scrollHeight;
}
function renderInfo() {
  if (!Doc.open) return;
  $("pInfo").innerHTML = [
    ["Document", Doc.name], ["Size", `${Doc.w} × ${Doc.h} px`],
    ["Layers", Doc.layers.length], ["Active", active()?.name ?? "—"],
    ["History", `${Hist.i + 1} / ${Hist.steps.length}`],
    ["Selection", Doc.selMask ? "active" : "none"],
    ["Megapixels", ((Doc.w * Doc.h) / 1e6).toFixed(2) + " MP"],
  ].map(([k, v]) => `<div class="kv"><span>${k}</span><b>${esc(String(v))}</b></div>`).join("");
}

/* adjustments + filters (Photoshop dialog behaviour) */
const ADJ = [
  { id: "brightcon", name: "Brightness/Contrast…", c: [["Brightness", -100, 100, 0], ["Contrast", -100, 100, 0]],
    f: v => `brightness(${100 + v[0]}%) contrast(${100 + v[1]}%)` },
  { id: "levels", name: "Levels…", c: [["Midtones", -50, 70, 0], ["Range", -50, 90, 0]],
    f: v => `brightness(${100 + v[0]}%) contrast(${100 + v[1]}%)` },
  { id: "curves", name: "Curves…", c: [["S-curve", -40, 80, 20], ["Lift", -30, 40, 0]],
    f: v => `contrast(${100 + v[0]}%) brightness(${100 + v[1]}%)` },
  { id: "exposure", name: "Exposure…", c: [["Exposure", -60, 90, 0]], f: v => `brightness(${100 + v[0]}%)` },
  { id: "huesat", name: "Hue/Saturation…", c: [["Hue", -180, 180, 0], ["Saturation", -100, 150, 0], ["Lightness", -50, 50, 0]],
    f: v => `hue-rotate(${v[0]}deg) saturate(${100 + v[1]}%) brightness(${100 + v[2]}%)` },
  { id: "colorbal", name: "Colour Balance…", c: [["Temperature", -100, 100, 0], ["Tint", -60, 60, 0]],
    f: v => `sepia(${Math.max(0, v[0] * .55)}%) hue-rotate(${(v[0] < 0 ? v[0] * .25 : 0) + v[1] * .35}deg) saturate(${100 + Math.abs(v[0]) * .12}%)` },
  { id: "bw", name: "Black & White…", c: [["Contrast", 0, 60, 12]], f: v => `grayscale(100%) contrast(${100 + v[0]}%)` },
  { id: "photofilter", name: "Photo Filter…", c: [["Warmth", -100, 100, 35], ["Density", 0, 100, 50]],
    f: v => `sepia(${v[0] > 0 ? v[0] * v[1] / 100 : 0}%) hue-rotate(${v[0] < 0 ? v[0] * .3 * v[1] / 100 : 0}deg) saturate(${100 + v[1] * .15}%)` },
  { id: "invert", name: "Invert", c: [], f: () => "invert(100%)" },
  { id: "posterize", name: "Posterize…", c: [["Levels", 2, 12, 4]], f: v => `contrast(${100 + (12 - v[0]) * 18}%) saturate(130%)` },
  { id: "threshold", name: "Threshold…", c: [["Cutoff", -60, 60, 0]], f: v => `grayscale(100%) brightness(${100 + v[0]}%) contrast(800%)` },
];
const FILTERS = [
  { id: "gauss", name: "Gaussian Blur…", c: [["Radius", 0, 40, 6]], f: v => `blur(${v[0]}px)` },
  { id: "fsharp", name: "Sharpen…", c: [["Amount", 0, 120, 40]], f: v => `contrast(${100 + v[0]}%)` },
  { id: "fnoise", name: "Reduce Noise…", c: [["Strength", 0, 8, 2]], f: v => `blur(${v[0] * .6}px)` },
];
let adjDraft = null;
function openAdjust(a, asLayer) {
  if (!Doc.open) return toast("Open an image first", "warn");
  const d = $("fdlg");
  d.hidden = false;
  d.style.left = Math.max(60, innerWidth - 320 - 300) + "px";
  d.style.top = "90px";
  $("fdlgTitle").textContent = a.name.replace(/…$/, "");
  const vals = a.c.map(c => c[3]);
  const upd = () => {
    adjDraft = Object.assign(newLayer("adjust", a.name), { filter: a.f(vals), visible: true });
    composite(adjDraft);
  };
  $("fdlgB").innerHTML = a.c.map(([n, mn, mx, dv], i) => `
    <div class="ctl"><div class="ctl-t"><label>${n}</label><span class="ctl-v" id="adv${i}">${dv}</span></div>
    <input type="range" id="adr${i}" min="${mn}" max="${mx}" value="${dv}"></div>`).join("") + `
    <div class="acts">
      <button class="btn btn-p f1" id="adOkL">Add as layer</button>
      <button class="btn btn-g f1" id="adOkB">Apply to layer</button>
    </div>
    <div class="acts"><button class="btn btn-g f1" id="adCancel">Cancel</button></div>`;
  a.c.forEach((_, i) => $("adr" + i).addEventListener("input", () => {
    vals[i] = +$("adr" + i).value;
    $("adv" + i).textContent = vals[i];
    upd();
  }));
  const close = () => { adjDraft = null; d.hidden = true; requestComposite(); };
  $("adOkL").addEventListener("click", () => {
    const l = Object.assign(newLayer("adjust", a.name.replace(/…$/, "")), { filter: a.f(vals), adjKind: a.id });
    Doc.layers.splice(Doc.active + 1, 0, l);
    Doc.active++;
    close();
    commit(l.name);
  });
  $("adOkB").addEventListener("click", () => {
    const l = active();
    if (!l || l.type !== "raster" || l.locked) { toast("Select an unlocked pixel layer to bake into", "warn"); return; }
    cow(l);
    const tmp = cloneCanvas(l.canvas);
    const x = l.canvas.getContext("2d");
    x.clearRect(0, 0, l.canvas.width, l.canvas.height);
    x.filter = a.f(vals);
    x.drawImage(tmp, 0, 0);
    x.filter = "none";
    close();
    commit(a.name.replace(/…$/, ""));
  });
  $("adCancel").addEventListener("click", close);
  $("fdlgX").onclick = close;
  if (!a.c.length) upd();
  else upd();
}
(function dragDlg() {
  const d = $("fdlg"), t = $("fdlgT");
  let on = false, sx = 0, sy = 0, ox = 0, oy = 0;
  t.addEventListener("pointerdown", e => {
    if (e.target.closest(".fdlg-x")) return;
    on = true; sx = e.clientX; sy = e.clientY;
    const r = d.getBoundingClientRect(); ox = r.left; oy = r.top;
  });
  window.addEventListener("pointermove", e => {
    if (!on) return;
    d.style.left = clamp(ox + e.clientX - sx, 6, innerWidth - 120) + "px";
    d.style.top = clamp(oy + e.clientY - sy, 40, innerHeight - 60) + "px";
  });
  window.addEventListener("pointerup", () => on = false);
})();
function renderAdjTree() {
  $("pAdj").innerHTML = `
    <div class="sec"><button class="sec-h" data-sec>
      <svg class="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="m6 9 6 6 6-6"/></svg>
      Adjustments</button>
      <div class="sec-b">${ADJ.map((a, i) => `<button class="trow" data-adj="${i}">${a.name}</button>`).join("")}</div></div>
    <div class="sec"><button class="sec-h" data-sec>
      <svg class="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="m6 9 6 6 6-6"/></svg>
      Filters</button>
      <div class="sec-b">${FILTERS.map((a, i) => `<button class="trow" data-flt="${i}">${a.name}</button>`).join("")}</div></div>`;
  $("pAdj").querySelectorAll("[data-adj]").forEach(b => b.addEventListener("click", () => openAdjust(ADJ[+b.dataset.adj])));
  $("pAdj").querySelectorAll("[data-flt]").forEach(b => b.addEventListener("click", () => openAdjust(FILTERS[+b.dataset.flt])));
}
document.addEventListener("click", e => {
  const h = e.target.closest("[data-sec]");
  if (h) h.parentElement.classList.toggle("shut");
  const pt = e.target.closest("[data-pt]");
  if (pt) {
    const g = pt.closest(".pgroup");
    g.querySelectorAll(".ptab").forEach(x => x.classList.toggle("on", x === pt));
    g.querySelectorAll(".pbody").forEach(x => x.classList.toggle("on", x.id === pt.dataset.pt));
  }
});

/* ============================================================
   Menus + shortcuts
   ============================================================ */
const mi = (label, sc, fn, id) => ({ label, sc, fn, id });
function buildMenu(el, items) {
  el.innerHTML = items.map((it, i) => it === "-" ? '<div class="msep"></div>' :
    it.sub ? `<div class="mi mi-sub">${it.label}<span class="sc">▸</span><div class="menu-d">${it.sub.map((s, j) =>
      `<button class="mi" data-m="${i}.${j}">${s.label}${s.sc ? `<span class="sc">${s.sc}</span>` : ""}</button>`).join("")}</div></div>` :
    `<button class="mi" data-m="${i}">${it.label}${it.sc ? `<span class="sc">${it.sc}</span>` : ""}</button>`).join("");
  el.querySelectorAll("[data-m]").forEach(b => b.addEventListener("click", () => {
    const [i, j] = b.dataset.m.split(".").map(Number);
    const it = j === undefined ? items[i] : items[i].sub[j];
    it.fn && it.fn();
  }));
}
function newTextLayerCentered() { addTextLayer({ x: Doc.w / 2, y: Doc.h / 2 }); }
function addTextLayer(p) {
  const l = newLayer("text", "Text");
  l.tx = p.x; l.ty = p.y;
  l.color = FG;
  l.align = "center";
  renderText(l);
  Doc.layers.splice(Doc.active + 1, 0, l);
  Doc.active++;
  commit("New text layer");
  setTool("text");
  setTimeout(() => { const i = $("txText"); if (i) { i.focus(); i.select(); } }, 60);
}
function resizeDialog() {
  if (!Doc.open) return;
  const w = prompt("New width (px)", Doc.w);
  if (!w) return;
  const nw = clamp(Math.round(+w) || Doc.w, 1, 8000);
  const nh = Math.round(nw * Doc.h / Doc.w);
  const k = nw / Doc.w;
  Doc.layers.forEach(l => {
    if (l.canvas) {
      const c = mkCanvas(nw, nh);
      c.getContext("2d").drawImage(l.canvas, 0, 0, nw, nh);
      l.canvas = c;
    }
    if (l.mask) {
      const m = mkCanvas(nw, nh);
      m.getContext("2d").drawImage(l.mask, 0, 0, nw, nh);
      l.mask = m;
    }
    l.x = Math.round(l.x * k); l.y = Math.round(l.y * k);
    if (l.type === "text") { l.tx *= k; l.ty *= k; l.size *= k; renderText(l); }
  });
  Doc.w = nw; Doc.h = nh;
  sizeCanvases();
  setSelection(null);
  $("sbDoc").textContent = `${Doc.w} × ${Doc.h}`;
  commit(`Image size ${nw}×${nh}`);
  fit();
}
function buildMenus() {
  buildMenu($("mFile"), [
    mi("Open image…", "⌘O", () => $("fileImg").click()),
    mi("New document", "", () => newDoc(1280, 800, "untitled")),
    mi("Load sample", "", () => newDoc(1600, 1067, "sample.jpg", makeSample())),
    "-",
    { label: "Export as", sub: [
      mi("PNG", "", () => exportPNG("png")),
      mi("JPG", "", () => exportPNG("jpeg", .9)),
      mi("WebP", "⌘E", () => exportPNG("webp", .9)),
    ] },
  ]);
  buildMenu($("mEdit"), [
    mi("Undo", "⌘Z", undo), mi("Redo", "⇧⌘Z", redo), "-",
    mi("Fill with foreground", "⌥⌫", () => { const l = active(); if (l?.type === "raster" && !l.locked) { cow(l); const buf = mkCanvas(Doc.w, Doc.h); const x = buf.getContext("2d"); x.fillStyle = FG; x.fillRect(0, 0, Doc.w, Doc.h); clipToSelection(buf); l.canvas.getContext("2d").drawImage(buf, -l.x, -l.y); commit("Fill"); } }),
    mi("Clear selection contents", "⌫", clearSelArea),
  ]);
  buildMenu($("mImage"), [
    mi("Image size…", "⌥⌘I", resizeDialog),
    mi("Crop to selection", "", cropToSelection),
    "-",
    { label: "Adjustments", sub: ADJ.map(a => mi(a.name, "", () => openAdjust(a))) },
    { label: "Rotation", sub: [
      mi("Rotate 90° CW", "", () => rotateDoc(90)),
      mi("Rotate 90° CCW", "", () => rotateDoc(-90)),
      mi("Rotate 180°", "", () => rotateDoc(180)),
      mi("Flip horizontal", "", () => flipDoc(true)),
      mi("Flip vertical", "", () => flipDoc(false)),
    ] },
  ]);
  buildMenu($("mLayer"), [
    mi("New layer", "⇧⌘N", () => addRaster()),
    mi("New text layer", "", newTextLayerCentered),
    mi("Duplicate layer", "⌘J", duplicateLayer),
    mi("Delete layer", "", deleteLayer),
    "-",
    mi("Add layer mask", "", addMask),
    mi("Disable/enable mask", "", () => { const l = active(); if (l?.mask) { l.maskEnabled = !l.maskEnabled; commit(l.maskEnabled ? "Enable mask" : "Disable mask"); } }),
    mi("Apply mask", "", () => removeMask(true)),
    mi("Delete mask", "", () => removeMask(false)),
    "-",
    mi("Rasterise text", "", rasterizeText),
    mi("Merge down", "⌘E", mergeDown),
    mi("Flatten image", "", flattenAll),
  ]);
  buildMenu($("mSelect"), [
    mi("Select all", "⌘A", selectAll),
    mi("Deselect", "⌘D", () => setSelection(null)),
    mi("Inverse", "⇧⌘I", invertSelection),
    "-",
    mi("Feather 4 px", "", () => featherSelection(4)),
    mi("Expand 4 px", "", () => growSelection(4)),
    mi("Contract 4 px", "", () => growSelection(-4)),
  ]);
  buildMenu($("mFilter"), FILTERS.map(a => mi(a.name, "", () => openAdjust(a))));
  buildMenu($("mView"), [
    mi("Fit to screen", "⌘0", fit),
    mi("Actual size", "⌘1", () => { View.z = 1; applyView(); }),
    mi("Zoom in", "⌘+", () => zoomAt(1.25)),
    mi("Zoom out", "⌘−", () => zoomAt(1 / 1.25)),
    "-",
    mi("Toggle panels", "Tab", () => $("app").classList.toggle("nopanels")),
  ]);
}
function clearSelArea() {
  const l = active();
  if (!l || l.type !== "raster" || l.locked) return;
  cow(l);
  const x = l.canvas.getContext("2d");
  if (Doc.selMask) {
    x.globalCompositeOperation = "destination-out";
    x.drawImage(Doc.selMask, -l.x, -l.y);
    x.globalCompositeOperation = "source-over";
  } else x.clearRect(0, 0, l.canvas.width, l.canvas.height);
  commit("Clear");
}
function cropToSelection() {
  if (!Doc.selMask) return toast("Make a selection first", "warn");
  // bounding box of selection
  const d = Doc.selMask.getContext("2d").getImageData(0, 0, Doc.w, Doc.h).data;
  let x0 = Doc.w, y0 = Doc.h, x1 = 0, y1 = 0;
  for (let py = 0; py < Doc.h; py += 2) for (let px = 0; px < Doc.w; px += 2) {
    if (d[(py * Doc.w + px) * 4 + 3] > 127) {
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
  }
  if (x1 <= x0 || y1 <= y0) return;
  cropRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  applyCropTool();
}
function rotateDoc(deg) {
  const swap = Math.abs(deg) === 90;
  const nw = swap ? Doc.h : Doc.w, nh = swap ? Doc.w : Doc.h;
  Doc.layers.forEach(l => {
    if (l.canvas) {
      const c = mkCanvas(nw, nh), x = c.getContext("2d");
      x.translate(nw / 2, nh / 2); x.rotate(deg * Math.PI / 180);
      x.drawImage(l.canvas, -Doc.w / 2 + l.x, -Doc.h / 2 + l.y);
      l.canvas = c; l.x = 0; l.y = 0;
    }
    if (l.mask) {
      const m = mkCanvas(nw, nh), x = m.getContext("2d");
      x.translate(nw / 2, nh / 2); x.rotate(deg * Math.PI / 180);
      x.drawImage(l.mask, -Doc.w / 2, -Doc.h / 2);
      l.mask = m;
    }
  });
  Doc.w = nw; Doc.h = nh;
  sizeCanvases(); setSelection(null);
  Doc.layers.forEach(l => { if (l.type === "text") renderText(l); });
  $("sbDoc").textContent = `${Doc.w} × ${Doc.h}`;
  commit(`Rotate ${deg}°`); fit();
}
function flipDoc(horiz) {
  Doc.layers.forEach(l => {
    if (l.canvas) {
      const c = mkCanvas(Doc.w, Doc.h), x = c.getContext("2d");
      x.scale(horiz ? -1 : 1, horiz ? 1 : -1);
      x.drawImage(l.canvas, horiz ? -Doc.w : 0, horiz ? 0 : -Doc.h);
      l.canvas = c;
    }
  });
  commit(horiz ? "Flip horizontal" : "Flip vertical");
}

/* menus open/close */
document.querySelectorAll("[data-menu]").forEach(m => {
  m.querySelector(".menu-t").addEventListener("click", e => {
    e.stopPropagation();
    const was = m.classList.contains("open");
    document.querySelectorAll("[data-menu]").forEach(o => o.classList.remove("open"));
    if (!was) m.classList.add("open");
  });
  m.addEventListener("mouseenter", () => {
    if ([...document.querySelectorAll("[data-menu]")].some(o => o.classList.contains("open"))) {
      document.querySelectorAll("[data-menu]").forEach(o => o.classList.remove("open"));
      m.classList.add("open");
    }
  });
});
document.addEventListener("click", () => document.querySelectorAll("[data-menu]").forEach(o => o.classList.remove("open")));

/* keyboard */
document.addEventListener("keydown", e => {
  const M = e.metaKey || e.ctrlKey;
  const tag = (e.target.tagName || "").toLowerCase();
  if (e.key === "Escape") {
    document.querySelectorAll("[data-menu]").forEach(o => o.classList.remove("open"));
    $("ctx").classList.remove("on"); $("flyout").classList.remove("on");
    if (!$("fdlg").hidden) { $("fdlgX").click(); return; }
    if (polyPts) { polyPts = null; clearUi(); return; }
    if (cropRect) { cropRect = null; drawCropUi(); return; }
  }
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.code === "Space" && !spaceHeld) { spaceHeld = true; vp.style.cursor = "grab"; }
  if (M) {
    const k = e.key.toLowerCase();
    if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === "a") { e.preventDefault(); selectAll(); }
    else if (k === "d") { e.preventDefault(); setSelection(null); }
    else if (k === "i" && e.shiftKey) { e.preventDefault(); invertSelection(); }
    else if (k === "j") { e.preventDefault(); duplicateLayer(); }
    else if (k === "n" && e.shiftKey) { e.preventDefault(); addRaster(); }
    else if (k === "e") { e.preventDefault(); exportPNG("webp", .9); }
    else if (k === "o") { e.preventDefault(); $("fileImg").click(); }
    else if (k === "0") { e.preventDefault(); fit(); }
    else if (k === "1") { e.preventDefault(); View.z = 1; applyView(); }
    else if (k === "=" || k === "+") { e.preventDefault(); zoomAt(1.25); }
    else if (k === "-") { e.preventDefault(); zoomAt(1 / 1.25); }
    return;
  }
  const tools = { v: "move", m: "marquee", l: "lasso", w: "wand", c: "crop", i: "eyedrop",
    b: "brush", e: "eraser", g: "bucket", s: "clone", r: "smudge", o: "dodge", t: "text", h: "hand", z: "zoom" };
  const k = e.key.toLowerCase();
  if (tools[k]) { setTool(tools[k]); return; }
  if (k === "x") { [FG, BG] = [BG, FG]; syncSwatches(); syncOptbar(); }
  if (k === "d") { FG = "#000000"; BG = "#ffffff"; syncSwatches(); syncOptbar(); }
  if (k === "[") { T.brushSize = Math.max(1, Math.round(T.brushSize * .85)); T.eraserSize = Math.max(1, Math.round(T.eraserSize * .85)); syncOptbar(); }
  if (k === "]") { T.brushSize = Math.min(400, Math.round(T.brushSize * 1.18)); T.eraserSize = Math.min(400, Math.round(T.eraserSize * 1.18)); syncOptbar(); }
  if (e.key === "Tab") { e.preventDefault(); $("app").classList.toggle("nopanels"); }
  if (e.key === "Enter" && polyPts) closePoly();
  if (e.key === "Enter" && TOOL === "crop" && cropRect) applyCropTool();
  if ((e.key === "Delete" || e.key === "Backspace")) {
    e.preventDefault();
    if (e.altKey) { /* fill */ } else clearSelArea();
  }
  // nudge active layer with arrows (move tool)
  if (TOOL === "move" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
    const l = active(); if (!l || l.locked) return;
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
    const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
    if (l.type === "text") { l.tx += dx; l.ty += dy; renderText(l); }
    else { l.x += dx; l.y += dy; }
    requestComposite();
  }
});
document.addEventListener("keyup", e => {
  if (e.code === "Space") { spaceHeld = false; vp.style.cursor = TOOL === "hand" ? "grab" : "crosshair"; }
  if (TOOL === "move" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) commit("Nudge");
});

/* ============================================================
   Splitter, theme, boot
   ============================================================ */
$("splitR").addEventListener("pointerdown", e => {
  e.preventDefault();
  const start = e.clientX;
  const cur = parseInt(getComputedStyle($("app")).getPropertyValue("--rw")) || 296;
  const mv = ev => $("app").style.setProperty("--rw", clamp(cur - (ev.clientX - start), 200, 480) + "px");
  const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", mv);
  window.addEventListener("pointerup", up);
});
(function theme() {
  let saved = null;
  try { saved = localStorage.getItem("kiln-theme"); } catch {}
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  $("thToggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = cur === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("kiln-theme", next); } catch {}
  });
})();

$("fileImg").addEventListener("change", e => openImageFile(e.target.files[0]));
$("dzOpen").addEventListener("click", e => { e.stopPropagation(); $("fileImg").click(); });
$("dzSample").addEventListener("click", e => { e.stopPropagation(); newDoc(1600, 1067, "sample.jpg", makeSample()); });
$("dzNew").addEventListener("click", e => { e.stopPropagation(); newDoc(1280, 800, "untitled"); });
$("dz").addEventListener("click", e => { if (!e.target.closest("button")) $("fileImg").click(); });
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
document.addEventListener("drop", e => { e.preventDefault(); openImageFile(e.dataTransfer.files[0]); });
addEventListener("resize", () => { if (Doc.open) drawAnts(); });
vp.addEventListener("contextmenu", e => e.preventDefault());

buildToolbar();
buildMenus();
renderAdjTree();
setTool("move");
syncSwatches();
