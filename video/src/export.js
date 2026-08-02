/* ============================================================
   Export — encode the timeline to a real video file.

   WebCodecs encodes frames the compositor draws; mp4-muxer / webm-muxer write
   the container. Audio is mixed offline through an OfflineAudioContext, then
   encoded in chunks. Frames come from seeking the source <video> elements,
   which is slower than decoding a stream but works with any file the browser
   can play, and keeps the exporter honest: it renders through exactly the same
   compositor as the preview.

   Everything here reports progress and can be cancelled — a 4K export is long
   enough that a stuck one has to be escapable.
   ============================================================ */
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "../vendor/mp4-muxer.mjs";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "../vendor/webm-muxer.mjs";
import { duration, mediaOf } from "./model.js";
import { renderFrame, visualClipsAt, sourceTime, audibleClipsAt, gainAt } from "./render.js";
import { spectral } from "./dsp.js";        // the denoiser the Voice workspace uses
import { gifFrameAt } from "./media.js";    // animated GIFs supply their own frames

/* Real noise removal, not a gate: spectral subtraction against a profile
   learned from the quietest tenth of the clip. Applied to the decoded buffer
   before it is mixed, and cached, because it is not cheap. */
const denoised = new Map();
function denoiseBuffer(ctx, buf, key) {
  if (denoised.has(key)) return denoised.get(key);
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const clean = spectral(buf.getChannelData(ch), buf.sampleRate, { denoise: 60 });
    out.copyToChannel(clean.length === buf.length ? clean : clean.subarray(0, buf.length), ch);
  }
  denoised.set(key, out);
  return out;
}

export const PRESETS = {
  "480p":  { w: 854,  h: 480,  bitrate: 2.5e6 },
  "720p":  { w: 1280, h: 720,  bitrate: 5e6 },
  "1080p": { w: 1920, h: 1080, bitrate: 10e6 },
  "1440p": { w: 2560, h: 1440, bitrate: 18e6 },
  "4K":    { w: 3840, h: 2160, bitrate: 40e6 },
};
/* A resolution preset names how many lines the *short* edge gets — 1080p is
   1920×1080 landscape and 1080×1920 portrait, the way a phone means it. The
   old code took the preset's literal 16:9 numbers and scaled the project into
   them on each axis separately, which squashed anything that was not 16:9.
   Bitrate follows the pixel count so quality holds across shapes. */
export let lastTimings = null;      // what the previous export spent its time on

export function outputSize(project, preset) {
  const P = PRESETS[preset] || PRESETS["1080p"];
  const short = P.h;
  const a = (project.w || 16) / (project.h || 9);
  let w, h;
  if (a >= 1) { h = short; w = Math.round(short * a); }
  else { w = short; h = Math.round(short / a); }
  w += w % 2; h += h % 2;                      // H.264 wants even dimensions
  return { w, h, bitrate: Math.round(P.bitrate * (w * h) / (P.w * P.h)) };
}

export const FORMATS = {
  mp4:  { ext: "mp4",  mime: "video/mp4",  video: "avc",  audio: "aac"  },
  webm: { ext: "webm", mime: "video/webm", video: "vp09", audio: "opus" },
};

export const supported = () => typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined";

/* an H.264 level that covers the frame size, so 4K does not fail at 1080p's level */
function avcCodec(w, h) {
  const px = w * h;
  const level = px > 1920 * 1080 ? "33" : px > 1280 * 720 ? "2a" : "1f";
  return `avc1.6400${level}`;
}

/* seek a <video> and wait for the frame to actually be there */
/* Every seek costs a decode, and the decode is nearly the whole of an export —
   measured at 95% of the wall clock. So the cheapest seek is the one that does
   not happen: if the element is already showing the frame this moment needs,
   asking for it again buys nothing but the decode.

   `tol` is half a source frame. Two output frames that land inside the same
   source frame are the same picture, which happens whenever the output runs
   faster than the source, whenever a clip is slowed down, and on any still. */
