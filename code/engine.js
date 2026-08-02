/* ============================================================
   Kiln Code — the editor.

   A textarea does the typing and a highlighted copy of the same text sits
   behind it, in the same font at the same size and padding. The browser
   already knows how to edit text — selection, undo, IME, autocorrect, a
   caret that behaves on every platform — and reimplementing that is how
   editors go wrong. So it is kept, and only the colour is added.

   The two layers have to agree to the pixel or the illusion breaks, which is
   why every metric lives in one CSS rule and both layers read it.

   Running is deliberately narrow: JavaScript in a sandboxed frame with no
   access to this page, HTML as a preview. Nothing is uploaded, and nothing
   else pretends to run.
   ============================================================ */
import { LANGS, languageList, detectLanguage, highlight, format, tokenize } from "./src/highlight.js";

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const App = {
  lang: "javascript",
  name: "untitled",
  font: 13.5,
  wrap: false,
  finds: [], findAt: -1,
};
window.App = App;

const src = () => $("src");

/* ---------------- chrome ---------------- */
function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span class="dot ${kind}"></span>${msg}`;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 320); }, 2400);
}
window.toast = toast;
const status = (t, kind = "") => { $("sbStatus").textContent = t; $("sbDot").className = "dot " + kind; };

/* ---------------- painting ---------------- */
let paintTimer = 0;
function paint() {
  const text = src().value;
  $("hl").innerHTML = highlight(text, App.lang) + "\n";      // trailing newline keeps the last line visible
  drawGutter();
  stats();
  syncScroll();
}
function schedule() {
  clearTimeout(paintTimer);
  // big files get a beat so typing never waits on the highlighter
  paintTimer = setTimeout(paint, src().value.length > 20000 ? 90 : 0);
}
function drawGutter() {
  const lines = src().value.split("\n").length;
  const cur = lineOf(src().selectionStart);
  let h = "";
  for (let i = 1; i <= lines; i++) h += `<i${i === cur ? ' class="cur"' : ""}>${i}</i>`;
  $("gutter").innerHTML = h;
}
const lineOf = pos => src().value.slice(0, pos).split("\n").length;
function stats() {
  const v = src().value, pos = src().selectionStart;
  const before = v.slice(0, pos).split("\n");
  $("sbLn").textContent = before.length;
  $("sbCol").textContent = before[before.length - 1].length + 1;
  $("sbLines").textContent = v.split("\n").length;
  $("sbChars").textContent = v.length;
  $("sbLang").textContent = LANGS[App.lang].name;
}
function syncScroll() {
  $("hlWrap").scrollTop = src().scrollTop;
  $("hlWrap").scrollLeft = src().scrollLeft;
  $("gutter").scrollTop = src().scrollTop;
}

/* ---------------- editing helpers ---------------- */
function replace(from, to, text, caret) {
  const el = src(), v = el.value;
  el.value = v.slice(0, from) + text + v.slice(to);
  el.selectionStart = el.selectionEnd = caret ?? from + text.length;
  paint();
}
const lineBounds = pos => {
  const v = src().value;
  const start = v.lastIndexOf("\n", pos - 1) + 1;
  const end = v.indexOf("\n", pos);
  return [start, end === -1 ? v.length : end];
};
const indentUnit = () => (App.lang === "python" || App.lang === "yaml" ? "    " : "  ");

function indentSelection(out) {
  const el = src();
  const [s] = lineBounds(el.selectionStart);
  const [, e] = lineBounds(el.selectionEnd);
  const block = el.value.slice(s, e);
  const unit = indentUnit();
  const next = block.split("\n").map(l =>
    out ? l.replace(new RegExp("^( {1," + unit.length + "}|\\t)"), "") : unit + l).join("\n");
  el.setSelectionRange(s, e);
  document.execCommand("insertText", false, next);   // keeps the browser's undo stack
  el.setSelectionRange(s, s + next.length);
  paint();
}
function toggleComment() {
  const el = src(), mark = LANGS[App.lang].comment;
  if (!mark) return toast("No comment syntax for " + LANGS[App.lang].name, "warn");
  const [s] = lineBounds(el.selectionStart);
  const [, e] = lineBounds(el.selectionEnd);
  const block = el.value.slice(s, e);
  const lines = block.split("\n");
  const closed = mark === "/*" ? " */" : mark === "<!--" ? " -->" : "";
  const on = mark + (closed ? " " : " ");
  const all = lines.every(l => !l.trim() || l.trimStart().startsWith(mark));
  const next = lines.map(l => {
    if (!l.trim()) return l;
    if (all) return l.replace(on, "").replace(mark, "").replace(closed, "");
    const lead = l.match(/^\s*/)[0];
    return lead + on + l.slice(lead.length) + closed;
  }).join("\n");
  el.setSelectionRange(s, e);
  document.execCommand("insertText", false, next);
  el.setSelectionRange(s, s + next.length);
  paint();
}

const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
function onKey(e) {
  const el = src(), M = e.metaKey || e.ctrlKey;
  if (M && e.key === "Enter") { e.preventDefault(); ACT.run(); return; }
  if (M && e.key.toLowerCase() === "s") { e.preventDefault(); ACT.save(); return; }
  if (M && e.key.toLowerCase() === "o") { e.preventDefault(); ACT.open(); return; }
  if (M && e.key.toLowerCase() === "f") { e.preventDefault(); ACT.find(); return; }
  if (M && e.key === "/") { e.preventDefault(); toggleComment(); return; }
  if (e.altKey && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); ACT.format(); return; }
  if (M) return;

  if (e.key === "Tab") {
    e.preventDefault();
    if (el.selectionStart !== el.selectionEnd || e.shiftKey) indentSelection(e.shiftKey);
    else document.execCommand("insertText", false, indentUnit());
    paint();
    return;
  }
  if (e.key === "Enter") {
    // carry the indent, and open a block when the line ends on a bracket
    const [s] = lineBounds(el.selectionStart);
    const line = el.value.slice(s, el.selectionStart);
    const lead = line.match(/^\s*/)[0];
    const opens = /[{[(:]$/.test(line.trim());
    e.preventDefault();
    const add = "\n" + lead + (opens ? indentUnit() : "");
    document.execCommand("insertText", false, add);
    paint();
    return;
  }
  if (PAIRS[e.key] && el.selectionStart === el.selectionEnd) {
    const after = el.value[el.selectionStart] || "";
    if (!/[\w$]/.test(after)) {
      e.preventDefault();
      const pos = el.selectionStart;
      document.execCommand("insertText", false, e.key + PAIRS[e.key]);
      el.selectionStart = el.selectionEnd = pos + 1;
      paint();
    }
  }
}

/* ---------------- find ---------------- */
function runFind(q) {
  App.finds = [];
  if (q) {
    const v = src().value.toLowerCase(), needle = q.toLowerCase();
    let i = v.indexOf(needle);
    while (i !== -1) { App.finds.push(i); i = v.indexOf(needle, i + Math.max(1, needle.length)); }
  }
  App.findAt = App.finds.length ? 0 : -1;
  $("findN").textContent = `${App.finds.length ? 1 : 0} / ${App.finds.length}`;
  if (App.findAt >= 0) gotoFind(0, q.length, false);   // typing must not pull focus back
}
function gotoFind(i, len, focusEditor = true) {
  if (!App.finds.length) return;
  App.findAt = (i + App.finds.length) % App.finds.length;
  const at = App.finds[App.findAt];
  if (focusEditor) src().focus();
  src().setSelectionRange(at, at + len);
  // put the hit in view
  const line = lineOf(at);
  const lh = parseFloat(getComputedStyle(src()).lineHeight);
  src().scrollTop = Math.max(0, (line - 6) * lh);
  $("findN").textContent = `${App.findAt + 1} / ${App.finds.length}`;
  syncScroll();
  stats();
}

/* ---------------- running ---------------- */
const RUNNER = `<!doctype html><meta charset="utf-8"><body><script>
  const send = (k, a) => parent.postMessage({ kiln: 1, k, a: a.map(v => {
    try { return typeof v === "string" ? v : JSON.stringify(v, (x, y) => typeof y === "bigint" ? String(y) : y, 1); }
    catch { return String(v); } }) }, "*");
  for (const k of ["log", "info", "warn", "error", "debug"])
    console[k] = (...a) => send(k === "debug" ? "log" : k, a);
  addEventListener("error", e => send("error", [e.message + " (line " + (e.lineno - 8) + ")"]));
  addEventListener("unhandledrejection", e => send("error", ["Unhandled promise: " + e.reason]));
  addEventListener("message", e => {
    if (!e.data || e.data.run === undefined) return;
    try { const r = eval(e.data.run); if (r !== undefined) send("ret", [r]); }
    catch (err) { send("error", [err.name + ": " + err.message]); }
    send("done", []);
  });
