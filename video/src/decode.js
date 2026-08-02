/* ============================================================
   Kiln Video — reading frames out of a file.

   An export is decode-bound. Measured on a ten-second timeline at 720p, 95%
   of the wall clock was the browser decoding the frame each seek asked for —
   about 35 ms a frame, against 3 ms of compositing and no measurable wait on
   the encoder. Export time was decode time, and nothing else was close.

   A seek is expensive because it is not one decode. To show frame 300 the
   decoder goes back to the keyframe before it and decodes forward through
   everything in between, then throws that work away. The next frame asks for
   the same thing again. Reading a file front to back decodes each packet once.

   That is all this module does: given the moments a clip needs, in order, it
   hands back pictures. `canvasesAtTimestamps` keeps one decode pipeline open
   and walks it forward, so the whole clip costs one pass rather than one pass
   per frame.

   It is deliberately failable. A file the demuxer will not open — an odd
   codec, a container it does not know — returns null and the exporter carries
   on with the seek path it has always had. Slower is better than broken.
   ============================================================ */
import { ALL_FORMATS, BlobSource, Input, CanvasSink } from "../vendor/mediabunny.mjs";

/* One clip's worth of pictures, pulled in the order the export asks for them. */
export class FrameReader {
  constructor(sink, times) {
    this.iter = sink.canvasesAtTimestamps(times);
    this.last = null;
    this.done = false;
  }
  /* The next picture. A null from the iterator means the file had nothing at
     that moment — the frame before it is the honest answer, since that is what
     was on screen. */
  async next() {
    if (this.done) return this.last;
    const step = await this.iter.next();
    if (step.done) { this.done = true; return this.last; }
    if (step.value?.canvas) this.last = step.value.canvas;
    return this.last;
  }
  async close() {
    this.done = true;
    try { await this.iter.return?.(); } catch { /* already finished */ }
  }
}

/* Open a media item for reading. Returns null when the file cannot be read
   this way, which is a fact about the file rather than an error. */
export async function openReader(media, times, opts = {}) {
  const blob = media?.file || (media?.buffer ? new Blob([media.buffer]) : null);
  if (!blob) return null;
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    if (!(await track.canDecode())) return null;
    const sink = new CanvasSink(track, {
      /* Decode straight to the size the export draws at. A 4K source composited
         into a 1080p frame is three quarters of every decoded pixel thrown
         away, and the scaler here is the same one drawImage would have used. */
      width: opts.width || undefined,
      fit: opts.width ? "contain" : undefined,
      poolSize: 2,
    });
    return new FrameReader(sink, times);
  } catch {
    return null;                       // unknown container, broken file, no codec
  }
}

/* Whether this path is available at all: the demuxer needs WebCodecs. */
export const canDecode = () => typeof VideoDecoder !== "undefined";
