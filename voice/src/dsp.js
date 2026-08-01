/* ============================================================
   Kiln Voice — the signal processing.

   No DOM in this file, no Web Audio: it takes Float32Arrays and returns
   Float32Arrays, so every part of it can be measured by a test rather than
   looked at. Two kinds of work live here:

     * things that need the spectrum — noise removal, de-essing, hum notching,
       whispering, and pitch and formant shifting. These share one short-time
       Fourier transform pass so the signal is analysed once, not five times.

     * things that are simpler in time — gating, trimming, normalising,
       measuring. The remaining effects (EQ, compression, reverb, delay, ring
       modulation) are Web Audio nodes and live in the engine, because the
       browser already has good ones and running them offline gives the same
       result as playing them.

   What this cannot do, and does not pretend to: turn one person's voice into
   another named person's. That needs a trained model. What it does is change
   the two things that actually make a voice sound like itself — its pitch and
   the resonances of the throat and mouth that sit on top of it — which is
   enough to make a recording unrecognisable, or to build a character.
   ============================================================ */

/* ---------------- FFT: iterative radix-2, tables precomputed ---------------- */
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error("FFT size must be a power of two");
    this.n = n;
    this.levels = Math.log2(n);
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(2 * Math.PI * i / n);
      this.sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < this.levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
  }
  transform(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  }
  inverse(re, im) {
    this.transform(im, re);                  // swapping the parts inverts it
    const n = this.n;
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

const hann = n => {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
};

/* ---------------- helpers ---------------- */
export const dbToGain = db => Math.pow(10, db / 20);
export const gainToDb = g => 20 * Math.log10(Math.max(g, 1e-12));

export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
}
export function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/* Pitch, by autocorrelation. Used for the readout in the panel and by the
   tests, which need a number to show that a shift did what it says. */
export function detectPitch(x, sampleRate, min = 60, max = 500) {
  const size = Math.min(x.length, 4096);
  if (size < 512) return 0;
  const start = Math.max(0, Math.floor((x.length - size) / 2));
  const buf = x.subarray(start, start + size);
  if (rms(buf) < 0.005) return 0;
  const minLag = Math.floor(sampleRate / max), maxLag = Math.floor(sampleRate / min);
  let best = -1, bestLag = 0;
  for (let lag = minLag; lag <= Math.min(maxLag, size - 1); lag++) {
    let sum = 0, norm = 0;
    for (let i = 0; i < size - lag; i++) { sum += buf[i] * buf[i + lag]; norm += buf[i + lag] * buf[i + lag]; }
    const score = sum / Math.sqrt(norm + 1e-9);
    if (score > best) { best = score; bestLag = lag; }
  }
  if (!bestLag) return 0;
  // parabolic touch-up around the winning lag
  return sampleRate / bestLag;
}

/* ---------------- the spectral pass ----------------
   One walk through the signal that can denoise, de-ess, notch hum, whisper
   and shift pitch and formants. Frame 2048, hop 512, Hann in and out.

   opts:
     denoise 0..100      how hard to subtract the noise it has learned
     noiseProfile        magnitudes to subtract; learned from the quiet parts
                         when not supplied
     deEss 0..100        pull down 4.5-9 kHz only in the frames where it spikes
     hum 0 | 50 | 60     notch the mains frequency and its harmonics
     whisper 0..100      randomise phase: voiced speech turns breathy
     formant  semitones  warp the envelope on its own axis

   Pitch is not done here. Shifting bins around at this hop size reconstructs
   an amplitude that is wrong by an order of magnitude — the frames stop being
   consistent with one another and the overlap-add adds coherently. It lives in
   pitchShift() below, which stretches time and resamples instead: slower, but
   exact in level and free of the metallic ring that a coarse vocoder leaves on
   a voice.
*/
const FRAME = 2048, HOP = 512, BINS = FRAME / 2 + 1;