<\/script>`;

let frame = null, runStarted = 0;
function out(kind, text) {
  const box = $("out");
  const line = document.createElement("span");
  line.className = "l " + kind;
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
function clearOut() { $("out").innerHTML = ""; }

addEventListener("message", e => {
  if (!e.data || e.data.kiln !== 1) return;
  if (e.data.k === "done") {
    out("dim", `— finished in ${Date.now() - runStarted} ms`);
    status("Ready");
    return;
  }
  const cls = e.data.k === "error" ? "err" : e.data.k === "warn" ? "warn" : e.data.k === "ret" ? "ret" : "";
  out(cls, e.data.a.join(" "));
});

function runJs(code) {
  clearOut();
  $("preview").hidden = true;
  frame?.remove();
  frame = document.createElement("iframe");
  frame.sandbox = "allow-scripts";
  frame.style.display = "none";
  frame.srcdoc = RUNNER;
  frame.onload = () => {
    runStarted = Date.now();
    frame.contentWindow.postMessage({ run: code }, "*");
  };
  document.body.appendChild(frame);
  status("Running…");
}
function runHtml(code) {
  clearOut();
  out("dim", "Rendered below.");
  const p = $("preview");
  p.hidden = false;
  p.srcdoc = code;
  status("Ready");
}

/* ---------------- files ---------------- */
function openFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    src().value = String(r.result);
    setLang(detectLanguage(file.name));
    App.name = file.name.replace(/\.[^.]+$/, "");
    paint();
    status("Opened " + file.name);
  };
  r.readAsText(file);
}
function save() {
  const blob = new Blob([src().value], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${App.name}.${LANGS[App.lang].ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("Saved " + a.download);
  return blob;
}
window.saveFile = save;

/* ---------------- starters ----------------
   Something real in every language, so the editor is never an empty box. */
const STARTERS = {
  javascript: ["Fizz buzz", "The loop everyone writes first",
`for (let i = 1; i <= 20; i++) {
  const s = (i % 3 ? "" : "Fizz") + (i % 5 ? "" : "Buzz");
  console.log(s || i);
}`],
  typescript: ["A typed function", "Types, then the same code",
`type Point = { x: number; y: number };

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

