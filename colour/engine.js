/* ============================================================
   Kiln Colour — application shell.

   The maths lives in src/color.js and knows nothing about the DOM. This file
   holds the current colour, the palette and the saved sets, and paints them.

   Two rules the UI follows throughout: every colour is one click from your
   clipboard, and every value is shown rather than hidden behind a dropdown —
   the format you need is the one you can see.
   ============================================================ */
import * as C from "./src/color.js";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const App = {
  hsv: { h: 21, s: 81, v: 89 },      // the picker's own state; rgb derives from it
  alpha: 1,
  prev: null,                        // the colour before the current one
  palette: [],
  locks: [],
  scheme: "golden",
  count: 5,
  cvd: "",
  swatches: load("kiln-colour-swatches", []),
  palettes: load("kiln-colour-palettes", []),
};
const rgb = () => C.hsvToRgb(App.hsv);
/* what the eye would see with the chosen vision simulation applied */
const shown = c => App.cvd ? C.simulate(c, App.cvd) : c;
const css = c => C.toHex(shown(c));

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = "toast";
  const tint = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" }[kind] || "var(--ok)";
  t.innerHTML = `<span class="dot" style="background:${tint}"></span>${esc(msg)}`;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; }, 2000);
  setTimeout(() => t.remove(), 2350);
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  toast(`${label || text} copied`);
}

/* ---------------- the wheel ----------------
   Hue is the angle, saturation is the distance out, and brightness is the
   slider under it — so the disc dims as the slider comes down, which is what
   a wheel is supposed to do. Painted per pixel into a canvas, and only when
   the brightness or the size changes; moving the cursor around the disc does
   not need a repaint. */
let wheelV = -1, wheelPx = 0;
function drawWheel() {
  const c = $("wheel");
  const box = c.getBoundingClientRect();
  const px = Math.max(80, Math.round(box.width * (window.devicePixelRatio || 1)));
  if (px === wheelPx && Math.abs(App.hsv.v - wheelV) < 0.5) return;
  wheelPx = px; wheelV = App.hsv.v;
  c.width = c.height = px;
  const x = c.getContext("2d");
  const img = x.createImageData(px, px);
  const d = img.data, r0 = px / 2, v = App.hsv.v;
  for (let y = 0; y < px; y++) {
    const dy = y - r0 + 0.5;
    for (let xi = 0; xi < px; xi++) {
      const dx = xi - r0 + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy) / r0;
      const i = (y * px + xi) * 4;
      if (dist > 1) { d[i + 3] = 0; continue; }
      const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360 + 90) % 360;
      const rgbv = C.hsvToRgb({ h, s: Math.min(100, dist * 100), v });
      d[i] = rgbv.r; d[i + 1] = rgbv.g; d[i + 2] = rgbv.b;
      d[i + 3] = dist > 0.985 ? Math.round((1 - dist) / 0.015 * 255) : 255;   // soft edge
    }
  }
  x.putImageData(img, 0, 0);
}
function placeWheelDot() {
  const box = $("wheel").getBoundingClientRect();
  const r = box.width / 2;
  const a = (App.hsv.h - 90) * Math.PI / 180;
  const dist = Math.min(1, App.hsv.s / 100) * r;
  $("svDot").style.left = (r + Math.cos(a) * dist) + "px";
  $("svDot").style.top = (r + Math.sin(a) * dist) + "px";
}
/* the wheel is square, and as large as the pane can give it */
function sizeWheel() {
  const pane = document.querySelector(".pick");
  const wrap = document.querySelector(".wheelwrap");
  const room = pane.clientHeight - 250;                 // circles, hex row, two sliders
  const side = Math.max(150, Math.min(pane.clientWidth - 28, room));
  wrap.style.width = wrap.style.height = side + "px";
  wheelPx = 0;                                          // force a repaint at the new size
  drawWheel();
  placeWheelDot();
}

new ResizeObserver(() => sizeWheel()).observe(document.querySelector(".pick"));

