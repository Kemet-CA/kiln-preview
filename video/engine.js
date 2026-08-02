/* ============================================================
   Kiln Video — application shell.

   Holds the project, drives the preview loop, and wires the panels. The real
   work lives in src/: the model describes the edit, the compositor draws it,
   the timeline handles gestures, and the exporter encodes it. Preview audio is
   played by the media elements themselves (per-clip volume and fades applied
   each frame); the exporter mixes offline instead, which is the one place
   sample-accurate summing actually matters.
   ============================================================ */
import * as M from "./src/model.js";
import { stage as pixelStage, hasKeyer, MASKS } from "./src/keyer.js";
import { analyse as analyseShake } from "./src/stabilise.js";
import { renderFrame, visualClipsAt, audibleClipsAt, sourceTime, gainAt } from "./src/render.js";
import { Timeline, fmtTime } from "./src/timeline.js";
import { importFile, rehydrate, recordVoice, gifFrameAt } from "./src/media.js";
import { exportVideo, PRESETS, outputSize, supported as canEncode } from "./src/export.js";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = M.clamp;
const status = s => { $("sbStatus").textContent = s; };

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = "toast";
  const tint = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" }[kind] || "var(--ok)";
  t.innerHTML = `<span class="dot" style="background:${tint}"></span>${esc(msg)}`;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; }, 2600);
  setTimeout(() => t.remove(), 2950);
  return t;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/* ---------------- state ---------------- */
const App = {
  project: M.newProject(),
  hist: M.makeHistory(),
  selection: [],
  picking: false,
  emojiQuery: "",
  transEdge: "in",
  loop: "once",            // once | loop | pong
  direction: 1,            // which way the playhead is travelling, for ping-pong
  mediaBin: new Map(),      // media taken out of the list, kept for undo
  stabilising: false,
  poolSel: [],
  playhead: 0,
  playing: false,
  snapping: true,
  masterVol: 1,
  exporting: false,
  cancelExport: false,
};
const ctx = $("preview").getContext("2d", { alpha: false });
let timeline;

const selectedClips = () => App.selection.map(id => M.findClip(App.project, id)).filter(Boolean);
const firstSelected = () => selectedClips()[0] || null;

/* ---------------- preview ----------------
   The compositor is not cheap: it draws the whole timeline, with filters, into
   a canvas. Running it sixty times a second regardless of whether anything had
   changed cost 455 ms of every idle second at 1080p — which is why everything
   else in the editor felt slow. It now runs when something has actually
   changed, and at the size the preview is shown rather than the size the
   project exports at. */
let lastTick = 0;
let dirty = true;
const invalidate = () => { dirty = true; };
window.__kilnInvalidate = invalidate;

function loop(now) {
  const dt = lastTick ? (now - lastTick) / 1000 : 0;
  lastTick = now;
  if (App.playing && !App.exporting) {
    const end = M.duration(App.project);
    App.playhead += dt * (App.loop === "pong" ? App.direction : 1);
    if (App.playhead >= end) {
      if (App.loop === "loop") App.playhead = 0;
      else if (App.loop === "pong") { App.playhead = end; App.direction = -1; }
      else { App.playhead = end; setPlaying(false); }
    } else if (App.playhead <= 0 && App.direction < 0) {
      // the bottom of a bounce: turn round rather than stop
      App.playhead = 0;
      if (App.loop === "pong") App.direction = 1;
      else setPlaying(false);
    }
    syncPlayheadUi();
    dirty = true;                 // the playhead moved, so the frame differs
  }
  if (dirty && !App.exporting) { dirty = false; drawPreview(); }
  requestAnimationFrame(loop);
}
function drawPreview() {
  const p = App.project;
  const cv = $("preview");
  /* The preview is shown at a few hundred pixels wide; compositing at the
     project's full resolution and then letting the browser scale it down is
     five times the fill for no visible gain. The compositor still works in
     project coordinates — the context is scaled, not the maths. */
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const shown = cv.getBoundingClientRect().width || p.w;
  const scale = Math.min(1, (shown * dpr) / p.w);
  const wantW = Math.max(64, Math.round(p.w * scale));
  const wantH = Math.max(36, Math.round(p.h * scale));
  if (cv.width !== wantW || cv.height !== wantH) {
    cv.width = wantW; cv.height = wantH;
    fitPreview();
  }
  ctx.setTransform(cv.width / p.w, 0, 0, cv.height / p.h, 0, 0);
  const t = App.playhead;

  const wanted = new Set();
  const sources = new Map();
  for (const clip of visualClipsAt(p, t)) {
    const media = M.mediaOf(p, clip);
    if (!media?.el) continue;
    // a GIF supplies the frame that belongs at this moment, not whatever the
    // browser is showing in the <img>
    sources.set(clip.id, media.gif ? gifFrameAt(media, sourceTime(clip, t)) : media.el);
    if (media.gif) invalidate();
    if (media.kind !== "image") {
      wanted.add(media.el);
      const want = sourceTime(clip, t);
      media.el.playbackRate = clamp(clip.speed, .0625, 16);
      if (App.playing) {
        if (media.el.paused) media.el.play().catch(() => {});
        // draw when the decoder actually has a new frame, not on a guess
        if (media.el.requestVideoFrameCallback && !media.el.__kilnRvfc) {
          media.el.__kilnRvfc = true;
          const tick = () => {
            invalidate();
            if (!media.el.paused) media.el.requestVideoFrameCallback(tick);
            else media.el.__kilnRvfc = false;
          };
          media.el.requestVideoFrameCallback(tick);
        }
        // nudge back into sync only when it has drifted noticeably
        if (Math.abs(media.el.currentTime - want) > .25) media.el.currentTime = want;
      } else if (Math.abs(media.el.currentTime - want) > .02) {
        media.el.currentTime = want;
      }
    }
  }
  /* ---- sound ----
     Elements are imported muted, because importing a file should not make a
     noise. Nothing ever unmuted them, so the preview has never been audible.

     One element can be wanted by two clips — a video and the linked audio clip
     that carries its sound — so the gain is worked out per element rather than
     per clip: the loudest audible clip using it wins, and an element no clip
     wants is silent rather than paused mid-frame. */
  const gains = new Map();
  for (const { clip } of audibleClipsAt(p, t)) {
    const media = M.mediaOf(p, clip);
    if (!media?.el || media.kind === "image") continue;
    wanted.add(media.el);
    const want = sourceTime(clip, t);
    gains.set(media.el, Math.max(gains.get(media.el) || 0, gainAt(clip, t) * App.masterVol));
    media.el.playbackRate = clamp(clip.speed, .0625, 16);
    if (App.playing && media.el.paused) media.el.play().catch(() => {});
    if (!App.playing && Math.abs(media.el.currentTime - want) > .02) media.el.currentTime = want;
  }
  for (const el of wanted) {
    const g = clamp(gains.get(el) || 0, 0, 1);
    // silent while scrubbing: a burst of sound on every seek is not useful
    el.muted = g <= 0.001 || !App.playing;
    el.volume = g;
  }
  for (const m of p.media) {
    if (m.el && m.kind !== "image" && !wanted.has(m.el) && !m.el.paused) m.el.pause();
  }
  renderFrame(ctx, p, t, sources);
}

/* The canvas carries its own pixel size (the project resolution), so its CSS
   size has to be computed rather than left to percentage max-height — which
   resolved against an indefinite flex height and let the picture overflow its
   box, worse the shorter the window. */
function fitPreview() {
  invalidate();
  if (typeof paintCropBox === "function") paintCropBox();
  const cv = $("preview"), wrap = document.querySelector(".vwrap");
  if (!cv || !wrap) return;
  const box = wrap.getBoundingClientRect();
  const avail = { w: Math.max(80, box.width - 32), h: Math.max(45, box.height - 32) };
  const ratio = App.project.w / App.project.h;
  let w = avail.w, h = w / ratio;
  if (h > avail.h) { h = avail.h; w = h * ratio; }
  cv.style.width = Math.floor(w) + "px";
  cv.style.height = Math.floor(h) + "px";
}

function syncLoopUi() {
  const b = $("loopBtn");
  if (!b) return;
  const label = { once: "↻ Play once", loop: "🔁 Loop", pong: "⇄ Ping-pong" }[App.loop];
  b.textContent = label;
  b.classList.toggle("on", App.loop !== "once");
  b.title = { once: "Stops at the end — click for looping",
    loop: "Starts again at the end — click for ping-pong",
    pong: "Turns round at each end — click to play once" }[App.loop];
}

function setPlaying(on) {
  App.playing = on;
  $("playIcon").innerHTML = on ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  if (!on) for (const m of App.project.media) m.el && m.kind !== "image" && m.el.pause();
}
function seek(t) {
  invalidate();
  App.playhead = clamp(t, 0, Math.max(0, M.duration(App.project)));
  syncPlayheadUi();
}
function syncPlayheadUi() {
  timeline?.syncPlayhead();
  $("tcNow").textContent = fmtTime(App.playhead);
}

/* ---------------- rendering the shell ---------------- */
function renderAll() {
  invalidate();
  timeline.render();
  renderPool();
  renderInspector();
  renderTransitions();
  renderFrameBar();
  renderCropMenu();
  paintCropBox();
  syncStatus();
  syncPlayheadUi();
}
function syncStatus() {
  const p = App.project;
  const clips = p.tracks.reduce((n, t) => n + t.clips.length, 0);
  $("sbClips").textContent = clips;
  $("sbDur").textContent = fmtTime(M.duration(p));
  $("tcTotal").textContent = fmtTime(M.duration(p));
  $("sbSize").textContent = `${p.w}×${p.h} · ${p.fps}fps`;
  $("sbEnc").textContent = canEncode() ? "WebCodecs" : "unavailable";
  $("tlInfo").textContent = `${clips} clips · ${p.tracks.length} tracks`;
  $("poolN").textContent = p.media.length;
  $("dz").hidden = p.media.length > 0;
  $("projName").value = p.name;
}
function renderPool() {
  const host = $("pool");
  const p = App.project;
  if (!p.media.length) { host.innerHTML = `<div class="empty">No media yet.<br>Import or drop files here.</div>`; return; }
  host.innerHTML = p.media.map(m => `
    <div class="mitem${App.poolSel.includes(m.id) ? " sel" : ""}" data-media="${m.id}" draggable="true">
      <div class="mth" style="${m.poster ? `background-image:url(${m.poster})` : ""}">${m.poster ? "" : m.kind === "audio" ? "♪" : "▦"}</div>
      <div class="mmeta">
        <div class="mname">${esc(m.name)}</div>
        <div class="msub">${m.kind} · ${fmtTime(m.dur)}${m.w ? ` · ${m.w}×${m.h}` : ""}</div>
      </div>
      <button class="mdel" data-media-del="${m.id}" title="Remove from the media list">✕</button>
    </div>`).join("");
}
/* ---------------- inspector ---------------- */
const row = (label, inner) => `<label class="fld"><span>${label}</span>${inner}</label>`;
/* What a keyable slider shows: the value at the playhead, not the stored base.
   With keyframes on a property the base is no longer what you see, and a panel
   that shows it is lying about the frame in front of you. */
const kv = (c, prop) => c.keys?.[prop]?.length ? M.valueAt(c, prop, App.playhead) : c[prop];
/* Transform starts off. Anything that sets a position, a scale or a rotation
   has to switch it on as well, or the numbers land in the model and nothing
   moves — the failure that is hardest to explain to the person looking at it. */
const needTransform = c => { if (c) c.fxTransform = true; };
/* which keyframe groups belong to which switch */
const FX_KEY_GROUPS = {
  fxTransform: ["transform", "animation"],
  fxColor: ["colour"],
};
/* A heading with a switch: every effect group can be turned off and back on
   without losing what was set, which is how you compare "with" and "without"
   without undoing your work. */
const fxHead = (title, prop, on) =>
  `<div class="ihead fx"><span>${title}</span>
     <button class="sw${on ? " on" : ""}" data-fx="${prop}" role="switch" aria-checked="${on}"
             title="${on ? "Turn this off" : "Turn this on"}"><i></i></button></div>`;
/* A whole group: the switch, then its controls — always. Hiding the controls
   when the effect is off meant reaching for a slider took two clicks and a
   guess about which switch owned it. The switch decides whether the effect
   applies; the panel stays where it is either way, dimmed while it is off so
   the state is still obvious. */
