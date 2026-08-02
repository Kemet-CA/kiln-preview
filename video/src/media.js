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
/* ---------------- animated GIF ----------------
   ImageDecoder is the only way to get at the individual frames; without it
   the GIF still imports and behaves like a still, which is what an <img>
   would have given anyway. */
async function decodeGif(file) {
  if (typeof ImageDecoder === "undefined") return null;
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: "image/gif" });
  await dec.completed;
  await dec.tracks.ready;                 // the frame count is not known before this
  const track = dec.tracks.selectedTrack;
  if (!track?.animated) return null;      // a still GIF is just an image
  const count = track.frameCount || 600;
  const frames = [], times = [];
  let t = 0, w = 0, h = 0;
  for (let i = 0; i < Math.min(count, 600); i++) {          // a sane ceiling
    let image;
    try { ({ image } = await dec.decode({ frameIndex: i })); } catch { break; }
    w = image.displayWidth || image.codedWidth;
    h = image.displayHeight || image.codedHeight;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(image, 0, 0);
    frames.push(cv);
    times.push(t);
    t += (image.duration || 100000) / 1e6;                  // microseconds
    image.close();
  }
  dec.close?.();
  return { frames, times, dur: Math.max(.1, t), w, h };
}

/* the frame that belongs at this moment, looping the way a GIF does */
export function gifFrameAt(media, t) {
  const g = media.gif;
  if (!g) return media.el;
  const at = ((t % g.dur) + g.dur) % g.dur;
  let i = 0;
  while (i + 1 < g.times.length && g.times[i + 1] <= at) i++;
  return g.frames[i];
}

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
    /* An animated GIF drawn from an <img> gives whatever frame the browser
       happens to be showing, which is fine on a page and wrong on a timeline.
       Decoding it properly means the clip plays at its own rate, scrubs, and
       exports the frame that belongs at that moment. */
    if (/gif/i.test(file.type) || /\.gif$/i.test(file.name)) {
      const gif = await decodeGif(file).catch(() => null);
      if (gif && gif.frames.length > 1) {
        media.gif = gif;
        media.dur = gif.dur;
        media.w = gif.w; media.h = gif.h;
      }
    }
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

    if (kind === "video") {
      media.poster = await posterOf(el).catch(() => null);
      // the strip takes a moment; let the pool show the poster first
      filmstripOf(el).then(strip => {
        if (!strip) return;
        media.strip = strip.url;
        media.stripFrames = strip.frames;
        media.stripAspect = strip.aspect;      // one frame's width ÷ its height
        window.__kilnStrip?.(media);
      }).catch(() => {});
    }
  }
  media.buffer = await file.arrayBuffer();

  /* Does this file carry sound, and what is it? There is no property that
     answers honestly — `webkitAudioDecodedByteCount` is zero until something
     has played, and `mozHasAudio` is not Chrome — so the answer comes from
     trying to decode it. Decoding throws when there is no audio track.

     The decoded buffer is kept, which turns the cost into a saving: the
     exporter used to decode every file again at mix time and now does not. */
  if (kind !== "image") {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      media.audio = await ac.decodeAudioData(media.buffer.slice(0));
      media.hasAudio = media.audio.length > 0;
      ac.close?.();
    } catch {
      media.hasAudio = false;                 // no audio track, or none we can read
    }
  }

  putBlob(id, file);
  return media;
}

/* ---------------- the filmstrip ----------------
   One wide image of frames taken across the whole clip, so the timeline shows
   where the scenes are rather than the same still repeated. Built once per
   media on import and cached with it; seeking a <video> is slow, so the count
   is kept to what is useful at timeline sizes.

   Built after the poster so the pool has something to show immediately. */
async function filmstripOf(el, frames = 0) {
  const dur = el.duration;
  if (!isFinite(dur) || dur <= 0) return null;
  /* One frame roughly every two seconds rather than a fixed twelve. A minute
     of footage squeezed into twelve frames had to be stretched to cover the
     clip, which is what made long videos look smeared. */
  if (!frames) frames = Math.max(8, Math.min(40, Math.round(dur / 2)));
  const fh = 44;
  const fw = Math.max(1, Math.round(fh * (el.videoWidth / Math.max(1, el.videoHeight)) || 78));
  const c = document.createElement("canvas");
  c.width = fw * frames; c.height = fh;
  const x = c.getContext("2d");
  let broken = false;
  const onErr = () => { broken = true; };
  el.addEventListener("error", onErr);
  for (let i = 0; i < frames; i++) {
    // the element can be torn down while this is still seeking — stop rather
    // than keep asking a blob that is no longer there
    if (broken || !el.isConnected && !el.src) break;
    const at = (i + 0.5) / frames * dur;
    await new Promise(res => {
      let done = false;
      const finish = () => { if (done) return; done = true; el.removeEventListener("seeked", finish); res(); };
      el.addEventListener("seeked", finish);
      setTimeout(finish, 700);                       // never hang on a stubborn file
      el.currentTime = Math.min(at, dur - 0.02);
    });
    try { x.drawImage(el, i * fw, 0, fw, fh); } catch {}
  }
  el.removeEventListener("error", onErr);
  if (broken) return null;
  el.currentTime = 0;
  return { url: c.toDataURL("image/jpeg", 0.55), frames, aspect: fw / fh };
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
