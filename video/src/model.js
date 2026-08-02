/* ============================================================
   Project model — the edit decision list.

   Nothing here touches pixels or audio. A project is a description of what
   should appear when: media items are the source files, tracks hold clips,
   and a clip points into a media item with its own trim, transform, colour,
   audio and keyframes. Editing is non-destructive by construction — the
   source files are never modified, and export re-renders from them.
   ============================================================ */

export const uid = (() => { let n = 1; return p => `${p}${n++}`; })();
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* properties that can be animated over time */
export const KEYABLE = ["x", "y", "scale", "rot", "opacity", "volume"];

export const DEFAULT_CLIP = {
  // timing (seconds)
  start: 0, dur: 0, in: 0, speed: 1,
  // transform
  x: 0, y: 0, scale: 1, rot: 0, flipH: false, flipV: false, opacity: 1,
  crop: { l: 0, t: 0, r: 0, b: 0 }, cropRatio: null,   // null = free, else a number
  // colour
  brightness: 1, contrast: 1, saturate: 1, hue: 0, blur: 0, sepia: 0, grayscale: 0,
  // green screen and shape masks — see src/keyer.js
  chroma: false, keyColor: "#00d000", keySimilarity: .18, keySmooth: .08, keySpill: .4,
  mask: "none", maskSize: .6, maskFeather: .1, maskX: 0, maskY: 0, maskInvert: false,
  // audio
  volume: 1, fadeIn: 0, fadeOut: 0, muted: false,
  // transitions with the neighbour on the same track
  transIn: null, transOut: null,      // { type, dur }
  // text / sticker
  text: "", font: "Inter, system-ui, sans-serif", size: 64, color: "#ffffff",
  bg: "", align: "center", stroke: 0, strokeColor: "#000000",
  weight: 700, shadow: 0, lineHeight: 1.2, pad: .3,
  keys: {},                            // { prop: [{ t, v }] } — t is 0..1 across the clip
};

/* ---------------- aspect ratios ----------------
   The frame a video is cut for is a platform decision, not a taste one, so
   the ratios carry the platform names — nobody thinks "I need 1.91:1", they
   think "this is going on Facebook". Choosing one sets the project frame and
   centre-crops the clips to fill it, so what the preview shows is what the
   export will be. */
export const RATIOS = [
  { id: "orig",   label: "Original", sub: "the source's own size" },
  { id: "free",   label: "Free",     sub: "crop each edge freely" },
  { id: "9:16",   label: "9:16",     sub: "TikTok · Reels · Shorts", r: 9 / 16,  w: 1080, h: 1920 },
  { id: "1:1",    label: "1:1",      sub: "Instagram post",          r: 1,       w: 1080, h: 1080 },
  { id: "4:5",    label: "4:5",      sub: "Instagram portrait",      r: 4 / 5,   w: 1080, h: 1350 },
  { id: "16:9",   label: "16:9",     sub: "YouTube",                 r: 16 / 9,  w: 1920, h: 1080 },
  { id: "1.91:1", label: "1.91:1",   sub: "Facebook",                r: 1.91,    w: 1920, h: 1005 },
];
export const ratioById = id => RATIOS.find(x => x.id === id) || null;

/* The centre crop that makes a source of sw×sh fill a frame of the given
   ratio: take the excess off whichever axis has it, half from each side. */
export function cropForRatio(sw, sh, ratio) {
  const crop = { l: 0, t: 0, r: 0, b: 0 };
  if (!sw || !sh || !ratio) return crop;
  const have = sw / sh;
  if (have > ratio) {                         // too wide: trim the sides
    const keep = (sh * ratio) / sw;
    crop.l = crop.r = clamp((1 - keep) / 2, 0, .49);
  } else if (have < ratio) {                  // too tall: trim top and bottom
    const keep = (sw / ratio) / sh;
    crop.t = crop.b = clamp((1 - keep) / 2, 0, .49);
  }
  return crop;
}

/* Keeping a locked crop on ratio while one edge is dragged: whatever the user
   just changed is respected, and the other axis is recomputed around it. */