const fxGroup = (title, prop, on, body, off) =>
  fxHead(title, prop, on) +
  `<div class="fxbody${on ? "" : " off"}" title="${on ? "" : esc(off)}">${body}</div>`;
const slider = (prop, min, max, step, v, unit = "", key = false) =>
  `<input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-prop="${prop}">
   <b>${typeof v === "number" ? (+v).toFixed(step < 1 ? 2 : 0) : v}${unit}</b>
   ${key ? `<button class="kbtn" data-key="${prop}" title="Add a keyframe here">◆</button>` : ""}`;

/* Which preset a clip is currently on: the stored lock if there is one, and
   otherwise "free" — a clip with no crop and no lock reads as Original. */
function activeRatio(c) {
  if (c.cropRatio) {
    const hit = M.RATIOS.find(a => a.r && Math.abs(a.r - c.cropRatio) < .005);
    if (hit) return hit.id;
  }
  const untouched = !c.crop.l && !c.crop.t && !c.crop.r && !c.crop.b;
  return untouched && !c.cropRatio ? "orig" : "free";
}

/* The framing strip under the player. Same presets as the crop panel, drawn
   compactly: the ratio on top and the platform under it, so it reads at a
   glance without a tooltip. */
function renderFrameBar() {
  const btn = $("cropBtn");
  if (!btn) return;
  const c = firstSelected();
  const cur = c ? activeRatio(c) : projectRatio();
  const hit = M.RATIOS.find(a => a.id === cur && a.r);
  // the button says what shape you are cutting for, so it needs no strip
  const label = btn.querySelector("span");
  if (label) label.textContent = Crop.on ? "Cropping…" : hit ? `Crop · ${hit.label}` : "Crop";
  $("cropBtn")?.classList.toggle("on", Crop.on || !$("cropMenu").hidden);
}
/* With nothing selected the strip still shows what the project is set to */
function projectRatio() {
  const a = App.project.w / App.project.h;
  const hit = M.RATIOS.find(r => r.r && Math.abs(r.r - a) < .01);
  return hit ? hit.id : "free";
}

/* ---------------- the track stretch window ----------------
   Speed is on the clip, but the question people ask is about the track in
   front of them: "make this bit shorter". So it opens from the track header,
   works on the selection if there is one and the whole track if there is not,
   and shows the length it will end up as while the slider moves. */
let speedFor = null;
function openSpeedPop(trackId, anchor) {
  const pop = $("speedPop");
  if (speedFor === trackId && !pop.hidden) { closeSpeedPop(); return; }
  speedFor = trackId;
  pop.hidden = false;
  renderSpeedPop();
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(innerWidth - 248, Math.max(8, r.left - 100)) + "px";
  pop.style.top = Math.min(innerHeight - 190, r.bottom + 6) + "px";
}
function closeSpeedPop() { speedFor = null; $("speedPop").hidden = true; }
function speedTargets() {
  const track = App.project.tracks.find(t => t.id === speedFor);
  if (!track) return { track: null, clips: [] };
  const picked = track.clips.filter(c => App.selection.includes(c.id));
  return { track, clips: picked.length ? picked : track.clips, whole: !picked.length };
}
function renderSpeedPop() {
  const pop = $("speedPop");
  if (!pop || pop.hidden) return;
  const { track, clips, whole } = speedTargets();
  if (!track) return closeSpeedPop();
  if (!clips.length) {
    pop.innerHTML = `<div class="shead">${esc(track.name)}</div><div class="slen">Nothing on this track yet.</div>`;
    return;
  }
  const speed = clips[0].speed || 1;
  const len = clips.reduce((n, c) => n + c.dur, 0);
  pop.innerHTML =
    `<div class="shead">Stretch ${esc(track.name)}</div>
     <div class="srow">
       <input type="range" id="spVal" min=".25" max="4" step=".05" value="${speed}">
       <b id="spNum">${(+speed).toFixed(2)}×</b>
     </div>
     <div class="chips">${[.25, .5, .75, 1, 1.5, 2, 4].map(v =>
       `<button class="chip${Math.abs(speed - v) < .001 ? " on" : ""}" data-tspeed="${v}">${v}×</button>`).join("")}</div>
     <div class="slen" id="spLen">${whole ? `${clips.length} clip${clips.length === 1 ? "" : "s"}` : "selected clips"}
       · ${fmtTime(len)} → <b style="font-family:inherit">${fmtTime(len)}</b></div>`;
}
/* Applying it: the source length is fixed, so a new speed is a new duration.
   Clips after the one that changed slide along, or the track would overlap. */
function applyTrackSpeed(v, done) {
  const { track, clips } = speedTargets();
  if (!track || !clips.length) return;
  for (const c of clips) {
    const srcLen = c.dur * (c.speed || 1);
    c.speed = v;
    c.dur = Math.max(.1, srcLen / v);
  }
  M.closeGaps(track, Math.min(...clips.map(c => c.start)));
  if (done) commit("Track speed");
  refresh({ silent: true });
  const len = clips.reduce((n, c) => n + c.dur, 0);
  const el = $("spLen");
  if (el) el.querySelector("b").textContent = fmtTime(len);
}

/* ---------------- cropping ----------------
   One button, one menu: free crop or a platform shape. Free crop puts a box on
   the picture — drag it, pull its corners, press Enter. Nothing is written to
   the clip until it is applied, so Escape really does cancel.

   The box is kept in *frame* coordinates (0..1 of the project), so it survives
   the preview being resized and converts straight into the clip's crop. */
const Crop = { on: false, box: null, ratio: null };

function renderCropMenu() {
  const menu = $("cropMenu");
  if (!menu || menu.hidden) return;
  const c = firstSelected();
  const cur = c ? activeRatio(c) : projectRatio();
  menu.innerHTML =
    `<button class="ci${Crop.on ? " on" : ""}" data-crop="free">
       <span class="sh"></span>Free crop<u>drag on the video</u></button>
     <div class="csep"></div>` +
    M.RATIOS.filter(a => a.r).map(a => {
      const w = a.r >= 1 ? 20 : 20 * a.r, h = a.r >= 1 ? 20 / a.r : 20;
      return `<button class="ci${cur === a.id ? " on" : ""}" data-crop="${a.id}">
        <span class="sh" style="width:${w.toFixed(0)}px;height:${h.toFixed(0)}px"></span>
        ${a.label}<u>${esc(a.sub.split(" · ")[0])}</u></button>`;
    }).join("") +
    `<div class="csep"></div>
     <button class="ci" data-crop="orig">Original<u>reset</u></button>`;
}

/* where the picture actually is on screen, so the box can sit exactly on it */
function previewRect() {
  const cv = $("preview"), stage = $("stage");
  const r = cv.getBoundingClientRect(), s = stage.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
}
function paintCropBox() {
  const el = $("cropBox");
  if (!Crop.on || !Crop.box) { el.hidden = true; return; }
  const p = previewRect(), b = Crop.box;
  el.hidden = false;
  el.style.left = (p.x + b.x * p.w) + "px";
  el.style.top = (p.y + b.y * p.h) + "px";
  el.style.width = (b.w * p.w) + "px";
  el.style.height = (b.h * p.h) + "px";
  const c = firstSelected();
  const px = c ? ` · ${Math.round(b.w * App.project.w)}×${Math.round(b.h * App.project.h)}` : "";
  $("cropHint").innerHTML = `Drag to frame it${px} · <b>Enter</b> to apply · <b>Esc</b> to cancel`;
}
function startFreeCrop() {
  /* Nothing selected? Crop what is on screen. Refusing to start because of a
     selection the user never made is the kind of small no that makes a tool
     feel fussy. */
  let c = firstSelected();
  if (!c) {
    const here = visualClipsAt(App.project, App.playhead)
      .filter(x => x.kind !== "text" && x.kind !== "sticker");
    if (here.length) { setSelection([here[0].id]); c = here[0]; }
  }
  if (!c) return toast("Nothing to crop at the playhead", "warn");
  Crop.on = true;
  Crop.ratio = null;
  // start from whatever crop the clip already has, so it can be adjusted
  const b = c.crop || { l: 0, t: 0, r: 0, b: 0 };
  Crop.box = { x: b.l, y: b.t, w: Math.max(.05, 1 - b.l - b.r), h: Math.max(.05, 1 - b.t - b.b) };
  $("cropBox").hidden = false;
  paintCropBox();
  renderCropMenu();
  toast("Drag the box, then press Enter");
}
function cancelCrop() {
  if (!Crop.on) return;
  Crop.on = false; Crop.box = null;
  $("cropBox").hidden = true;
  renderCropMenu();
}
function applyCrop() {
  const c = firstSelected();
  if (!Crop.on || !Crop.box || !c) return cancelCrop();
  const b = Crop.box;
  c.crop = {
    l: clamp(b.x, 0, .9), t: clamp(b.y, 0, .9),
    r: clamp(1 - b.x - b.w, 0, .9), b: clamp(1 - b.y - b.h, 0, .9),
  };
  c.cropRatio = null;                       // a hand-drawn crop is its own shape
  cancelCrop();
  commit("Crop"); refresh();
  toast(`Cropped to ${Math.round(b.w * App.project.w)}×${Math.round(b.h * App.project.h)}`);
}

