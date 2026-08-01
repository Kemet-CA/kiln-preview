/* ============================================================
   Colour maths — pure functions, no DOM.

   Everything here is a conversion, a harmony or a measurement. Keeping it
   free of the UI means it can be tested on known values (a colour space
   conversion that is subtly wrong looks fine on screen and is wrong in print),
   and reused by the API later without changes.

   Reference white points follow CSS Color 4: lab()/lch() are D50, oklab()/
   oklch() are D65. Getting that wrong is the classic off-by-a-few-units bug.
   ============================================================ */

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = n => Math.round(n * 100) / 100;
const r1 = n => Math.round(n * 10) / 10;

/* ---------------- hex ↔ rgb ---------------- */
export function parseHex(str) {
  let s = String(str).trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) s = [...s].map(c => c + c).join("");
  if (/^[0-9a-f]{4}$/i.test(s)) s = [...s].map(c => c + c).join("");
  if (/^[0-9a-f]{6}$/i.test(s)) s += "ff";
  if (!/^[0-9a-f]{8}$/i.test(s)) return null;
  return {
    r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16), a: parseInt(s.slice(6, 8), 16) / 255,
  };
}
const hx = n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
export const toHex = ({ r, g, b }) => `#${hx(r)}${hx(g)}${hx(b)}`.toUpperCase();
export const toHex8 = ({ r, g, b, a = 1 }) => `#${hx(r)}${hx(g)}${hx(b)}${hx(a * 255)}`.toUpperCase();

/* ---------------- hsl / hsv ---------------- */
export function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const l = (mx + mn) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h: r1(h * 60), s: r1(s * 100), l: r1(l * 100) };
}
export function hslToRgb({ h, s, l }) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return { r: Math.round((seg[0] + m) * 255), g: Math.round((seg[1] + m) * 255), b: Math.round((seg[2] + m) * 255) };
}
export function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: r1(h * 60), s: r1(mx ? (d / mx) * 100 : 0), v: r1(mx * 100) };
}
export function hsvToRgb({ h, s, v }) {
  h = ((h % 360) + 360) % 360; s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return { r: Math.round((seg[0] + m) * 255), g: Math.round((seg[1] + m) * 255), b: Math.round((seg[2] + m) * 255) };
}

/* ---------------- cmyk (naive device conversion, as every web tool uses) ---------------- */
export function rgbToCmyk({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const k = 1 - Math.max(r, g, b);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: r1(((1 - r - k) / (1 - k)) * 100), m: r1(((1 - g - k) / (1 - k)) * 100),
    y: r1(((1 - b - k) / (1 - k)) * 100), k: r1(k * 100),
  };
}
export function cmykToRgb({ c, m, y, k }) {
  c /= 100; m /= 100; y /= 100; k /= 100;
  return {
    r: Math.round(255 * (1 - c) * (1 - k)),
    g: Math.round(255 * (1 - m) * (1 - k)),
    b: Math.round(255 * (1 - y) * (1 - k)),
  };
}

/* ---------------- linear light, XYZ, Lab / LCH (D50) ---------------- */
const lin = c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
const unlin = c => clamp(Math.round(255 * (c <= .0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - .055)), 0, 255);

/* sRGB → XYZ(D65) → Bradford → XYZ(D50), the chain CSS Color 4 specifies */
export function rgbToXyz50({ r, g, b }) {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = 0.4360747 * R + 0.3850649 * G + 0.1430804 * B;
  const y = 0.2225045 * R + 0.7168786 * G + 0.0606169 * B;
  const z = 0.0139322 * R + 0.0971045 * G + 0.7141733 * B;
  return { x, y, z };
}
export function xyz50ToRgb({ x, y, z }) {
  const R = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z;
  const G = -0.9787684 * x + 1.9161415 * y + 0.0334540 * z;
  const B = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z;
  return { r: unlin(R), g: unlin(G), b: unlin(B) };
}
const D50 = { x: 0.9642957, y: 1, z: 0.8251046 };
const f = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
export function rgbToLab(rgb) {
  const { x, y, z } = rgbToXyz50(rgb);
  const fx = f(x / D50.x), fy = f(y / D50.y), fz = f(z / D50.z);
  return { l: r2(116 * fy - 16), a: r2(500 * (fx - fy)), b: r2(200 * (fy - fz)) };
}
export function labToRgb({ l, a, b }) {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = t => t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) * 27 / 24389;
  return xyz50ToRgb({ x: inv(fx) * D50.x, y: inv(fy) * D50.y, z: inv(fz) * D50.z });
}
export function rgbToLch(rgb) {
  const { l, a, b } = rgbToLab(rgb);
  const c = Math.hypot(a, b);
  let h = Math.atan2(b, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { l: r2(l), c: r2(c), h: r2(c < .02 ? 0 : h) };
}

/* ---------------- OKLab / OKLCH (D65) ---------------- */
export function rgbToOklab({ r, g, b }) {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    l: r2(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s),
    a: r2(1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s),
    b: r2(0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s),
  };
}
export function rgbToOklch(rgb) {
  const { l, a, b } = rgbToOklab(rgb);
  const c = Math.hypot(a, b);
  let h = Math.atan2(b, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { l: r2(l), c: r2(c), h: r2(c < .002 ? 0 : h) };
}

/* ---------------- contrast + readability ---------------- */
export const luminance = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return r2((Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05));
}
export function wcag(ratio) {
  return {
    aaLarge: ratio >= 3, aa: ratio >= 4.5, aaaLarge: ratio >= 4.5, aaa: ratio >= 7,
    grade: ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA large" : "fail",
  };
}
/* black or white text, whichever is more readable on this colour */
export const readableOn = rgb =>
  contrast(rgb, { r: 0, g: 0, b: 0 }) >= contrast(rgb, { r: 255, g: 255, b: 255 }) ? "#000000" : "#FFFFFF";