export function reflowCrop(crop, sw, sh, ratio, changed) {
  if (!ratio || !sw || !sh) return crop;
  const out = { ...crop };
  const horizontal = changed === "l" || changed === "r";
  if (horizontal) {
    const vw = sw * (1 - out.l - out.r);
    const vh = vw / ratio;
    if (vh <= sh) { const c = clamp((1 - vh / sh) / 2, 0, .49); out.t = out.b = c; }
    else {                                     // cannot get that tall: widen back
      out.t = out.b = 0;
      const c = clamp((1 - (sh * ratio) / sw) / 2, 0, .49);
      out.l = out.r = c;
    }
  } else {
    const vh = sh * (1 - out.t - out.b);
    const vw = vh * ratio;
    if (vw <= sw) { const c = clamp((1 - vw / sw) / 2, 0, .49); out.l = out.r = c; }
    else {
      out.l = out.r = 0;
      const c = clamp((1 - (sw / ratio) / sh) / 2, 0, .49);
      out.t = out.b = c;
    }
  }
  return out;
}

/* ---------------- titles ----------------
   A title is a look, not a font size. These are the looks, so adding one puts
   something finished on screen instead of 64px of white Helvetica that then
   has to be fixed by hand. */
export const TITLE_STYLES = [
  { id: "title",  name: "Title",       o: { size: 120, weight: 800, color: "#ffffff", stroke: 0, bg: "", align: "center", shadow: 24, y: 0 } },
  { id: "sub",    name: "Subtitle",    o: { size: 64,  weight: 500, color: "#ffffff", stroke: 0, bg: "", align: "center", shadow: 16, y: 260 } },
  { id: "caption",name: "Caption",     o: { size: 54,  weight: 700, color: "#ffffff", stroke: 0, bg: "#000000cc", align: "center", shadow: 0, y: 380 } },
  { id: "lower",  name: "Lower third", o: { size: 58,  weight: 700, color: "#ffffff", stroke: 0, bg: "#111111e6", align: "left", shadow: 0, x: -520, y: 330 } },
  { id: "bold",   name: "Bold outline",o: { size: 132, weight: 900, color: "#ffffff", stroke: 10, strokeColor: "#000000", bg: "", align: "center", shadow: 0, y: 0 } },
  { id: "quote",  name: "Quote",       o: { size: 72,  weight: 400, font: "Georgia, serif", color: "#ffffff", stroke: 0, bg: "", align: "center", shadow: 18, y: 0 } },
];

/* ---------------- stickers ----------------
   One emoji was never a sticker feature. Each one carries the words someone
   would actually search for — "fire", "clap", "party" — because searching a
   grid of pictures by its own character is no search at all. */