/* dragging the box and its eight grips */
function wireCropBox() {
  const el = $("cropBox");
  el.addEventListener("pointerdown", e => {
    if (!Crop.on || !Crop.box) return;
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.add("dragging");
    const grip = e.target.dataset.grip || null;
    const p = previewRect();
    const start = { ...Crop.box }, sx = e.clientX, sy = e.clientY;
    const move = ev => {
      const dx = (ev.clientX - sx) / p.w, dy = (ev.clientY - sy) / p.h;
      const b = { ...start };
      const MIN = .06;
      if (!grip) {                                   // move the whole box
        b.x = clamp(start.x + dx, 0, 1 - start.w);
        b.y = clamp(start.y + dy, 0, 1 - start.h);
      } else {
        if (grip.includes("w")) { const nx = clamp(start.x + dx, 0, start.x + start.w - MIN); b.w = start.w + (start.x - nx); b.x = nx; }
        if (grip.includes("e")) b.w = clamp(start.w + dx, MIN, 1 - start.x);
        if (grip.includes("n")) { const ny = clamp(start.y + dy, 0, start.y + start.h - MIN); b.h = start.h + (start.y - ny); b.y = ny; }
        if (grip.includes("s")) b.h = clamp(start.h + dy, MIN, 1 - start.y);
      }
      Crop.box = b;
      paintCropBox();
    };
    const up = () => {
      document.body.classList.remove("dragging");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });
}

const FONTS = ["Inter, system-ui, sans-serif", "Georgia, serif", "Impact, sans-serif",
  "Courier New, monospace", "Trebuchet MS, sans-serif", "Palatino, serif", "Verdana, sans-serif"];

function textPanel(c) {
  return `<div class="ihead">Text</div>
     ${row("Content", `<textarea data-prop="text" rows="3" placeholder="Type your title…">${esc(c.text)}</textarea>`)}
     <div class="ihead">Style</div>
     <div class="chips">${M.TITLE_STYLES.map(t =>
       `<button class="chip" data-title-style="${t.id}">${t.name}</button>`).join("")}</div>
     ${row("Font", `<select data-prop="font">${FONTS.map(f =>
        `<option value="${f}"${c.font === f ? " selected" : ""}>${f.split(",")[0]}</option>`).join("")}</select>`)}
     ${row("Weight", `<select data-prop="weight">${[[300, "Light"], [400, "Regular"], [500, "Medium"],
        [700, "Bold"], [800, "Extra bold"], [900, "Black"]].map(([v, l]) =>
        `<option value="${v}"${(c.weight || 700) === v ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
     ${row("Size", slider("size", 12, 400, 1, c.size, "px", true))}
     ${row("Line height", slider("lineHeight", .8, 2.4, .05, c.lineHeight ?? 1.2))}
     <div class="chips">${["left", "center", "right"].map(a =>
       `<button class="chip${(c.align || "center") === a ? " on" : ""}" data-align="${a}">${a}</button>`).join("")}</div>
     <div class="ihead">Colour</div>
     ${row("Fill", `<input type="color" data-prop="color" value="${c.color}">`)}
     ${row("Outline", slider("stroke", 0, 24, 1, c.stroke, "px"))}
     ${row("Outline colour", `<input type="color" data-prop="strokeColor" value="${c.strokeColor || "#000000"}">`)}
     ${row("Shadow", slider("shadow", 0, 60, 1, c.shadow ?? 0, "px"))}
     ${row("Box", `<input type="color" data-prop="bg" value="${(c.bg || "#000000").slice(0, 7)}">
        <button class="chip" data-act="clearBg">None</button>`)}
     ${row("Box padding", slider("pad", 0, 1.2, .05, c.pad ?? .3))}
     <div class="note">A shadow or an outline is what keeps white text readable over a bright frame.
       Drag it on the picture, or set X and Y in Transform.</div>`;
}

function stickerPanel(c) {
  const q = (App.emojiQuery || "").trim();
  const hits = q ? M.searchEmoji(q) : null;
  const shown = hits ? [[`${hits.length} match${hits.length === 1 ? "" : "es"}`, hits]] : Object.entries(M.EMOJI);
  return `<div class="ihead">Sticker</div>
     ${row("Current", `<input type="text" data-prop="text" value="${esc(c.text)}" class="stcur">`)}
     ${row("Size", slider("size", 24, 600, 2, c.size, "px", true))}
     ${row("Rotation", slider("rot", -180, 180, 1, c.rot, "°", true))}
     <div class="ihead">Library</div>
     <input type="search" id="emojiQ" placeholder="Search — fire, heart, clap…" value="${esc(q)}" class="emq">
     <div class="emlib">${shown.map(([name, list]) => !list.length ? "" : `
       <div class="emgrp">${esc(name)}</div>
       <div class="emgrid">${list.map(e =>
         `<button class="emb${c.text === e.ch ? " on" : ""}" data-emoji="${e.ch}" title="${esc(e.k)}">${e.ch}</button>`).join("")}</div>`).join("")}
     </div>
     <div class="note">Pick one and it changes straight away. Double-click a sticker on the timeline
       or in the picture to come back here.</div>`;
}

/* Each transition gets a small moving picture of itself: two panels doing what
   the transition does, so the list can be read at a glance instead of by name. */
function transThumb(def) {
  const k = { fade: "opacity:.45", dip: "opacity:.25;filter:brightness(2)",
    blur: "filter:blur(3px);opacity:.6", wipe: "clip-path:inset(0 42% 0 0)",
    iris: "clip-path:circle(30% at 50% 50%)", box: "clip-path:inset(22% 22%)",
    split: "clip-path:inset(28% 0)", slide: "transform:translateX(-38%)",
    zoom: "transform:scale(.55)", spin: "transform:rotate(28deg) scale(.6)",
    shake: "transform:translateX(9%) rotate(3deg)" }[def.kind] || "";
  return `<span class="trthumb"><i style="${k}"></i></span>`;
}

function renderTransitions() {
  const host = $("iTrans");
  if (!host) return;
  const c = firstSelected();
  if (!c) {
    host.innerHTML = `<div class="empty">Select a clip, then pick a transition for its
      start or its end.<br><br>A transition at a cut works best when the clip next to it
      touches — use Close gaps on the timeline first.</div>`;
    return;
  }
  const edge = App.transEdge || "in";
  const cur = (edge === "in" ? c.transIn : c.transOut)?.type || "none";
  const dur = (edge === "in" ? c.transIn : c.transOut)?.dur ?? .5;
  const has = e => !!(e === "in" ? c.transIn : c.transOut);

  host.innerHTML =
    `<div class="ihead">Where it goes</div>
     <div class="tredge">
       <button class="${edge === "in" ? "on" : ""}" data-tedge="in">Start of clip${has("in") ? " ●" : ""}</button>
       <button class="${edge === "out" ? "on" : ""}" data-tedge="out">End of clip${has("out") ? " ●" : ""}</button>
     </div>
     ${row("Length", `<input type="range" id="trDur" min=".1" max="3" step=".05" value="${dur}">
        <b id="trDurV">${(+dur).toFixed(2)}s</b>`)}
     <div class="chips">
       <button class="chip" data-trans-pick="none">Remove</button>
       <button class="chip" data-act="transBoth">Put it on both ends</button>
     </div>` +
    M.TRANSITION_GROUPS.map(g => `
      <div class="ihead">${g}</div>
      <div class="trgrid">${M.TRANSITIONS.filter(t => t.group === g).map(t =>
        `<button class="trcard${cur === t.id ? " on" : ""}" data-trans-pick="${t.id}" title="${esc(t.name)}">
           ${transThumb(t)}<span class="tn">${esc(t.name)}</span></button>`).join("")}</div>`).join("") +
    `<div class="note">Pick one and it plays straight away — the playhead moves to the cut so
      you can see it. ${M.TRANSITIONS.length - 1} to choose from.</div>`;
}

function renderInspector() {
  const c = firstSelected();
  const p = App.project;

  if (!c) {
    for (const id of ["iTransform", "iColor", "iAudio", "iText", "iKeys"])
      $(id).innerHTML = `<div class="empty">Select a clip on the timeline to edit it.</div>`;
  } else {
    $("iTransform").innerHTML =
      fxGroup("Position &amp; scale", "fxTransform", !!c.fxTransform,
      `${row("X", slider("x", -1920, 1920, 1, kv(c, "x"), "px", true))}
       ${row("Y", slider("y", -1080, 1080, 1, kv(c, "y"), "px", true))}
       ${row("Scale", slider("scale", .05, 4, .01, kv(c, "scale"), "×", true))}
       ${row("Rotation", slider("rot", -180, 180, 1, kv(c, "rot"), "°", true))}
       ${row("Opacity", slider("opacity", 0, 1, .01, kv(c, "opacity"), "", true))}
       <div class="chips">
         <button class="chip${c.flipH ? " on" : ""}" data-toggle="flipH">Flip horizontal</button>
         <button class="chip${c.flipV ? " on" : ""}" data-toggle="flipV">Flip vertical</button>
         <button class="chip" data-act="fitFrame">Fit to frame</button>
         <button class="chip" data-act="resetTransform">Reset</button>
       </div>
       <div class="ihead">Layout</div>
       <div class="chips">
         <button class="chip" data-layout="pip-br">Picture in picture</button>
         <button class="chip" data-layout="pip-tr">PiP top right</button>
         <button class="chip" data-layout="split-lr">Split left / right</button>
         <button class="chip" data-layout="split-tb">Split top / bottom</button>
       </div>
       <div class="note">Two clips on stacked video tracks make a layout: select
         both and pick one. The upper track sits in front.</div>
       <div class="ihead">Stabilise</div>
       <div class="chips">
         <button class="chip${App.stabilising ? " on" : ""}" data-act="stabilise"${App.stabilising ? " disabled" : ""}>
           ${App.stabilising ? "Measuring…" : c.stabilised ? "Stabilise again" : "Stabilise this clip"}</button>
         ${c.stabilised ? `<button class="chip" data-act="unstabilise">Remove</button>` : ""}
       </div>
       ${App.stabilising ? `<div class="stabtrack"><i id="stabBar"></i></div>` : ""}
       <div class="note">It measures how the frame moves, keeps the movement that
         looks deliberate and cancels the rest, then zooms in a little to cover the
         edges. The result is keyframes on X and Y — you can see them on the clip.</div>`,
      `Switch this on to move, scale, rotate or fade the clip, arrange a
       picture-in-picture, or stabilise handheld footage.`) +
      `<div class="ihead">Crop &amp; aspect</div>
       <div class="ratios">${M.RATIOS.map(a => `
         <button class="ratio${activeRatio(c) === a.id ? " on" : ""}" data-ratio="${a.id}">
           <b>${a.label}</b><i>${a.sub}</i></button>`).join("")}</div>
       <div class="note">Choosing one sets the frame and centre-crops the clips to fill it. There is a
         Crop button under the picture too, with a box you can drag.</div>
       ${row("Left", slider("crop.l", 0, .45, .01, c.crop.l))}
       ${row("Top", slider("crop.t", 0, .45, .01, c.crop.t))}
       ${row("Right", slider("crop.r", 0, .45, .01, c.crop.r))}
       ${row("Bottom", slider("crop.b", 0, .45, .01, c.crop.b))}
       <div class="ihead">Speed</div>
       ${row("Speed", slider("speed", .25, 4, .05, c.speed, "×"))}
       <div class="chips">${[.25, .5, 1, 1.5, 2, 4].map(s =>
         `<button class="chip${c.speed === s ? " on" : ""}" data-speed="${s}">${s}×</button>`).join("")}</div>
       <div class="note">Changing speed re-times the clip on the timeline and keeps its audio in sync.</div>`;

    $("iColor").innerHTML =
      fxGroup("Colour correction", "fxColor", !!c.fxColor,
      `${row("Brightness", slider("brightness", 0, 2, .01, kv(c, "brightness"), "", true))}
       ${row("Contrast", slider("contrast", 0, 2, .01, kv(c, "contrast"), "", true))}
       ${row("Saturation", slider("saturate", 0, 3, .01, kv(c, "saturate"), "", true))}
       ${row("Hue", slider("hue", -180, 180, 1, kv(c, "hue"), "°", true))}
       ${row("Blur", slider("blur", 0, 30, .5, kv(c, "blur"), "px", true))}
       <div class="ihead">Looks</div>
       <div class="chips">
         <button class="chip" data-look="none">Original</button>
         <button class="chip" data-look="warm">Warm</button>
         <button class="chip" data-look="cool">Cool</button>
         <button class="chip" data-look="bw">Black &amp; white</button>
         <button class="chip" data-look="sepia">Sepia</button>
         <button class="chip" data-look="punch">Punch</button>
         <button class="chip" data-look="fade">Faded</button>
       </div>`,
      `Switch this on for brightness, contrast, saturation, hue, blur and the
       ready-made looks.`) +
      fxGroup("Green screen", "fxKey", !!c.fxKey,
      `<div class="chips">
         <button class="chip${c.chroma ? " on" : ""}" data-toggle="chroma">Key out a colour</button>
         <button class="chip${App.picking ? " on" : ""}" data-act="pickKey">Pick from the frame</button>
       </div>
       ${row("Colour", `<input type="color" data-prop="keyColor" value="${c.keyColor || "#00d000"}">`)}
       ${row("Similarity", slider("keySimilarity", .01, .6, .005, c.keySimilarity ?? .18))}
       ${row("Softness", slider("keySmooth", 0, .4, .005, c.keySmooth ?? .08))}
       ${row("Spill removal", slider("keySpill", 0, 1, .01, c.keySpill ?? .4))}
       <div class="note">${hasKeyer()
         ? "Matched on colour, not brightness, so shadows on the screen key out with it. Raise similarity until the screen goes, then soften the edge."
         : "This browser has no WebGL2, so keying is off here — the clip still plays and exports."}</div>`,
      `Switch this on to key out a green or blue screen.`) +
      fxGroup("Mask", "fxMask", !!c.fxMask,
      `${row("Shape", `<select data-prop="mask">${MASKS.map(m =>
         `<option value="${m}"${(c.mask || "none") === m ? " selected" : ""}>${
           m === "letterbox" ? "Cinematic bars" : m[0].toUpperCase() + m.slice(1)}</option>`).join("")}</select>`)}
       ${c.mask === "letterbox"
         ? `${row("Bar height", slider("barSize", 0, .45, .005, c.barSize ?? .12))}
            ${row("Softness", slider("maskFeather", 0, 1, .01, c.maskFeather ?? .1))}
            ${row("Strength", slider("maskOpacity", 0, 1, .01, c.maskOpacity ?? 1))}
            <div class="note">Black bars top and bottom, the way a film frame sits inside a
              16:9 one. Drag the height to bring them together or apart — nothing is cropped,
              so the shot underneath is untouched.</div>`
         : `${row("Size", slider("maskSize", .05, 1, .01, c.maskSize ?? .6))}
            ${row("Feather", slider("maskFeather", 0, 1, .01, c.maskFeather ?? .1))}
            ${row("Strength", slider("maskOpacity", 0, 1, .01, c.maskOpacity ?? 1))}
            ${row("Offset X", slider("maskX", -.5, .5, .01, c.maskX ?? 0))}
            ${row("Offset Y", slider("maskY", -.5, .5, .01, c.maskY ?? 0))}
            <div class="chips">
              <button class="chip${c.maskInvert ? " on" : ""}" data-toggle="maskInvert">Invert</button>
            </div>
            <div class="note">Strength is how much of the outside is taken away — at 0 the mask
              does nothing, at 1 the outside is gone.</div>`}`,
      `Switch this on for a shape mask or cinematic black bars.`);

    $("iAudio").innerHTML =
      `<div class="ihead">Clip audio</div>
       ${row("Volume", slider("volume", 0, 2, .01, c.volume, "", true))}
       ${row("Fade in", slider("fadeIn", 0, 5, .1, c.fadeIn, "s"))}
       ${row("Fade out", slider("fadeOut", 0, 5, .1, c.fadeOut, "s"))}
       <div class="chips">
         <button class="chip${c.muted ? " on" : ""}" data-toggle="muted">Mute clip</button>
         <button class="chip" data-act="detachAudio">Detach audio</button>
       </div>
       <div class="ihead">Cleanup</div>
       <div class="chips">
         <button class="chip${c.denoise ? " on" : ""}" data-toggle="denoise">Remove background noise</button>
       </div>
       <div class="note">Spectral subtraction, the same denoiser the Voice workspace uses: it learns the
       noise from the quietest part of the clip and takes it out of the whole thing, including underneath
       speech. It runs on export, not in the live preview.</div>`;

    $("iText").innerHTML = (c.kind === "text" || c.kind === "sticker")
      ? (c.kind === "sticker" ? stickerPanel(c) : textPanel(c))
      : `<div class="empty">This is a ${c.kind} clip.<br>Use Text or Sticker in the toolbar to add one,
         or double-click a title on the timeline to edit it.</div>`;

    $("iKeys").innerHTML =
      `<div class="ihead">Keyframes</div>
       <div class="note">Move the playhead, then press ◆ beside a property to pin its value there.
         Between two keyframes the value eases from one to the other. They show up on the clip
         itself — drag one sideways to change when it happens.</div>
       <div class="kflegend">${Object.entries(M.KEY_GROUPS).map(([, g]) =>
         `<span><i style="background:${g.color}"></i>${g.name}</span>`).join("")}</div>
       ${Object.entries(M.KEY_GROUPS).map(([id, g]) => {
         const rows = g.props.filter(prop => (c.keys[prop] || []).length || M.KEYABLE.includes(prop));
         if (!rows.length) return "";
         return `<div class="ihead">${g.name}</div>` + rows.map(prop => {
           const keys = c.keys[prop] || [];
           return `<div class="fld"><span>${prop}</span>
             <b style="width:auto;flex:1;text-align:left;color:${keys.length ? g.color : "var(--t4)"}">
               ${keys.length ? `${keys.length} keyframe${keys.length === 1 ? "" : "s"}` : "—"}</b>
             <button class="kbtn" data-key="${prop}" title="Pin this value at the playhead">◆</button>
             ${keys.length ? `<button class="kbtn" data-unkey="${prop}" title="Remove them all">✕</button>` : ""}</div>` +
             (keys.length ? `<div class="kflist">${keys.map((k, i) =>
               `<button class="kfchip" data-delkey="${prop}" data-delkey-i="${i}"
                  style="--kfc:${g.color}" title="Remove this keyframe">
                  ${(k.t * (c.dur || 1)).toFixed(2)}s
                  <b>${typeof k.v === "number" ? (+k.v).toFixed(2) : k.v}</b><i>✕</i></button>`).join("")}</div>` : "");
         }).join("");
       }).join("")}
       <div class="ihead">Transitions</div>
       <div class="note">They have a panel of their own now — the
         <b style="font-weight:650">Transitions</b> tab, with ${M.TRANSITIONS.length - 1} to pick from
         and a picture of each one.</div>`;
  }

  $("iProject").innerHTML =
    `<div class="ihead">Project</div>
     ${row("Name", `<input type="text" id="pName" value="${esc(p.name)}">`)}
     ${row("Size", `<select id="pSize">${Object.entries(PRESETS).map(([k, v]) =>
        `<option value="${k}"${p.w === v.w ? " selected" : ""}>${k} · ${v.w}×${v.h}</option>`).join("")}</select>`)}
     ${row("Frame rate", `<select id="pFps">${[24, 25, 30, 50, 60].map(f =>
        `<option value="${f}"${p.fps === f ? " selected" : ""}>${f} fps</option>`).join("")}</select>`)}
     ${row("Background", `<input type="color" id="pBg" value="${p.bg}">`)}
     ${row("Master volume", `<input type="range" min="0" max="1" step=".01" value="${App.masterVol}" id="pVol"><b>${Math.round(App.masterVol * 100)}%</b>`)}
     <div class="ihead">Project file</div>
     <button class="rowbtn" data-act="saveProject">Save project (.kilnvid)</button>
     <button class="rowbtn" data-act="openProject">Open project…</button>
     <div class="note">The project file holds the edit. Your footage stays in this browser's storage, so a saved
     project reopens with its clips already attached.</div>`;
}

/* ---------------- edits ---------------- */
function commit(label) {
  M.commit(App.hist, App.project, label);
  syncStatus();
}
function refresh({ silent, noTimeline } = {}) {
  /* Anything that calls refresh has changed the edit, and the edit is what the
     preview draws. Without this the model updated and the picture did not, so
     a scale or colour change only appeared once something else — moving the
     playhead, resizing — happened to mark the frame dirty. */
  invalidate();
  if (!noTimeline) timeline.render();      // a live drag repaints its own clip
  syncStatus();
  if (!silent) { renderInspector(); renderTransitions(); }
  renderFrameBar();
  renderCropMenu();
  paintCropBox();
}
function setSelection(ids, reveal = false) {
  invalidate();
  // picking a clip picks whatever is linked to it, until they are unlinked
  App.selection = M.withLinked(App.project, ids);
  /* Move the playhead onto the clip when it is not already there. Editing a
     clip you cannot see was the whole of "the colour controls do not update":
     they did, on a frame that was not on screen. */
  if (reveal && ids.length === 1) {
    const c = M.findClip(App.project, ids[0]);
    if (c && (App.playhead < c.start || App.playhead > M.clipEnd(c)))
      seek(c.start + Math.min(.25, c.dur / 2));
  }
  timeline.render();
  renderInspector();
  renderTransitions();
  renderFrameBar();
  renderCropMenu();
  paintCropBox();
  const c = firstSelected();
  $("transSel").value = M.normaliseTransition(c?.transIn)?.type || "none";
}

async function addMediaFiles(files) {
  const list = [...files];
  if (!list.length) return;
  status("Importing…");
  let added = 0;
  for (const f of list) {
    try {
      const m = await importFile(f);
      App.project.media.push(m);
      added++;
    } catch (e) { toast(e.message, "bad"); }
  }
  status("Ready");
  if (added) {
    commit("Import media");
    renderAll();
    toast(`${added} file${added === 1 ? "" : "s"} imported`);
  }
}
/* drop a media item onto the first track that can take it, after what is there */
function addToTimeline(mediaId, atTime = null, trackId = null) {
  const p = App.project;
  const media = p.media.find(m => m.id === mediaId);
  if (!media) return null;
  const kind = media.kind === "audio" ? "audio" : "video";
  const track = p.tracks.find(t => t.id === trackId && t.kind === kind)
    || p.tracks.filter(t => t.kind === kind).sort((a, b) => a.clips.length - b.clips.length)[0]
    || p.tracks.find(t => t.kind === kind);
  if (!track) return null;
  const at = atTime ?? track.clips.reduce((m, c) => Math.max(m, M.clipEnd(c)), 0);
  const wasEmpty = !p.tracks.some(t => t.clips.length);
  const clip = M.makeClip(media, at, { kind: media.kind, dur: media.dur, name: media.name });
  M.addClip(track, clip);

  /* A video that carries sound gets that sound on the timeline as its own
     clip, linked to the picture. Sound you cannot see is sound you cannot
     edit, and hiding it inside the video clip meant every volume or fade
     decision had to be made through a panel. */
  if (media.kind === "video" && media.hasAudio) {
    const aTrack = p.tracks.filter(t => t.kind === "audio")
      .find(t => !t.clips.some(c => at < M.clipEnd(c) && c.start < at + media.dur))
      || p.tracks.find(t => t.kind === "audio");
    if (aTrack) {
      const sound = M.makeClip(media, at, {
        kind: "audio", dur: media.dur, name: (media.name || "Clip") + " audio",
      });
      sound.linkedTo = clip.id;
      clip.linkedTo = sound.id;
      clip.muted = true;                 // the audio clip is the one that plays it
      M.addClip(aTrack, sound);
    }
  }
  commit("Add clip");
  refresh();
  // an empty timeline has no length to fit, so it boots at maximum zoom —
  // fit again as soon as there is something to measure
  if (wasEmpty) timeline.zoomToFit();
  setSelection([clip.id]);
  return clip;
}

const ACT = {
  import: () => $("fileIn").click(),
  openProject: () => $("projIn").click(),
  addToTimeline: () => { App.poolSel.forEach(id => addToTimeline(id)); },
  play: () => { setPlaying(!App.playing); },
  toStart: () => seek(0),
  toEnd: () => seek(M.duration(App.project)),
  back1: () => seek(App.playhead - 1 / App.project.fps),
  fwd1: () => seek(App.playhead + 1 / App.project.fps),
  split: () => {
    const ids = App.selection.length ? App.selection : hitClipsAtPlayhead();
    let n = 0;
    for (const id of ids) {
      const track = M.trackOf(App.project, id), clip = M.findClip(App.project, id);
      if (track && clip && M.splitClip(track, clip, App.playhead)) n++;
    }
    if (!n) return toast("Put the playhead inside a clip to split it", "warn");
    commit("Split clip"); refresh(); toast(`Split ${n} clip${n === 1 ? "" : "s"}`);
  },
  delete: () => {
    if (!App.selection.length) return toast("Select a clip first", "warn");
    M.withLinked(App.project, App.selection).forEach(id => M.removeClip(App.project, id));
    setSelection([]); commit("Delete clip"); refresh();
  },
  /* The magnet: no gaps anywhere. It is one action rather than a mode, so a
     deliberate gap stays a deliberate gap until it is asked to close. */
  closeGaps: () => {
    let moved = 0;
    const tracks = App.selection.length
      ? [...new Set(App.selection.map(id => M.trackOf(App.project, id)).filter(Boolean))]
      : App.project.tracks;
    tracks.forEach(t => { if (!t.locked) moved += M.closeGaps(t); });
    if (!moved) return toast("No gaps to close");
    commit("Close gaps"); refresh();
    toast(`Closed ${moved} gap${moved === 1 ? "" : "s"}`);
  },

  ripple: () => {
    if (!App.selection.length) return toast("Select a clip first", "warn");
    App.selection.forEach(id => M.rippleDelete(App.project, id));
    setSelection([]); commit("Ripple delete"); refresh();
  },
  duplicate: () => {
    const out = [];
    for (const id of App.selection) {
      const track = M.trackOf(App.project, id), clip = M.findClip(App.project, id);
      if (!track || !clip) continue;
      const copy = structuredClone(clip);
      copy.id = M.uid("c");
      copy.start = M.clipEnd(clip);
      M.addClip(track, copy);
      out.push(copy.id);
    }
    if (out.length) { commit("Duplicate clip"); refresh(); setSelection(out); }
  },
  /* Stabilisation writes ordinary keyframes, so what it decided is visible in
     the Animate panel and can be edited or thrown away like anything else. */
  stabilise: async () => {
    const c = firstSelected();
    if (!c) return toast("Select a clip first", "warn");
    const media = M.mediaOf(App.project, c);
    if (!media || media.kind !== "video") return toast("Only video clips can be stabilised", "warn");
    if (App.stabilising) return;
    App.stabilising = true;
    renderInspector();
    try {
      const r = await analyseShake(media, c, {
        onProgress: k => { const el = $("stabBar"); if (el) el.style.width = Math.round(k * 100) + "%"; },
      });
      needTransform(c);
      c.keys.x = r.x; c.keys.y = r.y;
      c.scale = Math.max(c.scale || 1, r.zoom);
      c.stabilised = true;
      commit("Stabilise"); refresh();
      toast(`Stabilised — ${r.shake}px of shake taken out over ${r.samples} samples`);
    } catch (e) {
      toast(e.message || "Could not stabilise that clip", "warn");
    } finally {
      App.stabilising = false;
      renderInspector();
    }
  },
  unstabilise: () => {
    const c = firstSelected();
    if (!c) return;
    delete c.keys.x; delete c.keys.y;
    c.stabilised = false;
    commit("Remove stabilisation"); refresh();
  },

  /* Applying a transition also shows it: the playhead moves to the cut, which
     is the only place it can be seen. */
  transPick: id => {
    const c = firstSelected();
    if (!c) return toast("Select a clip first", "warn");
    const edge = App.transEdge || "in";
    const dur = Math.min(+($("trDur")?.value || .5), Math.max(.1, c.dur / 2));
    const def = id === "none" ? null : { type: id, dur };
    edge === "in" ? (c.transIn = def) : (c.transOut = def);
    commit("Transition"); refresh();
    if (def) {
      const at = edge === "in" ? c.start + dur * .5 : M.clipEnd(c) - dur * .5;
      seek(at);
      toast(`${M.transitionById(id).name} on the ${edge === "in" ? "start" : "end"}`);
    } else toast("Transition removed");
  },
  transBoth: () => {
    const c = firstSelected();
    if (!c) return;
    const src = c.transIn || c.transOut;
    if (!src) return toast("Pick a transition first", "warn");
    c.transIn = { ...src }; c.transOut = { ...src };
    commit("Transition"); refresh();
    toast("On both ends");
  },

  /* Taking something out of the media list. Anything of it on the timeline
     goes too — leaving clips pointing at media that is gone would give a
     timeline full of holes that draw nothing. */
  removeMedia: id => {
    const media = App.project.media.find(m => m.id === id);
    if (!media) return;
    const used = App.project.tracks.reduce((n, t) => n + t.clips.filter(c => c.mediaId === id).length, 0);
    if (used && !confirm(`${media.name} is used by ${used} clip${used === 1 ? "" : "s"}. Remove it and them?`)) return;
    App.project.tracks.forEach(t => { t.clips = t.clips.filter(c => c.mediaId !== id); });
    App.project.media = App.project.media.filter(m => m.id !== id);
    App.poolSel = App.poolSel.filter(x => x !== id);
    setSelection(App.selection.filter(sid => M.findClip(App.project, sid)));
    /* Keep the loaded object aside rather than freeing it. Undo restores the
       edit from a JSON snapshot, which carries the media's name and id but not
       its decoded element — so throwing the element away here would bring the
       clip back as an empty frame. Revoking the object URL would make that
       permanent. */
    App.mediaBin.set(id, media);
    try { media.el?.pause?.(); } catch {}
    commit("Remove media"); renderAll();
    toast(`Removed ${media.name}${used ? ` and ${used} clip${used === 1 ? "" : "s"}` : ""}`);
  },

  cropOpen: () => {
    const menu = $("cropMenu"), btn = $("cropBtn");
    const open = menu.hidden;
    document.querySelectorAll(".dropmenu").forEach(m => { m.hidden = true; });
    menu.hidden = !open;
    renderCropMenu();
    if (!menu.hidden) {
      // above the button if it fits, below if it does not
      const r = btn.getBoundingClientRect();
      const h = Math.min(menu.scrollHeight + 12, innerHeight * .7);
      const above = r.top - h - 8 > 8;
      menu.style.left = Math.max(8, Math.min(innerWidth - 244, r.left + r.width / 2 - 118)) + "px";
      menu.style.top = (above ? r.top - h - 8 : Math.min(innerHeight - h - 8, r.bottom + 8)) + "px";
    }
    btn.classList.toggle("on", !menu.hidden || Crop.on);
  },
  cropClose: () => { $("cropMenu").hidden = true; $("cropBtn").classList.toggle("on", Crop.on); },
  cropApply: applyCrop,
  cropCancel: cancelCrop,

  /* Aspect ratio presets. They belong with cropping rather than with export:
     a 9:16 cut is an editing decision you need to see while you frame it, not
     a checkbox at the end that surprises you with what it left out. */
  ratio: id => {
    const spec = M.ratioById(id);
    if (!spec) return;
    // the selection if there is one, otherwise every visual clip in the project
    let clips = selectedClips().filter(c => c.kind !== "text" && c.kind !== "sticker");
    const wholeProject = !clips.length;
    if (wholeProject)
      clips = App.project.tracks.flatMap(t => t.clips).filter(c => c.kind !== "text" && c.kind !== "sticker");

    if (id === "free") {
      clips.forEach(c => { c.cropRatio = null; });
      commit("Free crop"); refresh();
      return toast("Crop edges unlocked");
    }
    if (id === "orig") {
      clips.forEach(c => { c.crop = { l: 0, t: 0, r: 0, b: 0 }; c.cropRatio = null; });
      const m = M.mediaOf(App.project, clips[0]);
      if (m?.w && m?.h) { App.project.w = m.w; App.project.h = m.h; }
      commit("Original aspect"); renderAll(); fitPreview();
      return toast(`Back to the source's own ${App.project.w}×${App.project.h}`);
    }

    App.project.w = spec.w; App.project.h = spec.h;
    clips.forEach(c => {
      const m = M.mediaOf(App.project, c);
      c.crop = M.cropForRatio(m?.w || spec.w, m?.h || spec.h, spec.r);
      c.cropRatio = spec.r;
      c.x = 0; c.y = 0; c.scale = 1;
    });
    commit("Aspect " + spec.label);
    renderAll(); fitPreview();
    toast(`${spec.label} — ${spec.sub} · ${spec.w}×${spec.h}` +
      (wholeProject ? ` · ${clips.length} clip${clips.length === 1 ? "" : "s"}` : ""));
  },

  /* Eyedropper: the next click on the preview reads the pixel under it and
     makes that the key colour. Reading the preview is enough — it is the same
     picture the export will key, at a smaller size. */
  pickKey: () => {
    App.picking = !App.picking;
    $("preview").classList.toggle("picking", App.picking);
    if (App.picking) toast("Click the colour to key out");
    renderInspector();
  },

  /* ---------------- layouts ----------------
     Picture-in-picture and split screen are not new machinery: the compositor
     already places every clip with its own position, scale and crop. These
     write those numbers so nobody has to work them out with a slider. */
  layout: kind => {
    const sel = selectedClips();
    if (!sel.length) return toast("Select the clips to arrange", "warn");
    const W = App.project.w, H = App.project.h;
    const set = (c, o) => { needTransform(c); Object.assign(c, o); };
    const clear = c => set(c, { x: 0, y: 0, scale: 1, rot: 0, crop: { l: 0, t: 0, r: 0, b: 0 } });

    if (kind.startsWith("pip")) {
      // the front clip shrinks into a corner; anything under it fills the frame
      const front = sel[sel.length - 1];
      const rest = sel.slice(0, -1);
      rest.forEach(c => { clear(c); });
      clear(front);
      const s = 0.3, pad = 0.04;
      set(front, {
        scale: s,
        x: (kind.endsWith("tr") || kind.endsWith("br") ? 1 : -1) * (W / 2 - (W * s) / 2 - W * pad),
        y: (kind.endsWith("tr") ? -1 : 1) * (H / 2 - (H * s) / 2 - H * pad),
      });
      if (!rest.length) toast("Put another clip on the track below to sit behind it");
    } else if (kind === "split-lr" || kind === "split-tb") {
      const two = sel.slice(0, 2);
      if (two.length < 2) return toast("Select two clips for a split screen", "warn");
      const lr = kind === "split-lr";
      two.forEach((c, i) => {
        clear(c);
        /* Keep the middle half of each shot. The compositor fits whatever is
           left of the source into the frame, so cropping half the width makes
           it draw at half the width — which is exactly the half to move into
           place. Cropping one side instead would fill the frame again. */
        set(c, {
          crop: lr ? { l: .25, t: 0, r: .25, b: 0 } : { l: 0, t: .25, r: 0, b: .25 },
          scale: 1,
          x: lr ? (i === 0 ? -W / 4 : W / 4) : 0,
          y: lr ? 0 : (i === 0 ? -H / 4 : H / 4),
        });
      });
    }
    commit("Layout"); refresh();
    toast(kind.startsWith("pip") ? "Picture in picture" : "Split screen");
  },

  addText: (styleId = "title") => {
    const style = M.TITLE_STYLES.find(t => t.id === styleId) || M.TITLE_STYLES[0];
    const track = overlayTrack(App.playhead, 4);
    const clip = M.makeClip(null, App.playhead, {
      kind: "text", dur: 4, name: style.name, text: style.name === "Quote" ? "“Say something”" : "Your title here",
      fxTransform: true,            // the styles place themselves in the frame
      ...style.o,
    });
    M.addClip(track, clip);
    commit("Add text"); refresh(); setSelection([clip.id]);
    document.querySelector('[data-it="iText"]')?.click();
    // the content box is the first thing anyone wants, so put the cursor in it
    const ta = document.querySelector('#iText textarea[data-prop="text"]');
    if (ta) { ta.focus(); ta.select(); }
    toast(`${style.name} added — type to replace it`);
  },
  titleStyle: id => {
    const c = firstSelected();
    const style = M.TITLE_STYLES.find(t => t.id === id);
    if (!c || !style) return;
    needTransform(c);
    Object.assign(c, style.o);
    c.name = style.name;
    commit("Title style"); refresh();
  },
  setAlign: a => {
    const c = firstSelected();
    if (!c) return;
    c.align = a;
    commit("Align"); refresh();
  },
  addSticker: (emoji = "✨") => {
    const track = overlayTrack(App.playhead, 3);
    const clip = M.makeClip(null, App.playhead, {
      kind: "sticker", dur: 3, name: "Sticker " + emoji, text: emoji, size: 160, fxTransform: true,
    });
    M.addClip(track, clip);
    commit("Add sticker"); refresh(); setSelection([clip.id]);
    document.querySelector('[data-it="iText"]')?.click();
    toast("Pick any sticker from the library on the right");
  },
  recordVoice: async () => {
    if (App.recorder) {
      const file = await App.recorder.stop();
      App.recorder = null;
      $("voiceBtn").classList.remove("on");
      $("voiceBtn").textContent = "● Voice";
      await addMediaFiles([file]);
      const m = App.project.media[App.project.media.length - 1];
      if (m) addToTimeline(m.id, App.recStart ?? 0);
      return;
    }
    try {
      App.recStart = App.playhead;
      App.recorder = await recordVoice(lvl => {
        $("voiceBtn").textContent = "■ Stop " + "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor(lvl * 8))];
      });
      $("voiceBtn").classList.add("on");
      toast("Recording — press Voice again to stop");
    } catch { toast("Microphone permission was refused", "bad"); }
  },
  deleteTrack: id => {
    const p = App.project;
    if (p.tracks.length <= 1) return toast("A project needs at least one track", "warn");
    const t = p.tracks.find(t => t.id === id);
    if (!t) return;
    const n = t.clips.length;
    p.tracks = p.tracks.filter(x => x.id !== id);
    App.selection = App.selection.filter(id2 => !t.clips.some(c => c.id === id2));
    commit("Delete track"); renderAll();
    toast(n ? `${t.name} and ${n} clip${n === 1 ? "" : "s"} deleted` : `${t.name} deleted`);
  },
  toggleTrack: id => {
    const t = App.project.tracks.find(t => t.id === id);
    if (!t) return;
    if (t.kind === "audio") t.muted = !t.muted; else t.hidden = !t.hidden;
    commit("Toggle track"); renderAll();
  },
  addVideoTrack: () => {
    const n = App.project.tracks.filter(t => t.kind === "video").length + 1;
    App.project.tracks.unshift({ id: M.uid("t"), kind: "video", name: `Video ${n}`, hidden: false, locked: false, muted: false, clips: [] });
    commit("Add track"); renderAll();
  },
  addAudioTrack: () => {
    const n = App.project.tracks.filter(t => t.kind === "audio").length + 1;
    App.project.tracks.push({ id: M.uid("t"), kind: "audio", name: `Audio ${n}`, hidden: false, locked: false, muted: false, clips: [] });
    commit("Add track"); renderAll();
  },
  undo: () => {
    if (!M.canUndo(App.hist)) return;
    App.hist.i--;
    restore();
  },
  redo: () => {
    if (!M.canRedo(App.hist)) return;
    App.hist.i++;
    restore();
  },
  /* Three ways to reach the end: stop, start again, or turn round. Ping-pong
     is the one worth having for a short clip you are judging — it keeps the
     movement in front of you without the jump back to the start. */
  loopMode: () => {
    const order = ["once", "loop", "pong"];
    App.loop = order[(order.indexOf(App.loop) + 1) % order.length];
    App.direction = 1;
    syncLoopUi();
    toast({ once: "Plays once", loop: "Loops", pong: "Bounces back and forth" }[App.loop]);
  },
  snap: () => {
    App.snapping = !App.snapping;
    $("snapBtn").classList.toggle("on", App.snapping);
  },
  zoomIn: () => timeline.zoom(1.3),
  zoomOut: () => timeline.zoom(1 / 1.3),
  zoomFit: () => timeline.zoomToFit(),
  fitFrame: () => { const c = firstSelected(); if (c) { c.scale = 1; c.x = c.y = 0; commit("Fit"); refresh(); } },
  resetTransform: () => {
    const c = firstSelected();
    if (!c) return;
    Object.assign(c, { x: 0, y: 0, scale: 1, rot: 0, flipH: false, flipV: false, opacity: 1, crop: { l: 0, t: 0, r: 0, b: 0 } });
    commit("Reset transform"); refresh();
  },
  unlinkAudio: () => {
    const c = firstSelected();
    const other = M.linkedOf(App.project, c);
    if (!c || !other) return toast("This clip has no linked audio", "warn");
    c.linkedTo = null; other.linkedTo = null;
    commit("Unlink audio"); refresh();
    setSelection([c.id]);
    toast("Unlinked — the picture and the sound move on their own now");
  },
  relinkAudio: () => {
    const [a, b] = selectedClips();
    if (!a || !b || a.kind === b.kind) return toast("Select a video clip and an audio clip", "warn");
    a.linkedTo = b.id; b.linkedTo = a.id;
    commit("Link audio"); refresh();
    toast("Linked");
  },
  detachAudio: () => {
    const c = firstSelected();
    if (!c?.mediaId) return toast("Select a video clip first", "warn");
    const audioTrack = App.project.tracks.find(t => t.kind === "audio");
    const copy = structuredClone(c);
    copy.id = M.uid("c"); copy.kind = "audio"; copy.name = (c.name || "Clip") + " audio";
    M.addClip(audioTrack, copy);
    c.muted = true;
    commit("Detach audio"); refresh();
    toast("Audio moved to its own track");
  },
  clearBg: () => { const c = firstSelected(); if (c) { c.bg = ""; commit("Text background"); refresh(); } },
  saveProject: () => {
    const blob = new Blob([M.serialize(App.project)], { type: "application/json" });
    download(blob, `${App.project.name || "project"}.kilnvid`);
    toast("Project saved");
  },
  exportOpen: () => {
    if (App.exporting) return toast("An export is already running", "warn");
    if (!M.duration(App.project)) return toast("The timeline is empty", "warn");
    syncExportUi();
    $("expNote").textContent = canEncode()
      ? "Rendering happens on your machine — nothing is uploaded."
      : "This browser cannot encode video (WebCodecs unavailable).";
    $("expGo").disabled = !canEncode();
    $("exportModal").hidden = false;
  },
  exportCancel: () => { App.cancelExport = true; $("exportModal").hidden = true; },
  exportStart: doExport,
  sample: generateSample,
};
/* titles and stickers belong on a track that is free here — like every editor,
   they stack above the footage rather than replacing it */
function overlayTrack(at, dur) {
  const tracks = App.project.tracks;
  /* A title has to be IN FRONT of the footage, and the compositor draws the
     first track last — so "in front" means a lower index. Taking any free
     track put titles underneath the video, where they rendered perfectly and
     were never seen. The track has to be free *and* above whatever is playing.
     */
  const covered = tracks.findIndex(t =>
    t.kind === "video" && !t.hidden && t.clips.some(c => at < M.clipEnd(c) && c.start < at + dur));
  const limit = covered === -1 ? tracks.length : covered;
  const free = tracks.slice(0, limit).find(t => t.kind === "video" && !t.locked &&
    !t.clips.some(c => at < M.clipEnd(c) && c.start < at + dur));
  if (free) return free;
  const n = tracks.filter(t => t.kind === "video").length + 1;
  const track = { id: M.uid("t"), kind: "video", name: `Video ${n}`, hidden: false, locked: false, muted: false, clips: [] };
  tracks.unshift(track);
  return track;
}
/* right-click on a clip: the edits people reach for most, where the clip is */
function openClipMenu(id, x, y) {
  setSelection([id]);
  const clip = M.findClip(App.project, id);
  if (!clip) return;
  const items = [
    ["Split at playhead", "split"],
    ["Duplicate", "duplicate"],
    M.linkedOf(App.project, clip) ? ["Unlink audio", "unlinkAudio"] : ["Detach audio", "detachAudio"],
    null,
    ["Delete", "delete"],
    ["Ripple delete (close the gap)", "ripple"],
    ["Close all gaps (magnetic)", "closeGaps"],
  ];
  const menu = $("clipMenu");
  menu.innerHTML = items.map(it => it === null ? `<div class="msep"></div>`
    : `<button class="mi" data-act="${it[1]}">${esc(it[0])}</button>`).join("");
  menu.style.left = Math.min(x, innerWidth - 210) + "px";
  menu.style.top = Math.min(y, innerHeight - 200) + "px";
  menu.classList.add("on");
}
const closeClipMenu = () => $("clipMenu").classList.remove("on");

function hitClipsAtPlayhead() {
  return App.project.tracks.flatMap(t => {
    const c = M.clipAt(t, App.playhead);
    return c ? [c.id] : [];
  });
}
function restore() {
  const step = App.hist.steps[App.hist.i];
  if (!step) return;
  const restored = M.deserialize(step.state);
  // keep the loaded media objects; only the edit is versioned
  const byId = new Map(App.project.media.map(m => [m.id, m]));
  App.project.name = restored.name;
  App.project.w = restored.w; App.project.h = restored.h; App.project.fps = restored.fps; App.project.bg = restored.bg;
  App.project.tracks = restored.tracks;
  App.project.media = restored.media.map(m => byId.get(m.id) || App.mediaBin.get(m.id) || m);
  App.selection = [];
  renderAll();
}

/* ---------------- looks ---------------- */
const LOOKS = {
  none:  { brightness: 1, contrast: 1, saturate: 1, hue: 0, sepia: 0, grayscale: 0 },
  warm:  { brightness: 1.05, contrast: 1.05, saturate: 1.15, hue: -8, sepia: .12, grayscale: 0 },
  cool:  { brightness: 1.02, contrast: 1.08, saturate: 1.05, hue: 12, sepia: 0, grayscale: 0 },
  bw:    { brightness: 1.05, contrast: 1.15, saturate: 0, hue: 0, sepia: 0, grayscale: 1 },
  sepia: { brightness: 1.02, contrast: 1.02, saturate: .8, hue: 0, sepia: .7, grayscale: 0 },
  punch: { brightness: 1.03, contrast: 1.3, saturate: 1.4, hue: 0, sepia: 0, grayscale: 0 },
  fade:  { brightness: 1.1, contrast: .82, saturate: .85, hue: 0, sepia: .1, grayscale: 0 },
};

/* ---------------- a test clip, generated here ----------------
   So the editor can be tried — and tested — without hunting for footage. */
async function generateSample() {
  status("Generating…");
  const cv = document.createElement("canvas");
  cv.width = 1280; cv.height = 720;
  const c = cv.getContext("2d");
  const stream = cv.captureStream(30);
  /* Give the sample a soundtrack — a quiet two-note figure. A test clip with
     no audio cannot be used to try any of the audio features, which is most of
     what someone reaches for a test clip to do. */
  let ac = null;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();
    const gain = ac.createGain();
    gain.gain.value = .12;
    gain.connect(dest);
    for (const [freq, at] of [[220, 0], [330, 1.2], [262, 2.4], [392, 3.6]]) {
      const o = ac.createOscillator();
      o.type = "sine";
      o.frequency.value = freq;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, ac.currentTime + at);
      g.gain.linearRampToValueAtTime(1, ac.currentTime + at + .05);
      g.gain.linearRampToValueAtTime(0, ac.currentTime + at + 1.1);
      o.connect(g).connect(gain);
      o.start(ac.currentTime + at);
      o.stop(ac.currentTime + at + 1.2);
    }
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  } catch { /* no audio here; the clip is still worth having */ }
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm"]
    .find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.start();
  const t0 = performance.now();
  await new Promise(done => {
    const frame = () => {
      const t = (performance.now() - t0) / 1000;
      const g = c.createLinearGradient(0, 0, 1280, 720);
      g.addColorStop(0, `hsl(${(t * 40) % 360} 70% 22%)`);
      g.addColorStop(1, `hsl(${(t * 40 + 90) % 360} 70% 42%)`);
      c.fillStyle = g; c.fillRect(0, 0, 1280, 720);
      c.fillStyle = "rgba(255,255,255,.92)";
      c.beginPath();
      c.arc(640 + Math.cos(t * 2) * 320, 360 + Math.sin(t * 3) * 170, 64, 0, 7);
      c.fill();
      c.font = "600 54px system-ui, sans-serif";
      c.textAlign = "center";
      c.fillText(`Kiln test clip · ${t.toFixed(1)}s`, 640, 660);
      if (t >= 5) { rec.stop(); ac?.close?.(); done(); return; }
      requestAnimationFrame(frame);
    };
    frame();
  });
  await new Promise(r => { rec.onstop = r; });
  const file = new File([new Blob(chunks, { type: mime })], "test-clip.webm", { type: mime });
  await addMediaFiles([file]);
  const m = App.project.media[App.project.media.length - 1];
  if (m) addToTimeline(m.id, 0);
  status("Ready");
}

