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

   The layout does not turn around for Arabic. Mirroring the whole page is the
   textbook answer and it was what this did, but it moves every control a
   person had already learned the position of, and the ask here was for the
   site to be translated rather than rearranged. The document stays left to
   right; Arabic text still runs right to left inside it, because that is the
   browser's bidi algorithm doing its job and not a layout decision. Panes that
   hold translated text — the translator's own two boxes — set their own `dir`,
   which is the right place for it: that is content, not chrome.
   ============================================================ */
(function () {
  "use strict";

  /* Ordered by their English name, which is what someone scanning a Latin
     list expects — and each row also carries the name in its own script,
     because that is the one a speaker recognises fastest. */
  const LANGS = [
    { code: "ar", name: "Arabic",   own: "العربية" },
    { code: "zh", name: "Chinese",  own: "中文" },
    { code: "en", name: "English",  own: "English" },
    { code: "fr", name: "French",   own: "Français" },
    { code: "de", name: "German",   own: "Deutsch" },
    { code: "ja", name: "Japanese", own: "日本語" },
    { code: "ko", name: "Korean",   own: "한국어" },
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
    "proj.save": "Save",
    "proj.saving": "Saving…",
    "proj.new": "New project",
    "proj.open": "Open project…",
    "proj.saveas": "Save as…",
    "proj.recent": "Recent projects",
    "proj.auto": "Auto save",
    "proj.off": "Off",
    "proj.every": "Every",
    "proj.min": "min",
    "proj.download": "Save a copy to disk…",
    "proj.fromdisk": "Open from disk…",
    "proj.none": "Nothing saved yet.",
    "proj.delq": "Delete this project?",
    "proj.dropq": "There are unsaved changes. Start a new project anyway?",
    "ui.searchAll": "Search all tools",
    "ui.searchApp": "Search {app} tools",
    "ui.searchIn": "Search in {app} tools…",
    "ui.noMatches": "No matches",
    "ui.mode": "Light / dark",
    "ui.theme": "Theme",
    "ui.coffee": "Buy us a coffee",
    "ui.open": "Open",
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
    "proj.save": "حفظ",
    "proj.saving": "جارٍ الحفظ…",
    "proj.new": "مشروع جديد",
    "proj.open": "فتح مشروع…",
    "proj.saveas": "حفظ باسم…",
    "proj.recent": "المشاريع الأخيرة",
    "proj.auto": "حفظ تلقائي",
    "proj.off": "إيقاف",
    "proj.every": "كل",
    "proj.min": "دقيقة",
    "proj.download": "حفظ نسخة على الجهاز…",
    "proj.fromdisk": "فتح من الجهاز…",
    "proj.none": "لا يوجد شيء محفوظ بعد.",
    "proj.delq": "حذف هذا المشروع؟",
    "proj.dropq": "هناك تغييرات غير محفوظة. هل تبدأ مشروعًا جديدًا؟",
    "ui.searchAll": "ابحث في كل الأدوات",
    "ui.searchApp": "ابحث في أدوات {app}",
    "ui.searchIn": "ابحث في أدوات {app}…",
    "ui.noMatches": "لا نتائج",
    "ui.mode": "فاتح / داكن",
    "ui.theme": "السمة",
    "ui.coffee": "ادعمنا بقهوة",
    "ui.open": "افتح",
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
    "proj.save": "保存",
    "proj.saving": "保存中…",
    "proj.new": "新建项目",
    "proj.open": "打开项目…",
    "proj.saveas": "另存为…",
    "proj.recent": "最近的项目",
    "proj.auto": "自动保存",
    "proj.off": "关闭",
    "proj.every": "每",
    "proj.min": "分钟",
    "proj.download": "保存副本到磁盘…",
    "proj.fromdisk": "从磁盘打开…",
    "proj.none": "尚未保存任何内容。",
    "proj.delq": "删除这个项目？",
    "proj.dropq": "有未保存的更改。仍要新建项目吗？",
    "ui.searchAll": "搜索全部工具",
    "ui.searchApp": "搜索 {app} 工具",
    "ui.searchIn": "在 {app} 工具中搜索…",
    "ui.noMatches": "无匹配结果",
    "ui.mode": "浅色 / 深色",
    "ui.theme": "主题",
    "ui.coffee": "请我们喝杯咖啡",
    "ui.open": "打开",
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
    "proj.save": "Enregistrer",
    "proj.saving": "Enregistrement…",
    "proj.new": "Nouveau projet",
    "proj.open": "Ouvrir un projet…",
    "proj.saveas": "Enregistrer sous…",
    "proj.recent": "Projets récents",
    "proj.auto": "Enregistrement auto",
    "proj.off": "Désactivé",
    "proj.every": "Toutes les",
    "proj.min": "min",
    "proj.download": "Enregistrer une copie sur le disque…",
    "proj.fromdisk": "Ouvrir depuis le disque…",
    "proj.none": "Rien d’enregistré pour l’instant.",
    "proj.delq": "Supprimer ce projet ?",
    "proj.dropq": "Des modifications ne sont pas enregistrées. Créer un nouveau projet ?",
    "ui.searchAll": "Rechercher dans tous les outils",
    "ui.searchApp": "Rechercher les outils {app}",
    "ui.searchIn": "Rechercher dans {app}…",
    "ui.noMatches": "Aucun résultat",
    "ui.mode": "Clair / sombre",
    "ui.theme": "Thème",
    "ui.coffee": "Offrez-nous un café",
    "ui.open": "Ouvrir",
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
    "proj.save": "Speichern",
    "proj.saving": "Wird gespeichert…",
    "proj.new": "Neues Projekt",
    "proj.open": "Projekt öffnen…",
    "proj.saveas": "Speichern unter…",
    "proj.recent": "Zuletzt verwendet",
    "proj.auto": "Automatisch speichern",
    "proj.off": "Aus",
    "proj.every": "Alle",
    "proj.min": "Min.",
    "proj.download": "Kopie auf der Festplatte speichern…",
    "proj.fromdisk": "Von der Festplatte öffnen…",
    "proj.none": "Noch nichts gespeichert.",
    "proj.delq": "Dieses Projekt löschen?",
    "proj.dropq": "Es gibt ungespeicherte Änderungen. Trotzdem ein neues Projekt?",
    "ui.searchAll": "Alle Werkzeuge durchsuchen",
    "ui.searchApp": "{app}-Werkzeuge durchsuchen",
    "ui.searchIn": "In {app} suchen…",
    "ui.noMatches": "Keine Treffer",
    "ui.mode": "Hell / dunkel",
    "ui.theme": "Design",
    "ui.coffee": "Spendier uns einen Kaffee",
    "ui.open": "Öffnen",
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
    "proj.save": "保存",
    "proj.saving": "保存中…",
    "proj.new": "新規プロジェクト",
    "proj.open": "プロジェクトを開く…",
    "proj.saveas": "名前を付けて保存…",
    "proj.recent": "最近のプロジェクト",
    "proj.auto": "自動保存",
    "proj.off": "オフ",
    "proj.every": "毎",
    "proj.min": "分",
    "proj.download": "コピーをディスクに保存…",
    "proj.fromdisk": "ディスクから開く…",
    "proj.none": "まだ何も保存されていません。",
    "proj.delq": "このプロジェクトを削除しますか？",
    "proj.dropq": "保存されていない変更があります。新規プロジェクトを開始しますか？",
    "ui.searchAll": "すべてのツールを検索",
    "ui.searchApp": "{app} のツールを検索",
    "ui.searchIn": "{app} 内を検索…",
    "ui.noMatches": "一致なし",
    "ui.mode": "ライト / ダーク",
    "ui.theme": "テーマ",
    "ui.coffee": "コーヒーを贈る",
    "ui.open": "開く",
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
    "proj.save": "저장",
    "proj.saving": "저장 중…",
    "proj.new": "새 프로젝트",
    "proj.open": "프로젝트 열기…",
    "proj.saveas": "다른 이름으로 저장…",
    "proj.recent": "최근 프로젝트",
    "proj.auto": "자동 저장",
    "proj.off": "끄기",
    "proj.every": "매",
    "proj.min": "분",
    "proj.download": "사본을 디스크에 저장…",
    "proj.fromdisk": "디스크에서 열기…",
    "proj.none": "아직 저장된 항목이 없습니다.",
    "proj.delq": "이 프로젝트를 삭제할까요?",
    "proj.dropq": "저장하지 않은 변경 사항이 있습니다. 새 프로젝트를 시작할까요?",
    "ui.searchAll": "모든 도구 검색",
    "ui.searchApp": "{app} 도구 검색",
    "ui.searchIn": "{app} 도구에서 검색…",
    "ui.noMatches": "결과 없음",
    "ui.mode": "라이트 / 다크",
    "ui.theme": "테마",
    "ui.coffee": "커피 한 잔 후원하기",
    "ui.open": "열기",
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
    root.setAttribute("dir", "ltr");            // deliberately not mirrored — see the note above
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
    dispatchEvent(new CustomEvent("kiln-lang", { detail: { lang: code } }));
  }

  /* ---------------- the picker ---------------- */
  function mount(host) {
    // never the document itself, whatever a stray attribute might say
    if (!host || host === root || host === document.body || host.dataset.ready) return;
    host.dataset.ready = "1";
    /* It borrows .ktb-btn from the theme package rather than inventing a look
       of its own: it sits between the theme and mode buttons, and a control
       that is nearly the same as its neighbours is worse than one that is
       exactly the same. The code underneath is the label — two letters say
       which language is on without opening anything. */
    host.innerHTML =
      `<button class="ktb-btn klang-b" id="klangB" aria-haspopup="listbox" aria-expanded="false">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
              stroke-linecap="round" stroke-linejoin="round">
           <circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/>
           <path d="M12 3.6a13 13 0 0 1 0 16.8a13 13 0 0 1 0-16.8"/></svg>
         <b class="klang-code" id="klangNow"></b></button>
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

  /* The picker's own rules, injected once. They live here rather than in each
     page's stylesheet because a shared control with per-page styling is a
     control that looks different on every page. */
  function styles() {
    if (document.getElementById("kiln-lang-css")) return;
    const el = document.createElement("style");
    el.id = "kiln-lang-css";
    el.textContent = `
.klang{position:relative;display:inline-flex}
.klang-b{position:relative;width:auto;min-width:28px;padding:0 6px;gap:4px;display:inline-flex;
  align-items:center;justify-content:center}
.klang-b .klang-code{font-size:9px;font-weight:700;letter-spacing:.06em;line-height:1}
.klang-m{position:absolute;z-index:80;top:calc(100% + 6px);inset-inline-end:0;min-width:176px;
  background:var(--s1);border:var(--bw,1px) solid var(--line2);border-radius:11px;padding:5px;
  box-shadow:0 22px 50px -18px rgba(0,0,0,.5)}
.klang-m[hidden]{display:none}
.klang-i{display:flex;width:100%;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;
  font-size:12.5px;color:var(--t1);text-align:start;background:none;border:0;cursor:pointer}
.klang-i i{font-style:normal;color:var(--t3);font-size:11.5px;margin-inline-start:auto}
.klang-i:hover{background:var(--hov2)}
.klang-i[aria-selected="true"]{color:var(--brand-ink);background:var(--brand-soft)}`;
    document.head.appendChild(el);
  }

  function boot() {
    styles();
    apply(preferred());
    document.querySelectorAll("[data-kiln-lang]").forEach(mount);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.KilnLang = { LANGS, apply, t, get current() { return current; }, mount, dict: D };
})();