console.log(distance({ x: 0, y: 0 }, { x: 3, y: 4 }));`],
  python: ["Fibonacci", "A generator, the Python way",
`def fib(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b

print(list(fib(10)))`],
  html: ["A page", "Renders in the preview",
`<!doctype html>
<h1 style="font-family:system-ui">Hello</h1>
<p style="font-family:system-ui;color:#555">
  Edit this and press Run — it renders in the panel.
</p>`],
  css: ["A card", "Custom properties and a grid",
`:root { --pad: 16px; --radius: 14px; }

.card {
  display: grid;
  gap: var(--pad);
  padding: var(--pad);
  border-radius: var(--radius);
  background: #fff;
  box-shadow: 0 10px 30px -20px rgba(0,0,0,.4);
}`],
  json: ["A config", "Format it with the button",
`{"name":"kiln","private":true,"workspaces":["apps/*"],"scripts":{"dev":"node serve.mjs"}}`],
  sql: ["A join", "Two tables, one answer",
`SELECT c.name, COUNT(o.id) AS orders
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE c.created_at > '2024-01-01'
GROUP BY c.name
ORDER BY orders DESC
LIMIT 10;`],
  bash: ["A loop", "Rename every file in a folder",
`#!/usr/bin/env bash
set -euo pipefail

for f in *.jpeg; do
  mv -- "$f" "\${f%.jpeg}.jpg"
done`],
  go: ["Hello", "The shape of every Go file",
`package main

import "fmt"

func main() {
    for i, w := range []string{"shape", "and", "ship"} {
        fmt.Printf("%d %s\\n", i, w)
    }
}`],
  rust: ["Ownership", "Where Rust starts",
`fn main() {
    let words = vec!["shape", "and", "ship"];
    let joined: String = words.join(" ");
    println!("{joined} ({} chars)", joined.len());
}`],
  java: ["A class", "Still how it begins",
`public class Main {
    public static void main(String[] args) {
        for (String w : new String[]{"shape", "and", "ship"}) {
            System.out.println(w);
        }
    }
}`],
  c: ["Pointers", "The classic first lesson",
`#include <stdio.h>

int main(void) {
    int n = 42;
    int *p = &n;
    printf("%d at %p\\n", *p, (void *)p);
    return 0;
}`],
  php: ["A page", "Arrays and interpolation",
`<?php
$words = ['shape', 'and', 'ship'];
foreach ($words as $i => $w) {
    echo "$i: $w\\n";
}`],
  ruby: ["Blocks", "The thing Ruby is for",
`words = %w[shape and ship]

words.each_with_index do |w, i|
  puts "#{i}: #{w}"
end`],
  markdown: ["A readme", "What every project starts with",
`# Kiln

**Shape and ship anything.** Eight workspaces, in a browser tab.

- Nothing is uploaded
- No account
- [Open it](https://kemet-ca.github.io/kiln-preview/)`],
  yaml: ["A workflow", "Indentation matters",
`name: build
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node test.mjs`],
  xml: ["A document", "Tags all the way down",
`<?xml version="1.0" encoding="UTF-8"?>
<library>
  <book id="1">
    <title>Shape and ship</title>
    <year>2026</year>
  </book>
</library>`],
  plain: ["Notes", "Just text", "Type anything here."],
};
function paintSnippets() {
  const s = STARTERS[App.lang] || STARTERS.plain;
  $("pSnip").innerHTML =
    `<button class="snip" data-snip="1"><b>${s[0]}</b><span>${s[1]}</span></button>` +
    `<div class="note">Starters replace what is in the editor. The language menu
       has one for each of the ${languageList().length} languages.</div>`;
}

/* ---------------- language + view ---------------- */
function setLang(id) {
  App.lang = LANGS[id] ? id : "plain";
  $("langSel").value = App.lang;
  paint();
  paintSnippets();
  buildMenus();
}
function setFont(px) {
  App.font = clamp(px, 10, 24);
  document.querySelector(".ed").style.setProperty("--code-size", App.font + "px");
  $("fontV").textContent = App.font;
  syncScroll();
}

/* ---------------- actions ---------------- */
const ACT = {
  saveProject: () => window.KilnProject?.save(),
  downloadProject: () => window.KilnProject?.download(),
  run: () => {
    const code = src().value;
    if (App.lang === "javascript" || App.lang === "typescript") {
      // types are stripped crudely: enough for a snippet, not a compiler
      runJs(App.lang === "typescript"
        ? code.replace(/:\s*[A-Za-z_$][\w$<>[\]|,.\s]*(?=\s*[=,);])/g, "").replace(/^\s*(type|interface)\s[\s\S]*?\n}/gm, "")
        : code);
    } else if (App.lang === "html" || App.lang === "xml") runHtml(code);
    else {
      clearOut();
      out("dim", `${LANGS[App.lang].name} needs a runtime this tab does not have — nothing is sent anywhere to run it.`);
      out("dim", "JavaScript and HTML run here. Everything else is for reading and writing.");
    }
    document.querySelector('[data-pt="pOut"]').click();
  },
  open: () => $("fileIn").click(),
  save,
  format: () => {
    try {
      const before = src().value;
      src().value = format(before, App.lang);
      paint();
      toast(before === src().value ? "Already tidy" : "Formatted");
    } catch (e) { toast("Could not format: " + e.message, "bad"); }
  },
  comment: toggleComment,
  find: () => {
    $("findbar").classList.add("on");
    $("findIn").focus();
    $("findIn").select();
  },
  findClose: () => { $("findbar").classList.remove("on"); src().focus(); },
  findNext: () => gotoFind(App.findAt + 1, $("findIn").value.length),
  findPrev: () => gotoFind(App.findAt - 1, $("findIn").value.length),
  fontUp: () => setFont(App.font + 1),
  fontDown: () => setFont(App.font - 1),
  wrap: () => {
    App.wrap = !App.wrap;
    document.body.classList.toggle("wrap", App.wrap);
    $("wrapBtn").classList.toggle("on", App.wrap);
  },
  panels: () => document.body.classList.toggle("nopanels"),
  clear: () => { src().value = ""; paint(); },
  starter: () => {
    const s = STARTERS[App.lang] || STARTERS.plain;
    src().value = s[2];
    paint();
    toast(`${s[0]} — ${LANGS[App.lang].name}`);
  },
  selectAll: () => { src().focus(); src().select(); },
  copyAll: async () => {
    try { await navigator.clipboard.writeText(src().value); toast("Copied"); }
    catch { toast("Clipboard refused", "warn"); }
  },
};