/* ---------------- export ---------------- */
/* Free up to 1080p. Larger frames are many times the encode time in a tab,
   and that is what the paid tier is meant to cover. */
const PREMIUM = new Set(["1440p", "4K"]);

/* Quality presets set the bitrate the way a person would: by intent. */
const EXPORT_PRESETS = {
  web:      { mbps: { "480p": 1.5, "720p": 3,  "1080p": 6,  "1440p": 10, "4K": 20 }, q: 85,  audio: "96"  },
  standard: { mbps: { "480p": 2.5, "720p": 5,  "1080p": 10, "1440p": 18, "4K": 35 }, q: 100, audio: "128" },
  high:     { mbps: { "480p": 4,   "720p": 8,  "1080p": 16, "1440p": 28, "4K": 55 }, q: 115, audio: "192" },
  master:   { mbps: { "480p": 8,   "720p": 16, "1080p": 30, "1440p": 50, "4K": 90 }, q: 140, audio: "256" },
};
const CODECS = {
  mp4:  [["avc", "H.264 · plays everywhere"], ["hevc", "H.265 · smaller, less support"]],
  webm: [["vp09", "VP9 · good compression"], ["av01", "AV1 · best, slowest"]],
};

function syncExportUi() {
  const res = $("expRes").value, fmt = $("expFmt").value;
  const preset = $("expPreset").value;
  // the codec list follows the container
  const list = CODECS[fmt] || CODECS.mp4;
  if ($("expCodec").dataset.for !== fmt) {
    $("expCodec").dataset.for = fmt;
    $("expCodec").innerHTML = list.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  }
  if (preset !== "custom") {
    const P = EXPORT_PRESETS[preset];
    $("expBr").value = String(Math.round(P.mbps[res] ?? 10));
    $("expQ").value = String(P.q);
    $("expAud").value = P.audio;
  }
  $("expBrV").textContent = $("expBr").value + " Mbps";
  $("expQV").textContent = $("expQ").value + "%";

  // the output follows the project's shape, so a 9:16 edit exports 9:16
  const size = outputSize(App.project, res);
  const fps = +$("expFps").value;
  const shape = Math.abs(App.project.w / App.project.h - 16 / 9) < .01 ? ""
    : ` · ${(App.project.w / App.project.h).toFixed(2)}:1`;
  $("expOut").textContent = `${size.w}×${size.h} · ${fps} fps${shape}`;

  const secs = M.duration(App.project);
  $("expLen").textContent = fmtTime(secs);
  /* An estimate, and honestly a rough one: a modern encoder undershoots its
     ceiling on quiet footage, so this is the top of the range rather than a
     promise. */
  const vBits = (+$("expBr").value * 1e6) * secs;
  const aBits = (+$("expAud").value * 1000) * secs;
  const bytes = (vBits + aBits) / 8 * 1.02;            // ~2% for the container
  $("expSize").textContent = secs > 0
    ? (bytes > 1073741824 ? (bytes / 1073741824).toFixed(2) + " GB" : Math.max(1, Math.round(bytes / 1048576)) + " MB")
    : "—";

  const locked = PREMIUM.has(res);
  $("expPrem").hidden = !locked;
  $("expGo").disabled = locked || App.exporting;
  $("expGo").textContent = locked ? "1080p and below are free" : "Start export";
}
window.syncExportUi = syncExportUi;

