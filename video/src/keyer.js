/* ============================================================
   Kiln Video — the pixel stage.

   The compositor is a 2D canvas: it can place, scale, rotate and filter a
   picture, but it never sees the pixels. Chroma key and a feathered mask both
   need them, so this is the one place that looks.

   Two passes, either of which can be skipped:

     key    a WebGL shader compares each pixel to the key colour in chroma
            space (not RGB — brightness must not decide whether a pixel is
            green) and turns the matching ones transparent, then takes the
            green cast off what is left.
     mask   a shape drawn with a soft edge and composited `destination-in`,
            which the 2D context does perfectly well on its own.

   Both write into scratch canvases that are reused between frames, because a
   30 fps timeline cannot allocate a 1920×1080 canvas thirty times a second.
   The result is something `drawImage` takes, so the compositor does not have
   to know any of this happened.
   ============================================================ */

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2(p.x * .5 + .5, .5 - p.y * .5);   // flip: canvas y runs down
  gl_Position = vec4(p, 0., 1.);
}`;

/* The maths is the standard one broadcast has used for decades: convert to
   Y'CbCr, measure the distance from the key's chroma, and fade out over a
   band. Working in chroma alone is what lets a shadow on the screen key out
   with the screen, and a green shirt lit differently stay. */
const FRAG = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;
uniform sampler2D tex;
uniform vec3 key;          // key colour, 0..1
uniform float similarity;  // how close counts as the key
uniform float smoothness;  // width of the fade to transparent
uniform float spill;       // how much of the key's colour to pull back out

vec2 chroma(vec3 c) {
  float y  = dot(c, vec3(.2126, .7152, .0722));
  return vec2(c.b - y, c.r - y) * .5;
}

void main() {
  vec4 src = texture(tex, uv);
  vec2 kc = chroma(key);
  float d = distance(chroma(src.rgb), kc);
  float a = smoothstep(similarity, similarity + max(smoothness, .0005), d);

  vec3 rgb = src.rgb;
  if (spill > 0.) {
    // desaturate towards luma in proportion to how key-coloured it still is
    float y = dot(rgb, vec3(.2126, .7152, .0722));
    float amount = (1. - a) * spill;
    rgb = mix(rgb, vec3(y), clamp(amount, 0., 1.));
  }
  outColor = vec4(rgb, src.a * a);
}`;

let gl = null, prog = null, glCanvas = null, tex = null, uni = null, failed = false;

function initGL() {
  if (gl || failed) return gl;
  try {
    glCanvas = document.createElement("canvas");
    gl = glCanvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error("no webgl2");
    const build = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, build(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, build(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
                          [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    uni = {
      key: gl.getUniformLocation(prog, "key"),
      similarity: gl.getUniformLocation(prog, "similarity"),
      smoothness: gl.getUniformLocation(prog, "smoothness"),
      spill: gl.getUniformLocation(prog, "spill"),
    };
  } catch (e) {
    // no WebGL here: the clip still plays, it just is not keyed
    console.warn("Kiln video: chroma key unavailable —", e.message);
    failed = true; gl = null;
  }
  return gl;
}

export const hasKeyer = () => !!initGL();

const hex = h => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h || "#00ff00"));
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 1, 0];
};

/* the key pass: source in, canvas with holes in it out */
const keyOut = document.createElement("canvas");
const keyCtx = keyOut.getContext("2d", { willReadFrequently: false });
function keyed(src, w, h, opts) {
  if (!initGL()) return null;
  if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  } catch { return null; }               // a video frame that is not ready yet
  const [r, g, b] = hex(opts.keyColor);
  gl.uniform3f(uni.key, r, g, b);
  gl.uniform1f(uni.similarity, Math.max(.001, opts.keySimilarity ?? .18));
  gl.uniform1f(uni.smoothness, Math.max(0, opts.keySmooth ?? .08));
  gl.uniform1f(uni.spill, Math.max(0, opts.keySpill ?? .4));
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // hand back a 2D canvas: the compositor and the mask pass both want one
  if (keyOut.width !== w || keyOut.height !== h) { keyOut.width = w; keyOut.height = h; }
  keyCtx.clearRect(0, 0, w, h);
  keyCtx.drawImage(glCanvas, 0, 0);
  return keyOut;
}

/* the mask pass: a shape with a soft edge, kept only where it covers */
const maskOut = document.createElement("canvas");
const maskCtx = maskOut.getContext("2d");
export const MASKS = ["none", "letterbox", "rectangle", "ellipse", "circle", "top", "bottom", "left", "right"];

/* ------------------------------------------------------------
   The mask pass, rewritten as: build an alpha layer, then apply it once.

   The old version painted straight onto the output with `destination-in`
   between fills, so every shape had to leave the context exactly as the next
   one expected — which is why it worked some of the time. Building the mask
   separately means each shape is just a fill, feathering is one blur, invert
   is one composite, and the picture is touched once at the end.
   ------------------------------------------------------------ */
const maskLayer = document.createElement("canvas");