/* ---------------- the picker ---------------- */
function paintPicker() {
  const c = rgb(), hex = C.toHex(c);
  drawWheel();
  placeWheelDot();
  $("valKnob").style.left = App.hsv.v + "%";
  $("valBar").style.setProperty("--cur", C.toHex(C.hsvToRgb({ h: App.hsv.h, s: App.hsv.s, v: 100 })));
  $("alphaKnob").style.left = (App.alpha * 100) + "%";
  $("alphaBar").style.setProperty("--cur", hex);
  if (document.activeElement !== $("hexIn")) $("hexIn").value = hex;
  $("sbHex").textContent = hex;
  $("sbCon").textContent = C.contrast(c, { r: 0, g: 0, b: 0 }).toFixed(2) + ":1";
}
function setColor(c, { silent, keepPrev } = {}) {
  // remember what it was, so the small circle can put it back
  if (!keepPrev) {
    const now = C.toHex(rgb());
    if (now !== C.toHex(c)) App.prev = now;
  }
  App.hsv = C.rgbToHsv(c);
  paintAll();
  if (!silent) $("sbStatus").textContent = "Ready";
}
function dragOn(el, onMove) {
  const run = e => {
    const r = el.getBoundingClientRect();
    onMove(C.clamp((e.clientX - r.left) / r.width, 0, 1), C.clamp((e.clientY - r.top) / r.height, 0, 1));
    paintAll();
  };
  el.addEventListener("pointerdown", e => {
    el.setPointerCapture(e.pointerId);
    run(e);
    const move = ev => run(ev);
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
}

/* ---------------- every value, one click each ---------------- */
function paintFormats() {
  const c = rgb();
  $("formats").innerHTML = C.formats(c, App.alpha).map(([k, v]) =>
    `<button class="fmt" data-copy="${esc(v)}" data-label="${esc(k)}">
       <span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="c">copy</span>
     </button>`).join("");
}

/* ---------------- harmonies, ramps ---------------- */
function swatchRow(list) {
  return `<div class="hrow">${list.map(c => {
    const hex = C.toHex(c);
    return `<i style="background:${css(c)};--lbl:${C.readableOn(shown(c))}" data-copy="${hex}" data-hex="${hex}" title="${hex}"></i>`;
  }).join("")}</div>`;
}
function paintHarmonies() {
  const c = rgb();
  const cards = Object.keys(C.HARMONIES).map(kind =>
    `<div class="hcard"><h3 data-use="${kind}">${esc(kind)}<span class="use">use ↗</span></h3>
       ${swatchRow(C.harmony(c, kind))}</div>`).join("");
  $("harmonies").innerHTML = cards;
  $("shades").innerHTML = C.shades(c, 12).map(x =>
    `<i style="background:${css(x)}" data-copy="${C.toHex(x)}" title="${C.toHex(x)}"></i>`).join("");
  $("tints").innerHTML = C.tints(c, 12).map(x =>
    `<i style="background:${css(x)}" data-copy="${C.toHex(x)}" title="${C.toHex(x)}"></i>`).join("");
  $("mono").innerHTML = C.monochromatic(c, 8).map(x =>
    `<i style="background:${css(x)}" data-copy="${C.toHex(x)}" title="${C.toHex(x)}"></i>`).join("");
}

/* ---------------- the palette strip ---------------- */
function randomise() {
  const locked = App.palette.map((c, i) => App.locks[i] ? c : null);
  App.palette = C.randomPalette(App.count, App.scheme, locked);
  App.locks = App.locks.slice(0, App.count);
  paintPalette();
  $("sbStatus").textContent = `${App.scheme} palette`;
}
function paintPalette() {
  $("palette").innerHTML = App.palette.map((c, i) => {
    const hex = C.toHex(c), fg = C.readableOn(shown(c));
    const name = C.nearestNamed(c).name;
    return `<div class="pcol${App.locks[i] ? " locked" : ""}" style="background:${css(c)};color:${fg}"
        data-copy="${hex}" data-idx="${i}">
      <div class="tools">
        <button class="ptool lock" data-lock="${i}" title="${App.locks[i] ? "Unlock" : "Lock"}">${App.locks[i] ? "🔒" : "🔓"}</button>
        <button class="ptool" data-use-idx="${i}" title="Edit this colour">✎</button>
      </div>
      <span class="hexlab">${hex}</span>
      <span class="namelab">${esc(name)}</span>
    </div>`;
  }).join("");
}

/* ---------------- saved swatches and palettes ---------------- */
function paintSwatches() {
  $("pSwatches").innerHTML = App.swatches.length
    ? `<div class="swgrid">${App.swatches.map((hex, i) =>
        `<div class="sw" style="background:${hex}" data-sw="${i}" title="${hex} — click to use, ✕ to remove">
           <span class="x" data-rmsw="${i}">✕</span></div>`).join("")}</div>
       <button class="rowbtn" data-act="copySwatches">Copy all as a list</button>
       <button class="rowbtn" data-act="clearSwatches">Clear swatches</button>`
    : `<div class="empty">No swatches yet.<br>Press ＋ Swatch to keep the colour you are on.</div>`;
  $("sbSw").textContent = App.swatches.length;
}
function paintPalettes() {
  $("pPalettes").innerHTML = App.palettes.length
    ? `<div class="plist">${App.palettes.map((p, i) => `
        <div class="pitem">
          <div class="strip" data-pal="${i}" title="Load this palette">
            ${p.colors.map(h => `<i style="background:${h}"></i>`).join("")}
          </div>
          <div class="meta"><span>${esc(p.name)}</span>
            <span class="sp">
              <button data-palcopy="${i}">copy</button>
              <button data-palcss="${i}">css</button>
              <button data-palrm="${i}">remove</button>
            </span></div>
        </div>`).join("")}</div>`
    : `<div class="empty">No palettes yet.<br>Press ★ Save palette to keep the strip above.</div>`;
  $("sbPal").textContent = App.palettes.length;
}
function paintContrast() {
  const c = rgb();
  const onWhite = C.contrast(c, { r: 255, g: 255, b: 255 });
  const onBlack = C.contrast(c, { r: 0, g: 0, b: 0 });
  const grade = r => {
    const w = C.wcag(r);
    return `<span class="grade ${w.aa ? "pass" : "fail"}">${w.grade}</span>`;
  };
  const pairs = App.palette.map((p, i) => {
    const r = C.contrast(c, p);
    return `<div class="kv"><span>vs ${C.toHex(p)}</span><b>${r.toFixed(2)}:1 ${grade(r)}</b></div>`;
  }).join("");
  $("pContrast").innerHTML = `
    <div class="kv"><span>On white</span><b>${onWhite.toFixed(2)}:1 ${grade(onWhite)}</b></div>
    <div class="kv"><span>On black</span><b>${onBlack.toFixed(2)}:1 ${grade(onBlack)}</b></div>
    <div class="kv"><span>Readable text</span><b>${C.readableOn(c)}</b></div>
    <div class="note">WCAG asks for 4.5:1 for body text and 3:1 for large text. AAA is 7:1.</div>
    <div class="note" style="padding-top:0"><b style="color:var(--t3)">Against the palette</b></div>
    ${pairs || `<div class="note">Generate a palette to compare against it.</div>`}
    <div class="note">Simulating colour blindness changes what is drawn, not the values —
    the hex you copy is always the real colour.</div>`;
}

function paintAll() {
  paintPicker();
  paintFormats();
  paintHarmonies();
  paintPalette();
  paintContrast();
}

/* ---------------- actions ---------------- */
const ACT = {
  randomise,
  randomColor: () => setColor(C.randomPalette(1, App.scheme)[0]),
  copyHex: () => copy(C.toHex(rgb()), "Hex"),
  revert: () => {
    if (!App.prev) return toast("Nothing to go back to", "warn");
    const back = App.prev;
    setColor(C.parseHex(back), { keepPrev: true });
    App.prev = null;
    paintAll();
    toast(`Back to ${back}`);
  },
  addSwatch: () => {
    const hex = C.toHex(rgb());
    if (App.swatches.includes(hex)) return toast("Already saved", "warn");
    App.swatches = [hex, ...App.swatches].slice(0, 120);
    save("kiln-colour-swatches", App.swatches);
    paintSwatches();
    toast(`${hex} saved`);
  },
  clearSwatches: () => {
    if (!App.swatches.length) return;
    App.swatches = [];
    save("kiln-colour-swatches", App.swatches);
    paintSwatches();
  },
  copySwatches: () => copy(App.swatches.join("\n"), `${App.swatches.length} swatches`),
  savePalette: () => {
    const colors = App.palette.map(C.toHex);
    if (!colors.length) return toast("Generate a palette first", "warn");
    const name = prompt("Name this palette", `${App.scheme} ${App.palettes.length + 1}`);
    if (name === null) return;
    App.palettes = [{ name: name.trim() || "Palette", colors, at: Date.now() }, ...App.palettes].slice(0, 60);
    save("kiln-colour-palettes", App.palettes);
    paintPalettes();
    toast("Palette saved");
  },
  copyAll: () => copy(App.palette.map(C.toHex).join(", "), "Palette"),
  exportCss: () => {
    const lines = App.palette.map((c, i) => `  --colour-${i + 1}: ${C.toHex(c)};`);
    copy(`:root {\n${lines.join("\n")}\n}`, "CSS variables");
  },
  exportJson: () => copy(JSON.stringify(App.palette.map(C.toHex), null, 2), "JSON"),
  exportSvg: () => {
    const w = 120, h = 240;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * App.palette.length}" height="${h}">` +
      App.palette.map((c, i) => `<rect x="${i * w}" y="0" width="${w}" height="${h}" fill="${C.toHex(c)}"/>`).join("") +
      `</svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "palette.svg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Palette saved as SVG");
  },
  eyedropper: async () => {
    if (typeof EyeDropper === "undefined") return toast("This browser has no screen picker", "warn");
    try {
      const { sRGBHex } = await new EyeDropper().open();
      setColor(C.parseHex(sRGBHex));
      toast(`Picked ${sRGBHex.toUpperCase()}`);
    } catch { /* the user pressed escape */ }
  },
};

/* ---------------- wiring ---------------- */
const MENUS = {
  mFile: [["Copy the hex", "copyHex", "⌘C"], ["Copy the palette", "copyAll"], null,
          ["Export CSS variables", "exportCss"], ["Export JSON", "exportJson"], ["Export SVG…", "exportSvg"]],
  mColour: [["Random colour", "randomColor", "R"], ["Pick from the screen…", "eyedropper"],
    ["Back to the previous colour", "revert"], null,
            ["Save as a swatch", "addSwatch", "S"]],
  mPalette: [["Generate a new palette", "randomise", "Space"], ["Save this palette", "savePalette", "⌘S"], null,
             ["Copy every colour", "copyAll"]],
};
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

  document.addEventListener("click", async e => {
    const mi = e.target.closest(".mi");
    if (mi?.dataset.act) ACT[mi.dataset.act]?.();
    if (!e.target.closest("[data-menu]") || mi) document.querySelectorAll("[data-menu]").forEach(x => x.classList.remove("open"));

    const lock = e.target.closest("[data-lock]");
    if (lock) {
      e.stopPropagation();
      const i = +lock.dataset.lock;
      App.locks[i] = !App.locks[i];
      paintPalette();
      return;
    }
    const useIdx = e.target.closest("[data-use-idx]");
    if (useIdx) { e.stopPropagation(); setColor(App.palette[+useIdx.dataset.useIdx]); return; }

    /* anything carrying data-copy puts its value on the clipboard */
    const cp = e.target.closest("[data-copy]");
    if (cp) {
      await copy(cp.dataset.copy, cp.dataset.label);
      cp.classList.add("copied");
      setTimeout(() => cp.classList.remove("copied"), 700);
      return;
    }
    const act = e.target.closest("[data-act]:not(.mi)");
    if (act) { ACT[act.dataset.act]?.(); return; }
    const use = e.target.closest("[data-use]");
    if (use) { setColor(C.harmony(rgb(), use.dataset.use)[1] || rgb()); return; }

    const tab = e.target.closest(".ptab");
    if (tab) {
      document.querySelectorAll(".ptab").forEach(t => t.classList.toggle("on", t === tab));
      document.querySelectorAll(".pbody").forEach(b => b.classList.toggle("on", b.id === tab.dataset.pt));
    }
    const rmsw = e.target.closest("[data-rmsw]");
    if (rmsw) {
      e.stopPropagation();
      App.swatches.splice(+rmsw.dataset.rmsw, 1);
      save("kiln-colour-swatches", App.swatches);
      paintSwatches();
      return;
    }
    const sw = e.target.closest("[data-sw]");
    if (sw) { setColor(C.parseHex(App.swatches[+sw.dataset.sw])); return; }
    const pal = e.target.closest("[data-pal]");
    if (pal) {
      App.palette = App.palettes[+pal.dataset.pal].colors.map(C.parseHex);
      App.locks = [];
      App.count = App.palette.length;
      $("count").value = String(App.count);
      paintPalette(); paintContrast();
      toast("Palette loaded");
      return;
    }
    const pc = e.target.closest("[data-palcopy]");
    if (pc) return copy(App.palettes[+pc.dataset.palcopy].colors.join(", "), "Palette");
    const pcss = e.target.closest("[data-palcss]");
    if (pcss) {
      const p = App.palettes[+pcss.dataset.palcss];
      return copy(`:root {\n${p.colors.map((h, i) => `  --${p.name.toLowerCase().replace(/\W+/g, "-")}-${i + 1}: ${h};`).join("\n")}\n}`, "CSS");
    }
    const prm = e.target.closest("[data-palrm]");
    if (prm) {
      App.palettes.splice(+prm.dataset.palrm, 1);
      save("kiln-colour-palettes", App.palettes);
      paintPalettes();
    }
  });

  dragOn($("wheel"), (x, y) => {
    // back from a point on the disc to hue and saturation
    const dx = x - 0.5, dy = y - 0.5;
    App.hsv.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360 + 90) % 360;
    App.hsv.s = Math.min(100, Math.sqrt(dx * dx + dy * dy) * 2 * 100);
  });
  dragOn($("valBar"), x => { App.hsv.v = x * 100; });
  dragOn($("alphaBar"), x => { App.alpha = x; });

  $("hexIn").addEventListener("input", e => {
    const c = C.parseHex(e.target.value);
    if (c) { App.alpha = c.a; setColor(c, { silent: true }); }
  });
  $("scheme").innerHTML = C.SCHEMES.map(s => `<option value="${s}">${s}</option>`).join("");
  $("scheme").addEventListener("change", e => { App.scheme = e.target.value; randomise(); });
  $("count").addEventListener("change", e => { App.count = +e.target.value; randomise(); });
  $("cvd").addEventListener("change", e => {
    App.cvd = e.target.value;
    paintAll();
    $("sbStatus").textContent = App.cvd ? `simulating ${App.cvd}` : "Ready";
  });

  addEventListener("keydown", e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const M = e.metaKey || e.ctrlKey;
    if (e.code === "Space") { e.preventDefault(); randomise(); }
    else if (M && e.key.toLowerCase() === "c") { e.preventDefault(); ACT.copyHex(); }
    else if (M && e.key.toLowerCase() === "s") { e.preventDefault(); ACT.savePalette(); }
    else if (e.key.toLowerCase() === "r") ACT.randomColor();
    else if (e.key.toLowerCase() === "s") ACT.addSwatch();
  });
}

/* ---------------- boot ---------------- */
wire();
randomise();
paintAll();
paintSwatches();
paintPalettes();

window.Kiln = { App, C, ACT, setColor, rgb, randomise, paintAll, paintSwatches, paintPalettes, copy };