async function doExport() {
  if (App.exporting) return;
  App.exporting = true;
  App.cancelExport = false;
  setPlaying(false);
  const preset = $("expRes").value, format = $("expFmt").value;
  const fps = +$("expFps").value, quality = +$("expQ").value / 100;
  if (PREMIUM.has(preset)) {
    toast("2K and 4K are a premium export — 1080p and below are free", "warn");
    App.exporting = false;
    return;
  }
  const bitrate = +$("expBr").value * 1e6;
  const audioKbps = +$("expAud").value;
  $("expGo").disabled = true;
  setExportBusy(0);
  const t0 = performance.now();
  try {
    const blob = await exportVideo(App.project, {
      preset, format, fps, quality, bitrate,
      audioBitrate: audioKbps * 1000, audio: audioKbps > 0,
      codec: $("expCodec").value || undefined,
    }, {
      onStage: s => { $("expNote").textContent = s + "…"; status(s); },
      onProgress: p => { $("expBar").style.width = Math.round(p * 100) + "%"; setExportBusy(p); },
      onError: e => toast("Encoder error: " + e.message, "bad"),
      cancelled: () => App.cancelExport,
    });
    if (!blob) { toast("Export cancelled", "warn"); return; }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    download(blob, `${App.project.name || "video"}-${preset}.${format}`);
    $("expNote").textContent = `Done — ${(blob.size / 1048576).toFixed(1)} MB in ${secs}s`;
    toast(`Exported ${preset} ${format.toUpperCase()} · ${(blob.size / 1048576).toFixed(1)} MB`);
  } catch (e) {
    toast("Export failed: " + (e?.message || e), "bad");
    $("expNote").textContent = "Export failed: " + (e?.message || e);
  } finally {
    App.exporting = false;
    $("expGo").disabled = false;
    $("expBar").style.width = "0%";
    setExportBusy(null);
    status("Ready");
  }
}