export function learnNoise(x, sampleRate) {
  // The quietest tenth of the frames is the room, not the speaker. Taking a
  // percentile rather than the first half-second means it works on a clip
  // that starts in the middle of a word.
  const fft = new FFT(FRAME), win = hann(FRAME);
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
  const frames = [];
  for (let pos = 0; pos + FRAME <= x.length; pos += HOP) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = x[pos + i] * win[i];
    fft.transform(re, im);
    const mag = new Float32Array(BINS);
    let energy = 0;
    for (let k = 0; k < BINS; k++) { mag[k] = Math.hypot(re[k], im[k]); energy += mag[k]; }
    frames.push({ mag, energy });
  }
  if (!frames.length) return new Float32Array(BINS);
  frames.sort((a, b) => a.energy - b.energy);
  const take = Math.max(1, Math.floor(frames.length * 0.1));
  const prof = new Float32Array(BINS);
  for (let f = 0; f < take; f++) for (let k = 0; k < BINS; k++) prof[k] += frames[f].mag[k];
  for (let k = 0; k < BINS; k++) prof[k] /= take;
  return prof;
}

/* spectral envelope by cepstral smoothing — the shape of the throat and
   mouth, separated from the pitch that excites it */
function envelope(mag, fft, work, cutoff = 42) {
  const n = FRAME;
  const re = work.re, im = work.im;
  // even symmetry, or the cepstrum comes back complex and the envelope that
  // exp() rebuilds from it is wrong by orders of magnitude
  for (let k = 0; k < BINS; k++) re[k] = Math.log(Math.max(mag[k], 1e-8));
  for (let k = 1; k < n / 2; k++) re[n - k] = re[k];
  im.fill(0);
  fft.transform(re, im);                       // to the cepstrum
  for (let k = cutoff; k < n - cutoff; k++) { re[k] = 0; im[k] = 0; }
  fft.inverse(re, im);
  const env = new Float32Array(BINS);
  for (let k = 0; k < BINS; k++) env[k] = Math.exp(re[k]);
  return env;
}

