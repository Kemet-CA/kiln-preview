/* ============================================================
   Media — importing files, probing them, and keeping them around.

   A media item owns three things: the decoded <video>/<img> element the
   preview draws from, an ArrayBuffer the exporter decodes audio out of, and a
   poster frame for the timeline. Blobs are also written to IndexedDB so a
   saved project can reopen with its footage instead of asking for the files
   again.
   ============================================================ */
import { uid } from "./model.js";

const DB = "kiln-video", STORE = "media";

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function putBlob(id, blob) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, id);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* storage unavailable — the project still works this session */ }
}
export async function getBlob(id) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly");
      const q = tx.objectStore(STORE).get(id);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    });
  } catch { return null; }
}

const kindOf = file =>
  file.type.startsWith("video") ? "video" :
  file.type.startsWith("audio") ? "audio" :
  file.type.startsWith("image") ? "image" : null;

/* load a file into something the compositor can draw, and measure it */
export async function importFile(file, id = uid("m")) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`${file.name} is not a video, audio or image file`);
  const url = URL.createObjectURL(file);
  const media = { id, name: file.name, kind, url, size: file.size, file };

  if (kind === "image") {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    media.el = img;
    media.w = img.naturalWidth; media.h = img.naturalHeight;
    media.dur = 5;                       // stills get a default length on the timeline
    media.poster = url;
  } else {
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    el.src = url;
    el.preload = "auto";
    el.muted = true;                     // the WebAudio graph does the hearing
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    await new Promise((res, rej) => {
      el.addEventListener("loadedmetadata", res, { once: true });
      el.addEventListener("error", () => rej(new Error(`Could not read ${file.name}`)), { once: true });
      setTimeout(res, 8000);
    });
    media.el = el;
    media.dur = isFinite(el.duration) ? el.duration : 10;
    media.w = el.videoWidth || 0;
    media.h = el.videoHeight || 0;
    if (kind === "video") media.poster = await posterOf(el).catch(() => null);
  }
  media.buffer = await file.arrayBuffer();
  putBlob(id, file);
  return media;
}

/* a small still from one second in, for the timeline and the media pool */
async function posterOf(el) {
  const at = Math.min(1, (el.duration || 2) / 3);
  await new Promise(res => {
    const done = () => res();
    el.addEventListener("seeked", done, { once: true });
    setTimeout(done, 1200);
    el.currentTime = at;
  });
  const c = document.createElement("canvas");
  const scale = 160 / Math.max(1, el.videoWidth);
  c.width = 160; c.height = Math.max(1, Math.round(el.videoHeight * scale));
  c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
  el.currentTime = 0;
  return c.toDataURL("image/jpeg", .6);
}

/* re-attach footage to a project loaded from JSON */
export async function rehydrate(project) {
  const missing = [];
  for (const m of project.media) {
    const blob = await getBlob(m.id);
    if (!blob) { missing.push(m.name); continue; }
    const file = new File([blob], m.name, { type: blob.type });
    Object.assign(m, await importFile(file, m.id));
  }
  return missing;
}

/* ============================================================
   Audio graph — one gain per clip, one per track, one master.
   Built fresh whenever the edit changes; WebAudio nodes are cheap and this
   avoids a whole class of stale-routing bugs.
   ============================================================ */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sources = new Map();     // media id → MediaElementSourceNode
    this.gains = new Map();       // clip id → GainNode
  }
  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }
  /* a media element can only ever have one source node, so they are cached */
  sourceFor(media) {
    if (!media?.el || media.kind === "image") return null;
    if (!this.sources.has(media.id)) {
      try { this.sources.set(media.id, this.ctx.createMediaElementSource(media.el)); }
      catch { this.sources.set(media.id, null); }
    }
    return this.sources.get(media.id);
  }
  gainFor(clip, media) {
    this.ensure();
    if (!this.gains.has(clip.id)) {
      const g = this.ctx.createGain();
      g.connect(this.master);
      const src = this.sourceFor(media);
      src?.connect(g);
      this.gains.set(clip.id, g);
    }
    return this.gains.get(clip.id);
  }
  setGain(clip, media, value) {
    const g = this.gainFor(clip, media);
    if (g) g.gain.value = value;
  }
  setMaster(v) { this.ensure(); this.master.gain.value = v; }
  silenceAll() { for (const g of this.gains.values()) g.gain.value = 0; }
}

/* ---------------- voiceover ---------------- */
export async function recordVoice(onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.start();

  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.frequencyBinCount);
  const tick = () => {
    if (rec.state !== "recording") return;
    an.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
    onLevel?.(peak);
    requestAnimationFrame(tick);
  };
  tick();

  return {
    stop: () => new Promise(res => {
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        ctx.close();
        res(new File([new Blob(chunks, { type: rec.mimeType })], `Voiceover ${new Date().toLocaleTimeString()}.webm`,
          { type: rec.mimeType }));
      };
      rec.stop();
    }),
  };
}
