/* ============================================================
   Kiln Code — the highlighter.

   No DOM, no editor: text in, HTML out, so every language can be checked by a
   test rather than squinted at.

   One tokenizer, driven by a table per language. It walks the source once and
   emits spans; the rules are ordered, and the first that matches at the cursor
   wins. That is enough for the thing this is for — reading and learning code —
   without dragging in a parser for every grammar.

   What it does not do: understand the code. It will highlight a keyword inside
   a template literal's expression as a keyword, and it does not know types.
   A real language server is a different project.
   ============================================================ */

export const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const WORD = /^[A-Za-z_$][\w$]*/;

/* Shared pieces, so a language table stays short */
const C_LINE = { k: "comment", re: /^\/\/[^\n]*/ };
const C_BLOCK = { k: "comment", re: /^\/\*[\s\S]*?(\*\/|$)/ };
const HASH = { k: "comment", re: /^#[^\n]*/ };
const DQ = { k: "string", re: /^"(\\.|[^"\\])*"?/ };
const SQ = { k: "string", re: /^'(\\.|[^'\\])*'?/ };
const TICK = { k: "string", re: /^`(\\.|[^`\\])*`?/ };
const NUM = { k: "number", re: /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?[\d_]*([eE][+-]?\d+)?)[a-zA-Z]*/ };
const OP = { k: "op", re: /^[+\-*/%=<>!&|^~?:;,.()[\]{}@]/ };

const kw = list => new Set(list.split(" "));

export const LANGS = {
  javascript: {
    name: "JavaScript", ext: "js", comment: "//",
    keywords: kw("await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of return set static super switch this throw try typeof var void while with yield async"),
    atoms: kw("true false null undefined NaN Infinity globalThis"),
    types: kw("Array Boolean Date Error JSON Map Math Number Object Promise RegExp Set String Symbol WeakMap console document window"),
    rules: [C_LINE, C_BLOCK, TICK, DQ, SQ, { k: "regex", re: /^\/(?![/*])(\\.|\[(\\.|[^\]])*\]|[^/\\\n])+\/[gimsuy]*/ }, NUM, OP],
  },
  typescript: { extends: "javascript", name: "TypeScript", ext: "ts",
    extraKeywords: "type namespace declare readonly abstract enum public private protected as satisfies keyof infer",
    extraTypes: "string number boolean unknown never any void object bigint symbol Record Partial Pick Omit" },
  json: {
    name: "JSON", ext: "json", comment: "",
    keywords: kw(""), atoms: kw("true false null"), types: kw(""),
    rules: [{ k: "key", re: /^"(\\.|[^"\\])*"(?=\s*:)/ }, DQ, NUM, OP],
  },
  python: {
    name: "Python", ext: "py", comment: "#",
    keywords: kw("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
    atoms: kw("True False None self cls"),
    types: kw("int float str bool list dict set tuple bytes object range len print open enumerate zip map filter"),
    rules: [HASH, { k: "string", re: /^(f|r|b|rb|br)?("""[\s\S]*?"""|'''[\s\S]*?'''|"(\\.|[^"\\])*"?|'(\\.|[^'\\])*'?)/ }, NUM, OP],
  },
  html: {
    name: "HTML", ext: "html", comment: "<!--", markup: true,
    keywords: kw(""), atoms: kw(""), types: kw(""),
    rules: [
      { k: "comment", re: /^<!--[\s\S]*?(-->|$)/ },
      { k: "doctype", re: /^<!DOCTYPE[^>]*>/i },
      { k: "tag", re: /^<\/?[A-Za-z][\w:-]*/ },
      { k: "attr", re: /^[A-Za-z_:][\w:.-]*(?==)/ },
      { k: "string", re: /^"(\\.|[^"\\])*"|^'(\\.|[^'\\])*'/ },
      { k: "op", re: /^[<>/=]/ },
    ],
  },
  css: {
    name: "CSS", ext: "css", comment: "/*",
    keywords: kw("import media supports keyframes font-face charset namespace layer container"),
    atoms: kw("inherit initial unset none auto"), types: kw(""),
    rules: [
      C_BLOCK,
      { k: "atrule", re: /^@[\w-]+/ },
      // the colour comes before the selector, or #E2622A reads as an id
      { k: "number", re: /^#[0-9a-fA-F]{3,8}\b|^\d*\.?\d+(px|em|rem|%|vh|vw|s|ms|deg|fr|ch|pt)?/ },
      { k: "selector", re: /^[.#][A-Za-z_][\w-]*/ },
      { k: "attr", re: /^--[\w-]+|^[a-z-]+(?=\s*:)/ },
      DQ, SQ,
      OP,
    ],
  },
  sql: {
    name: "SQL", ext: "sql", comment: "--", ci: true,
    keywords: kw("select from where insert into values update set delete create table alter drop index view join inner left right outer on group by order having limit offset union all distinct as and or not null is in between like exists case when then else end primary key foreign references default constraint unique check begin commit rollback with returning"),
    atoms: kw("true false null"),
    types: kw("int integer bigint smallint text varchar char boolean date timestamp time numeric decimal real double serial uuid json jsonb blob"),
    rules: [{ k: "comment", re: /^--[^\n]*/ }, C_BLOCK, SQ, DQ, NUM, OP],
  },
  bash: {
    name: "Shell", ext: "sh", comment: "#",
    keywords: kw("if then else elif fi for while do done case esac in function return exit local export source alias set unset trap shift read"),
    atoms: kw("true false"),
    types: kw("echo cd ls cat grep sed awk find cp mv rm mkdir chmod curl git node npm pnpm python docker"),
    rules: [HASH, DQ, SQ, { k: "var", re: /^\$\{?[\w@#?*!-]+\}?/ }, NUM, OP],
  },
  go: {
    name: "Go", ext: "go", comment: "//",
    keywords: kw("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    atoms: kw("true false nil iota"),
    types: kw("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uintptr make new len cap append copy delete panic recover print println"),
    rules: [C_LINE, C_BLOCK, TICK, DQ, SQ, NUM, OP],
  },
  rust: {
    name: "Rust", ext: "rs", comment: "//",
    keywords: kw("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
    atoms: kw("true false None Some Ok Err"),
    types: kw("bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option Result Box Rc Arc HashMap"),
    rules: [C_LINE, C_BLOCK, DQ, SQ, { k: "macro", re: /^[a-z_]\w*!/ }, NUM, OP],
  },
  java: {
    name: "Java", ext: "java", comment: "//",
    keywords: kw("abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed"),
    atoms: kw("true false null"),
    types: kw("boolean byte char double float int long short void String Integer Double Boolean List Map Set Object System"),
    rules: [C_LINE, C_BLOCK, DQ, SQ, NUM, OP],
  },
  c: {
    name: "C / C++", ext: "c", comment: "//",
    keywords: kw("auto break case class const constexpr continue default delete do else enum extern for friend goto if inline namespace new operator private protected public register return sizeof static struct switch template this throw try typedef typename union using virtual volatile while"),
    atoms: kw("true false NULL nullptr"),
    types: kw("bool char double float int long short signed unsigned void size_t string vector map set auto uint8_t int32_t FILE"),
    rules: [C_LINE, C_BLOCK, { k: "macro", re: /^#\s*\w+/ }, DQ, SQ, NUM, OP],
  },
  php: {
    name: "PHP", ext: "php", comment: "//",
    keywords: kw("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield"),
    atoms: kw("true false null this"),
    types: kw("int float string bool array object mixed void never self parent"),
    rules: [C_LINE, HASH, C_BLOCK, DQ, SQ, { k: "var", re: /^\$\w+/ }, NUM, OP],
  },
  ruby: {
    name: "Ruby", ext: "rb", comment: "#",
    keywords: kw("alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield attr_accessor attr_reader require require_relative"),
    atoms: kw("true false nil"),
    types: kw("Array Hash String Integer Float Symbol Struct Comparable Enumerable puts print p lambda proc"),
    rules: [HASH, DQ, SQ, { k: "var", re: /^[@$][\w@]+/ }, { k: "atom", re: /^:[A-Za-z_]\w*/ }, NUM, OP],
  },
  markdown: {
    name: "Markdown", ext: "md", comment: "", markup: true,
    keywords: kw(""), atoms: kw(""), types: kw(""),
    rules: [
      { k: "heading", re: /^#{1,6}[^\n]*/ },
      { k: "string", re: /^```[\s\S]*?(```|$)|^`[^`\n]*`?/ },
      { k: "keyword", re: /^(\*\*|__)(?!\s)[\s\S]*?\1/ },
      { k: "attr", re: /^\[[^\]\n]*\]\([^)\n]*\)/ },
      { k: "op", re: /^^[>*+-]\s|^\d+\.\s/m },
    ],
  },
  yaml: {
    name: "YAML", ext: "yml", comment: "#",
    keywords: kw(""), atoms: kw("true false null yes no on off"), types: kw(""),
    rules: [HASH, { k: "attr", re: /^[A-Za-z_][\w.-]*(?=\s*:)/ }, DQ, SQ,
      { k: "op", re: /^[-:>|]/ }, NUM],
  },
  xml: { extends: "html", name: "XML", ext: "xml" },
  plain: { name: "Plain text", ext: "txt", comment: "", keywords: kw(""), atoms: kw(""), types: kw(""), rules: [] },
};