/* An export takes minutes, and a button that still looks ready to press is an
   invitation to press it again. It goes flat, says how far along it is, and
   fills as it goes. */
function setExportBusy(p) {
  const btn = document.querySelector('.optbar [data-act="exportOpen"]');
  if (!btn) return;
  if (p === null) {
    btn.classList.remove("busy");
    btn.style.removeProperty("--done");
    btn.textContent = "Export";
    btn.removeAttribute("aria-busy");
    return;
  }
  btn.classList.add("busy");
  btn.setAttribute("aria-busy", "true");
  btn.style.setProperty("--done", Math.round(p * 100) + "%");
  btn.textContent = `Exporting ${Math.round(p * 100)}%`;
}

/* ---------------- menus ---------------- */
const MENUS = {
  mFile: [["Import media…", "import", "⌘I"], ["Generate a test clip", "sample"], null,
          ["Save project", "saveProject", "⌘S"], ["Open project…", "openProject", "⌘O"], null,
          ["Export video…", "exportOpen", "⌘E"]],
  mEdit: [["Undo", "undo", "⌘Z"], ["Redo", "redo", "⇧⌘Z"], null,
          ["Split at playhead", "split", "S"], ["Delete", "delete", "⌫"], ["Ripple delete", "ripple", "⇧⌫"],
          ["Duplicate", "duplicate", "⌘D"]],
  mClip: [["Add text", "addText"], ["Add sticker", "addSticker"], ["Record voiceover", "recordVoice"], null,
          ["Detach audio", "detachAudio"], ["Unlink audio", "unlinkAudio"],
          ["Reset transform", "resetTransform"], ["Fit to frame", "fitFrame"]],
  mView: [["Zoom in", "zoomIn"], ["Zoom out", "zoomOut"], ["Fit timeline", "zoomFit"], null,
          ["Add video track", "addVideoTrack"], ["Add audio track", "addAudioTrack"]],
};