/* ---------------- menus ---------------- */
const MENUS = () => ({
  mFile: [["Open a file…", "open", "⌘O"], ["Download", "save"], null,
    ["Save project", "saveProject", "⌘S"], ["Save a copy to disk…", "downloadProject"], null,
    ["Insert the starter", "starter"], ["Clear", "clear"]],
  mEdit: [["Select all", "selectAll", "⌘A"], ["Copy all", "copyAll"], null,
    ["Comment / uncomment", "comment", "⌘/"], ["Format", "format", "⇧⌥F"], ["Find…", "find", "⌘F"]],
  mLang: languageList().map(l => [l.name, "lang:" + l.id, "." + l.ext, l.id === App.lang]),
  mView: [["Wrap long lines", "wrap"], ["Bigger text", "fontUp"], ["Smaller text", "fontDown"], null,
    ["Editor theme: Kiln", "theme:kiln"], ["Editor theme: Midnight", "theme:midnight"],
    ["Editor theme: Paper", "theme:paper"], null, ["Hide the panel", "panels"]],
});
function buildMenus() {
  for (const [id, items] of Object.entries(MENUS())) {
    $(id).innerHTML = items.map(it => it === null ? `<div class="msep"></div>`
      : `<button class="mi${it[3] ? " on" : ""}" data-act="${it[1]}">${it[0]}` +
        `${it[2] ? `<span class="sc">${it[2]}</span>` : ""}</button>`).join("");
  }
}