/* resolve `extends` once, at load */
for (const [id, l] of Object.entries(LANGS)) {
  if (!l.extends) continue;
  const base = LANGS[l.extends];
  LANGS[id] = {
    ...base, ...l,
    keywords: new Set([...base.keywords, ...(l.extraKeywords || "").split(" ").filter(Boolean)]),
    types: new Set([...base.types, ...(l.extraTypes || "").split(" ").filter(Boolean)]),
  };
}

export const languageList = () =>
  Object.entries(LANGS).map(([id, l]) => ({ id, name: l.name, ext: l.ext }))
    .sort((a, b) => a.name.localeCompare(b.name));

export function detectLanguage(filename = "") {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const map = { js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", py: "python", html: "html", htm: "html",
    css: "css", scss: "css", sql: "sql", sh: "bash", bash: "bash", zsh: "bash", go: "go",
    rs: "rust", java: "java", c: "c", h: "c", cpp: "c", cc: "c", hpp: "c", cs: "java",
    php: "php", rb: "ruby", md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml",
    xml: "xml", svg: "xml", txt: "plain" };
  return map[ext] || "plain";
}

/* ---------------- the tokenizer ----------------
   Returns [{k, text}] so a test can assert on the tokens themselves rather
   than on a string of HTML. */
export function tokenize(src, langId = "plain") {
  const lang = LANGS[langId] || LANGS.plain;
  const out = [];
  let i = 0;
  const push = (k, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.k === k) last.text += text;      // keep the run count down
    else out.push({ k, text });
  };
  while (i < src.length) {
    const rest = src.slice(i);
    // whitespace is plain, and skipping it in bulk keeps this fast
    const ws = /^\s+/.exec(rest);
    if (ws) { push("", ws[0]); i += ws[0].length; continue; }

    let matched = false;
    for (const rule of lang.rules) {
      const m = rule.re.exec(rest);
      if (m && m[0]) { push(rule.k, m[0]); i += m[0].length; matched = true; break; }
    }
    if (matched) continue;

    const w = WORD.exec(rest);
    if (w) {
      const word = w[0];
      const probe = lang.ci ? word.toLowerCase() : word;
      const k = lang.keywords.has(probe) ? "keyword"
        : lang.atoms.has(probe) ? "atom"
        : lang.types.has(probe) ? "type"
        : /^[A-Z]/.test(word) ? "type"
        : /^\s*\(/.test(src.slice(i + word.length)) ? "fn"
        : "";
      push(k, word);
      i += word.length;
      continue;
    }
    push("", src[i]);
    i++;
  }
  return out;
}