export function spectral(x, sampleRate, opts = {}) {
  const denoise = (opts.denoise || 0) / 100;
  const deEss = (opts.deEss || 0) / 100;
  const whisper = (opts.whisper || 0) / 100;
  const hum = opts.hum || 0;
  const formantRatio = Math.pow(2, (opts.formant || 0) / 12);
  const shifting = Math.abs(formantRatio - 1) > 1e-6;
  if (!denoise && !deEss && !whisper && !hum && !shifting) return x.slice();
  if (x.length < FRAME) return x.slice();

  const noise = denoise ? (opts.noiseProfile || learnNoise(x, sampleRate)) : null;
  const fft = new FFT(FRAME), win = hann(FRAME);
  const work = { re: new Float32Array(FRAME), im: new Float32Array(FRAME) };
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
  const out = new Float32Array(x.length + FRAME);
  const wsum = new Float32Array(x.length + FRAME);

  const binHz = sampleRate / FRAME;
  const expected = 2 * Math.PI * HOP / FRAME;
  const lastPhase = new Float32Array(BINS);
  const sumPhase = new Float32Array(BINS);
  const prevGain = new Float32Array(BINS).fill(1);
  const mag = new Float32Array(BINS), freq = new Float32Array(BINS);
  const dEssLo = Math.floor(4500 / binHz), dEssHi = Math.min(BINS - 1, Math.floor(9000 / binHz));

  for (let pos = 0; pos + FRAME <= x.length; pos += HOP) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = x[pos + i] * win[i];
    fft.transform(re, im);

    let total = 0, high = 0;
    for (let k = 0; k < BINS; k++) {
      const m = Math.hypot(re[k], im[k]);
      const phase = Math.atan2(im[k], re[k]);
      // true frequency of this bin, from how far the phase moved
      let d = phase - lastPhase[k] - k * expected;
      lastPhase[k] = phase;
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      freq[k] = (k + d * FRAME / (2 * Math.PI * HOP)) * binHz;
      mag[k] = m;
      total += m;
      if (k >= dEssLo && k <= dEssHi) high += m;
    }

    /* --- noise subtraction, with a floor so it does not sing --- */
    if (noise) {
      const over = 1 + denoise * 2.2;
      const floor = 0.12 - denoise * 0.1;
      for (let k = 0; k < BINS; k++) {
        const clean = mag[k] - over * noise[k];
        let g = clean > 0 ? clean / Math.max(mag[k], 1e-9) : 0;
        g = Math.max(g, floor);
        g = 0.6 * g + 0.4 * prevGain[k];       // smooth in time: fewer artefacts
        prevGain[k] = g;
        mag[k] *= g;
      }
    }
    /* --- de-esser: only the frames where the sibilance actually spikes --- */
    if (deEss && total > 1e-6) {
      const share = high / total;
      if (share > 0.28) {
        const cut = 1 - Math.min(0.85, (share - 0.28) * 3 * deEss);
        for (let k = dEssLo; k <= dEssHi; k++) mag[k] *= cut;
      }
    }
    /* --- mains hum and its harmonics --- */
    if (hum) {
      for (let f = hum; f < sampleRate / 2; f += hum) {
        const k = Math.round(f / binHz);
        for (let j = Math.max(0, k - 1); j <= Math.min(BINS - 1, k + 1); j++) mag[j] *= 0.06;
      }
    }

    /* --- formants: move the throat, leave the pitch --- */
    if (shifting) {
      const env = envelope(mag, fft, work);
      // Whitening divides by the envelope, and in a bin that holds nothing the
      // envelope is nothing either — the quotient would come out at one and a
      // thousand empty bins would be re-voiced into a roar. Floor the divisor
      // against the loudest part of this frame so silence stays silent.
      let envMax = 0, before = 0;
      for (let k = 0; k < BINS; k++) { if (env[k] > envMax) envMax = env[k]; before += mag[k] * mag[k]; }
      const floor = Math.max(envMax * 1e-3, 1e-9);
      let after = 0;
      for (let k = 0; k < BINS; k++) {
        const src = k / formantRatio;
        const i0 = Math.floor(src), t = src - i0;
        const e = i0 + 1 < BINS ? env[i0] * (1 - t) + env[i0 + 1] * t : env[BINS - 1];
        mag[k] = (mag[k] / Math.max(env[k], floor)) * e;
        after += mag[k] * mag[k];
      }
      // moving the resonances should change the colour, not the loudness
      const fix = after > 1e-12 ? Math.min(4, Math.max(0.25, Math.sqrt(before / after))) : 1;
      if (fix !== 1) for (let k = 0; k < BINS; k++) mag[k] *= fix;
    }

    /* --- resynthesis --- */
    re.fill(0); im.fill(0);
    for (let k = 0; k < BINS; k++) {
      let d = freq[k] - k * binHz;
      d = 2 * Math.PI * HOP * d / sampleRate + k * expected;
      sumPhase[k] += d;
      const ph = whisper ? sumPhase[k] * (1 - whisper) + Math.random() * 2 * Math.PI * whisper : sumPhase[k];
      const m = whisper ? mag[k] * (1 - whisper * 0.35) : mag[k];
      re[k] = m * Math.cos(ph); im[k] = m * Math.sin(ph);
      if (k > 0 && k < FRAME / 2) { re[FRAME - k] = re[k]; im[FRAME - k] = -im[k]; }
    }
    fft.inverse(re, im);
    for (let i = 0; i < FRAME; i++) {
      out[pos + i] += re[i] * win[i];
      wsum[pos + i] += win[i] * win[i];
    }
  }
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = wsum[i] > 1e-6 ? out[i] / wsum[i] : x[i];
  return y;
}

/* ---------------- pitch ----------------
   Stretch time, then read it back faster. The stretch is WSOLA: each output
   frame is the piece of the original that best continues what has already been
   written, so periods line up and the voice keeps its texture instead of
   flanging. Amplitude is untouched by construction — every output sample is a
   cross-fade of real input samples. */
export function timeStretch(x, alpha) {
  if (Math.abs(alpha - 1) < 1e-6 || x.length < 4096) return x.slice();
  const N = 1024, Hs = N >> 1, Ha = Math.max(1, Math.round(Hs / alpha)), delta = N >> 2;
  const w = hann(N);
  const outLen = Math.ceil(x.length * alpha) + N;
  const acc = new Float32Array(outLen), norm = new Float32Array(outLen);
  const templ = new Float32Array(N);
  let ana = 0, syn = 0, first = true;
  while (ana + N < x.length && syn + N < outLen) {
    let best = 0;
    if (!first) {
      let bestScore = -Infinity;
      for (let off = -delta; off <= delta; off++) {
        const p = ana + off;
        if (p < 0 || p + N > x.length) continue;
        let sum = 0;
        for (let i = 0; i < N; i += 4) sum += x[p + i] * templ[i];   // every fourth sample picks the same winner
        if (sum > bestScore) { bestScore = sum; best = off; }
      }
    }
    first = false;
    const p = Math.max(0, Math.min(x.length - N, ana + best));
    for (let i = 0; i < N; i++) { acc[syn + i] += x[p + i] * w[i]; norm[syn + i] += w[i]; }
    for (let i = 0; i < N; i++) templ[i] = x[Math.min(x.length - 1, p + Hs + i)];
    ana += Ha; syn += Hs;
  }
  const y = new Float32Array(Math.max(1, Math.round(x.length * alpha)));
  for (let i = 0; i < y.length; i++) y[i] = norm[i] > 1e-4 ? acc[i] / norm[i] : 0;
  return y;
}

