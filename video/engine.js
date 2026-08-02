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
import { exportVideo, PRESETS, supported as canEncode } from "./src/export.js";

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
    App.playhead += dt;
    const end = M.duration(App.project);
    if (App.playhead >= end) { App.playhead = end; setPlaying(false); }
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
  // audio-only clips still need their element running
  for (const { clip } of audibleClipsAt(p, t)) {
    const media = M.mediaOf(p, clip);
    if (!media?.el || media.kind === "image") continue;
    wanted.add(media.el);
    const want = sourceTime(clip, t);
    media.el.volume = clamp(gainAt(clip, t) * App.masterVol, 0, 1);
    media.el.playbackRate = clamp(clip.speed, .0625, 16);
    if (App.playing && media.el.paused) media.el.play().catch(() => {});
    if (!App.playing && Math.abs(media.el.currentTime - want) > .02) media.el.currentTime = want;
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
  renderTrackNames();
  renderInspector();
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
    </div>`).join("");
}
function renderTrackNames() {
  const host = $("tNames");
  host.innerHTML = App.project.tracks.map(t => `
    <div class="tname${t.kind === "audio" ? " audio" : ""}" data-tn="${t.id}">
      <button class="tg${t.hidden || t.muted ? " off" : ""}" data-tg="${t.id}" title="${t.kind === "audio" ? "Mute" : "Hide"}">
        ${t.kind === "audio" ? (t.muted ? "🔇" : "🔊") : (t.hidden ? "◌" : "◉")}</button>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</span>
    </div>`).join("");
}

/* ---------------- inspector ---------------- */
const row = (label, inner) => `<label class="fld"><span>${label}</span>${inner}</label>`;
const slider = (prop, min, max, step, v, unit = "", key = false) =>
  `<input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-prop="${prop}">
   <b>${typeof v === "number" ? (+v).toFixed(step < 1 ? 2 : 0) : v}${unit}</b>
   ${key ? `<button class="kbtn" data-key="${prop}" title="Add a keyframe here">◆</button>` : ""}`;

function renderInspector() {
  const c = firstSelected();
  const p = App.project;

  if (!c) {
    for (const id of ["iTransform", "iColor", "iAudio", "iText", "iKeys"])
      $(id).innerHTML = `<div class="empty">Select a clip on the timeline to edit it.</div>`;
  } else {
    $("iTransform").innerHTML =
      `<div class="ihead">Position &amp; scale</div>
       ${row("X", slider("x", -1920, 1920, 1, c.x, "px", true))}
       ${row("Y", slider("y", -1080, 1080, 1, c.y, "px", true))}
       ${row("Scale", slider("scale", .05, 4, .01, c.scale, "×", true))}
       ${row("Rotation", slider("rot", -180, 180, 1, c.rot, "°", true))}
       ${row("Opacity", slider("opacity", 0, 1, .01, c.opacity, "", true))}
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
         edges. The result is keyframes on X and Y — look in Animate to see them.</div>
       <div class="ihead">Crop</div>
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
      `<div class="ihead">Colour correction</div>
       ${row("Brightness", slider("brightness", 0, 2, .01, c.brightness))}
       ${row("Contrast", slider("contrast", 0, 2, .01, c.contrast))}
       ${row("Saturation", slider("saturate", 0, 3, .01, c.saturate))}
       ${row("Hue", slider("hue", -180, 180, 1, c.hue, "°"))}
       ${row("Blur", slider("blur", 0, 30, .5, c.blur, "px"))}
       <div class="ihead">Looks</div>
       <div class="chips">
         <button class="chip" data-look="none">Original</button>
         <button class="chip" data-look="warm">Warm</button>
         <button class="chip" data-look="cool">Cool</button>
         <button class="chip" data-look="bw">Black &amp; white</button>
         <button class="chip" data-look="sepia">Sepia</button>
         <button class="chip" data-look="punch">Punch</button>
         <button class="chip" data-look="fade">Faded</button>
       </div>
       <div class="ihead">Green screen</div>
       <div class="chips">
         <button class="chip${c.chroma ? " on" : ""}" data-toggle="chroma">Key out a colour</button>
         <button class="chip${App.picking ? " on" : ""}" data-act="pickKey">Pick from the frame</button>
       </div>
       ${row("Colour", `<input type="color" data-prop="keyColor" value="${c.keyColor || "#00d000"}">`)}
       ${row("Similarity", slider("keySimilarity", .01, .6, .005, c.keySimilarity ?? .18))}
       ${row("Softness", slider("keySmooth", 0, .4, .005, c.keySmooth ?? .08))}
       ${row("Spill removal", slider("keySpill", 0, 1, .01, c.keySpill ?? .4))}
       <div class="note">${hasKeyer()
         ? "Matched on colour, not brightness, so shadows on the screen key out with it. Raise similarity until the screen goes, then soften the edge."
         : "This browser has no WebGL2, so keying is off here — the clip still plays and exports."}</div>
       <div class="ihead">Mask</div>
       ${row("Shape", `<select data-prop="mask">${MASKS.map(m =>
         `<option value="${m}"${(c.mask || "none") === m ? " selected" : ""}>${m[0].toUpperCase() + m.slice(1)}</option>`).join("")}</select>`)}
       ${row("Size", slider("maskSize", .05, 1, .01, c.maskSize ?? .6))}
       ${row("Feather", slider("maskFeather", 0, 1, .01, c.maskFeather ?? .1))}
       ${row("Offset X", slider("maskX", -.5, .5, .01, c.maskX ?? 0))}
       ${row("Offset Y", slider("maskY", -.5, .5, .01, c.maskY ?? 0))}
       <div class="chips">
         <button class="chip${c.maskInvert ? " on" : ""}" data-toggle="maskInvert">Invert</button>
       </div>`;

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
      ? `<div class="ihead">${c.kind === "text" ? "Text" : "Sticker"}</div>
         ${row("Content", `<textarea data-prop="text">${esc(c.text)}</textarea>`)}
         ${row("Size", slider("size", 12, 300, 1, c.size, "px", true))}
         ${row("Colour", `<input type="color" data-prop="color" value="${c.color}">`)}
         ${row("Background", `<input type="color" data-prop="bg" value="${c.bg || "#000000"}">
            <button class="chip" data-act="clearBg">None</button>`)}
         ${row("Outline", slider("stroke", 0, 20, 1, c.stroke, "px"))}
         ${row("Font", `<select data-prop="font">
            ${["Inter, system-ui, sans-serif", "Georgia, serif", "Impact, sans-serif", "Courier New, monospace", "Trebuchet MS, sans-serif"]
              .map(f => `<option value="${f}"${c.font === f ? " selected" : ""}>${f.split(",")[0]}</option>`).join("")}</select>`)}
         <div class="ihead">Emoji</div>
         <div class="chips">${["😀", "😍", "🔥", "✨", "👍", "🎉", "💡", "❤️", "⭐", "🚀"].map(e =>
            `<button class="chip" data-emoji="${e}">${e}</button>`).join("")}</div>`
      : `<div class="empty">This is a ${c.kind} clip.<br>Use Text or Sticker in the toolbar to add a title.</div>`;

    $("iKeys").innerHTML =
      `<div class="ihead">Keyframes</div>
       <div class="note">Move the playhead, then press ◆ next to a property to record its value there.
       Between keyframes the value eases smoothly.</div>
       ${M.KEYABLE.map(prop => {
         const keys = c.keys[prop] || [];
         return `<div class="fld"><span>${prop}</span>
           <b style="width:auto;flex:1;text-align:left">${keys.length ? `${keys.length} keys` : "—"}</b>
           <button class="kbtn" data-key="${prop}" title="Add a keyframe here">◆</button>
           ${keys.length ? `<button class="kbtn" data-unkey="${prop}" title="Clear">✕</button>` : ""}</div>`;
       }).join("")}
       <div class="ihead">Transitions</div>
       ${row("Into clip", `<select data-trans="in">${M.TRANSITIONS.map(t =>
          `<option value="${t}"${c.transIn?.type === t ? " selected" : ""}>${t}</option>`).join("")}</select>`)}
       ${row("Out of clip", `<select data-trans="out">${M.TRANSITIONS.map(t =>
          `<option value="${t}"${c.transOut?.type === t ? " selected" : ""}>${t}</option>`).join("")}</select>`)}
       ${row("Length", slider("transDur", .1, 3, .1, c.transOut?.dur ?? c.transIn?.dur ?? .5, "s"))}`;
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
  if (!noTimeline) timeline.render();      // a live drag repaints its own clip
  syncStatus();
  if (!silent) renderInspector();
}
function setSelection(ids) {
  invalidate();
  App.selection = ids;
  timeline.render();
  renderInspector();
  const c = firstSelected();
  $("transSel").value = c?.transIn?.type || "none";
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
    App.selection.forEach(id => M.removeClip(App.project, id));
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
    const set = (c, o) => Object.assign(c, o);
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

  addText: () => {
    const track = overlayTrack(App.playhead, 4);
    const clip = M.makeClip(null, App.playhead, {
      kind: "text", dur: 4, name: "Title", text: "Your title here", size: 96,
    });
    M.addClip(track, clip);
    commit("Add text"); refresh(); setSelection([clip.id]);
    document.querySelector('[data-it="iText"]')?.click();
  },
  addSticker: () => {
    const track = overlayTrack(App.playhead, 3);
    const clip = M.makeClip(null, App.playhead, {
      kind: "sticker", dur: 3, name: "Sticker", text: "✨", size: 160,
    });
    M.addClip(track, clip);
    commit("Add sticker"); refresh(); setSelection([clip.id]);
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
  const free = M.freeTrack(App.project, "video", at, dur);
  if (free) return free;
  const n = App.project.tracks.filter(t => t.kind === "video").length + 1;
  const track = { id: M.uid("t"), kind: "video", name: `Video ${n}`, hidden: false, locked: false, muted: false, clips: [] };
  App.project.tracks.unshift(track);
  renderTrackNames();
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
    ["Detach audio", "detachAudio"],
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
  App.project.media = restored.media.map(m => byId.get(m.id) || m);
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
  const mime = ["video/webm;codecs=vp9", "video/webm"].find(m => MediaRecorder.isTypeSupported(m));
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
      if (t >= 5) { rec.stop(); done(); return; }
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

  const size = PRESETS[res] || PRESETS["1080p"];
  const fps = +$("expFps").value;
  $("expOut").textContent = `${size.w}×${size.h} · ${fps} fps`;

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
  const t0 = performance.now();
  try {
    const blob = await exportVideo(App.project, {
      preset, format, fps, quality, bitrate,
      audioBitrate: audioKbps * 1000, audio: audioKbps > 0,
      codec: $("expCodec").value || undefined,
    }, {
      onStage: s => { $("expNote").textContent = s + "…"; status(s); },
      onProgress: p => { $("expBar").style.width = Math.round(p * 100) + "%"; },
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
    status("Ready");
  }
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
          ["Detach audio", "detachAudio"], ["Reset transform", "resetTransform"], ["Fit to frame", "fitFrame"]],
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
  const lay = e.target.closest("[data-layout]");
  if (lay) { ACT.layout(lay.dataset.layout); return; }
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
    const tg = e.target.closest("[data-tg]");
    if (tg) {
      const track = App.project.tracks.find(t => t.id === tg.dataset.tg);
      if (track) { track.kind === "audio" ? (track.muted = !track.muted) : (track.hidden = !track.hidden); renderTrackNames(); }
    }
    const mediaEl = e.target.closest("[data-media]");
    if (mediaEl) { App.poolSel = [mediaEl.dataset.media]; renderPool(); }
  });
  $("pool").addEventListener("dblclick", e => {
    const m = e.target.closest("[data-media]");
    if (m) addToTimeline(m.dataset.media);
  });

  // the eyedropper reads the preview where it was clicked
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
      if (path.startsWith("crop.")) c.crop[path.split(".")[1]] = v;
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
    if (t.id === "pVol") { App.masterVol = +t.value; t.nextElementSibling.textContent = Math.round(App.masterVol * 100) + "%"; }
    if (t.id === "pName") { App.project.name = t.value; syncStatus(); }
    if (t.id === "expQ") $("expQV").textContent = t.value + "%";
    if (t.id === "projName") { App.project.name = t.value; }
  });
  $("app").addEventListener("change", e => {
    const t = e.target, c = firstSelected();
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
    if (emo && c) { c.text = emo.dataset.emoji; commit("Sticker"); refresh(); }
    const key = e.target.closest("[data-key]");
    if (key && c) {
      const prop = key.dataset.key;
      M.setKey(c, prop, App.playhead, M.valueAt(c, prop, App.playhead));
      commit("Keyframe"); refresh();
      toast(`Keyframe on ${prop}`);
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
  $("tlScroll").addEventListener("scroll", () => { $("tNames").scrollTop = $("tlScroll").scrollTop; });
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

  $("transSel").innerHTML = M.TRANSITIONS.map(t => `<option value="${t}">${t}</option>`).join("");
}

/* ---------------- boot ---------------- */
timeline = new Timeline($("tlScroll"), {
  get project() { return App.project; },
  get selection() { return App.selection; },
  get playhead() { return App.playhead; },
  get snapping() { return App.snapping; },
  onChange: refresh,
  onSelect: setSelection,
  onSeek: seek,
  onSplit: id => { setSelection([id]); ACT.split(); },
  onDelete: id => { setSelection([id]); ACT.delete(); },
  onContext: openClipMenu,
  commit,
});
wire();
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
  setSelection, doExport, exportVideo, renderAll, drawPreview,
  duration: () => M.duration(App.project),
  clips: () => App.project.tracks.flatMap(t => t.clips),
};