/* ---------------- wiring ---------------- */
document.addEventListener("click", e => {
  const mi = e.target.closest(".mi");
  const btn = e.target.closest("[data-act]");
  if (btn) {
    const a = btn.dataset.act;
    if (a.startsWith("lang:")) setLang(a.slice(5));
    else if (a.startsWith("theme:")) { document.body.dataset.codeTheme = a.slice(6); $("themeSel").value = a.slice(6); }
    else ACT[a]?.();
  }
  if (e.target.closest("[data-snip]")) ACT.starter();
  if (!e.target.closest("[data-menu]") || mi)
    document.querySelectorAll("[data-menu]").forEach(m => m.classList.remove("open"));
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
src().addEventListener("input", schedule);
src().addEventListener("scroll", syncScroll);
src().addEventListener("keydown", onKey);
for (const ev of ["click", "keyup", "select"]) src().addEventListener(ev, () => { drawGutter(); stats(); });
$("langSel").addEventListener("change", e => setLang(e.target.value));
$("themeSel").addEventListener("change", e => { document.body.dataset.codeTheme = e.target.value; });
$("fileIn").addEventListener("change", e => { openFile(e.target.files[0]); e.target.value = ""; });
$("findIn").addEventListener("input", e => runFind(e.target.value));
$("findIn").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); gotoFind(App.findAt + (e.shiftKey ? -1 : 1), e.target.value.length); }
  if (e.key === "Escape") ACT.findClose();
});
document.addEventListener("keydown", e => {
  if (e.target === src() || e.target === $("findIn")) return;
  const M = e.metaKey || e.ctrlKey;
  if (M && e.key.toLowerCase() === "f") { e.preventDefault(); ACT.find(); }
  if (M && e.key === "Enter") { e.preventDefault(); ACT.run(); }
});
["dragover", "drop"].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault();
  if (ev === "drop" && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
}));

