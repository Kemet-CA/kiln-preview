/* ============================================================
   Kiln Translator — engine

   Translation runs **on the device**, through the browser's own Translator API.
   Kiln ships no model, sends nothing anywhere, and needs no key or account:
   the text you paste never leaves the machine. The browser downloads a small
   model per language pair the first time you use it, and reuses it offline
   afterwards.

   Where that is not available — any browser without the API — the app says so
   plainly instead of silently doing nothing, because a translator that quietly
   fails is worse than one that admits it cannot help.
   ============================================================ */

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* the languages Chrome's on-device models cover, plus their own names */
const LANGS = [
  ["en", "English"], ["es", "Spanish · Español"], ["fr", "French · Français"],
  ["de", "German · Deutsch"], ["it", "Italian · Italiano"], ["pt", "Portuguese · Português"],
  ["nl", "Dutch · Nederlands"], ["pl", "Polish · Polski"], ["ru", "Russian · Русский"],
  ["uk", "Ukrainian · Українська"], ["tr", "Turkish · Türkçe"], ["ar", "Arabic · العربية"],
  ["he", "Hebrew · עברית"], ["fa", "Persian · فارسی"], ["hi", "Hindi · हिन्दी"],
  ["bn", "Bengali · বাংলা"], ["ur", "Urdu · اردو"], ["zh", "Chinese, simplified · 简体中文"],
  ["zh-Hant", "Chinese, traditional · 繁體中文"], ["ja", "Japanese · 日本語"], ["ko", "Korean · 한국어"],
  ["vi", "Vietnamese · Tiếng Việt"], ["th", "Thai · ไทย"], ["id", "Indonesian"],
  ["ms", "Malay"], ["sv", "Swedish · Svenska"], ["da", "Danish · Dansk"], ["no", "Norwegian"],
  ["fi", "Finnish · Suomi"], ["cs", "Czech · Čeština"], ["el", "Greek · Ελληνικά"],
  ["ro", "Romanian · Română"], ["hu", "Hungarian · Magyar"], ["sw", "Swahili · Kiswahili"],
];
const NAME = code => (LANGS.find(l => l[0] === code) || [, code])[1].split(" · ")[0];
const RTL = new Set(["ar", "he", "fa", "ur"]);

const App = {
  from: "auto", to: "es",
  live: true,
  busy: false,
  translator: null,          // cached per pair
  pair: "",
  detector: null,
  detected: null,
  history: load("kiln-translate-history", []),
  seq: 0,
};

function load(k, dflt) { try { return JSON.parse(localStorage.getItem(k)) ?? dflt; } catch { return dflt; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = "toast";
  const tint = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" }[kind] || "var(--ok)";
  t.innerHTML = `<span class="dot" style="background:${tint}"></span>${esc(msg)}`;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; }, 2600);
  setTimeout(() => t.remove(), 2950);
}
function status(text, kind = "ok") {
  $("sbStatus").textContent = text;
  $("sbDot").className = "dot" + (kind === "ok" ? "" : " " + kind);
}
const supported = () => typeof Translator !== "undefined";

/* ---------------- language detection ---------------- */
async function detect(text) {
  if (!text.trim() || typeof LanguageDetector === "undefined") return null;
  try {
    if (!App.detector) {
      const avail = await LanguageDetector.availability();
      if (avail === "unavailable") return null;
      App.detector = await LanguageDetector.create();
    }
    const [best] = await App.detector.detect(text.slice(0, 400));
    return best && best.confidence > .3 ? best : null;
  } catch { return null; }
}

/* ---------------- the translator itself ---------------- */
async function translatorFor(from, to) {
  const pair = `${from}→${to}`;
  if (App.translator && App.pair === pair) return App.translator;
  App.translator?.destroy?.();
  App.translator = null;

  const avail = await Translator.availability({ sourceLanguage: from, targetLanguage: to });
  $("sbModel").textContent = avail;
  if (avail === "unavailable") throw new Error(`${NAME(from)} → ${NAME(to)} is not available on this device`);

  if (avail === "downloadable" || avail === "downloading") {
    status("Downloading the language model…", "warn");
    showProgress(0);
  }
  const t = await Translator.create({
    sourceLanguage: from, targetLanguage: to,
    monitor(m) {
      m.addEventListener("downloadprogress", e => {
        const p = e.total ? e.loaded / e.total : e.loaded;
        showProgress(p);
        status(`Downloading the language model… ${Math.round(p * 100)}%`, "warn");
      });
    },
  });
  hideProgress();
  App.translator = t;
  App.pair = pair;
  $("sbModel").textContent = "ready";
  status("Ready");
  return t;
}
function showProgress(p) {
  let el = $("dlProg");
  if (!el) {
    const wrap = document.createElement("div");
    wrap.className = "prog";
    wrap.innerHTML = `<i id="dlProg"></i>`;
    $("pInfo").prepend(wrap);
    el = $("dlProg");
  }
  el.style.width = Math.round(p * 100) + "%";
}
function hideProgress() { $("dlProg")?.parentElement?.remove(); }