/* ---------------- colour blindness (Brettel/Viénot style matrices) ---------------- */
const CVD = {
  protanopia:   [0.567, 0.433, 0, 0.558, 0.442, 0, 0, 0.242, 0.758],
  deuteranopia: [0.625, 0.375, 0, 0.7, 0.3, 0, 0, 0.3, 0.7],
  tritanopia:   [0.95, 0.05, 0, 0, 0.433, 0.567, 0, 0.475, 0.525],
  achromatopsia: [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114],
};
export function simulate(rgb, kind) {
  const m = CVD[kind];
  if (!m) return rgb;
  const { r, g, b } = rgb;
  return {
    r: clamp(Math.round(m[0] * r + m[1] * g + m[2] * b), 0, 255),
    g: clamp(Math.round(m[3] * r + m[4] * g + m[5] * b), 0, 255),
    b: clamp(Math.round(m[6] * r + m[7] * g + m[8] * b), 0, 255),
  };
}
export const CVD_KINDS = Object.keys(CVD);

/* ---------------- named colours (the CSS set, for the nearest match) ---------------- */
export const NAMED = {
  black: "#000000", white: "#FFFFFF", red: "#FF0000", lime: "#00FF00", blue: "#0000FF",
  yellow: "#FFFF00", cyan: "#00FFFF", magenta: "#FF00FF", silver: "#C0C0C0", gray: "#808080",
  maroon: "#800000", olive: "#808000", green: "#008000", purple: "#800080", teal: "#008080",
  navy: "#000080", orange: "#FFA500", pink: "#FFC0CB", brown: "#A52A2A", gold: "#FFD700",
  indigo: "#4B0082", violet: "#EE82EE", turquoise: "#40E0D0", salmon: "#FA8072", crimson: "#DC143C",
  coral: "#FF7F50", tomato: "#FF6347", khaki: "#F0E68C", plum: "#DDA0DD", orchid: "#DA70D6",
  beige: "#F5F5DC", ivory: "#FFFFF0", lavender: "#E6E6FA", tan: "#D2B48C", chocolate: "#D2691E",
  firebrick: "#B22222", forestgreen: "#228B22", seagreen: "#2E8B57", skyblue: "#87CEEB",
  steelblue: "#4682B4", slategray: "#708090", midnightblue: "#191970", peru: "#CD853F",
};
export function nearestNamed(rgb) {
  let best = null, bestD = Infinity;
  const lab = rgbToLab(rgb);
  for (const [name, hex] of Object.entries(NAMED)) {
    const l2 = rgbToLab(parseHex(hex));
    const d = Math.hypot(lab.l - l2.l, lab.a - l2.a, lab.b - l2.b);   // ΔE76, close enough to name a colour
    if (d < bestD) { bestD = d; best = { name, hex, distance: r2(d) }; }
  }
  return best;
}

