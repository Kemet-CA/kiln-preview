/* ============================================================
   Kiln languages.

   Seven languages, and the machinery is deliberately small: a dictionary, a
   function that walks the page swapping marked-up text, and a picker. No build
   step, no bundle, no framework — the same rules as everything else here.

   How a string gets translated:

     <h2 data-i18n="grid.head">Your Workspaces</h2>

   The English stays in the HTML. It is the fallback, it is what a search
   engine and a screen reader get before any script runs, and it means a
   missing translation degrades to English rather than to an empty element.

   Attributes are marked separately, because a placeholder or a label is not
   the element's text:

     <input data-i18n-attr="placeholder:search.ph">

   Arabic sets the document to RTL. That is not a translation problem, it is a
   layout one, and it is why `dir` is set here rather than left to CSS.
   ============================================================ */
(function () {
  "use strict";

  /* Ordered by their English name, which is what someone scanning a Latin
     list expects — and each row also carries the name in its own script,
     because that is the one a speaker recognises fastest. */
  const LANGS = [
    { code: "ar", name: "Arabic",   own: "العربية",  dir: "rtl" },
    { code: "zh", name: "Chinese",  own: "中文",      dir: "ltr" },
    { code: "en", name: "English",  own: "English",  dir: "ltr" },
    { code: "fr", name: "French",   own: "Français", dir: "ltr" },
    { code: "de", name: "German",   own: "Deutsch",  dir: "ltr" },
    { code: "ja", name: "Japanese", own: "日本語",    dir: "ltr" },
    { code: "ko", name: "Korean",   own: "한국어",    dir: "ltr" },
  ];

  const KEY = "kiln-lang";
  const D = {};

  /* ---------------- the dictionary ----------------
     Product names are not translated: Kiln is Kiln, PDF is PDF, and Kemet
     Studio is a company. Everything a person reads as a sentence is. */

  D.en = {
    "hero.slogan": "Shape & Ship Anything.",
    "hero.q": "Why pay for a different subscription every month?",
    "f.photo": "Edit photos", "f.video": "Cut videos", "f.voice": "Record voice",
    "f.doc": "Write documents", "f.pdf": "Read and sign PDFs",
    "f.trans": "Translate anything", "f.code": "Write code",
    "f.all": "All here. All free.",
    "cta.explore": "Explore Workspaces", "cta.browse": "Browse all tools",
    "grid.head": "Your Workspaces", "grid.all": "View all tools",
    "card.image": "Photo Editor", "card.video": "Video Editor",
    "card.voice": "Voice Recorder and Editor", "card.color": "Colour Palette",
    "card.documents": "Writer and Editor", "card.pdf": "PDF Viewer and Editor",
    "card.translate": "Translator", "card.code": "Code Editor", "card.storage": "Storage",
    "card.ai": "AI",
    "tag.image": "Edit. Enhance. Create.", "tag.video": "Cut. Arrange. Export.",
    "tag.voice": "Record. Clean. Transform.", "tag.color": "Pick. Harmonise. Copy.",
    "tag.documents": "Write. Format. Export.", "tag.pdf": "Read. Edit. Convert.",
    "tag.translate": "Any language, on device.", "tag.code": "Write. Run. Learn.",
    "tag.storage": "Drives. Folders. Soon.", "tag.ai": "Smarter tools. Local.",
    "n.tools": "tools", "n.comingSoon": "Coming soon", "n.soon": "Soon",
    "stat.workspaces": "Workspaces", "stat.tools": "Tools",
    "stat.private": "Private", "stat.yours": "Always yours", "stat.local": "Local-first",
    "feat.privacy": "Privacy first", "feat.privacyD": "Your files stay yours. Always.",
    "feat.local": "Everything local", "feat.localD": "No cloud. No tracking. No account.",
    "feat.one": "One workspace", "feat.oneD": "Every tool, one place.",
    "feat.tab": "Open in a tab", "feat.tabD": "Nothing to install.",
    "foot.by": "Kiln by Kemet Studio",
    "lang.label": "Language",
  };

  D.ar = {
    "hero.slogan": "اصنع أي شيء وانشره.",
    "hero.q": "لماذا تدفع اشتراكًا مختلفًا كل شهر؟",
    "f.photo": "حرّر الصور", "f.video": "قصّ الفيديو", "f.voice": "سجّل صوتك",
    "f.doc": "اكتب المستندات", "f.pdf": "اقرأ ووقّع ملفات PDF",
    "f.trans": "ترجم أي شيء", "f.code": "اكتب الشيفرة",
    "f.all": "كل ذلك هنا. وبالمجان.",
    "cta.explore": "استكشف المساحات", "cta.browse": "تصفّح كل الأدوات",
    "grid.head": "مساحات عملك", "grid.all": "عرض كل الأدوات",
    "card.image": "محرّر الصور", "card.video": "محرّر الفيديو",
    "card.voice": "مسجّل ومحرّر الصوت", "card.color": "لوحة الألوان",
    "card.documents": "الكتابة والتحرير", "card.pdf": "عارض ومحرّر PDF",
    "card.translate": "المترجم", "card.code": "محرّر الشيفرة", "card.storage": "التخزين",
    "card.ai": "الذكاء الاصطناعي",
    "tag.image": "حرّر. حسّن. أبدع.", "tag.video": "قصّ. رتّب. صدّر.",
    "tag.voice": "سجّل. نقِّ. حوّل.", "tag.color": "اختر. ناسق. انسخ.",
    "tag.documents": "اكتب. نسّق. صدّر.", "tag.pdf": "اقرأ. حرّر. حوّل.",
    "tag.translate": "أي لغة، على جهازك.", "tag.code": "اكتب. شغّل. تعلّم.",
    "tag.storage": "أقراص. مجلدات. قريبًا.", "tag.ai": "أدوات أذكى. محليًا.",
    "n.tools": "أداة", "n.comingSoon": "قريبًا", "n.soon": "قريبًا",
    "stat.workspaces": "مساحات العمل", "stat.tools": "الأدوات",
    "stat.private": "خصوصية", "stat.yours": "ملكك دائمًا", "stat.local": "محلي أولًا",
    "feat.privacy": "الخصوصية أولًا", "feat.privacyD": "ملفاتك تبقى ملكك. دائمًا.",
    "feat.local": "كل شيء محلي", "feat.localD": "بلا سحابة. بلا تتبّع. بلا حساب.",
    "feat.one": "مساحة واحدة", "feat.oneD": "كل الأدوات في مكان واحد.",
    "feat.tab": "افتحه في تبويب", "feat.tabD": "لا شيء لتثبيته.",
    "foot.by": "Kiln من Kemet Studio",
    "lang.label": "اللغة",
  };

  D.zh = {
    "hero.slogan": "创作一切，随时发布。",
    "hero.q": "为什么每个月要为不同的订阅付费？",
    "f.photo": "编辑照片", "f.video": "剪辑视频", "f.voice": "录制声音",
    "f.doc": "撰写文档", "f.pdf": "阅读并签署 PDF",
    "f.trans": "翻译一切", "f.code": "编写代码",
    "f.all": "全在这里，全部免费。",
    "cta.explore": "浏览工作区", "cta.browse": "查看全部工具",
    "grid.head": "你的工作区", "grid.all": "查看全部工具",
    "card.image": "照片编辑器", "card.video": "视频编辑器",
    "card.voice": "录音与音频编辑", "card.color": "调色板",
    "card.documents": "文档编辑器", "card.pdf": "PDF 阅读与编辑",
    "card.translate": "翻译器", "card.code": "代码编辑器", "card.storage": "存储",
    "card.ai": "人工智能",
    "tag.image": "编辑。增强。创作。", "tag.video": "剪辑。编排。导出。",
    "tag.voice": "录制。降噪。变声。", "tag.color": "选取。搭配。复制。",
    "tag.documents": "撰写。排版。导出。", "tag.pdf": "阅读。编辑。转换。",
    "tag.translate": "任何语言，本机运行。", "tag.code": "编写。运行。学习。",
    "tag.storage": "驱动器。文件夹。敬请期待。", "tag.ai": "更聪明的工具，本地运行。",
    "n.tools": "个工具", "n.comingSoon": "敬请期待", "n.soon": "即将推出",
    "stat.workspaces": "工作区", "stat.tools": "工具",
    "stat.private": "私密", "stat.yours": "始终属于你", "stat.local": "本地优先",
    "feat.privacy": "隐私优先", "feat.privacyD": "你的文件始终属于你。",
    "feat.local": "全部本地运行", "feat.localD": "无云端。无追踪。无需账号。",
    "feat.one": "一个工作区", "feat.oneD": "所有工具，一处齐全。",
    "feat.tab": "打开即用", "feat.tabD": "无需安装。",
    "foot.by": "Kiln，由 Kemet Studio 出品",
    "lang.label": "语言",
  };

  D.fr = {
    "hero.slogan": "Créez et publiez tout.",
    "hero.q": "Pourquoi payer un abonnement différent chaque mois ?",
    "f.photo": "Retoucher des photos", "f.video": "Monter des vidéos", "f.voice": "Enregistrer la voix",
    "f.doc": "Rédiger des documents", "f.pdf": "Lire et signer des PDF",
    "f.trans": "Tout traduire", "f.code": "Écrire du code",
    "f.all": "Tout est ici. Et gratuit.",
    "cta.explore": "Explorer les espaces", "cta.browse": "Voir tous les outils",
    "grid.head": "Vos espaces de travail", "grid.all": "Voir tous les outils",
    "card.image": "Éditeur photo", "card.video": "Éditeur vidéo",
    "card.voice": "Enregistreur et éditeur audio", "card.color": "Palette de couleurs",
    "card.documents": "Traitement de texte", "card.pdf": "Lecteur et éditeur PDF",
    "card.translate": "Traducteur", "card.code": "Éditeur de code", "card.storage": "Stockage",
    "card.ai": "IA",
    "tag.image": "Retoucher. Sublimer. Créer.", "tag.video": "Couper. Monter. Exporter.",
    "tag.voice": "Enregistrer. Nettoyer. Transformer.", "tag.color": "Choisir. Harmoniser. Copier.",
    "tag.documents": "Rédiger. Mettre en forme. Exporter.", "tag.pdf": "Lire. Modifier. Convertir.",
    "tag.translate": "Toutes les langues, sur l'appareil.", "tag.code": "Écrire. Exécuter. Apprendre.",
    "tag.storage": "Disques. Dossiers. Bientôt.", "tag.ai": "Des outils plus malins. En local.",
    "n.tools": "outils", "n.comingSoon": "Bientôt disponible", "n.soon": "Bientôt",
    "stat.workspaces": "Espaces", "stat.tools": "Outils",
    "stat.private": "Privé", "stat.yours": "Toujours à vous", "stat.local": "Local d'abord",
    "feat.privacy": "La confidentialité d'abord", "feat.privacyD": "Vos fichiers restent les vôtres. Toujours.",
    "feat.local": "Tout en local", "feat.localD": "Pas de cloud. Pas de suivi. Pas de compte.",
    "feat.one": "Un seul espace", "feat.oneD": "Tous les outils au même endroit.",
    "feat.tab": "Ouvrir dans un onglet", "feat.tabD": "Rien à installer.",
    "foot.by": "Kiln par Kemet Studio",
    "lang.label": "Langue",
  };

  D.de = {
    "hero.slogan": "Alles gestalten und veröffentlichen.",
    "hero.q": "Warum jeden Monat für ein anderes Abo bezahlen?",
    "f.photo": "Fotos bearbeiten", "f.video": "Videos schneiden", "f.voice": "Stimme aufnehmen",
    "f.doc": "Dokumente schreiben", "f.pdf": "PDFs lesen und signieren",
    "f.trans": "Alles übersetzen", "f.code": "Code schreiben",
    "f.all": "Alles hier. Alles kostenlos.",
    "cta.explore": "Arbeitsbereiche ansehen", "cta.browse": "Alle Werkzeuge",
    "grid.head": "Deine Arbeitsbereiche", "grid.all": "Alle Werkzeuge ansehen",
    "card.image": "Fotoeditor", "card.video": "Videoeditor",
    "card.voice": "Rekorder und Audioeditor", "card.color": "Farbpalette",
    "card.documents": "Textverarbeitung", "card.pdf": "PDF-Betrachter und -Editor",
    "card.translate": "Übersetzer", "card.code": "Code-Editor", "card.storage": "Speicher",
    "card.ai": "KI",
    "tag.image": "Bearbeiten. Verbessern. Gestalten.", "tag.video": "Schneiden. Anordnen. Exportieren.",
    "tag.voice": "Aufnehmen. Säubern. Verwandeln.", "tag.color": "Wählen. Abstimmen. Kopieren.",
    "tag.documents": "Schreiben. Formatieren. Exportieren.", "tag.pdf": "Lesen. Bearbeiten. Umwandeln.",
    "tag.translate": "Jede Sprache, auf dem Gerät.", "tag.code": "Schreiben. Ausführen. Lernen.",
    "tag.storage": "Laufwerke. Ordner. Bald.", "tag.ai": "Klügere Werkzeuge. Lokal.",
    "n.tools": "Werkzeuge", "n.comingSoon": "Demnächst", "n.soon": "Bald",
    "stat.workspaces": "Arbeitsbereiche", "stat.tools": "Werkzeuge",
    "stat.private": "Privat", "stat.yours": "Immer deins", "stat.local": "Lokal zuerst",
    "feat.privacy": "Datenschutz zuerst", "feat.privacyD": "Deine Dateien bleiben deine. Immer.",
    "feat.local": "Alles lokal", "feat.localD": "Keine Cloud. Kein Tracking. Kein Konto.",
    "feat.one": "Ein Arbeitsbereich", "feat.oneD": "Jedes Werkzeug an einem Ort.",
    "feat.tab": "Im Tab öffnen", "feat.tabD": "Nichts zu installieren.",
    "foot.by": "Kiln von Kemet Studio",
    "lang.label": "Sprache",
  };

  D.ja = {
    "hero.slogan": "つくる、そして届ける。",
    "hero.q": "毎月ちがうサブスクに払う理由はありますか？",
    "f.photo": "写真を編集", "f.video": "動画を編集", "f.voice": "音声を録音",
    "f.doc": "文書を作成", "f.pdf": "PDF を読んで署名",
    "f.trans": "なんでも翻訳", "f.code": "コードを書く",
    "f.all": "すべてここに。すべて無料。",
    "cta.explore": "ワークスペースを見る", "cta.browse": "すべてのツール",
    "grid.head": "あなたのワークスペース", "grid.all": "すべてのツールを見る",
    "card.image": "写真エディター", "card.video": "動画エディター",
    "card.voice": "ボイスレコーダー＆エディター", "card.color": "カラーパレット",
    "card.documents": "文書エディター", "card.pdf": "PDF ビューアー＆エディター",
    "card.translate": "翻訳ツール", "card.code": "コードエディター", "card.storage": "ストレージ",
    "card.ai": "AI",
    "tag.image": "編集。補正。創造。", "tag.video": "カット。並べる。書き出す。",
    "tag.voice": "録音。ノイズ除去。加工。", "tag.color": "選ぶ。合わせる。コピー。",
    "tag.documents": "書く。整える。書き出す。", "tag.pdf": "読む。編集。変換。",
    "tag.translate": "どんな言語も、端末の中で。", "tag.code": "書く。動かす。学ぶ。",
    "tag.storage": "ドライブ。フォルダー。近日。", "tag.ai": "より賢いツールを、ローカルで。",
    "n.tools": "ツール", "n.comingSoon": "近日公開", "n.soon": "近日",
    "stat.workspaces": "ワークスペース", "stat.tools": "ツール",
    "stat.private": "プライベート", "stat.yours": "ずっとあなたのもの", "stat.local": "ローカル優先",
    "feat.privacy": "プライバシー第一", "feat.privacyD": "ファイルはずっとあなたのものです。",
    "feat.local": "すべてローカル", "feat.localD": "クラウドなし。追跡なし。アカウント不要。",
    "feat.one": "ひとつの作業場所", "feat.oneD": "すべての道具が一か所に。",
    "feat.tab": "タブで開くだけ", "feat.tabD": "インストール不要。",
    "foot.by": "Kiln — Kemet Studio",
    "lang.label": "言語",
  };

  D.ko = {
    "hero.slogan": "무엇이든 만들고 내보내세요.",
    "hero.q": "매달 다른 구독료를 낼 이유가 있을까요?",
    "f.photo": "사진 편집", "f.video": "영상 편집", "f.voice": "음성 녹음",
    "f.doc": "문서 작성", "f.pdf": "PDF 읽기와 서명",
    "f.trans": "무엇이든 번역", "f.code": "코드 작성",
    "f.all": "전부 여기에. 전부 무료로.",
    "cta.explore": "작업 공간 둘러보기", "cta.browse": "모든 도구 보기",
    "grid.head": "내 작업 공간", "grid.all": "모든 도구 보기",
    "card.image": "사진 편집기", "card.video": "영상 편집기",
    "card.voice": "음성 녹음·편집기", "card.color": "색상 팔레트",
    "card.documents": "문서 편집기", "card.pdf": "PDF 뷰어·편집기",
    "card.translate": "번역기", "card.code": "코드 편집기", "card.storage": "저장소",
    "card.ai": "AI",
    "tag.image": "편집. 보정. 창작.", "tag.video": "자르고. 배치하고. 내보내고.",
    "tag.voice": "녹음. 정리. 변조.", "tag.color": "고르고. 맞추고. 복사.",
    "tag.documents": "쓰고. 다듬고. 내보내고.", "tag.pdf": "읽고. 편집하고. 변환.",
    "tag.translate": "모든 언어를, 기기 안에서.", "tag.code": "쓰고. 실행하고. 배우고.",
    "tag.storage": "드라이브. 폴더. 준비 중.", "tag.ai": "더 똑똑한 도구, 로컬에서.",
    "n.tools": "개 도구", "n.comingSoon": "준비 중", "n.soon": "곧",
    "stat.workspaces": "작업 공간", "stat.tools": "도구",
    "stat.private": "비공개", "stat.yours": "언제나 당신의 것", "stat.local": "로컬 우선",
    "feat.privacy": "개인정보가 먼저", "feat.privacyD": "당신의 파일은 언제나 당신의 것입니다.",
    "feat.local": "모두 로컬에서", "feat.localD": "클라우드 없음. 추적 없음. 계정 없음.",
    "feat.one": "하나의 작업 공간", "feat.oneD": "모든 도구가 한곳에.",
    "feat.tab": "탭에서 바로", "feat.tabD": "설치할 것이 없습니다.",
    "foot.by": "Kiln — Kemet Studio",
    "lang.label": "언어",
  };

  /* ---------------- applying it ---------------- */
  const root = document.documentElement;
  let current = "en";

  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const remember = c => { try { localStorage.setItem(KEY, c); } catch {} };

  /* The browser's language if we speak it, English if we do not. Someone
     arriving in Seoul should not have to find the picker first. */
  function preferred() {
    const saved = stored();
    if (saved && D[saved]) return saved;
    for (const tag of navigator.languages || [navigator.language || "en"]) {
      const code = String(tag).toLowerCase().split("-")[0];
      if (D[code]) return code;
    }
    return "en";
  }

  const t = (key, lang = current) => D[lang]?.[key] ?? D.en[key] ?? "";

  function apply(code) {
    if (!D[code]) code = "en";
    current = code;
    const lang = LANGS.find(l => l.code === code);
    root.setAttribute("lang", code);
    root.setAttribute("dir", lang.dir);
    /* Deliberately NOT data-kiln-lang: that attribute marks where the picker
       mounts, and setting it on <html> made the picker mount into the document
       element and replace the entire page with itself. The `lang` attribute is
       the state; one name, one job. */
    root.dataset.kilnLangActive = code;

    for (const el of document.querySelectorAll("[data-i18n]")) {
      const key = el.dataset.i18n;
      const val = t(key);
      if (val) el.textContent = val;
    }
    for (const el of document.querySelectorAll("[data-i18n-attr]")) {
      for (const pair of el.dataset.i18nAttr.split(",")) {
        const [attr, key] = pair.split(":").map(s => s.trim());
        const val = t(key);
        if (attr && val) el.setAttribute(attr, val);
      }
    }
    remember(code);
    dispatchEvent(new CustomEvent("kiln-lang", { detail: { lang: code, dir: lang.dir } }));
  }

  /* ---------------- the picker ---------------- */
  function mount(host) {
    // never the document itself, whatever a stray attribute might say
    if (!host || host === root || host === document.body || host.dataset.ready) return;
    host.dataset.ready = "1";
    host.innerHTML =
      `<button class="klang-b" id="klangB" aria-haspopup="listbox" aria-expanded="false">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round"><circle cx="12" cy="12" r="9"/>
           <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></svg>
         <b id="klangNow"></b></button>
       <div class="klang-m" id="klangM" role="listbox" hidden>${LANGS.map(l =>
         `<button class="klang-i" role="option" data-lang="${l.code}">
            <span>${l.name}</span><i>${l.own}</i></button>`).join("")}</div>`;
    const btn = host.querySelector("#klangB"), menu = host.querySelector("#klangM");
    const sync = () => {
      const l = LANGS.find(x => x.code === current);
      host.querySelector("#klangNow").textContent = l.code.toUpperCase();
      btn.title = t("lang.label") + " — " + l.name;
      btn.setAttribute("aria-label", t("lang.label"));
      host.querySelectorAll(".klang-i").forEach(i =>
        i.setAttribute("aria-selected", i.dataset.lang === current ? "true" : "false"));
    };
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });
    host.addEventListener("click", e => {
      const pick = e.target.closest("[data-lang]");
      if (!pick) return;
      apply(pick.dataset.lang);
      sync();
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    });
    addEventListener("click", () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); });
    addEventListener("kiln-lang", sync);
    sync();
  }

  function boot() {
    apply(preferred());
    document.querySelectorAll("[data-kiln-lang]").forEach(mount);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.KilnLang = { LANGS, apply, t, get current() { return current; }, mount, dict: D };
})();
