/* ============================================================
   Kiln Storage — a preview, and honest about it.

   Every other workspace in Kiln does its work on the machine it is running
   on. This one cannot: storing files somewhere they survive a closed laptop
   needs somewhere to put them, and that does not exist yet.

   So this is the shape of it and nothing more. The drives and folders below
   are a fixed list, the buttons that would write are disabled rather than
   silently doing nothing, and the status bar says "not connected" because it
   is not connected to anything.
   ============================================================ */

const $ = id => document.getElementById(id);

/* ---------------- the pretend filesystem ----------------
   Sizes and dates are here so the details panel has something to show; they
   are made up, and the interface says so. */
const ICON = {
  drive: '<path d="M4 5.6h16a1.4 1.4 0 0 1 1.4 1.4v4.2H2.6V7A1.4 1.4 0 0 1 4 5.6z" fill="currentColor" opacity=".22"/><path d="M2.6 11.2h18.8V17a1.4 1.4 0 0 1-1.4 1.4H4A1.4 1.4 0 0 1 2.6 17z" fill="currentColor" opacity=".5"/><circle cx="18" cy="14.8" r="1.1" fill="currentColor"/>',
  folder: '<path d="M3 6.8A1.8 1.8 0 0 1 4.8 5h4.4l2 2.6h8A1.8 1.8 0 0 1 21 9.4v8.8A1.8 1.8 0 0 1 19.2 20H4.8A1.8 1.8 0 0 1 3 18.2z" fill="currentColor" opacity=".28"/><path d="M3 9.6h18v8.6A1.8 1.8 0 0 1 19.2 20H4.8A1.8 1.8 0 0 1 3 18.2z" fill="currentColor" opacity=".55"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2.2" fill="currentColor" opacity=".28"/><circle cx="8.6" cy="10" r="1.7" fill="currentColor"/><path d="M4 17.4 9.4 12l3.4 3.2 3-2.6L20 17.4z" fill="currentColor" opacity=".75"/>',
  video: '<rect x="2.6" y="6" width="13" height="12" rx="2.2" fill="currentColor" opacity=".3"/><path d="m16 12 5.4-3.4v6.8z" fill="currentColor" opacity=".7"/><path d="m8 10 4 2-4 2z" fill="currentColor"/>',
  doc: '<path d="M6 3.4h7L18.6 9v11.2a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4V4.8A1.4 1.4 0 0 1 6 3.4z" fill="currentColor" opacity=".3"/><path d="M13 3.6V9h5.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7.6 12.4h8M7.6 15.4h8M7.6 18.2h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  code: '<rect x="3" y="4.6" width="18" height="14.8" rx="2.4" fill="currentColor" opacity=".26"/><path d="m9.4 9.4-2.8 2.6 2.8 2.6M14.6 9.4l2.8 2.6-2.8 2.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  audio: '<rect x="9" y="3.6" width="6" height="11" rx="3" fill="currentColor" opacity=".5"/><path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0M12 17.8V21M9 21h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};
const TINT = { photo: "var(--cat-image)", video: "var(--cat-video)", audio: "var(--cat-voice)",
  doc: "var(--cat-documents)", code: "var(--cat-code)", folder: "var(--cat-file)" };

const DRIVES = [
  { id: "d1", name: "My Drive 1", used: 62, size: "100 GB",
    folders: [
      { name: "My Photos", kind: "photo", items: 1284, size: "18.4 GB", when: "Today, 14:02" },
      { name: "My Videos", kind: "video", items: 96, size: "31.7 GB", when: "Yesterday" },
      { name: "My Documents", kind: "doc", items: 412, size: "1.2 GB", when: "12 Jul 2026" },
      { name: "My Code", kind: "code", items: 88, size: "340 MB", when: "3 Jul 2026" },
      { name: "My Recordings", kind: "audio", items: 37, size: "2.1 GB", when: "28 Jun 2026" },
      { name: "Shared with me", kind: "folder", items: 12, size: "620 MB", when: "20 Jun 2026" },
    ] },
  { id: "d2", name: "My Drive 2", used: 18, size: "1 TB",
    folders: [
      { name: "Archive 2025", kind: "folder", items: 3140, size: "142 GB", when: "1 Jan 2026" },
      { name: "Client work", kind: "folder", items: 208, size: "38 GB", when: "9 Feb 2026" },
      { name: "My Photos", kind: "photo", items: 640, size: "9.8 GB", when: "14 Mar 2026" },
    ] },
  { id: "d3", name: "My Drive 3", used: 4, size: "1 GB",
    folders: [
      { name: "Scratch", kind: "folder", items: 6, size: "44 MB", when: "Today, 09:31" },
    ] },
];

const App = { drive: "d1", path: [], sel: null, view: "grid" };
window.App = App;

const drive = () => DRIVES.find(d => d.id === App.drive) || DRIVES[0];
const svg = (d, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span class="dot"></span>${msg}`;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 320); }, 2600);
}
window.toast = toast;

/* ---------------- painting ---------------- */
function paintTree() {
  $("tree").innerHTML = DRIVES.map(d => `
    <button data-drive="${d.id}" class="${d.id === App.drive ? "on" : ""}">
      ${svg(ICON.drive, "ic")}<span>${d.name}</span></button>
    ${d.id === App.drive ? `<div class="sub">${d.folders.map(f =>
      `<button data-open="${f.name}">${svg(ICON[f.kind] || ICON.folder, "ic")}<span>${f.name}</span></button>`).join("")}</div>` : ""}
  `).join("");
  const d = drive();
  $("useBar").style.width = d.used + "%";
  $("useCap").textContent = `${d.used}% of ${d.size} — in the preview`;
  $("sbDrive").textContent = d.name;
}
function items() {
  // one level deep: a folder opens onto an empty one, which is the truth
  return App.path.length ? [] : drive().folders;
}
function paintGrid() {
  const list = items();
  $("grid").innerHTML = list.length
    ? list.map(f => `
      <button class="item${App.sel === f.name ? " on" : ""}" data-open="${f.name}" style="--tint:${TINT[f.kind] || TINT.folder}">
        <span class="fi">${svg(ICON[f.kind] || ICON.folder)}</span>
        <span class="nm">${f.name}</span>
        <span class="sz">${f.items} items · ${f.size}</span>
      </button>`).join("")
    : `<div style="grid-column:1/-1;padding:38px 10px;text-align:center;color:var(--t4);font-size:12.5px">
         This folder is empty — there is nowhere to put anything yet.</div>`;
  $("crumbCount").textContent = `${list.length} item${list.length === 1 ? "" : "s"}`;
  $("sbItems").textContent = list.length;
  $("crumbPath").innerHTML = `<b>My Storage</b><span class="sep">›</span>${drive().name}` +
    App.path.map(p => `<span class="sep">›</span>${p}`).join("");
}
function paintInfo() {
  const f = items().find(x => x.name === App.sel);
  $("pInfo").innerHTML = f ? `
    <div class="prev" style="color:${TINT[f.kind] || TINT.folder}">${svg(ICON[f.kind] || ICON.folder)}</div>
    <div class="kv"><span>Name</span><b>${f.name}</b></div>
    <div class="kv"><span>Items</span><b>${f.items}</b></div>
    <div class="kv"><span>Size</span><b>${f.size}</b></div>
    <div class="kv"><span>Modified</span><b>${f.when}</b></div>
    <div class="kv"><span>Drive</span><b>${drive().name}</b></div>
    <div class="note">These numbers are part of the preview. Nothing here is a
      real file, and nothing has been uploaded.</div>`
    : `<div class="note" style="padding:20px 6px;text-align:center">Select a folder to see what
       the panel will show.</div>`;
}
function paintAll() { paintTree(); paintGrid(); paintInfo(); }

/* ---------------- menus ---------------- */
const MENUS = {
  mFile: [["New folder", "newFolder", "", false], ["Upload files…", "upload", "", false],
    ["Download", "download", "", false], null, ["Tell me when it opens", "waitlist"]],
  mView: [["Icons", "viewGrid"], ["Details", "viewList"], null, ["Hide the panel", "panels"]],
  mDrive: [...DRIVES.map(d => [d.name, "drive:" + d.id]), null, ["Add a drive", "addDrive", "", false]],
};
function buildMenus() {
  for (const [id, list] of Object.entries(MENUS)) {
    $(id).innerHTML = list.map(it => it === null ? `<div class="msep"></div>`
      : `<button class="mi" data-act="${it[1]}"${it[3] === false ? ' aria-disabled="true"' : ""}>${it[0]}` +
        `${it[2] ? `<span class="sc">${it[2]}</span>` : ""}</button>`).join("");
  }
}

/* ---------------- actions ---------------- */
const ACT = {
  up: () => { if (App.path.length) { App.path.pop(); paintAll(); } },
  viewGrid: () => { App.view = "grid"; document.body.classList.remove("listview"); sync(); },
  viewList: () => { App.view = "list"; document.body.classList.add("listview"); sync(); },
  panels: () => document.body.classList.toggle("nopanels"),
  waitlist: () => toast("Nothing to sign up to yet — this is a preview of the design"),
  newFolder: () => toast("Not yet — storage is not open"),
  upload: () => toast("Not yet — storage is not open"),
  download: () => toast("Not yet — storage is not open"),
  addDrive: () => toast("Not yet — storage is not open"),
};
function sync() {
  $("vGrid").classList.toggle("on", App.view === "grid");
  $("vList").classList.toggle("on", App.view === "list");
  KilnSession?.save({ view: App.view, drive: App.drive });
}

document.addEventListener("click", e => {
  const d = e.target.closest("[data-drive]");
  if (d) { App.drive = d.dataset.drive; App.path = []; App.sel = null; paintAll(); sync(); return; }
  const open = e.target.closest("[data-open]");
  if (open) {
    const name = open.dataset.open;
    if (App.sel === name && !open.closest(".tree")) { App.path = [name]; App.sel = null; }
    else App.sel = name;
    paintAll();
    return;
  }
  const mi = e.target.closest(".mi");
  const btn = e.target.closest("[data-act]");
  if (btn) {
    const a = btn.dataset.act;
    if (a.startsWith("drive:")) { App.drive = a.slice(6); App.path = []; paintAll(); sync(); }
    else ACT[a]?.();
  }
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

/* ---------------- boot ---------------- */
const kept = KilnSession?.state || {};
if (kept.drive && DRIVES.some(d => d.id === kept.drive)) App.drive = kept.drive;
if (kept.view === "list") { App.view = "list"; document.body.classList.add("listview"); }
buildMenus();
paintAll();
sync();
window.Storage = { App, DRIVES, ACT, paintAll };