export function resample(x, ratio) {
  if (Math.abs(ratio - 1) < 1e-6) return x.slice();
  const n = Math.max(1, Math.floor(x.length / ratio));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * ratio, i0 = Math.floor(s), t = s - i0;
    const a = x[i0] || 0, b = x[i0 + 1] !== undefined ? x[i0 + 1] : a;
    y[i] = a + (b - a) * t;
  }
  return y;
}

/* semitones up or down, same length out as in */
export function pitchShift(x, sampleRate, semitones) {
  if (!semitones) return x.slice();
  const ratio = Math.pow(2, semitones / 12);
  return resample(timeStretch(x, ratio), ratio);
}

/* ---------------- time-domain work ---------------- */

/* A gate with a real envelope: opens fast, closes slowly, so it does not
   chop the tails off words. threshold in dBFS. */
export function gate(x, sampleRate, thresholdDb = -45, attackMs = 5, releaseMs = 140) {
  if (thresholdDb <= -80) return x.slice();
  const th = dbToGain(thresholdDb);
  const atk = Math.exp(-1 / (sampleRate * attackMs / 1000));
  const rel = Math.exp(-1 / (sampleRate * releaseMs / 1000));
  const y = new Float32Array(x.length);
  let env = 0, g = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    env = a > env ? a + atk * (env - a) : a + rel * (env - a);
    const want = env > th ? 1 : 0;
    g = want > g ? want + atk * (g - want) : want + rel * (g - want);
    y[i] = x[i] * g;
  }
  return y;
}

export function trimSilence(x, sampleRate, thresholdDb = -42, padMs = 80) {
  const th = dbToGain(thresholdDb);
  const win = Math.max(1, Math.floor(sampleRate * 0.01));
  let first = -1, last = -1;
  for (let i = 0; i + win <= x.length; i += win) {
    if (rms(x, i, i + win) > th) { if (first < 0) first = i; last = i + win; }
  }
  if (first < 0) return { data: x.slice(), from: 0, to: x.length };
  const pad = Math.floor(sampleRate * padMs / 1000);
  const from = Math.max(0, first - pad), to = Math.min(x.length, last + pad);
  return { data: x.slice(from, to), from, to };
}

export function normalize(x, targetDb = -1) {
  const p = peak(x);
  if (p < 1e-6) return x.slice();
  const g = dbToGain(targetDb) / p;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = Math.max(-1, Math.min(1, x[i] * g));
  return y;
}

/* Peaks for drawing: min and max per bucket, which is what makes a waveform
   look like a waveform rather than a smear. */
export function peaks(x, buckets) {
  const out = new Float32Array(buckets * 2);
  const per = x.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per), to = Math.min(x.length, Math.floor((b + 1) * per));
    let lo = 0, hi = 0;
    for (let i = from; i < to; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[b * 2] = lo; out[b * 2 + 1] = hi;
  }
  return out;
}

/* ---------------- WAV ---------------- */
export function encodeWav(channels, sampleRate, bits = 16) {
  const n = channels[0].length, ch = channels.length;
  const bytes = bits / 8;
  const dataLen = n * ch * bytes;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * bytes, true);
  v.setUint16(32, ch * bytes, true); v.setUint16(34, bits, true);
  str(36, "data"); v.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (bits === 16) { v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2; }
      else { const q = Math.round(s * 0x7FFFFF); v.setUint8(off, q & 255); v.setUint8(off + 1, (q >> 8) & 255); v.setUint8(off + 2, (q >> 16) & 255); off += 3; }
    }
  }
  return buf;
}