const G = (name, spec) => [name, spec.split("|").map(e => {
  const [ch, ...words] = e.trim().split(/\s+/);
  return { ch, k: words.join(" ") };
}).filter(e => e.ch)];
export const EMOJI = Object.fromEntries([
  G("Reactions", `
    😀 grin happy smile
    | 😂 laugh lol cry funny
    | 🥹 touched proud tears
    | 😍 love heart eyes
    | 🤩 star struck wow
    | 😎 cool sunglasses
    | 🥳 party celebrate
    | 😮 wow surprised shock
    | 🤯 mind blown exploding
    | 😭 cry sad sob
    | 😡 angry mad rage
    | 🤔 think hmm wonder
    | 🙃 upside silly
    | 😴 sleep tired bored
    | 🤗 hug thanks
    | 🙄 eye roll whatever
    | 😬 grimace awkward
    | 🥺 pleading please
    | 😇 angel innocent
    | 😜 wink tongue joke`),
  G("Hands", `
    👍 thumbs up like yes
    | 👎 thumbs down no
    | 👏 clap applause bravo
    | 🙌 raise hands praise
    | 🙏 pray thanks please
    | 💪 muscle strong flex
    | 🤝 handshake deal
    | ✌️ peace victory
    | 🤞 fingers crossed luck
    | 👌 ok perfect
    | 🫶 heart hands love
    | 👋 wave hello bye
    | 🤙 call shaka
    | ☝️ point up one
    | 🖐️ hand stop five
    | 🤟 love you rock`),
  G("Hearts", `
    ❤️ red heart love
    | 🧡 orange heart
    | 💛 yellow heart
    | 💚 green heart
    | 💙 blue heart
    | 💜 purple heart
    | 🖤 black heart
    | 🤍 white heart
    | 💖 sparkle heart
    | 💘 arrow heart cupid
    | 💔 broken heart
    | ❣️ heart exclamation
    | 💕 two hearts
    | 💞 revolving hearts
    | 💓 beating heart
    | 💗 growing heart`),
  G("Symbols", `
    🔥 fire lit hot
    | ✨ sparkles shine magic
    | ⭐ star favourite
    | 🌟 glowing star
    | 💥 boom explosion
    | 💫 dizzy swirl
    | ⚡ lightning fast power
    | 💯 hundred perfect
    | ✅ check done yes
    | ❌ cross no wrong
    | ❗ exclamation warning
    | ❓ question ask
    | ⚠️ warning caution
    | 🚫 forbidden stop
    | ♻️ recycle
    | 🔔 bell notify alert`),
  G("Objects", `
    🎉 party tada celebrate 🎊 confetti party
    | 🎁 gift present
    | 🏆 trophy win prize
    | 🥇 gold medal first
    | 💡 idea bulb tip
    | 📌 pin note
    | 📎 clip attach
    | 🔑 key unlock
    | 💰 money bag cash
    | 💎 diamond gem
    | 🕐 clock time
    | 📱 phone mobile
    | 💻 laptop computer
    | 🎬 clapper film movie
    | 📷 camera photo`),
  G("Characters", `
    🤖 robot bot ai
    | 👽 alien ufo
    | 👻 ghost boo
    | 💀 skull dead
    | 🎃 pumpkin halloween
    | 🤡 clown
    | 😺 cat grin
    | 🙈 see no monkey
    | 🙉 hear no monkey
    | 🙊 speak no monkey
    | 🐶 dog puppy
    | 🐱 cat kitten
    | 🦄 unicorn magic
    | 🐝 bee honey
    | 🦋 butterfly
    | 🐢 turtle slow`),
  G("Food", `
    🍕 pizza slice
    | 🍔 burger
    | 🍟 fries chips
    | 🌮 taco
    | 🍿 popcorn movie
    | 🍩 donut
    | 🍪 cookie biscuit
    | 🎂 cake birthday
    | 🍎 apple fruit
    | 🍌 banana
    | 🍓 strawberry
    | 🍉 watermelon
    | ☕ coffee tea
    | 🍺 beer drink
    | 🥤 soda cup
    | 🍫 chocolate`),
  G("Travel", `
    🚀 rocket launch fast
    | ✈️ plane flight travel
    | 🚗 car drive
    | 🚲 bike cycle
    | 🏝️ island beach
    | 🏔️ mountain
    | 🌊 wave sea ocean
    | ☀️ sun sunny
    | 🌙 moon night
    | ⛅ cloud weather
    | 🌈 rainbow
    | ❄️ snow cold winter
    | 🌍 earth world globe
    | 🗺️ map
    | 🎯 target goal
    | 🏁 finish flag race`),
]);
export const ALL_EMOJI = Object.values(EMOJI).flat();
export const searchEmoji = q => {
  const t = String(q || "").trim().toLowerCase();
  if (!t) return [];
  return ALL_EMOJI.filter(e => e.ch === t || e.k.includes(t));
};

export const TRANSITIONS = ["none", "crossfade", "dip to black", "dip to white", "wipe left", "wipe right", "slide up", "zoom"];

export function newProject(name = "Untitled") {
  return {
    name, w: 1920, h: 1080, fps: 30, bg: "#000000",
    media: [],
    tracks: [
      { id: uid("t"), kind: "video", name: "Video 2", hidden: false, locked: false, muted: false, clips: [] },
      { id: uid("t"), kind: "video", name: "Video 1", hidden: false, locked: false, muted: false, clips: [] },
      { id: uid("t"), kind: "audio", name: "Audio 1", hidden: false, locked: false, muted: false, clips: [] },
    ],
  };
}

