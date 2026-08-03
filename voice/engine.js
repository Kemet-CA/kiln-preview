/* ============================================================
   Kiln Voice — recorder, timeline and voice designer.

   The shape of it:

     a clip holds the samples it was recorded with and a description of what
     should happen to them. Nothing is ever written back over a recording, so
     every knob stays live: change the pitch an hour later and the take is
     re-derived from the original, not from the last render.

     that description is applied in two passes. The spectral work — noise,
     sibilance, hum, whisper, pitch and formants — is in src/dsp.js and runs on
     plain arrays. The rest is a Web Audio graph rendered offline, which is the
     same graph shape the browser would use to play it, so what you export is
     what you heard.

   Recording is getUserMedia into a MediaRecorder, with an analyser tapped off
   the same stream to draw the waveform as it arrives. Nothing leaves the tab:
   there is no network code in this file.
   ============================================================ */
import * as D from "./src/dsp.js";

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (s, ms = false) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  const t = `${m}:${String(sec).padStart(2, "0")}`;
  return ms ? `${t}.${Math.floor((s % 1) * 10)}` : t;
};
const uid = (() => { let n = 0; return () => `c${++n}`; })();

/* ---------------- the voices ----------------
   A voice is nothing but a set of numbers. The built-in ones are starting
   points; anything the user builds can be saved beside them. */
const FX0 = {
  pitch: 0, formant: 0, whisper: 0, robot: 0,
  denoise: 0, gate: -80, deEss: 0, hum: 0, compress: 0,
  low: 0, mid: 0, high: 0, normalize: true,
  reverb: 0, size: 40, delay: 0, delayMs: 260, telephone: 0, drive: 0,
};
const VOICES = [
  { id: "natural", name: "Natural", hint: "as recorded", fx: {} },
  { id: "deep", name: "Deep", hint: "lower, larger", fx: { pitch: -4, formant: -2.5, low: 2.5 } },
  { id: "bright", name: "Bright", hint: "higher, lighter", fx: { pitch: 4, formant: 2.5, high: 2 } },
  { id: "child", name: "Child", hint: "small and quick", fx: { pitch: 6, formant: 5 } },
  { id: "giant", name: "Giant", hint: "slow and vast", fx: { pitch: -7, formant: -5, reverb: 32, size: 70, low: 3 } },
  { id: "robot", name: "Robot", hint: "ring modulated", fx: { robot: 80, formant: -1, drive: 20 } },
  { id: "radio", name: "Radio", hint: "compressed and close", fx: { compress: 70, low: 2, high: 2.5, drive: 12 } },
  { id: "phone", name: "Telephone", hint: "narrow band", fx: { telephone: 92, drive: 18, compress: 40 } },
  { id: "whisper", name: "Whisper", hint: "breath, no pitch", fx: { whisper: 82, high: 3, low: -4 } },
  { id: "alien", name: "Alien", hint: "wrong resonances", fx: { pitch: 3, formant: -7, robot: 28 } },
  { id: "monster", name: "Monster", hint: "deep and rough", fx: { pitch: -8, formant: -4, drive: 45, reverb: 22 } },
  { id: "cave", name: "Cave", hint: "far away", fx: { reverb: 68, size: 92, delay: 22, delayMs: 320, high: -3 } },
];
const CUSTOM_KEY = "kiln-voice-voices";
const loadCustom = () => { try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]"); } catch { return []; } };
const saveCustom = v => { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(v)); } catch {} };

/* ---------------- state ---------------- */
const App = {
  clips: [], sel: null, sr: 48000, tracks: 2,
  zoom: 40, pos: 0,
  recording: false, playing: false, monitor: false,
  ctx: null, stream: null, rec: null, analyser: null, media: null,
  live: [], liveStart: 0, raf: 0,
  nodes: [], playStart: 0, playFrom: 0,
  hist: [], hi: -1, rendering: false,
  custom: loadCustom(), voice: "natural",
};
window.App = App;                                   // the tests read this

const audio = () => (App.ctx ||= new (window.AudioContext || window.webkitAudioContext)());
const selClip = () => App.clips.find(c => c.id === App.sel) || null;
const projectEnd = () => App.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
const laneEnd = t => App.clips.filter(c => (c.track || 0) === t).reduce((m, c) => Math.max(m, c.start + c.dur), 0);
const laneCount = () => Math.max(App.tracks, ...App.clips.map(c => (c.track || 0) + 1), 1);

