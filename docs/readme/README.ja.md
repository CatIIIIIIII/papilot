<div align="center">

<img src="../assets/wordmark.svg#gh-light-mode-only" width="220" height="69" alt="Papilot"><img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="220" height="69" alt="Papilot"><br>**次世代 AI LaTeX エディタ**

# `.tex` の読み書きは不要<br><img src="../assets/pdf.svg" width="34" height="41" align="absmiddle" alt="PDF"> 上で直接作業

AI を用いた責任ある執筆と組版のための**新しいパラダイム**。

<picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/apple-dark.svg"><img src="../assets/readme-icons/apple.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;macOS (Apple&nbsp;Silicon&nbsp;/&nbsp;Intel)<br>および <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/linux-dark.svg"><img src="../assets/readme-icons/linux.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;Linux (AppImage / <img src="../assets/readme-icons/ubuntu.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Ubuntu / <img src="../assets/readme-icons/debian.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Debian / <img src="../assets/readme-icons/nixos.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;NixOS) 向けに **[Papilot をダウンロード](https://github.com/PapilotAI/papilot/releases/latest)**、<br>または `npm install -g papilot` を実行してください。

<a href="https://papilot.ai">
<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/hero-compact-dark.png">
  <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/hero-dark.png">
  <source media="(max-width: 600px)" srcset="../assets/readme-showcase/hero-compact.png">
  <img src="../assets/readme-showcase/hero.png" alt="Papilot は AI による編集を組版済みの変更前後として PDF 上に表示し、承認・却下・コメントを行えます。" width="900">
</picture>
</a>

</div>

<a id="-you-care-about-the-pdfbrnot-the-tex-behind-it"></a>

## 📄 重要なのは PDF であり<br>裏側の `.tex` ではありません

論文、学位論文、書籍、スライド——読者が目にするのは組版されたページだけです。<br>
**だからこそ、作業もそのページ上で行うべきです。**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/paradigm-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact.png">
    <img src="../assets/readme-showcase/paradigm.png" alt="手書きの LaTeX、AI による LaTeX 差分の確認、そして Papilot による PDF のレビューへ。" width="900">
  </picture>
</p>

**頭の中で差分をコンパイルする必要はもうありません。**<br>
ソースの差分では PDF を*想像*するしかありませんが、Papilot は組版された状態でそれを*表示*します。

<a id="-point-at-the-page-and-say-what-you-want"></a>

## 👉 ページを指して指示するだけ

文、数式、または図を選択して、注釈を書き込むだけ。<br>
**エージェントが該当するソースを見つけます。`.tex` ファイルを開く必要は一切ありません。**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/notes-app-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact.png">
    <img src="../assets/readme-showcase/notes-app.png" alt="PDF 上の数式を囲む枠とハイライトされた文にそれぞれ注釈が付けられ、次のタスクに追加されている Papilot の画面。" width="900">
  </picture>
</p>

<a id="features"></a>

<a id="-your-files-stay-yours"></a>

## 🔒 ファイルは常にあなたの手元に

<img src="../assets/readme-icons/folder.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**ローカルマシン上のプレーンファイル。** すべての変更は Git の履歴に記録されます。

<img src="../assets/readme-icons/git.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Git を介して共著者と同期。** プルやプッシュを行い、コンフリクトの解決はエージェントに任せられます。

<img src="../assets/readme-icons/code.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**無料かつオープンソース。** MIT ライセンスで提供され、macOS と Linux に対応しています。

<a id="agents"></a>

<a id="-bring-the-ai-agent-you-already-use"></a>

## 🤖 普段使っている AI エージェントをそのまま利用

<!-- BEGIN AGENT ICONS -->
<p align="center">
  <a href="../guide.md#agents">
    <picture>
      <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-agents/compact-dark.svg">
      <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-agents/desktop-dark.svg">
      <source media="(max-width: 600px)" srcset="../assets/readme-agents/compact.svg">
      <img src="../assets/readme-agents/desktop.svg" alt="Codex, Claude, Cursor, Copilot, Grok, Antigravity, Kimi, GLM, DeepSeek, Qwen, OpenCode" width="816">
    </picture>
  </a>
</p>
<!-- END AGENT ICONS -->

<a id="quick-start"></a>

<a id="-get-started"></a>

## 🚀 はじめに

1. **インストール。** macOS または Linux 向けの[アプリをダウンロード](https://github.com/PapilotAI/papilot/releases/latest)するか、`npm install -g papilot`（Node.js 22.22 以降）を実行します。また、Git と TeX Live または MacTeX が必要です。
2. **プロジェクトを開く。** `.tex` ファイルが含まれるフォルダを選択すると、Papilot が PDF をビルドします。
3. **エージェントを選択。** 既存の CLI ログインまたは API キーを使用し、ページに注釈を付けます。

まずはサンプルを試したいですか？ `papilot demo` を実行してください。詳細は[ガイド](../guide.md#install-and-run)を参照してください。

<a id="documentation-and-community"></a>

<a id="-community"></a>

## 🤝 コミュニティ

<img src="../assets/readme-icons/issue.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**バグの発見や機能の要望がありますか？** 簡単な内容でも構いませんので、[Issue を作成](https://github.com/PapilotAI/papilot/issues/new/choose)してください。

<img src="../assets/readme-icons/discussion.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**質問やアイデアがありますか？** [Discussion を開始](https://github.com/PapilotAI/papilot/discussions)してください。

<img src="../assets/readme-icons/pull-request.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**コントリビューターになる。** AI エージェントを用いて作成されたものを含め、プルリクエストを歓迎します。まずは[コントリビューションガイド](../../.github/CONTRIBUTING.md)をご覧ください。

---

<div align="center">

<p data-language-switcher><sub><a href="../../README.md">English</a>&nbsp;· <a href="README.zh-CN.md">简体中文</a>&nbsp;· <a href="README.zh-Hant.md">繁體中文</a>&nbsp;· <a href="README.ja.md">日本語</a>&nbsp;· <a href="README.ko.md">한국어</a>&nbsp;· <a href="README.de.md">Deutsch</a>&nbsp;· <a href="README.fr.md">Français</a>&nbsp;· <a href="README.es.md">Español</a>&nbsp;· <a href="README.pt.md">Português</a>&nbsp;· <a href="README.it.md">Italiano</a>&nbsp;· <a href="README.sv.md">Svenska</a></sub></p>

</div>

<p align="center"><sub><a href="../../LICENSE">MIT</a> © 2026 PapilotAI. <a href="https://linux.do/">LINUX DO</a> の皆様に感謝いたします。</sub></p>