/* ---------------- queries ---------------- */
export const allClips = p => p.tracks.flatMap(t => t.clips.map(c => ({ clip: c, track: t })));
export const clipEnd = c => c.start + c.dur;
export const trackOf = (p, id) => p.tracks.find(t => t.clips.some(c => c.id === id));
export const findClip = (p, id) => p.tracks.flatMap(t => t.clips).find(c => c.id === id);
export const duration = p =>
  p.tracks.reduce((m, t) => t.clips.reduce((n, c) => Math.max(n, clipEnd(c)), m), 0);
export const mediaOf = (p, c) => p.media.find(m => m.id === c.mediaId);
/* The clip a track is showing at time t. Clips on one track should not overlap,
   but a drag can leave them stacked — in that case the one placed latest wins,
   which is what "I just dropped this on top" looks like it should do. */
export function clipAt(track, t) {
  let best = null;
  for (const c of track.clips) if (t >= c.start && t < clipEnd(c) && (!best || c.start >= best.start)) best = c;
  return best;
}
/* a track of this kind with nothing occupying [at, at+dur) */
export function freeTrack(project, kind, at, dur) {
  return project.tracks.find(t => t.kind === kind && !t.locked &&
    !t.clips.some(c => at < clipEnd(c) && c.start < at + dur)) || null;
}

/* ---------------- keyframes ----------------
   Values are stored against a 0..1 position inside the clip, so trimming a
   clip keeps its animation aligned with its own content. */
export function valueAt(clip, prop, time) {
  const keys = clip.keys?.[prop];
  const base = clip[prop] ?? DEFAULT_CLIP[prop];
  if (!keys?.length) return base;
  const u = clamp(clip.dur ? (time - clip.start) / clip.dur : 0, 0, 1);
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  if (u <= sorted[0].t) return sorted[0].v;
  if (u >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].v;
  for (let i = 1; i < sorted.length; i++) {
    if (u <= sorted[i].t) {
      const a = sorted[i - 1], b = sorted[i];
      const k = (u - a.t) / Math.max(1e-6, b.t - a.t);
      const eased = k * k * (3 - 2 * k);            // smoothstep, so motion starts and stops softly
      return a.v + (b.v - a.v) * eased;
    }
  }
  return base;
}
export function setKey(clip, prop, time, value) {
  const u = clamp(clip.dur ? (time - clip.start) / clip.dur : 0, 0, 1);
  const list = (clip.keys[prop] ||= []);
  const at = list.find(k => Math.abs(k.t - u) < 1e-3);
  if (at) at.v = value; else list.push({ t: u, v: value });
  list.sort((a, b) => a.t - b.t);
}
export function clearKeys(clip, prop) { delete clip.keys[prop]; }