async function translate({ silent } = {}) {
  const text = $("src").value;
  const mine = ++App.seq;
  if (!text.trim()) { setOut(""); return; }
  if (!supported()) {
    setOut("");
    status("Not available in this browser", "bad");
    if (!silent) toast("This browser has no on-device translator — see the About panel", "warn");
    return;
  }
  let from = App.from;
  if (from === "auto") {
    const d = await detect(text);
    App.detected = d;
    $("detected").textContent = d ? `detected ${NAME(d.detectedLanguage)}` : "";
    from = d?.detectedLanguage || "en";
  } else $("detected").textContent = "";

  if (from === App.to) { setOut(text); status("Same language"); return; }

  setBusy(true);
  try {
    const t = await translatorFor(from, App.to);
    if (mine !== App.seq) return;                      // a newer keystroke won
    let out = "";
    if (t.translateStreaming) {
      for await (const chunk of t.translateStreaming(text)) {
        if (mine !== App.seq) return;
        out += chunk;
        setOut(out);
      }
    } else {
      out = await t.translate(text);
      if (mine !== App.seq) return;
      setOut(out);
    }
    status("Ready");
    remember(text, out, from, App.to);
  } catch (e) {
    status(e.message.slice(0, 60), "bad");
    if (!silent) toast(e.message, "bad");
  } finally {
    if (mine === App.seq) setBusy(false);
  }
}
function setBusy(on) { App.busy = on; $("busy").classList.toggle("on", on); }
function setOut(text) {
  $("out").value = text;
  $("out").dir = RTL.has(App.to) ? "rtl" : "ltr";
  $("outCount").textContent = text.length;
}

/* ---------------- history ---------------- */
function remember(src, out, from, to) {
  if (!out || src.length < 2) return;
  const entry = { src: src.slice(0, 400), out: out.slice(0, 400), from, to, at: Date.now() };
  App.history = [entry, ...App.history.filter(h => h.src !== entry.src || h.to !== entry.to)].slice(0, 40);
  save("kiln-translate-history", App.history);
  renderHistory();
}
function renderHistory() {
  $("pHist").innerHTML = App.history.length
    ? App.history.map((h, i) => `<button class="hrow" data-h="${i}">
        <span class="hl">${esc(NAME(h.from))} → ${esc(NAME(h.to))}</span>
        <span class="hs">${esc(h.src.slice(0, 70))}</span>
        <span class="ht">${esc(h.out.slice(0, 70))}</span></button>`).join("")
      + `<button class="rowbtn" data-act="clearHistory">Clear history</button>`
    : `<div class="empty">Nothing yet. Translations you make are kept here, on this device only.</div>`;
}
function renderAbout() {
  const has = supported();
  $("pInfo").innerHTML = `
    <div class="ihead">How this works</div>
    <div class="note">
      Translation runs <b>on your device</b>, through the browser's own translator. Kiln ships no
      model and sends your text nowhere — no key, no account, no server. The browser downloads a
      small model the first time you use a language pair, then works offline.
    </div>
    <div class="ihead">This browser</div>
    <div class="kv"><span>On-device translator</span><b>${has ? "available" : "missing"}</b></div>
    <div class="kv"><span>Language detection</span><b>${typeof LanguageDetector !== "undefined" ? "available" : "missing"}</b></div>
    <div class="kv"><span>Read aloud</span><b>${typeof speechSynthesis !== "undefined" ? "available" : "missing"}</b></div>
    ${has ? "" : `<div class="note"><b>No translator here.</b> The Translator API ships in Chrome and
      Edge 138 and later, on desktop. Everything else in this workspace still works, but the
      translation itself needs that browser — Kiln will not send your text to a cloud service to
      work around it.</div>`}
    <div class="ihead">Limits worth knowing</div>
    <div class="note">
      Machine translation gets the sense across; it is not a substitute for a person on anything
      that matters legally or medically. Long documents translate a paragraph at a time — accuracy
      drops when a sentence depends on context far away from it.
    </div>`;
}

/* ---------------- speech ---------------- */
function speak(text, lang) {
  if (!text.trim() || typeof speechSynthesis === "undefined") return toast("Read aloud is unavailable here", "warn");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 3000));
  u.lang = lang === "auto" ? (App.detected?.detectedLanguage || "en") : lang;
  speechSynthesis.speak(u);
}