export function highlight(src, langId) {
  return tokenize(src, langId)
    .map(t => t.k ? `<span class="t-${t.k}">${esc(t.text)}</span>` : esc(t.text))
    .join("");
}

/* ---------------- shaping ----------------
   Not a formatter for every language — an honest one for the two where the
   rules are unambiguous, and indentation repair for the rest. */
export function format(src, langId) {
  if (langId === "json") return JSON.stringify(JSON.parse(src), null, 2);
  const unit = langId === "python" || langId === "yaml" ? 4 : 2;
  const lines = src.replace(/\t/g, " ".repeat(unit)).split("\n");
  if (langId === "python" || langId === "yaml" || langId === "markdown") return lines.join("\n");
  let depth = 0;
  return lines.map(raw => {
    const line = raw.trim();
    if (!line) return "";
    const opens = (line.match(/[{[(]/g) || []).length;
    const closes = (line.match(/[}\])]/g) || []).length;
    const starts = /^[}\])]/.test(line);
    if (starts) depth = Math.max(0, depth - 1);
    const out = " ".repeat(depth * unit) + line;
    depth += Math.max(0, opens - closes - (starts ? 0 : 0)) - (starts ? 0 : Math.max(0, closes - opens));
    if (depth < 0) depth = 0;
    return out;
  }).join("\n");
}