/* ---------------- editing ---------------- */
export function addClip(track, clip) {
  track.clips.push(clip);
  track.clips.sort((a, b) => a.start - b.start);
  return clip;
}
export function makeClip(media, at = 0, opts = {}) {
  return {
    ...structuredClone(DEFAULT_CLIP),
    id: uid("c"),
    mediaId: media?.id ?? null,
    kind: opts.kind || media?.kind || "video",
    name: opts.name || media?.name || "Clip",
    start: at,
    dur: opts.dur ?? media?.dur ?? 5,
    ...opts,
  };
}
/* split at an absolute timeline position; returns the new right-hand clip */
export function splitClip(track, clip, t) {
  if (t <= clip.start + .05 || t >= clipEnd(clip) - .05) return null;
  const right = structuredClone(clip);
  right.id = uid("c");
  const cut = t - clip.start;
  right.start = t;
  right.dur = clip.dur - cut;
  right.in = clip.in + cut * clip.speed;
  right.transIn = null;
  clip.dur = cut;
  clip.transOut = null;
  addClip(track, right);
  return right;
}
/* trim from either edge, keeping the source in sync */
export function trimClip(clip, edge, deltaSec, media) {
  if (edge === "left") {
    const maxLeft = media ? (media.dur - clip.in) : Infinity;
    const d = clamp(deltaSec, -clip.in / clip.speed, clip.dur - .1);
    clip.start += d;
    clip.dur -= d;
    clip.in += d * clip.speed;
    void maxLeft;
  } else {
    const roomInSource = media ? (media.dur - clip.in) / clip.speed - clip.dur : Infinity;
    clip.dur = Math.max(.1, clip.dur + Math.min(deltaSec, roomInSource));
  }
}
export function removeClip(project, id) {
  for (const t of project.tracks) {
    const i = t.clips.findIndex(c => c.id === id);
    if (i >= 0) { t.clips.splice(i, 1); return true; }
  }
  return false;
}
/* close the gap left behind, like a ripple delete */
export function rippleDelete(project, id) {
  const track = trackOf(project, id);
  const clip = findClip(project, id);
  if (!track || !clip) return false;
  const gap = clip.dur;
  removeClip(project, id);
  track.clips.filter(c => c.start > clip.start).forEach(c => { c.start = Math.max(0, c.start - gap); });
  return true;
}
/* Magnetic: pull everything on a track up against its neighbour so there are
   no gaps left. Order is kept — this only removes the empty space between. */
export function closeGaps(track, from = 0) {
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  let at = from, moved = 0;
  for (const c of clips) {
    if (c.start < from) { at = Math.max(at, clipEnd(c)); continue; }
    if (Math.abs(c.start - at) > .001) { c.start = at; moved++; }
    at = clipEnd(c);
  }
  return moved;
}

export function moveClip(project, id, toTrackId, newStart) {
  const from = trackOf(project, id);
  const clip = findClip(project, id);
  const to = project.tracks.find(t => t.id === toTrackId) || from;
  if (!clip || !from || to.locked) return;
  if (to.kind !== from.kind && !(clip.kind === "audio" && to.kind === "audio")) {
    if (to.kind === "audio" && clip.kind !== "audio") return;      // video cannot live on an audio track
    if (to.kind === "video" && clip.kind === "audio") return;
  }
  from.clips.splice(from.clips.indexOf(clip), 1);
  clip.start = Math.max(0, newStart);
  addClip(to, clip);
}

/* ---------------- history ----------------
   Snapshots of the model only — media elements and decoded frames are never
   copied, so undo costs a JSON clone of a small object. */
export function makeHistory(limit = 80) {
  return { steps: [], i: -1, limit };
}
export function commit(hist, project, label) {
  hist.steps = hist.steps.slice(0, hist.i + 1);
  hist.steps.push({ label, state: serialize(project) });
  if (hist.steps.length > hist.limit) hist.steps.shift();
  hist.i = hist.steps.length - 1;
}
export const canUndo = h => h.i > 0;
export const canRedo = h => h.i < h.steps.length - 1;

/* ---------------- persistence ----------------
   The project file holds the edit, not the footage: media is referenced by id
   and rehydrated from the browser's own storage when the project reopens. */
export function serialize(project) {
  return JSON.stringify({
    kiln: "video/1", name: project.name, w: project.w, h: project.h, fps: project.fps, bg: project.bg,
    media: project.media.map(m => ({ id: m.id, name: m.name, kind: m.kind, dur: m.dur, w: m.w, h: m.h })),
    tracks: project.tracks.map(t => ({
      id: t.id, kind: t.kind, name: t.name, hidden: t.hidden, locked: t.locked, muted: t.muted,
      clips: t.clips.map(c => ({ ...c, el: undefined })),
    })),
  });
}
export function deserialize(json) {
  const d = typeof json === "string" ? JSON.parse(json) : json;
  if (d.kiln !== "video/1") throw new Error("Not a Kiln video project");
  return {
    name: d.name, w: d.w, h: d.h, fps: d.fps, bg: d.bg || "#000000",
    media: d.media, tracks: d.tracks,
  };
}