/* ---------------- actions ---------------- */
const ACT = {
  translate: () => translate(),
  live: () => {
    App.live = !App.live;
    $("liveBtn").classList.toggle("on", App.live);
    toast(App.live ? "Translating as you type" : "Press Translate when you are ready");
  },
  swap: () => {
    const from = App.from === "auto" ? (App.detected?.detectedLanguage || "en") : App.from;
    const src = $("src").value, out = $("out").value;
    App.from = App.to; App.to = from;
    $("from").value = App.from; $("to").value = App.to;
    if (out) { $("src").value = out; setOut(src); }
    syncPair();
    translate();
  },
  clear: () => { $("src").value = ""; setOut(""); $("srcCount").textContent = "0"; $("detected").textContent = ""; $("src").focus(); },
  copy: async () => {
    const t = $("out").value;
    if (!t) return;
    try { await navigator.clipboard.writeText(t); toast("Translation copied"); }
    catch { $("out").select(); document.execCommand("copy"); toast("Translation copied"); }
  },
  paste: async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { $("src").value = t; onInput(); }
    } catch { toast("Press ⌘V to paste — browsers only allow that from the keyboard", "warn"); }
  },
  speakSrc: () => speak($("src").value, App.from),
  speakOut: () => speak($("out").value, App.to),
  saveOut: () => {
    const t = $("out").value;
    if (!t) return toast("Nothing to save yet", "warn");
    const blob = new Blob([t], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `translation-${App.to}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  },
  openFile: () => $("fileIn").click(),
  clearHistory: () => { App.history = []; save("kiln-translate-history", []); renderHistory(); },
};

function onInput() {
  const v = $("src").value;
  $("srcCount").textContent = v.length;
  $("src").dir = App.from !== "auto" && RTL.has(App.from) ? "rtl" : "ltr";
  if (!App.live) return;
  clearTimeout(App.timer);
  App.timer = setTimeout(() => translate({ silent: true }), 450);
}
function syncPair() {
  $("sbPair").textContent = `${App.from === "auto" ? "detect" : App.from} → ${App.to}`;
  $("srcLabel").textContent = App.from === "auto" ? "Source · detect language" : `Source · ${NAME(App.from)}`;
  $("outLabel").textContent = `Translation · ${NAME(App.to)}`;
}

/* ---------------- wiring ---------------- */
const MENUS = {
  mFile: [["Open a text file…", "openFile", "⌘O"], ["Save the translation…", "saveOut", "⌘S"], null,
          ["Clear", "clear"]],
  mEdit: [["Copy the translation", "copy", "⌘C"], ["Paste into the source", "paste"], null,
          ["Read the source aloud", "speakSrc"], ["Read the translation aloud", "speakOut"]],
  mLang: [["Swap languages", "swap", "⌘⇧S"], ["Translate now", "translate", "⌘↵"], null,
          ["Translate as you type", "live"]],
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
  document.addEventListener("click", e => {
    const mi = e.target.closest(".mi");
    if (mi?.dataset.act) ACT[mi.dataset.act]?.();
    if (!e.target.closest("[data-menu]") || mi) document.querySelectorAll("[data-menu]").forEach(x => x.classList.remove("open"));
    const act = e.target.closest("[data-act]:not(.mi)");
    if (act) ACT[act.dataset.act]?.();
    const tab = e.target.closest(".ptab");
    if (tab) {
      document.querySelectorAll(".ptab").forEach(t => t.classList.toggle("on", t === tab));
      document.querySelectorAll(".pbody").forEach(b => b.classList.toggle("on", b.id === tab.dataset.pt));
    }
    const h = e.target.closest("[data-h]");
    if (h) {
      const item = App.history[+h.dataset.h];
      if (item) {
        $("src").value = item.src;
        App.from = item.from; App.to = item.to;
        $("from").value = item.from; $("to").value = item.to;
        syncPair(); onInput(); translate();
      }
    }
  });
  $("swapBtn").addEventListener("click", ACT.swap);

  $("from").innerHTML = `<option value="auto">Detect language</option>` +
    LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join("");
  $("to").innerHTML = LANGS.map(([c, n]) => `<option value="${c}"${c === App.to ? " selected" : ""}>${n}</option>`).join("");
  $("from").value = App.from;

  $("from").addEventListener("change", e => { App.from = e.target.value; App.pair = ""; syncPair(); translate(); });
  $("to").addEventListener("change", e => { App.to = e.target.value; App.pair = ""; syncPair(); translate(); });
  $("src").addEventListener("input", onInput);
  $("fileIn").addEventListener("change", async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    $("src").value = (await f.text()).slice(0, 20000);
    onInput();
    translate();
  });
  ["dragover", "drop"].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
  document.addEventListener("drop", async e => {
    const f = e.dataTransfer.files[0];
    if (f && /\.(txt|md|csv)$/i.test(f.name)) { $("src").value = (await f.text()).slice(0, 20000); onInput(); translate(); }
  });

  addEventListener("keydown", e => {
    const M = e.metaKey || e.ctrlKey;
    if (M && e.key === "Enter") { e.preventDefault(); translate(); }
    else if (M && e.shiftKey && e.key.toLowerCase() === "s") { e.preventDefault(); ACT.swap(); }
    else if (M && e.key.toLowerCase() === "o") { e.preventDefault(); ACT.openFile(); }
    else if (M && e.key.toLowerCase() === "s") { e.preventDefault(); ACT.saveOut(); }
  });
}

/* ---------------- boot ---------------- */
wire();
syncPair();
renderHistory();
renderAbout();
if (supported()) {
  status("Ready");
  Translator.availability({ sourceLanguage: "en", targetLanguage: App.to })
    .then(a => { $("sbModel").textContent = a; })
    .catch(() => {});
} else {
  status("No on-device translator", "bad");
  $("sbModel").textContent = "unavailable";
  document.querySelector('[data-pt="pInfo"]').click();
}

window.Kiln = { App, ACT, translate, detect, LANGS, NAME, setOut, renderHistory, supported };