/* ---------------- keeping the session ----------------
   The text, the language, the look. Written on a debounce while you type and
   flushed when the tab goes away, so coming back finds the same screen. */
function remember() {
  window.KilnProject?.touch();
  KilnSession?.save({
    text: src().value, lang: App.lang, name: App.name,
    codeTheme: document.body.dataset.codeTheme, font: App.font, wrap: App.wrap,
  });
}
function restoreSession() {
  const s = KilnSession?.state || {};
  if (s.codeTheme) { document.body.dataset.codeTheme = s.codeTheme; $("themeSel").value = s.codeTheme; }
  if (s.font) setFont(s.font);
  if (s.wrap) { App.wrap = true; document.body.classList.add("wrap"); $("wrapBtn").classList.add("on"); }
  if (s.name) App.name = s.name;
  if (typeof s.text === "string") {
    setLang(s.lang || "javascript");
    src().value = s.text;
    paint();
    return true;
  }
  return false;
}

/* ---------------- boot ---------------- */
$("langSel").innerHTML = languageList().map(l =>
  `<option value="${l.id}">${l.name}</option>`).join("");
setFont(App.font);
setLang("javascript");
if (!restoreSession()) {
  src().value = STARTERS.javascript[2];
  paint();
}
src().addEventListener("input", remember);
$("langSel").addEventListener("change", remember);
$("themeSel").addEventListener("change", remember);
addEventListener("pagehide", remember);
buildMenus();
paintSnippets();
status("Ready");
window.Code = { App, ACT, setLang, paint, tokenize, format, highlight, STARTERS };

/* ---------------- the project system ----------------
   A file's worth of text and the settings that make it readable. Small enough
   that the whole thing is the document and there are no assets at all — which
   is the point of letting each workspace describe its own. */
window.KilnProject?.register({
  kind: "code", schema: 1, newName: "Untitled snippet",
  snapshot: () => ({
    doc: {
      text: src().value, lang: App.lang, name: App.name, font: App.font, wrap: App.wrap,
      codeTheme: document.body.dataset.codeTheme || "",
    },
    assets: [], history: null,
  }),
  restore(doc) {
    setLang(doc.lang || "javascript");
    src().value = doc.text || "";
    App.name = doc.name || "untitled";
    if (doc.font) setFont(doc.font);
    if (doc.codeTheme) { document.body.dataset.codeTheme = doc.codeTheme; $("themeSel").value = doc.codeTheme; }
    App.wrap = !!doc.wrap;
    document.body.classList.toggle("wrap", App.wrap);
    $("wrapBtn").classList.toggle("on", App.wrap);
    paint();
  },
  reset() { src().value = ""; App.name = "untitled"; paint(); },
});