function drawShape(m, w, h, opts) {
  const size = Math.min(1, Math.max(.02, opts.maskSize ?? .6));
  const cx = w / 2 + (opts.maskX ?? 0) * w, cy = h / 2 + (opts.maskY ?? 0) * h;
  m.fillStyle = "#fff";
  switch (opts.mask) {
    case "rectangle": {
      const rw = w * size, rh = h * size;
      m.fillRect(cx - rw / 2, cy - rh / 2, rw, rh);
      break;
    }
    case "circle": {
      const r = Math.min(w, h) * size / 2;
      m.beginPath(); m.arc(cx, cy, r, 0, Math.PI * 2); m.fill();
      break;
    }
    case "ellipse": {
      m.beginPath();
      m.ellipse(cx, cy, w * size / 2, h * size / 2, 0, 0, Math.PI * 2);
      m.fill();
      break;
    }
    case "top":    m.fillRect(0, 0, w, cy); break;
    case "bottom": m.fillRect(0, cy, w, h - cy); break;
    case "left":   m.fillRect(0, 0, cx, h); break;
    case "right":  m.fillRect(cx, 0, w - cx, h); break;
    default:       m.fillRect(0, 0, w, h);
  }
}

function masked(src, w, h, opts) {
  if (maskOut.width !== w || maskOut.height !== h) { maskOut.width = w; maskOut.height = h; }
  maskCtx.setTransform(1, 0, 0, 1, 0, 0);
  maskCtx.globalCompositeOperation = "source-over";
  maskCtx.globalAlpha = 1;
  maskCtx.filter = "none";
  maskCtx.clearRect(0, 0, w, h);
  maskCtx.drawImage(src, 0, 0, w, h);

  const strength = Math.max(0, Math.min(1, opts.maskOpacity ?? 1));
  if (strength <= .001) return maskOut;            // the mask is turned all the way down

  /* Letterbox is not a hole in the picture, it is bars over it: the frame
     stays full and two black bands sit on top. Cropping instead would leave
     the shot floating on the project background, which is not what a
     cinematic bar looks like. */
  if (opts.mask === "letterbox") {
    const bar = Math.max(0, Math.min(.45, opts.barSize ?? .12)) * h;
    if (bar < .5) return maskOut;
    const soft = Math.max(0, Math.min(1, opts.maskFeather ?? 0)) * bar;
    maskCtx.globalAlpha = strength;
    if (soft > .5) maskCtx.filter = `blur(${soft / 2}px)`;
    maskCtx.fillStyle = "#000";
    maskCtx.fillRect(0, -soft, w, bar + soft);
    maskCtx.fillRect(0, h - bar, w, bar + soft);
    maskCtx.filter = "none";
    maskCtx.globalAlpha = 1;
    return maskOut;
  }

  // ---- shape masks: build the alpha layer, then apply it once ----
  if (maskLayer.width !== w || maskLayer.height !== h) { maskLayer.width = w; maskLayer.height = h; }
  const m = maskLayer.getContext("2d");
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalCompositeOperation = "source-over";
  m.globalAlpha = 1;
  m.filter = "none";
  m.clearRect(0, 0, w, h);

  // what survives outside the shape: nothing at full strength, more as it drops
  if (strength < 1) {
    m.fillStyle = `rgba(255,255,255,${1 - strength})`;
    m.fillRect(0, 0, w, h);
  }

  const feather = Math.max(0, Math.min(1, opts.maskFeather ?? 0));
  const soft = feather * Math.min(w, h) * .25;
  if (soft > .5) m.filter = `blur(${soft}px)`;

  if (opts.maskInvert) {
    // keep the outside: a full sheet with the shape cut out of it
    m.fillStyle = "#fff";
    m.filter = "none";
    m.fillRect(0, 0, w, h);
    m.globalCompositeOperation = "destination-out";
    if (soft > .5) m.filter = `blur(${soft}px)`;
    drawShape(m, w, h, opts);
    m.globalCompositeOperation = "source-over";
    if (strength < 1) {
      // put the floor back under the hole
      m.globalCompositeOperation = "destination-over";
      m.filter = "none";
      m.fillStyle = `rgba(255,255,255,${1 - strength})`;
      m.fillRect(0, 0, w, h);
      m.globalCompositeOperation = "source-over";
    }
  } else {
    drawShape(m, w, h, opts);
  }
  m.filter = "none";

  maskCtx.globalCompositeOperation = "destination-in";
  maskCtx.drawImage(maskLayer, 0, 0);
  maskCtx.globalCompositeOperation = "source-over";
  return maskOut;
}

export const needsStage = c =>
  !!c && ((c.chroma && c.fxKey && c.kind !== "text" && c.kind !== "sticker") ||
          (c.fxMask && c.mask && c.mask !== "none"));

/* Run whichever passes the clip asks for. Returns something drawImage takes,
   or null if nothing could be done — the caller then draws the source as it
   is, which is the right answer for a browser with no WebGL. */
export function stage(src, clip) {
  const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  if (!w || !h) return null;
  let out = src;
  if (clip.chroma && clip.fxKey) {
    const k = keyed(out, w, h, clip);
    if (k) out = k;
  }
  if (clip.fxMask && clip.mask && clip.mask !== "none") out = masked(out, w, h, clip);
  return out === src ? null : out;
}