/* ---------------- wiring ---------------- */
function wire() {
  for (const [id, items] of Object.entries(MENUS)) {
    $(id).innerHTML = items.map(it => it === null ? `<div class="msep"></div>`
      : `<button class="mi" data-act="${it[1]}">${esc(it[0])}${it[2] ? `<span class="sc">${it[2]}</span>` : ""}</button>`).join("");
  }
  document.querySelectorAll("[data-menu]").forEach(m => {
    m.querySelector(".menu-t").addEventListener("click", e => {
      e.stopPropagation();
      const was = m.classList.contains("open");
      document.querySelectorAll("[data-menu]").forEach(x => x.classList.remove("open"));
      m.classList.toggle("open", !was);
    });
  });

  document.addEventListener("click", e => {
  const mdel = e.target.closest("[data-media-del]");
  if (mdel) { e.stopPropagation(); ACT.removeMedia(mdel.dataset.mediaDel); return; }
  const te = e.target.closest("[data-tedge]");
  if (te) { App.transEdge = te.dataset.tedge; renderTransitions(); return; }
  const tp = e.target.closest("[data-trans-pick]");
  if (tp) { ACT.transPick(tp.dataset.transPick); return; }
  const cm = e.target.closest("[data-crop]");
  if (cm) {
    const what = cm.dataset.crop;
    $("cropMenu").hidden = true;
    if (what === "free") startFreeCrop();
    else { cancelCrop(); ACT.ratio(what); }
    $("cropBtn").classList.toggle("on", Crop.on);
    return;
  }
  const fx = e.target.closest("[data-fx]");
  if (fx) {
    const c = firstSelected();
    if (c) {
      const prop = fx.dataset.fx;
      const now = !c[prop];
      c[prop] = now;
      /* Switching an effect off takes its keyframes with it. Animation on an
         effect that is not running is invisible work waiting to surprise
         whoever turns it back on. */
      let dropped = 0;
      if (!now) {
        for (const g of FX_KEY_GROUPS[prop] || []) dropped += M.clearGroupKeys(c, g);
      }
      commit("Toggle effect"); refresh();
      toast(now ? "Effect on"
        : dropped ? `Effect off — ${dropped} keyframe track${dropped === 1 ? "" : "s"} removed`
        : "Effect off");
    }
    return;
  }
  const rat = e.target.closest("[data-ratio]");
  if (rat) { ACT.ratio(rat.dataset.ratio); return; }
  const lay = e.target.closest("[data-layout]");
  if (lay) { ACT.layout(lay.dataset.layout); return; }
  const dm = e.target.closest("[data-drop]");
  if (dm) { openDropMenu(dm.dataset.drop); return; }
  const at = e.target.closest("[data-add-title]");
  if (at) { closeDropMenus(); ACT.addText(at.dataset.addTitle); return; }
  const as = e.target.closest("[data-add-sticker]");
  if (as) { closeDropMenus(); ACT.addSticker(as.dataset.addSticker); return; }
  const tspc = e.target.closest("[data-tspeed]");
  if (tspc) { applyTrackSpeed(+tspc.dataset.tspeed, true); renderSpeedPop(); return; }
  const tsp = e.target.closest("[data-track-speed]");
  if (tsp) { openSpeedPop(tsp.dataset.trackSpeed, tsp); return; }
  const tdel = e.target.closest("[data-track-del]");
  if (tdel) { ACT.deleteTrack(tdel.dataset.trackDel); return; }
  const ttog = e.target.closest("[data-track-toggle]");
  if (ttog) { ACT.toggleTrack(ttog.dataset.trackToggle); return; }
    if (!e.target.closest("#clipMenu")) closeClipMenu();
    const mi = e.target.closest(".mi");
    if (mi?.dataset.act) { ACT[mi.dataset.act]?.(); closeClipMenu(); }
    if (!e.target.closest("[data-menu]") || mi) document.querySelectorAll("[data-menu]").forEach(x => x.classList.remove("open"));
    const act = e.target.closest("[data-act]:not(.mi)");
    if (act) ACT[act.dataset.act]?.();
    const tab = e.target.closest(".itab");
    if (tab) {
      document.querySelectorAll(".itab").forEach(t => t.classList.toggle("on", t === tab));
      document.querySelectorAll(".ibody").forEach(b => b.classList.toggle("on", b.id === tab.dataset.it));
    }
    const mediaEl = e.target.closest("[data-media]");
    if (mediaEl) { App.poolSel = [mediaEl.dataset.media]; renderPool(); }
  });
  $("pool").addEventListener("dblclick", e => {
    const m = e.target.closest("[data-media]");
    if (m) addToTimeline(m.dataset.media);
  });

  // the eyedropper reads the preview where it was clicked
  // a popover that will not go away is worse than no popover
  document.addEventListener("pointerdown", e => {
    if (!e.target.closest(".menuwrap")) closeDropMenus();
    if (!$("speedPop").hidden && !e.target.closest("#speedPop,[data-track-speed]")) closeSpeedPop();
    if (!$("cropMenu").hidden && !e.target.closest("#cropMenu,#cropBtn")) ACT.cropClose();
  }, true);
  addEventListener("keydown", e => {
    if (Crop.on && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      e.stopPropagation();
      e.key === "Enter" ? applyCrop() : cancelCrop();
      return;
    }
    if (e.key !== "Escape") return;
    closeDropMenus();
    $("cropMenu").hidden = true;
    if (!$("speedPop").hidden) closeSpeedPop();
    if (!$("cropMenu").hidden) ACT.cropClose();
  });

  /* Double-clicking the picture edits the title that is on screen — the
     thing you are looking at is the thing you want to change. */
  $("preview").addEventListener("dblclick", () => {
    const here = visualClipsAt(App.project, App.playhead)
      .filter(c => c.kind === "text" || c.kind === "sticker");
    if (!here.length) return toast("No title or sticker at the playhead");
    editTextClip(here[0].id);
  });

  $("preview").addEventListener("click", e => {
    if (!App.picking) return;
    const c = firstSelected();
    App.picking = false;
    $("preview").classList.remove("picking");
    if (!c) return renderInspector();
    const cv = $("preview"), r = cv.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) / r.width * cv.width);
    const y = Math.round((e.clientY - r.top) / r.height * cv.height);
    try {
      const d = cv.getContext("2d").getImageData(x, y, 1, 1).data;
      c.keyColor = "#" + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, "0")).join("");
      c.chroma = true;
      commit("Key colour"); refresh();
      toast("Keying out " + c.keyColor);
    } catch { toast("Could not read that pixel", "warn"); renderInspector(); }
  });

  // inspector bindings
  $("app").addEventListener("input", e => {
    const t = e.target;
    const c = firstSelected();
    if (t.dataset.prop && c) {
      const path = t.dataset.prop;
      let v = t.type === "range" ? +t.value : t.value;
      /* Changing a keyed property at the playhead sets a keyframe there. Without
         this the slider moved the base value, valueAt kept returning the
         animated one, and the control looked broken — which is exactly what it
         was reported as. */
      if (M.KEYABLE.includes(path) && c.keys?.[path]?.length) {
        M.setKey(c, path, App.playhead, v);
        refresh({ silent: true });
        const b = t.parentElement.querySelector("b");
        if (b && t.type === "range") b.textContent = (+v).toFixed(t.step < 1 ? 2 : 0) + (b.textContent.match(/[^\d.\-]+$/)?.[0] || "");
        return;
      }
      if (path.startsWith("crop.")) {
        const edge = path.split(".")[1];
        c.crop[edge] = v;
        if (c.cropRatio) {
          // a locked ratio means the other axis follows whatever was dragged
          const m = M.mediaOf(App.project, c);
          c.crop = M.reflowCrop(c.crop, m?.w || App.project.w, m?.h || App.project.h, c.cropRatio, edge);
        }
      }
      else if (path === "speed") {
        const media = M.mediaOf(App.project, c);
        const srcLen = c.dur * c.speed;
        c.speed = v;
        c.dur = Math.max(.1, srcLen / v);
        void media;
      } else c[path] = v;
      const b = t.parentElement.querySelector("b");
      if (b && t.type === "range") b.textContent = (+v).toFixed(t.step < 1 ? 2 : 0) + (b.textContent.match(/[^\d.\-]+$/)?.[0] || "");
      refresh({ silent: true });
    }
    if (t.id === "trDur") {
      $("trDurV").textContent = (+t.value).toFixed(2) + "s";
      const c = firstSelected();
      const edge = App.transEdge || "in";
      const def = edge === "in" ? c?.transIn : c?.transOut;
      if (def) { def.dur = +t.value; refresh({ silent: true }); }
    }
    if (t.id === "emojiQ") {
      App.emojiQuery = t.value;
      const keep = t.selectionStart;
      renderInspector();
      const again = $("emojiQ");
      if (again) { again.focus(); again.setSelectionRange(keep, keep); }
    }
    if (t.id === "spVal") {
      $("spNum").textContent = (+t.value).toFixed(2) + "×";
      applyTrackSpeed(+t.value, false);
    }
    if (t.id === "pVol") { App.masterVol = +t.value; t.nextElementSibling.textContent = Math.round(App.masterVol * 100) + "%"; }
    if (t.id === "pName") { App.project.name = t.value; syncStatus(); }
    if (t.id === "expQ") $("expQV").textContent = t.value + "%";
    if (t.id === "projName") { App.project.name = t.value; }
  });
  $("app").addEventListener("change", e => {
    const t = e.target, c = firstSelected();
    if (t.id === "trDur") {
      $("trDurV").textContent = (+t.value).toFixed(2) + "s";
      const c = firstSelected();
      const edge = App.transEdge || "in";
      const def = edge === "in" ? c?.transIn : c?.transOut;
      if (def) { def.dur = +t.value; refresh({ silent: true }); }
    }
    if (t.id === "emojiQ") {
      App.emojiQuery = t.value;
      const keep = t.selectionStart;
      renderInspector();
      const again = $("emojiQ");
      if (again) { again.focus(); again.setSelectionRange(keep, keep); }
    }
    if (t.id === "spVal") { applyTrackSpeed(+t.value, true); renderSpeedPop(); }
    if (t.dataset.prop && c) commit("Adjust clip");
    if (t.dataset.trans && c) {
      const dur = c.transOut?.dur ?? c.transIn?.dur ?? .5;
      const def = t.value === "none" ? null : { type: t.value, dur };
      t.dataset.trans === "in" ? (c.transIn = def) : (c.transOut = def);
      commit("Transition"); refresh();
    }
    if (t.id === "pSize") {
      const p = PRESETS[t.value];
      App.project.w = p.w; App.project.h = p.h;
      commit("Project size"); renderAll(); fitPreview();
    }
    if (t.id === "pFps") { App.project.fps = +t.value; commit("Frame rate"); syncStatus(); }
    if (t.id === "pBg") { App.project.bg = t.value; commit("Background"); }
    if (t.id === "transSel" && c) {
      c.transIn = t.value === "none" ? null : { type: t.value, dur: c.transIn?.dur ?? .5 };
      commit("Transition"); refresh();
    }
  });
  $("app").addEventListener("click", e => {
    const c = firstSelected();
    const tog = e.target.closest("[data-toggle]");
    if (tog && c) { c[tog.dataset.toggle] = !c[tog.dataset.toggle]; commit("Toggle"); refresh(); }
    const look = e.target.closest("[data-look]");
    if (look && c) { Object.assign(c, LOOKS[look.dataset.look]); commit("Look"); refresh(); }
    const sp = e.target.closest("[data-speed]");
    if (sp && c) {
      const srcLen = c.dur * c.speed;
      c.speed = +sp.dataset.speed;
      c.dur = Math.max(.1, srcLen / c.speed);
      commit("Speed"); refresh();
    }
    const emo = e.target.closest("[data-emoji]");
    if (emo && c) {
      c.text = emo.dataset.emoji;
      c.name = (c.kind === "sticker" ? "Sticker " : "") + emo.dataset.emoji;
      commit("Sticker"); refresh();
    }
    const ts = e.target.closest("[data-title-style]");
    if (ts) { ACT.titleStyle(ts.dataset.titleStyle); return; }
    const al = e.target.closest("[data-align]");
    if (al) { ACT.setAlign(al.dataset.align); return; }
    const key = e.target.closest("[data-key]");
    if (key && c) {
      const prop = key.dataset.key;
      // the value it is showing right now, which is the base until keys exist
      M.setKey(c, prop, App.playhead, kv(c, prop));
      // animating something that is switched off would do nothing at all
      const group = M.groupOfProp(prop);
      if (group === "transform" || group === "animation") c.fxTransform = true;
      if (group === "colour") c.fxColor = true;
      commit("Keyframe"); refresh();
      toast(`Keyframe on ${prop} — ${(c.keys[prop] || []).length} now`);
    }
    const dk = e.target.closest("[data-delkey]");
    if (dk && c) {
      if (M.removeKey(c, dk.dataset.delkey, +dk.dataset.delkeyI)) {
        commit("Delete keyframe"); refresh();
        toast("Keyframe removed");
      }
      return;
    }
    const unkey = e.target.closest("[data-unkey]");
    if (unkey && c) { M.clearKeys(c, unkey.dataset.unkey); commit("Clear keyframes"); refresh(); }
  });

  // files in
  $("fileIn").addEventListener("change", e => { addMediaFiles(e.target.files); e.target.value = ""; });
  $("projIn").addEventListener("change", async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const loaded = M.deserialize(await f.text());
      App.project = loaded;
      status("Reattaching media…");
      const missing = await rehydrate(App.project);
      App.hist = M.makeHistory();
      commit("Open project");
      renderAll();
      status("Ready");
      toast(missing.length ? `Opened — ${missing.length} media file(s) missing` : "Project opened",
        missing.length ? "warn" : "ok");
    } catch (err) { toast("Could not open project: " + err.message, "bad"); }
  });
  const stage = $("stage");
  ["dragenter", "dragover"].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); $("dz").classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => stage.addEventListener(ev, () => $("dz").classList.remove("over")));
  stage.addEventListener("drop", e => { e.preventDefault(); addMediaFiles(e.dataTransfer.files); });

  // drag from the pool onto the timeline
  $("pool").addEventListener("dragstart", e => {
    const m = e.target.closest("[data-media]");
    if (m) e.dataTransfer.setData("text/kiln-media", m.dataset.media);
  });
  $("tlScroll").addEventListener("dragover", e => e.preventDefault());
  $("tlScroll").addEventListener("drop", e => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/kiln-media");
    if (!id) return;
    const trackEl = e.target.closest(".tl-track");
    const r = $("tlScroll").getBoundingClientRect();
    const at = timeline.pxToTime(e.clientX - r.left + $("tlScroll").scrollLeft);
    addToTimeline(id, Math.max(0, at), trackEl?.dataset.track);
  });

  for (const id of ["expPreset", "expRes", "expFmt", "expFps", "expAud", "expCodec"])
    $(id).addEventListener("change", syncExportUi);
  for (const id of ["expBr", "expQ"])
    $(id).addEventListener("input", () => { $("expPreset").value = "custom"; syncExportUi(); });

  addEventListener("keydown", e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const M_ = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.code === "Space") { e.preventDefault(); ACT.play(); return; }
    if (M_ && k === "z") { e.preventDefault(); e.shiftKey ? ACT.redo() : ACT.undo(); return; }
    if (M_ && k === "i") { e.preventDefault(); ACT.import(); return; }
    if (M_ && k === "s") { e.preventDefault(); ACT.saveProject(); return; }
    if (M_ && k === "o") { e.preventDefault(); ACT.openProject(); return; }
    if (M_ && k === "e") { e.preventDefault(); ACT.exportOpen(); return; }
    if (M_ && k === "d") { e.preventDefault(); ACT.duplicate(); return; }
    if (k === "s") { e.preventDefault(); ACT.split(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.shiftKey ? ACT.ripple() : ACT.delete(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); seek(App.playhead - (e.shiftKey ? 1 : 1 / App.project.fps)); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); seek(App.playhead + (e.shiftKey ? 1 : 1 / App.project.fps)); return; }
    if (e.key === "Home") { e.preventDefault(); ACT.toStart(); return; }
    if (e.key === "End") { e.preventDefault(); ACT.toEnd(); return; }
    if (e.key === "Escape") setSelection([]);
  });

  $("transSel").innerHTML = M.TRANSITIONS.map(t =>
    `<option value="${t.id}">${t.group ? t.group + " · " : ""}${t.name}</option>`).join("");
}