/* ---------------- harmonies ---------------- */
export const HARMONIES = {
  complementary: [0, 180],
  "split complementary": [0, 150, 210],
  analogous: [-30, 0, 30],
  "analogous wide": [-60, -30, 0, 30, 60],
  triadic: [0, 120, 240],
  tetradic: [0, 90, 180, 270],
  "double split": [-30, 30, 150, 210],
  compound: [0, 30, 180, 210],
};
/* rotate the hue, keeping saturation and lightness — the classic wheel harmony */
export function harmony(rgb, kind) {
  const hsl = rgbToHsl(rgb);
  const offsets = HARMONIES[kind];
  if (!offsets) return monochromatic(rgb);
  return offsets.map(o => hslToRgb({ ...hsl, h: hsl.h + o }));
}
export function monochromatic(rgb, n = 5) {
  const { h, s } = rgbToHsl(rgb);
  return Array.from({ length: n }, (_, i) => hslToRgb({ h, s, l: 12 + (76 * i) / (n - 1) }));
}
export function shades(rgb, n = 10) {
  const { h, s } = rgbToHsl(rgb);
  return Array.from({ length: n }, (_, i) => hslToRgb({ h, s, l: 95 - (90 * i) / (n - 1) }));
}
export function tints(rgb, n = 10) {
  const { h, s, l } = rgbToHsl(rgb);
  return Array.from({ length: n }, (_, i) => hslToRgb({ h, s: s * (1 - i / n), l: l + (95 - l) * (i / (n - 1)) }));
}

/* ---------------- palette generation ----------------
   Random hues look like noise. These walk the wheel with structure — the
   golden angle spreads hues evenly however many you ask for, and saturation
   and lightness stay inside ranges that read as deliberate rather than
   fluorescent. */
const GOLDEN = 137.50776;
const rnd = (a, b) => a + Math.random() * (b - a);

export const SCHEMES = ["golden", "harmonious", "pastel", "vivid", "earthy", "muted", "neon", "monochrome"];
export function randomPalette(n = 5, scheme = "golden", locked = []) {
  const base = rnd(0, 360);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (locked[i]) { out.push(locked[i]); continue; }
    let h, s, l;
    switch (scheme) {
      case "harmonious": {
        const offs = [0, 30, 180, 210, 150, 330];
        h = base + offs[i % offs.length] + rnd(-8, 8);
        s = rnd(45, 80); l = rnd(38, 68);
        break;
      }
      case "pastel":     h = base + i * GOLDEN; s = rnd(35, 60); l = rnd(76, 88); break;
      case "vivid":      h = base + i * GOLDEN; s = rnd(78, 96); l = rnd(45, 58); break;
      case "earthy":     h = rnd(18, 52) + rnd(-6, 6) + i * 9; s = rnd(30, 62); l = rnd(28, 72); break;
      case "muted":      h = base + i * GOLDEN; s = rnd(14, 34); l = rnd(40, 74); break;
      case "neon":       h = base + i * GOLDEN; s = 100; l = rnd(50, 62); break;
      case "monochrome": h = base + rnd(-6, 6); s = rnd(20, 70); l = 16 + (70 * i) / Math.max(1, n - 1); break;
      default:           h = base + i * GOLDEN; s = rnd(52, 84); l = rnd(40, 66);
    }
    out.push(hslToRgb({ h, s, l }));
  }
  return out;
}

/* ---------------- every format, ready to copy ---------------- */
export function formats(rgb, alpha = 1) {
  const hsl = rgbToHsl(rgb), hsv = rgbToHsv(rgb), cmyk = rgbToCmyk(rgb);
  const lab = rgbToLab(rgb), lch = rgbToLch(rgb), oklch = rgbToOklch(rgb);
  const named = nearestNamed(rgb);
  const a = Math.round(alpha * 100) / 100;
  return [
    ["HEX", toHex(rgb)],
    ["HEX with alpha", toHex8({ ...rgb, a: alpha })],
    ["RGB", `rgb(${rgb.r} ${rgb.g} ${rgb.b})`],
    ["RGB legacy", `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`],
    ["RGBA", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`],
    ["HSL", `hsl(${hsl.h} ${hsl.s}% ${hsl.l}%)`],
    ["HSLA", `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${a})`],
    ["HSB / HSV", `${hsv.h}°, ${hsv.s}%, ${hsv.v}%`],
    ["CMYK", `${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%`],
    ["LAB", `lab(${lab.l}% ${lab.a} ${lab.b})`],
    ["LCH", `lch(${lch.l}% ${lch.c} ${lch.h})`],
    ["OKLCH", `oklch(${oklch.l} ${oklch.c} ${oklch.h})`],
    ["CSS variable", `--colour: ${toHex(rgb)};`],
    ["Nearest name", `${named.name} (${named.hex})`],
    ["Integer", String((rgb.r << 16) + (rgb.g << 8) + rgb.b)],
    ["Swift", `UIColor(red: ${r2(rgb.r / 255)}, green: ${r2(rgb.g / 255)}, blue: ${r2(rgb.b / 255)}, alpha: ${a})`],
    ["Android", `Color.parseColor("${toHex8({ ...rgb, a: alpha })}")`],
  ];
}