function seekTo(el, t, tol = 0.001) {
  const want = Math.max(0, Math.min(t, (el.duration || 1e9) - 0.001));
  if (Math.abs(el.currentTime - want) <= tol && el.readyState >= 2) return null;
  const p = new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; el.removeEventListener("seeked", finish); resolve(); };
    el.addEventListener("seeked", finish, { once: true });
    setTimeout(finish, 400);                       // never hang the whole export on one frame
  });
  el.currentTime = want;
  return p;
}

/* ---------------- audio ---------------- */
async function mixAudio(project, sampleRate, totalDur, onProgress) {
  const frames = Math.max(1, Math.ceil(totalDur * sampleRate));
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  let decoded = 0;
  const buffers = new Map();
  const withAudio = project.tracks.flatMap(t => t.muted ? [] : t.clips.filter(c => !c.muted && c.mediaId));
  for (const clip of withAudio) {
    const media = mediaOf(project, clip);
    if (!media?.buffer || buffers.has(media.id)) continue;
    // import already decoded it; decoding the same file twice is pure waste
    if (media.audio) { buffers.set(media.id, media.audio); }
    else {
      try { buffers.set(media.id, await ctx.decodeAudioData(media.buffer.slice(0))); }
      catch { buffers.set(media.id, null); }       // silent or image media
    }
    onProgress?.(++decoded / Math.max(1, withAudio.length) * .15);
  }
  for (const clip of withAudio) {
    const media = mediaOf(project, clip);
    const buf = buffers.get(media?.id);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = clip.denoise ? denoiseBuffer(ctx, buf, media.id) : buf;
    src.playbackRate.value = clip.speed;
    const gain = ctx.createGain();
    // sample the same gain curve the preview uses, so fades and keyframes match
    const steps = Math.max(2, Math.ceil(clip.dur * 20));
    for (let i = 0; i <= steps; i++) {
      const t = clip.start + (clip.dur * i) / steps;
      gain.gain.linearRampToValueAtTime(gainAt(clip, t), Math.max(0, t));
    }
    src.connect(gain).connect(ctx.destination);
    try { src.start(clip.start, clip.in, clip.dur * clip.speed); } catch { /* out of range */ }
  }
  return ctx.startRendering();
}