/* ---------------- chrome ---------------- */
function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span class="dot ${kind}"></span>${msg}`;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 320); }, 2400);
}
window.toast = toast;
function status(text, kind = "") {
  $("sbStatus").textContent = text;
  $("sbDot").className = "dot " + kind;
}
function stats() {
  $("sbClips").textContent = App.clips.length;
  $("sbLen").textContent = fmt(projectEnd());
  $("sbRate").textContent = App.clips.length ? `${Math.round(App.sr / 100) / 10} kHz` : "—";
  $("tlLen").textContent = fmt(projectEnd(), true);
  $("tlEmpty").hidden = App.clips.length > 0;
}

/* ---------------- history ----------------
   A snapshot shares the sample data and copies only the description, so undo
   costs a few hundred bytes however long the recording is. */
const snap = () => App.clips.map(c => ({ ...c, fx: { ...c.fx } }));
function push(label) {
  setTimeout(() => { try { rememberSession(); } catch {} }, 0);
  window.KilnProject?.touch();
  App.hist = App.hist.slice(0, App.hi + 1);
  App.hist.push({ label, clips: snap(), sel: App.sel });
  if (App.hist.length > 60) App.hist.shift();
  App.hi = App.hist.length - 1;
  buildMenus();
}
function restore(i) {
  const h = App.hist[i];
  if (!h) return;
  App.hi = i;
  App.clips = h.clips.map(c => ({ ...c, fx: { ...c.fx } }));
  App.sel = h.sel;
  drawAll(); buildMenus();
}
const undo = () => { if (App.hi > 0) { restore(App.hi - 1); status("Undo"); } };
const redo = () => { if (App.hi < App.hist.length - 1) { restore(App.hi + 1); status("Redo"); } };

/* ---------------- recording ---------------- */
async function startRecording() {
  if (App.recording) return stopRecording();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: $("devSel").value ? { exact: $("devSel").value } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
    });
  } catch (e) {
    toast("No microphone: " + (e.message || e.name), "bad");
    status("Microphone refused", "bad");
    return;
  }
  App.stream = stream;
  const ctx = audio();
  if (ctx.state === "suspended") await ctx.resume();
  App.sr = ctx.sampleRate;

  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  an.smoothingTimeConstant = 0.15;
  src.connect(an);
  if (App.monitor) src.connect(ctx.destination);
  App.analyser = an;
  App.media = src;

  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
    .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const parts = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    App.recording = false;
    cancelAnimationFrame(App.raf);
    paintRecorderIdle();
    syncTransport();
    if (!parts.length) { status("Nothing recorded", "warn"); return; }
    status("Decoding…");
    try {
      const blob = new Blob(parts, { type: mime || "audio/webm" });
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      addClip(monoOf(buf), buf.sampleRate, `Take ${App.clips.length + 1}`);
      status("Recorded " + fmt(buf.duration, true));
    } catch (e) {
      toast("Could not decode the recording: " + e.message, "bad");
      status("Decode failed", "bad");
    }
  };
  $("scopeEmpty").hidden = true;          // nothing but the waveform while recording
  App.rec = rec;
  App.recording = true;
  App.live = [];
  App.liveStart = performance.now();
  rec.start(120);
  status("Recording", "bad");
  syncTransport();
  drawLive();
}
function stopRecording() {
  if (!App.recording || !App.rec) return;
  try { App.rec.stop(); } catch {}
}

function monoOf(buf) {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const n = buf.length, out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  for (let i = 0; i < n; i++) out[i] /= buf.numberOfChannels;
  return out;
}

function addClip(data, sr, name) {
  App.sr = sr;
  const clip = {
    id: uid(), name, sr, buf: data, track: 0,
    offset: 0, dur: data.length / sr, start: laneEnd(0),
    fx: { ...FX0 }, voice: "natural", rendered: null, noiseProfile: null,
  };
  App.clips.push(clip);
  App.sel = clip.id;
  push("Add " + name);
  renderClip(clip).then(drawAll);
  drawAll();
  if (App.clips.length === 1) zoomFit();
  return clip;
}

/* ---------------- the live scope ----------------
   One bar per frame, newest on the right, plus the instantaneous waveform
   drawn over it. Both come from the same analyser as the recording. */
function drawLive() {
  const an = App.analyser;
  if (!an || !App.recording) return;
  // while the meter is live there is nothing to read but the waveform
  if (!$("scopeEmpty").hidden) $("scopeEmpty").hidden = true;
  const c = $("wave"), x = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = c.width = Math.round(c.clientWidth * dpr);
  const h = c.height = Math.round(c.clientHeight * dpr);
  const time = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(time);

  // Both numbers matter: the peak is the shape of the sound, the average is
  // its body. A bar chart of one of them is what looked wrong.
  let peak = 0, sum = 0;
  for (let i = 0; i < time.length; i++) {
    const v = time[i], a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  const level = Math.sqrt(sum / time.length);
  App.live.push({ p: peak, r: level });
  const cols = Math.max(60, Math.floor(w / (2 * dpr)));      // one column per two CSS pixels
  while (App.live.length > cols) App.live.shift();

  const css = getComputedStyle(document.querySelector(".scope"));
  const accent = css.getPropertyValue("--wave").trim();
  x.clearRect(0, 0, w, h);
  const mid = h / 2, colw = w / cols, scale = h * 0.46;

  // the outer envelope, as one filled shape rather than a row of sticks
  const band = (key, alpha) => {
    x.globalAlpha = alpha;
    x.fillStyle = accent;
    x.beginPath();
    x.moveTo(w - App.live.length * colw, mid);
    for (let i = 0; i < App.live.length; i++) {
      const v = Math.max(App.live[i][key], 0.002) * scale;
      x.lineTo(w - (App.live.length - i) * colw, mid - v);
    }
    for (let i = App.live.length - 1; i >= 0; i--) {
      const v = Math.max(App.live[i][key], 0.002) * scale;
      x.lineTo(w - (App.live.length - i) * colw, mid + v);
    }
    x.closePath();
    x.fill();
  };
  band("p", 0.38);           // reach
  band("r", 0.95);           // body
  x.globalAlpha = 1;

  // a hairline down the middle, and the moment itself at the leading edge
  x.fillStyle = accent;
  x.globalAlpha = 0.25;
  x.fillRect(0, mid - dpr / 2, w, dpr);
  x.globalAlpha = 1;
  x.strokeStyle = "#FFFFFF";
  x.lineWidth = dpr;
  x.beginPath();
  const span = Math.min(w * 0.3, 360 * dpr);
  const step = time.length / span;
  for (let i = 0; i < span; i++) {
    const v = time[Math.floor(i * step)] || 0;
    const px = w - span + i, py = mid - v * scale;
    i ? x.lineTo(px, py) : x.moveTo(px, py);
  }
  x.globalAlpha = 0.55;
  x.stroke();
  x.globalAlpha = 1;

  const secs = (performance.now() - App.liveStart) / 1000;
  $("timer").textContent = fmt(secs);
  $("timerMs").textContent = "." + Math.floor((secs % 1) * 10);
  meter(level, peak);
  const f = D.detectPitch(time, App.ctx ? App.ctx.sampleRate : 48000);
  $("pitchHz").textContent = f ? Math.round(f) + " Hz" : "—";
  App.raf = requestAnimationFrame(drawLive);
}
function meter(level, peakV) {
  const db = D.gainToDb(level);
  $("meterFill").style.right = clamp(100 - (db + 60) / 60 * 100, 0, 100) + "%";
  $("lvlDb").textContent = level > 0.0005 ? db.toFixed(1) + " dB" : "−∞ dB";
  $("meter").classList.toggle("over", peakV >= 0.999);
}

/* the scope when not recording: the selected clip, or the whole take */
function paintRecorderIdle() {
  const c = $("wave"), x = c.getContext("2d");
  const w = c.width = c.clientWidth * devicePixelRatio;
  const h = c.height = c.clientHeight * devicePixelRatio;
  x.clearRect(0, 0, w, h);
  const clip = selClip();
  $("scopeEmpty").hidden = !!clip;
  if (!clip) return;
  const data = clip.rendered || clip.buf.subarray(
    Math.floor(clip.offset * clip.sr), Math.floor((clip.offset + clip.dur) * clip.sr));
  const css = getComputedStyle(document.querySelector(".scope"));
  const accent = css.getPropertyValue("--wave").trim();
  const buckets = Math.max(2, Math.floor(w / (2 * devicePixelRatio)));
  const pk = D.peaks(data, buckets);
  const mid = h / 2;
  x.fillStyle = accent;
  for (let b = 0; b < buckets; b++) {
    const lo = pk[b * 2] * h * 0.44, hi = pk[b * 2 + 1] * h * 0.44;
    x.fillRect(b * 2 * devicePixelRatio, mid - hi, 2 * devicePixelRatio - 1, Math.max(1, hi - lo));
  }
  // playhead inside the clip
  const rel = (App.pos - clip.start) / clip.dur;
  if (rel >= 0 && rel <= 1) {
    x.fillStyle = "#FFFFFF";
    x.fillRect(rel * w, 0, Math.max(1, devicePixelRatio), h);
  }
  $("pitchHz").textContent = (() => {
    const f = D.detectPitch(data, clip.sr);
    return f ? Math.round(f) + " Hz" : "—";
  })();
}

/* ---------------- rendering a clip ----------------
   spectral work on the array, then the same graph the browser would play. */
async function renderClip(clip) {
  const fx = clip.fx;
  const from = Math.floor(clip.offset * clip.sr);
  const to = Math.min(clip.buf.length, Math.floor((clip.offset + clip.dur) * clip.sr));
  let x = clip.buf.slice(from, to);
  if (!x.length) { clip.rendered = x; return x; }

  x = D.spectral(x, clip.sr, {
    denoise: fx.denoise, noiseProfile: clip.noiseProfile, deEss: fx.deEss,
    hum: fx.hum, whisper: fx.whisper, formant: fx.formant,
  });
  // pitch last of the two: the envelope warp above is what the formant control
  // moves on its own, and the shift then carries the whole voice with it
  if (fx.pitch) x = D.pitchShift(x, clip.sr, fx.pitch);
  if (fx.gate > -80) x = D.gate(x, clip.sr, fx.gate);
  x = await renderGraph(x, clip.sr, fx);
  if (fx.normalize) x = D.normalize(x, -1);
  clip.rendered = x;
  return x;
}

/* wet/dry around an arbitrary insert, so effects can be stacked without each
   one having to know about mixing */
function mixInto(ctx, input, makeWet, amount) {
  if (amount <= 0.001) return input;
  const out = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1 - amount;
  const wet = ctx.createGain(); wet.gain.value = amount;
  input.connect(dry).connect(out);
  const w = makeWet(input);
  w.connect(wet).connect(out);
  return out;
}
function driveCurve(amount) {
  const n = 1024, c = new Float32Array(n), k = 1 + amount * 40;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) * 2 - 1;
    c[i] = Math.tanh(t * k) / Math.tanh(k);
  }
  return c;
}
function impulse(ctx, seconds, decay = 2.4) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
  }
  return buf;
}
async function renderGraph(x, sr, fx) {
  const needs = fx.low || fx.mid || fx.high || fx.compress || fx.reverb || fx.delay
    || fx.telephone || fx.drive || fx.robot;
  if (!needs) return x;
  const tail = (fx.reverb ? fx.size / 100 * 3 : 0) + (fx.delay ? fx.delayMs / 1000 * 4 : 0);
  const len = Math.ceil(x.length + tail * sr);
  const ctx = new OfflineAudioContext(1, len, sr);
  const buf = ctx.createBuffer(1, x.length, sr);
  buf.copyToChannel(x, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  let node = src;
  const shelf = (type, freq, gain) => {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.gain.value = gain;
    if (type === "peaking") f.Q.value = 0.9;
    return f;
  };
  if (fx.low) node = node.connect(shelf("lowshelf", 220, fx.low));
  if (fx.mid) node = node.connect(shelf("peaking", 1400, fx.mid));
  if (fx.high) node = node.connect(shelf("highshelf", 4200, fx.high));

  if (fx.telephone) node = mixInto(ctx, node, input => {
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 320; hp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3400; lp.Q.value = 0.8;
    const pk = ctx.createBiquadFilter(); pk.type = "peaking"; pk.frequency.value = 1800; pk.gain.value = 6;
    input.connect(hp).connect(lp).connect(pk);
    return pk;
  }, fx.telephone / 100);

  if (fx.drive) node = mixInto(ctx, node, input => {
    const ws = ctx.createWaveShaper();
    ws.curve = driveCurve(fx.drive / 100);
    ws.oversample = "2x";
    input.connect(ws);
    return ws;
  }, Math.min(1, fx.drive / 100));

  if (fx.robot) node = mixInto(ctx, node, input => {
    // ring modulation: the carrier drives the gain, which is multiplication
    const ring = ctx.createGain(); ring.gain.value = 0;
    const osc = ctx.createOscillator(); osc.frequency.value = 42 + fx.robot * 0.9;
    const amp = ctx.createGain(); amp.gain.value = 1;
    osc.connect(amp).connect(ring.gain);
    osc.start(0);
    input.connect(ring);
    return ring;
  }, fx.robot / 100);

  if (fx.compress) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -8 - fx.compress * 0.32;
    c.ratio.value = 2 + fx.compress * 0.1;
    c.attack.value = 0.004; c.release.value = 0.18; c.knee.value = 8;
    node = node.connect(c);
    const make = ctx.createGain();
    make.gain.value = 1 + fx.compress / 140;
    node = node.connect(make);
  }

  const out = ctx.createGain();
  node.connect(out);
  if (fx.reverb) {
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, clamp(fx.size / 100 * 3, 0.2, 3));
    const wet = ctx.createGain(); wet.gain.value = fx.reverb / 100 * 0.8;
    const down = ctx.createGain(); down.gain.value = 1;   // convolver is 2ch, context is 1
    node.connect(conv).connect(wet).connect(down).connect(out);
  }
  if (fx.delay) {
    const d = ctx.createDelay(1.5);
    d.delayTime.value = clamp(fx.delayMs / 1000, 0.02, 1.4);
    const fb = ctx.createGain(); fb.gain.value = clamp(fx.delay / 100 * 0.6, 0, 0.72);
    const wet = ctx.createGain(); wet.gain.value = fx.delay / 100 * 0.7;
    node.connect(d); d.connect(fb).connect(d); d.connect(wet).connect(out);
  }
  out.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

let renderTimer = 0;
function reRender(clip, label) {
  clearTimeout(renderTimer);
  App.rendering = true;
  status("Rendering…");
  renderTimer = setTimeout(async () => {
    try {
      await renderClip(clip);
      clip.peaksCache = null;
      status("Ready");
    } catch (e) {
      status("Render failed", "bad");
      toast(e.message, "bad");
    }
    App.rendering = false;
    drawAll();
    if (label) push(label);
  }, 90);
}

/* ---------------- timeline ---------------- */
function drawRuler() {
  const c = $("rulerC"), x = c.getContext("2d");
  const width = Math.max($("tlScroll").clientWidth, projectEnd() * App.zoom + 220);
  c.style.width = width + "px";
  c.width = width * devicePixelRatio; c.height = 20 * devicePixelRatio;
  const css = getComputedStyle(document.documentElement);
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = css.getPropertyValue("--t4").trim();
  x.font = `${9 * devicePixelRatio}px ${css.getPropertyValue("--mono").trim() || "monospace"}`;
  const step = App.zoom > 120 ? 0.5 : App.zoom > 60 ? 1 : App.zoom > 25 ? 5 : 15;
  for (let t = 0; t * App.zoom < width; t += step) {
    const px = t * App.zoom * devicePixelRatio;
    x.fillRect(px, 12 * devicePixelRatio, devicePixelRatio, 8 * devicePixelRatio);
    x.fillText(fmt(t), px + 3 * devicePixelRatio, 9 * devicePixelRatio);
  }
  $("tlInner").style.width = width + "px";
}
function clipPeaks(clip) {
  const px = Math.max(4, Math.floor(clip.dur * App.zoom));
  if (clip.peaksCache && clip.peaksCache.px === px) return clip.peaksCache.data;
  const data = clip.rendered || clip.buf.subarray(
    Math.floor(clip.offset * clip.sr), Math.floor((clip.offset + clip.dur) * clip.sr));
  const pk = D.peaks(data, px);
  clip.peaksCache = { px, data: pk };
  return pk;
}
function drawClip(el, clip) {
  const c = el.querySelector("canvas");
  const w = Math.max(4, Math.floor(clip.dur * App.zoom));
  const h = 63;
  c.width = w * devicePixelRatio; c.height = h * devicePixelRatio;
  const x = c.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--cat").trim() || css.getPropertyValue("--ember").trim();
  x.clearRect(0, 0, c.width, c.height);
  const pk = clipPeaks(clip);
  const mid = c.height / 2;
  x.fillStyle = accent;
  const n = pk.length / 2;
  for (let b = 0; b < n; b++) {
    const lo = pk[b * 2] * c.height * 0.42, hi = pk[b * 2 + 1] * c.height * 0.42;
    x.fillRect(b * devicePixelRatio, mid - hi, devicePixelRatio, Math.max(devicePixelRatio, hi - lo));
  }
}
function fxSummary(fx) {
  const bits = [];
  if (fx.pitch) bits.push((fx.pitch > 0 ? "+" : "") + fx.pitch + "st");
  if (fx.formant) bits.push("F" + (fx.formant > 0 ? "+" : "") + fx.formant);
  if (fx.denoise) bits.push("NR");
  if (fx.robot) bits.push("ROBOT");
  if (fx.whisper) bits.push("WHISPER");
  if (fx.telephone) bits.push("TEL");
  if (fx.reverb) bits.push("VERB");
  return bits.slice(0, 3).join(" · ");
}
function drawTimeline() {
  const lanes = $("lanes");
  const n = laneCount();
  if (lanes.children.length !== n) {
    lanes.innerHTML = Array.from({ length: n }, (_, i) =>
      `<div class="track" data-track="${i}"><span class="track-lab">Track ${i + 1}</span></div>`).join("");
  }
  [...lanes.querySelectorAll(".clip")].forEach(e => e.remove());
  for (const clip of App.clips) {
    const lane = lanes.children[Math.min(clip.track || 0, n - 1)];
    if (!lane) continue;
    const el = document.createElement("div");
    el.className = "clip" + (clip.id === App.sel ? " on" : "");
    el.dataset.clip = clip.id;
    el.style.left = clip.start * App.zoom + "px";
    el.style.width = Math.max(4, clip.dur * App.zoom) + "px";
    el.innerHTML = `<canvas></canvas><span class="cname">${clip.name}</span>` +
      `<span class="cfx">${fxSummary(clip.fx)}</span>` +
      `<span class="edge l"></span><span class="edge r"></span>`;
    lane.appendChild(el);
    drawClip(el, clip);
  }
  $("playhead").style.left = App.pos * App.zoom + "px";
  $("tlPos").textContent = fmt(App.pos, true);
  $("tlEmpty").hidden = App.clips.length > 0;
}
function drawAll() {
  drawRuler();
  drawTimeline();
  paintRecorderIdle();
  paintClipPanel();
  syncFxUI();
  stats();
  $("zoomV").textContent = Math.round(App.zoom) + " px/s";
}

/* ---------------- clip operations ---------------- */
function selectClip(id) {
  App.sel = id;
  drawAll();
  buildMenus();
}
function splitAtPlayhead() {
  const c = App.clips.find(c => App.pos > c.start + 0.02 && App.pos < c.start + c.dur - 0.02);
  if (!c) { toast("Put the playhead inside a clip first", "warn"); return; }
  const at = App.pos - c.start;
  const right = {
    ...c, id: uid(), name: c.name + " b", fx: { ...c.fx },
    offset: c.offset + at, dur: c.dur - at, start: c.start + at,
    rendered: null, peaksCache: null,
  };
  c.dur = at; c.rendered = null; c.peaksCache = null;
  App.clips.push(right);
  App.sel = right.id;
  push("Split");
  Promise.all([renderClip(c), renderClip(right)]).then(drawAll);
  drawAll();
}
function deleteClip() {
  const c = selClip();
  if (!c) return;
  App.clips = App.clips.filter(x => x.id !== c.id);
  App.sel = App.clips.length ? App.clips[App.clips.length - 1].id : null;
  push("Delete clip");
  drawAll();
}
function duplicateClip() {
  const c = selClip();
  if (!c) return;
  const copy = { ...c, id: uid(), name: c.name + " copy", fx: { ...c.fx },
    start: projectEnd(), rendered: null, peaksCache: null };
  App.clips.push(copy);
  App.sel = copy.id;
  push("Duplicate clip");
  renderClip(copy).then(drawAll);
  drawAll();
}
function trimSilenceClip() {
  const c = selClip();
  if (!c) return;
  const from = Math.floor(c.offset * c.sr), to = Math.floor((c.offset + c.dur) * c.sr);
  const t = D.trimSilence(c.buf.subarray(from, to), c.sr);
  c.offset += t.from / c.sr;
  c.dur = (t.to - t.from) / c.sr;
  c.rendered = null; c.peaksCache = null;
  reRender(c, "Trim silence");
  toast("Trimmed to " + fmt(c.dur, true));
}
function learnNoiseFromClip() {
  const c = selClip();
  if (!c) return;
  const from = Math.floor(c.offset * c.sr), to = Math.floor((c.offset + c.dur) * c.sr);
  c.noiseProfile = D.learnNoise(c.buf.subarray(from, to), c.sr);
  if (!c.fx.denoise) c.fx.denoise = 45;
  reRender(c, "Learn room");
  toast("Room learned from the quiet parts");
}

/* ---------------- voices ---------------- */
const allVoices = () => [...VOICES, ...App.custom];
function applyVoice(id) {
  const c = selClip();
  const v = allVoices().find(v => v.id === id);
  if (!v) return;
  App.voice = id;
  $("recVoice").textContent = "Voice: " + v.name;
  if (!c) { drawVoices(); return; }
  // a voice sets what it names and leaves cleanup settings alone
  c.fx = { ...c.fx, pitch: 0, formant: 0, whisper: 0, robot: 0, telephone: 0,
    drive: 0, reverb: 0, delay: 0, ...v.fx };
  c.voice = id;
  reRender(c, "Voice: " + v.name);
  drawVoices();
  syncFxUI();
}
function drawVoices() {
  const c = selClip();
  const cur = c ? c.voice : App.voice;
  $("voiceList").innerHTML = allVoices().map(v =>
    `<button class="voice${v.id === cur ? " on" : ""}" data-voice="${v.id}">${v.name}` +
    (v.custom ? `<span class="rm" data-rmvoice="${v.id}" title="Forget this voice">✕</span>` : "") +
    `<small>${v.hint || "saved voice"}</small></button>`).join("");
}
function saveVoiceFromClip() {
  const c = selClip();
  if (!c) { toast("Select a clip whose settings you want to keep", "warn"); return; }
  const name = prompt("Name this voice", "My voice " + (App.custom.length + 1));
  if (!name) return;
  const v = {
    id: "u" + Date.now(), name, custom: true, hint: "yours",
    fx: { pitch: c.fx.pitch, formant: c.fx.formant, whisper: c.fx.whisper, robot: c.fx.robot,
      telephone: c.fx.telephone, drive: c.fx.drive, reverb: c.fx.reverb, size: c.fx.size,
      delay: c.fx.delay, delayMs: c.fx.delayMs, low: c.fx.low, mid: c.fx.mid, high: c.fx.high },
  };
  App.custom.push(v);
  saveCustom(App.custom);
  c.voice = v.id;
  drawVoices();
  toast(`“${name}” saved — it will be here next time`);
}
function forgetVoice(id) {
  App.custom = App.custom.filter(v => v.id !== id);
  saveCustom(App.custom);
  drawVoices();
}

/* ---------------- playback ---------------- */
function stopSources() {
  for (const n of App.nodes) { try { n.stop(); } catch {} }
  App.nodes = [];
}
async function play() {
  if (App.playing) return pause();
  if (!App.clips.length) { toast("Record something first", "warn"); return; }
  const ctx = audio();
  if (ctx.state === "suspended") await ctx.resume();
  stopSources();
  const t0 = ctx.currentTime + 0.05;
  App.playFrom = App.pos >= projectEnd() ? 0 : App.pos;
  App.playStart = t0;
  for (const clip of App.clips) {
    const data = clip.rendered || await renderClip(clip);
    if (!data.length) continue;
    const end = clip.start + data.length / clip.sr;
    if (end <= App.playFrom) continue;
    const buf = ctx.createBuffer(1, data.length, clip.sr);
    buf.copyToChannel(data, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const when = Math.max(0, clip.start - App.playFrom);
    const offset = Math.max(0, App.playFrom - clip.start);
    src.start(t0 + when, offset);
    App.nodes.push(src);
  }
  App.playing = true;
  syncTransport();
  status("Playing");
  const tick = () => {
    if (!App.playing) return;
    App.pos = App.playFrom + (audio().currentTime - App.playStart);
    if (App.pos >= projectEnd()) { App.pos = projectEnd(); stop(); return; }
    $("playhead").style.left = App.pos * App.zoom + "px";
    $("tlPos").textContent = fmt(App.pos, true);
    paintRecorderIdle();
    App.raf = requestAnimationFrame(tick);
  };
  tick();
}
function pause() {
  if (!App.playing) return;
  stopSources();
  App.playing = false;
  cancelAnimationFrame(App.raf);
  syncTransport();
  status("Paused");
}
function stop() {
  stopSources();
  App.playing = false;
  cancelAnimationFrame(App.raf);
  if (App.recording) stopRecording();
  App.pos = 0;
  syncTransport();
  drawAll();
  status("Ready");
}
function syncTransport() {
  $("recBtn").classList.toggle("on", App.recording);
  $("recTitle").textContent = App.recording ? "Recording" : App.playing ? "Playing" : "Recorder";
}

/* ---------------- export ---------------- */
async function mixdown(onlySelected) {
  const clips = onlySelected ? [selClip()].filter(Boolean) : App.clips;
  if (!clips.length) return null;
  const sr = App.sr;
  const base = onlySelected ? clips[0].start : 0;
  let end = 0;
  for (const c of clips) {
    const data = c.rendered || await renderClip(c);
    end = Math.max(end, c.start - base + data.length / c.sr);
  }
  const out = new Float32Array(Math.ceil(end * sr) || 1);
  for (const c of clips) {
    const data = c.rendered || await renderClip(c);
    const at = Math.floor((c.start - base) * sr);
    for (let i = 0; i < data.length; i++) {
      const j = at + i;
      if (j >= 0 && j < out.length) out[j] = clamp(out[j] + data[i], -1, 1);
    }
  }
  return { data: out, sr };
}
async function exportWav() {
  if (!App.clips.length) { toast("Nothing to export yet", "warn"); return; }
  status("Mixing…");
  $("expProg").hidden = false;
  $("expBar").style.width = "35%";
  const mix = await mixdown($("expSel").checked);
  if (!mix) { $("expProg").hidden = true; return; }
  $("expBar").style.width = "80%";
  const bits = Number($("expBits").value) || 16;
  const wav = D.encodeWav([mix.data], mix.sr, bits);
  const blob = new Blob([wav], { type: "audio/wav" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (selClip()?.name || "kiln-voice").replace(/\s+/g, "-").toLowerCase() + ".wav";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $("expBar").style.width = "100%";
  setTimeout(() => { $("expProg").hidden = true; $("expBar").style.width = "0"; }, 600);
  status("Exported " + fmt(mix.data.length / mix.sr, true));
  toast(`Exported ${bits}-bit WAV · ${(blob.size / 1048576).toFixed(1)} MB`);
  return blob;
}
window.exportWav = exportWav;
/* A small surface for the tests: they build a known signal, run it through the
   real pipeline and measure what comes out, rather than trusting the UI. */
window.Voice = { addClip, renderClip, applyVoice, splitAtPlayhead, exportWav, mixdown, drawAll, VOICES, FX0 };
window.DSP = D;

async function importFile(file) {
  if (!file) return;
  status("Decoding " + file.name + "…");
  try {
    const buf = await audio().decodeAudioData(await file.arrayBuffer());
    addClip(monoOf(buf), buf.sampleRate, file.name.replace(/\.[^.]+$/, ""));
    status("Imported " + fmt(buf.duration, true));
  } catch (e) {
    toast("Could not decode that file: " + e.message, "bad");
    status("Import failed", "bad");
  }
}

/* ---------------- panels ---------------- */
function paintClipPanel() {
  const c = selClip();
  const box = $("clipInfo");
  if (!c) { box.innerHTML = `<div class="empty">No clip selected.</div>`; return; }
  const v = allVoices().find(v => v.id === c.voice);
  box.innerHTML =
    `<div class="kv"><span>Name</span><b>${c.name}</b></div>` +
    `<div class="kv"><span>Starts at</span><b>${fmt(c.start, true)}</b></div>` +
    `<div class="kv"><span>Length</span><b>${fmt(c.dur, true)}</b></div>` +
    `<div class="kv"><span>Voice</span><b>${v ? v.name : "Natural"}</b></div>` +
    `<div class="kv"><span>Sample rate</span><b>${(c.sr / 1000).toFixed(1)} kHz</b></div>` +
    `<div class="kv"><span>Peak</span><b>${D.gainToDb(D.peak(c.rendered || c.buf)).toFixed(1)} dB</b></div>`;
}
const FX_LABEL = {
  pitch: v => (v > 0 ? "+" : "") + v + " st", formant: v => (v > 0 ? "+" : "") + v + " st",
  whisper: v => v + "%", robot: v => v + "%", denoise: v => v + "%", deEss: v => v + "%",
  gate: v => (v <= -80 ? "off" : v + " dB"), compress: v => v + "%",
  low: v => (v > 0 ? "+" : "") + v + " dB", mid: v => (v > 0 ? "+" : "") + v + " dB",
  high: v => (v > 0 ? "+" : "") + v + " dB",
  reverb: v => v + "%", size: v => (v / 100 * 3).toFixed(1) + " s", delay: v => v + "%",
  delayMs: v => v + " ms", telephone: v => v + "%", drive: v => v + "%",
};
const V_ID = { pitch: "vPitch", formant: "vFormant", whisper: "vWhisper", robot: "vRobot",
  denoise: "vDenoise", gate: "vGate", deEss: "vDeEss", low: "vLow", mid: "vMid", high: "vHigh",
  compress: "vComp", reverb: "vReverb", size: "vSize", delay: "vDelay", delayMs: "vDelayMs",
  telephone: "vTele", drive: "vDrive" };
function syncFxUI() {
  const fx = selClip()?.fx || FX0;
  for (const el of document.querySelectorAll("[data-fx]")) {
    const key = el.dataset.fx;
    if (el.type === "checkbox") el.checked = key === "hum" ? !!fx.hum : !!fx[key];
    else if (fx[key] !== undefined) el.value = fx[key];
    const vid = V_ID[key];
    if (vid && $(vid)) $(vid).textContent = (FX_LABEL[key] || (v => v))(Number(el.value));
  }
  drawVoices();
}
function onFx(el) {
  const c = selClip();
  if (!c) { toast("Select a clip first", "warn"); syncFxUI(); return; }
  const key = el.dataset.fx;
  if (el.type === "checkbox") c.fx[key] = key === "hum" ? (el.checked ? Number($("humHz").value) : 0) : el.checked;
  else c.fx[key] = Number(el.value);
  c.voice = "custom";
  const vid = V_ID[key];
  if (vid && $(vid)) $(vid).textContent = (FX_LABEL[key] || (v => v))(Number(el.value));
  reRender(c, null);
}

/* ---------------- zoom + scrubbing ---------------- */
function setZoom(z) {
  App.zoom = clamp(z, 4, 400);
  drawAll();
}
function zoomFit() {
  const end = projectEnd();
  if (!end) return setZoom(40);
  setZoom(clamp(($("tlScroll").clientWidth - 40) / end, 4, 400));
}
/* Scrubbing: the ruler is a strip you can grab, and it keeps following the
   pointer until you let go — outside the strip too, which is what makes it
   feel like a transport rather than a series of clicks. */
(function scrubbing() {
  const seekTo = e => {
    const r = $("tlInner").getBoundingClientRect();
    App.pos = clamp((e.clientX - r.left) / App.zoom, 0, Math.max(projectEnd(), 0.01));
    $("playhead").style.left = App.pos * App.zoom + "px";
    $("tlPos").textContent = fmt(App.pos, true);
    paintRecorderIdle();
  };
  const strip = document.querySelector(".ruler");
  strip.addEventListener("pointerdown", e => {
    strip.setPointerCapture(e.pointerId);
    seekTo(e);
    const move = ev => seekTo(ev);
    const up = () => { strip.removeEventListener("pointermove", move); strip.removeEventListener("pointerup", up); };
    strip.addEventListener("pointermove", move);
    strip.addEventListener("pointerup", up);
  });
  // empty timeline space seeks too
  $("tlScroll").addEventListener("pointerdown", e => {
    if (e.target.closest(".clip") || e.target.closest(".ruler")) return;
    seekTo(e);
  });
  /* the wheel: across to travel, with a modifier to zoom about the pointer */
  $("tlScroll").addEventListener("wheel", e => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      const r = $("tlInner").getBoundingClientRect();
      const atPointer = (e.clientX - r.left) / App.zoom;          // the second the pointer is over
      setZoom(App.zoom * (e.deltaY > 0 ? 0.88 : 1.14));
      $("tlScroll").scrollLeft = atPointer * App.zoom - (e.clientX - $("tlScroll").getBoundingClientRect().left);
    } else if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
      e.preventDefault();
      $("tlScroll").scrollLeft += e.deltaY;                        // a plain wheel travels sideways
    }
  }, { passive: false });
})();

/* dragging a clip, and dragging its edges to trim */
(function dragging() {
  let mode = null, clip = null, startX = 0, orig = 0, origDur = 0, origOff = 0, el = null;
  $("lanes").addEventListener("pointerdown", e => {
    const box = e.target.closest(".clip");
    if (!box) return;
    clip = App.clips.find(c => c.id === box.dataset.clip);
    if (!clip) return;
    selectClip(clip.id);
    el = $("lanes").querySelector(`.clip[data-clip="${clip.id}"]`);
    mode = e.target.classList.contains("edge")
      ? (e.target.classList.contains("l") ? "trimL" : "trimR") : "move";
    startX = e.clientX; orig = clip.start; origDur = clip.dur; origOff = clip.offset;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    e.preventDefault();
  });
  $("lanes").addEventListener("pointermove", e => {
    if (!mode || !clip || !el) return;
    const d = (e.clientX - startX) / App.zoom;
    if (mode === "move") {
      clip.start = Math.max(0, orig + d);
      el.style.left = clip.start * App.zoom + "px";
      // which lane is the pointer over?
      const lanes = [...$("lanes").children];
      const over = lanes.findIndex(l => { const r = l.getBoundingClientRect();
        return e.clientY >= r.top && e.clientY <= r.bottom; });
      lanes.forEach((l, i) => l.classList.toggle("drop", i === over && over !== clip.track));
      if (over >= 0 && over !== clip.track) { clip.track = over; drawTimeline(); el = null; }
    } else if (mode === "trimL") {
      const max = origOff + origDur - 0.05;
      const off = clamp(origOff + d, 0, max);
      const delta = off - origOff;
      clip.offset = off; clip.dur = origDur - delta; clip.start = orig + delta;
      el.style.left = clip.start * App.zoom + "px";
      el.style.width = Math.max(4, clip.dur * App.zoom) + "px";
    } else {
      const maxDur = clip.buf.length / clip.sr - clip.offset;
      clip.dur = clamp(origDur + d, 0.05, maxDur);
      el.style.width = Math.max(4, clip.dur * App.zoom) + "px";
    }
  });
  const end = () => {
    [...$("lanes").children].forEach(l => l.classList.remove("drop"));
    if (!mode) return;
    const wasTrim = mode !== "move";
    mode = null;
    el?.classList.remove("dragging");
    if (!el) { push("Move clip"); drawAll(); mode = null; return; }
    if (wasTrim && clip) { clip.rendered = null; clip.peaksCache = null; reRender(clip, "Trim"); }
    else push("Move clip");
    drawAll();
  };
  $("lanes").addEventListener("pointerup", end);
  $("lanes").addEventListener("pointercancel", end);
})();

/* ---------------- menus ---------------- */
const MENUS = () => ({
  mFile: [
    ["Record", "record", "R"], ["Import audio…", "import", "⌘O"], null,
    ["Save project", "saveProject", "⌘S"], ["Save a copy to disk…", "downloadProject"], null,
    ["Export WAV…", "export", "⌘E"], ["Export the selected clip…", "exportSel"], null,
    ["Clear everything", "clearAll"],
  ],
  mEdit: [
    ["Undo", "undo", "⌘Z", App.hi > 0], ["Redo", "redo", "⇧⌘Z", App.hi < App.hist.length - 1], null,
    ["Split at playhead", "split", "S"], ["Delete clip", "delete", "⌫"],
    ["Duplicate clip", "duplicate", "⌘D"], null,
    ["Select all", "selectAll", "⌘A"],
  ],
  mVoice: [
    ...allVoices().slice(0, 12).map(v => [v.name, "voice:" + v.id]), null,
    ["Save these settings as a voice…", "saveVoice"],
  ],
  mClip: [
    ["Clean up this recording", "cleanPreset"], ["Learn the room", "learnNoise"],
    ["Trim silence", "trimSilence"], null,
    ["Normalise", "normalizeNow"], ["Rename…", "rename"],
  ],
});
function buildMenus() {
  const menus = MENUS();
  for (const [id, items] of Object.entries(menus)) {
    const box = $(id);
    if (!box) continue;
    box.innerHTML = items.map(it => it === null ? `<div class="msep"></div>`
      : `<button class="mi" data-act="${it[1]}"${it[3] === false ? ' aria-disabled="true"' : ""}>${it[0]}` +
        `${it[2] ? `<span class="sc">${it[2]}</span>` : ""}</button>`).join("");
  }
}

/* ---------------- actions ---------------- */
const ACT = {
  record: startRecording,
  play, stop, pause,
  import: () => $("fileIn").click(),
  export: () => exportWav(),
  exportSel: () => { $("expSel").checked = true; exportWav(); },
  split: splitAtPlayhead,
  delete: deleteClip,
  duplicate: duplicateClip,
  undo, redo,
  selectAll: () => { if (App.clips.length) selectClip(App.clips[0].id); },
  zoomIn: () => setZoom(App.zoom * 1.4),
  zoomOut: () => setZoom(App.zoom / 1.4),
  zoomFit,
  monitor: () => {
    App.monitor = !App.monitor;
    $("obMon").classList.toggle("on", App.monitor);
    toast(App.monitor ? "Monitoring — use headphones" : "Monitoring off");
  },
  learnNoise: learnNoiseFromClip,
  trimSilence: trimSilenceClip,
  saveVoice: saveVoiceFromClip,
  normalizeNow: () => { const c = selClip(); if (c) { c.fx.normalize = true; reRender(c, "Normalise"); } },
  rename: () => {
    const c = selClip();
    if (!c) return;
    const n = prompt("Rename this clip", c.name);
    if (n) { c.name = n; push("Rename"); drawAll(); }
  },
  saveProject: () => window.KilnProject?.save(),
  downloadProject: () => window.KilnProject?.download(),
  clearAll: () => {
    if (!App.clips.length) return;
    App.clips = []; App.sel = null; App.pos = 0;
    push("Clear");
    drawAll();
  },
  cleanPreset: () => {
    const c = selClip();
    if (!c) { toast("Select a clip first", "warn"); return; }
    c.noiseProfile = D.learnNoise(c.buf.subarray(Math.floor(c.offset * c.sr),
      Math.floor((c.offset + c.dur) * c.sr)), c.sr);
    Object.assign(c.fx, { denoise: 55, deEss: 45, gate: -52, compress: 35, low: -1.5, high: 1.5, normalize: true });
    reRender(c, "Clean up");
    toast("Noise learned, sibilance tamed, levelled and normalised");
  },
  addTrack: () => { App.tracks = laneCount() + 1; drawAll(); toast(`Track ${App.tracks}`); },
  seekStart: () => { App.pos = 0; drawTimeline(); paintRecorderIdle(); },
  seekEnd: () => { App.pos = projectEnd(); drawTimeline(); paintRecorderIdle(); },
  nudge: d => { App.pos = clamp(App.pos + d, 0, projectEnd()); drawTimeline(); paintRecorderIdle(); },
  foldR: () => document.body.classList.toggle("foldR"),
};
document.addEventListener("click", e => {
  const rm = e.target.closest("[data-rmvoice]");
  if (rm) { forgetVoice(rm.dataset.rmvoice); e.stopPropagation(); return; }
  const v = e.target.closest("[data-voice]");
  if (v) { applyVoice(v.dataset.voice); return; }
  const mi = e.target.closest(".mi");
  const btn = e.target.closest("[data-act]");
  if (btn) {
    const act = btn.dataset.act;
    if (act.startsWith("voice:")) applyVoice(act.slice(6));
    else ACT[act]?.();
  }
  if (!e.target.closest("[data-menu]") || mi) {
    document.querySelectorAll("[data-menu]").forEach(m => m.classList.remove("open"));
  }
  const pt = e.target.closest(".ptab");
  if (pt) {
    document.querySelectorAll(".ptab").forEach(t => t.classList.toggle("on", t === pt));
    document.querySelectorAll(".pbody").forEach(b => b.classList.toggle("on", b.id === pt.dataset.pt));
  }
});
document.querySelectorAll("[data-menu]").forEach(m => {
  m.querySelector(".menu-t").addEventListener("click", e => {
    e.stopPropagation();
    const was = m.classList.contains("open");
    document.querySelectorAll("[data-menu]").forEach(x => x.classList.remove("open"));
    m.classList.toggle("open", !was);
  });
});
document.addEventListener("input", e => {
  if (e.target.matches("[data-fx]")) onFx(e.target);
});
document.addEventListener("change", e => {
  if (e.target.matches("[data-fx]")) onFx(e.target);
  if (e.target.id === "humHz" && $("fxHum").checked) onFx($("fxHum"));
});
$("fileIn").addEventListener("change", e => { importFile(e.target.files[0]); e.target.value = ""; });

/* drag a file onto the recorder */
["dragover", "drop"].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault();
  if (ev === "drop" && e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
}));

document.addEventListener("keydown", e => {
  const M = e.metaKey || e.ctrlKey;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (M && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (M && e.key.toLowerCase() === "e") { e.preventDefault(); exportWav(); return; }
  if (M && e.key.toLowerCase() === "o") { e.preventDefault(); ACT.import(); return; }
  if (M && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateClip(); return; }
  if (M) return;
  if (e.key === " ") { e.preventDefault(); e.shiftKey ? stop() : play(); }
  else if (e.key.toLowerCase() === "r") { e.preventDefault(); startRecording(); }
  else if (e.key.toLowerCase() === "s") { e.preventDefault(); splitAtPlayhead(); }
  else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteClip(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); ACT.nudge(e.shiftKey ? -1 : -0.1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); ACT.nudge(e.shiftKey ? 1 : 0.1); }
  else if (e.key === "Home") { e.preventDefault(); ACT.seekStart(); }
  else if (e.key === "End") { e.preventDefault(); ACT.seekEnd(); }
  else if (e.key === "Escape") document.querySelectorAll("[data-menu]").forEach(m => m.classList.remove("open"));
});

/* ---------------- devices ---------------- */
async function listDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const ins = list.filter(d => d.kind === "audioinput");
    $("devSel").innerHTML = ins.length
      ? ins.map((d, i) => `<option value="${d.deviceId}">${d.label || "Microphone " + (i + 1)}</option>`).join("")
      : `<option value="">Default microphone</option>`;
  } catch {
    $("devSel").innerHTML = `<option value="">Default microphone</option>`;
  }
}

/* ---------------- keeping the session ----------------
   Clip descriptions are small and go in the session; the samples are not, and
   go in IndexedDB. Coming back finds the same takes on the same tracks with
   the same voices on them. */
function rememberSession() {
  KilnSession?.save({
    tracks: laneCount(),
    zoom: App.zoom,
    clips: App.clips.map(c => ({ id: c.id, name: c.name, sr: c.sr, track: c.track || 0,
      offset: c.offset, dur: c.dur, start: c.start, fx: c.fx, voice: c.voice })),
  });
  for (const c of App.clips) {
    if (c.saved) continue;
    c.saved = true;
    KilnSession?.put("clip:" + c.id, c.buf.buffer.slice(0)).catch(() => { c.saved = false; });
  }
}
async function restoreSession() {
  const s = KilnSession?.state || {};
  if (!s.clips?.length) return false;
  status("Reopening the last session…");
  const clips = [];
  for (const meta of s.clips) {
    const raw = await KilnSession.get("clip:" + meta.id).catch(() => null);
    if (!raw) continue;
    clips.push({ ...meta, buf: new Float32Array(raw), fx: { ...FX0, ...meta.fx },
      rendered: null, peaksCache: null, noiseProfile: null, saved: true });
  }
  if (!clips.length) return false;
  App.clips = clips;
  App.tracks = Math.max(2, s.tracks || 2);
  App.sr = clips[0].sr;
  App.sel = clips[clips.length - 1].id;
  if (s.zoom) App.zoom = s.zoom;
  drawAll();
  for (const c of clips) await renderClip(c);
  drawAll();
  status(`Reopened ${clips.length} clip${clips.length > 1 ? "s" : ""}`);
  return true;
}

/* ---------------- boot ---------------- */
new ResizeObserver(() => { if (!App.recording) paintRecorderIdle(); drawRuler(); })
  .observe(document.querySelector(".scope"));
window.addEventListener("resize", () => drawAll());

buildMenus();
drawVoices();
syncFxUI();
drawAll();
push("Start");
listDevices();
status("Ready");
restoreSession().catch(e => console.warn("Kiln Voice: could not reopen —", e));
addEventListener("pagehide", rememberSession);
if (!navigator.mediaDevices?.getUserMedia) {
  status("No microphone API in this browser", "warn");
  toast("This browser will not give a page the microphone — import a file instead", "warn");
}

/* ---------------- the project system ----------------
   The samples are the assets and the clip list is the document. Undo comes
   with it: a history step here is a list of clip descriptions that share their
   sample data by reference, so the steps cost nothing to write down as long as
   every buffer they mention is in the asset list. That is why the assets are
   gathered from the kept history as well as from the current clips — an undo
   that reaches back to a take you deleted needs that take to still exist. */
window.KilnProject?.register({
  kind: "voice", schema: 1, newName: "Untitled recording", tabName: "Recording",

  /* ---- tabs ----
     Sample buffers move by reference; a switch never copies audio. */
  capture: () => ({
    clips: App.clips, hist: App.hist, hi: App.hi,
    sel: App.sel, sr: App.sr, tracks: App.tracks, zoom: App.zoom, pos: App.pos,
  }),
  adopt(st) {
    if (App.playing) ACT.stop?.();
    App.clips = st.clips; App.hist = st.hist; App.hi = st.hi;
    App.sel = st.sel; App.sr = st.sr; App.tracks = st.tracks;
    App.zoom = st.zoom; App.pos = st.pos;
    drawAll(); buildMenus();
  },
  async snapshot() {
    const keep = App.hist.slice(Math.max(0, App.hi - 19), App.hi + 1);
    const from = Math.max(0, App.hi - 19);
    const bare = c => { const { buf, rendered, peaksCache, noiseProfile, ...rest } = c; return rest; };

    const bufs = new Map();                       // clip id → samples, wherever they were found
    for (const c of App.clips) if (c.buf) bufs.set(c.id, c.buf);
    for (const h of keep) for (const c of h.clips) if (c.buf && !bufs.has(c.id)) bufs.set(c.id, c.buf);

    const assets = [];
    for (const [id, buf] of bufs) {
      const blob = new Blob([buf.buffer.slice(0)], { type: "audio/x-f32" });
      assets.push({ id: "au_" + id, name: id + ".f32", type: "audio/x-f32", size: blob.size, blob });
    }
    return {
      doc: {
        sr: App.sr, tracks: laneCount(), zoom: App.zoom, sel: App.sel,
        clips: App.clips.map(bare),
      },
      assets,
      history: { i: App.hi - from, steps: keep.map(h => ({ label: h.label, sel: h.sel, clips: h.clips.map(bare) })) },
    };
  },
  async restore(doc, assets, rec) {
    const samples = new Map();
    for (const [id, blob] of assets) samples.set(id.replace(/^au_/, ""), new Float32Array(await blob.arrayBuffer()));
    const hydrate = c => ({
      ...c, fx: { ...FX0, ...c.fx }, buf: samples.get(c.id) || new Float32Array(0),
      rendered: null, peaksCache: null, noiseProfile: null, saved: false,
    });
    App.clips = (doc.clips || []).map(hydrate).filter(c => c.buf.length);
    App.sr = doc.sr || App.sr;
    App.tracks = Math.max(2, doc.tracks || 2);
    App.zoom = doc.zoom || App.zoom;
    App.sel = App.clips.some(c => c.id === doc.sel) ? doc.sel : (App.clips.at(-1)?.id ?? null);
    const steps = rec.history?.steps || [];
    App.hist = steps.map(h => ({ ...h, clips: h.clips.map(hydrate) }));
    App.hi = Math.max(0, Math.min(rec.history?.i ?? App.hist.length - 1, App.hist.length - 1));
    if (!App.hist.length) { App.hist = []; App.hi = -1; push("Open project"); }
    drawAll();
    for (const c of App.clips) await renderClip(c);
    drawAll(); buildMenus();
  },
  reset() {
    App.clips = []; App.sel = null; App.pos = 0;
    App.hist = []; App.hi = -1;
    push("New project");
    drawAll();
  },
});