/* The Text and Sticker buttons open a small menu rather than inserting one
   fixed thing — picking the look up front is quicker than adding a default
   and then correcting it. */
function openDropMenu(id) {
  const menu = $(id);
  const wasOpen = !menu.hidden;
  document.querySelectorAll(".dropmenu").forEach(m => { m.hidden = true; });
  if (wasOpen) return;
  if (id === "textMenu") {
    menu.innerHTML = M.TITLE_STYLES.map(t =>
      `<button class="mi" data-add-title="${t.id}">${t.name}<i>${t.o.size}px</i></button>`).join("");
  } else {
    const quick = ["🔥", "✨", "❤️", "👍", "🎉", "💯", "😂", "⭐", "🚀", "👏", "😍", "💡"];
    menu.innerHTML =
      `<div class="quickem">${quick.map(e => `<button data-add-sticker="${e}">${e}</button>`).join("")}</div>
       <button class="mi" data-add-sticker="✨">All ${M.ALL_EMOJI.length} stickers…<i>search</i></button>`;
  }
  menu.hidden = false;
}
const closeDropMenus = () => document.querySelectorAll(".dropmenu").forEach(m => { m.hidden = true; });

/* Editing a title: select it, move the playhead onto it so it is on screen
   while it is being changed, open its panel, and put the cursor in the box. */
function editTextClip(id) {
  const clip = M.findClip(App.project, id);
  if (!clip) return;
  setSelection([id]);
  if (App.playhead < clip.start || App.playhead > M.clipEnd(clip)) seek(clip.start + clip.dur / 2);
  document.querySelector('[data-it="iText"]')?.click();
  document.body.classList.remove("foldR");
  const box = document.querySelector('#iText textarea[data-prop="text"], #iText .stcur');
  if (box) { box.focus(); box.select?.(); }
  else document.getElementById("emojiQ")?.focus();
}

/* ---------------- boot ---------------- */
timeline = new Timeline($("tlScroll"), {
  get project() { return App.project; },
  get selection() { return App.selection; },
  get playhead() { return App.playhead; },
  get snapping() { return App.snapping; },
  onChange: refresh,
  onSelect: (ids, reveal) => setSelection(ids, reveal),
  onSeek: seek,
  onSplit: id => { setSelection([id]); ACT.split(); },
  onEditText: editTextClip,
  onDeleteKey: (clipId, prop, i) => {
    const c = M.findClip(App.project, clipId);
    if (!c || !M.removeKey(c, prop, i)) return;
    commit("Delete keyframe"); refresh();
    toast(`Keyframe removed — ${(c.keys[prop] || []).length} left on ${prop}`);
  },
  onDelete: id => { setSelection([id]); ACT.delete(); },
  onContext: openClipMenu,
  commit,
});
wire();
wireCropBox();
syncLoopUi();
new ResizeObserver(fitPreview).observe(document.querySelector(".vwrap"));
addEventListener("resize", fitPreview);
M.commit(App.hist, App.project, "New project");
renderAll();
fitPreview();
timeline.zoomToFit();
requestAnimationFrame(loop);
status("Ready");

/* test + console handle */
/* a filmstrip arriving late repaints the timeline that is waiting for it */
window.__kilnStrip = () => { timeline.render(); };

window.Kiln = {
  App, M, ACT, timeline, addMediaFiles, addToTimeline, generateSample, seek,
  setSelection, doExport, exportVideo, renderAll, drawPreview, setExportBusy,
  duration: () => M.duration(App.project),
  clips: () => App.project.tracks.flatMap(t => t.clips),
};