/* ---------------- main ---------------- */
export async function exportVideo(project, opts, hooks = {}) {
  const { preset = "1080p", format = "mp4", fps = project.fps, quality = 1 } = opts;
  const P = PRESETS[preset], F = FORMATS[format];
  if (!supported()) throw new Error("This browser cannot encode video (WebCodecs unavailable)");

  const total = duration(project);
  if (total <= 0) throw new Error("The timeline is empty");

  const OUT = outputSize(project, preset);
  const W = OUT.w, H = OUT.h;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });
  // render at the project's own size, then scale — keeps text and transforms exact
  const scale = { x: W / project.w, y: H / project.h };

  const sampleRate = 48000;
  hooks.onStage?.("Mixing audio");
  const audioBuf = await mixAudio(project, sampleRate, total, p => hooks.onProgress?.(p * .1));

  hooks.onStage?.("Preparing encoder");
  const target = format === "mp4" ? new Mp4Target() : new WebmTarget();
  const muxer = format === "mp4"
    ? new Mp4Muxer({
        target, fastStart: "in-memory",
        video: { codec: "avc", width: W, height: H, frameRate: fps },
        audio: { codec: "aac", numberOfChannels: 2, sampleRate },
      })
    : new WebmMuxer({
        target,
        video: { codec: "V_VP9", width: W, height: H, frameRate: fps },
        audio: { codec: "A_OPUS", numberOfChannels: 2, sampleRate },
      });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => hooks.onError?.(e),
  });
  videoEncoder.configure({
    codec: format === "mp4" ? avcCodec(W, H) : "vp09.00.10.08",
    width: W, height: H, framerate: fps,
    bitrate: Math.round(OUT.bitrate * quality),
    ...(format === "mp4" ? { avc: { format: "avc" } } : {}),
  });

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: e => hooks.onError?.(e),
  });
  audioEncoder.configure({
    codec: format === "mp4" ? "mp4a.40.2" : "opus",
    sampleRate, numberOfChannels: 2, bitrate: 192000,
  });

  /* ---- video ----
     An export is decode-bound. Measured on a 10-second timeline: 95% of the
     wall clock is the browser decoding the frame each seek asks for, ~35 ms a
     frame, against 3 ms of compositing and no measurable encoder wait.

     A pool of extra <video> elements decoding in parallel was tried and
     reverted: it did overlap the decodes, but the frames drawn no longer
     matched the seeks that had been issued, and a faster export of the wrong
     pictures is not faster. The real fix is not to seek at all — demux the
     source and feed a WebCodecs VideoDecoder, which decodes forward once
     instead of paying for a seek per frame. That needs a demuxer, which is a
     piece of work in its own right and is the next thing to do here. */
  hooks.onStage?.("Rendering frames");
  const frameCount = Math.ceil(total * fps);
  const els = new Map();                    // clip id → the <video> it draws from
  for (const track of project.tracks)
    for (const clip of track.clips) {
      const media = mediaOf(project, clip);
      if (media?.el) els.set(clip.id, media.el);
    }

  /* Where the time goes, kept because "export is slow" is not actionable
     without it: decoding source frames, compositing them and waiting for the
     encoder are three different problems with three different fixes. */
  const spent = { seek: 0, draw: 0, encode: 0, seeks: 0 };
  const clock = () => performance.now();

  for (let i = 0; i < frameCount; i++) {
    if (hooks.cancelled?.()) { videoEncoder.close(); audioEncoder.close(); return null; }
    const t = i / fps;

    const sources = new Map();
    const waits = [];
    for (const clip of visualClipsAt(project, t)) {
      const media = mediaOf(project, clip);
      if (!media) continue;
      if (media.kind === "image") {
        sources.set(clip.id, media.gif ? gifFrameAt(media, sourceTime(clip, t)) : media.el);
        continue;
      }
      const el = els.get(clip.id) || media.el;
      if (!el) continue;
      /* Half an output frame, adjusted for the clip's speed: that is how far
         the source moves between two output frames, so anything closer than
         half of it is the same picture and the decode can be skipped. It pays
         on stills, on slowed clips, and whenever the output runs faster than
         the source. */
      const tol = Math.max(0.001, (clip.speed || 1) / (fps * 2) - 0.0005);
      const wait = seekTo(el, sourceTime(clip, t), tol);
      if (wait) waits.push(wait);           // several clips decode at once
      sources.set(clip.id, el);
    }
    if (waits.length) {
      const s0 = clock();
      await Promise.all(waits);
      spent.seek += clock() - s0;
      spent.seeks = (spent.seeks || 0) + waits.length;
    }

    const d0 = clock();
    ctx.save();
    ctx.scale(scale.x, scale.y);
    renderFrame(ctx, project, t, sources);
    ctx.restore();

    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
    videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    spent.draw += clock() - d0;
    const e0 = clock();
    if (videoEncoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
    spent.encode += clock() - e0;
    if (i % 3 === 0) hooks.onProgress?.(.1 + .8 * (i / frameCount));
  }

  /* ---- audio ---- */
  hooks.onStage?.("Encoding audio");
  const CH = 1024 * 10;
  const left = audioBuf.getChannelData(0);
  const right = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : left;
  for (let off = 0; off < audioBuf.length; off += CH) {
    const n = Math.min(CH, audioBuf.length - off);
    const inter = new Float32Array(n * 2);
    for (let s = 0; s < n; s++) { inter[s * 2] = left[off + s]; inter[s * 2 + 1] = right[off + s]; }
    audioEncoder.encode(new AudioData({
      format: "f32", sampleRate, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round((off / sampleRate) * 1e6), data: inter,
    }));
    if (audioEncoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
  }

  lastTimings = { ...spent, frames: frameCount, seeks: spent.seeks || 0 };
  hooks.onStage?.("Finishing file");
  await videoEncoder.flush();
  await audioEncoder.flush();
  muxer.finalize();
  hooks.onProgress?.(1);
  return new Blob([target.buffer], { type: F.mime });
}
