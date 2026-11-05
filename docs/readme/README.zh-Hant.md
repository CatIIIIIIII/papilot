<div align="center">

<img src="../assets/wordmark.svg#gh-light-mode-only" width="220" height="69" alt="Papilot"><img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="220" height="69" alt="Papilot"><br>**新世代 AI LaTeX 編輯器**

# 不必讀寫 `.tex`<br>直接在 <img src="../assets/pdf.svg" width="34" height="41" align="absmiddle" alt="PDF"> 上作業

以 AI 進行負責任寫作與排版的**全新典範**。

**[下載 Papilot](https://github.com/PapilotAI/papilot/releases/latest)** 支援 <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/apple-dark.svg"><img src="../assets/readme-icons/apple.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;macOS (Apple&nbsp;Silicon&nbsp;/&nbsp;Intel)<br>與 <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/linux-dark.svg"><img src="../assets/readme-icons/linux.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;Linux (AppImage / <img src="../assets/readme-icons/ubuntu.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Ubuntu / <img src="../assets/readme-icons/debian.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Debian / <img src="../assets/readme-icons/nixos.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;NixOS)，<br>或執行 `npm install -g papilot`。

<a href="https://papilot.ai">
<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/hero-compact-dark.png">
  <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/hero-dark.png">
  <source media="(max-width: 600px)" srcset="../assets/readme-showcase/hero-compact.png">
  <img src="../assets/readme-showcase/hero.png" alt="Papilot 在 PDF 上以排版後的前後對照呈現 AI 編輯內容，並提供接受、拒絕與評論功能。" width="900">
</picture>
</a>

</div>

<a id="-you-care-about-the-pdfbrnot-the-tex-behind-it"></a>

## 📄 你在意的是 PDF<br>而非背後的 `.tex`

論文、學位論文、書籍、投影片：讀者只會看到排版後的頁面。<br>
**因此，頁面也該是你工作的地方。**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/paradigm-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact.png">
    <img src="../assets/readme-showcase/paradigm.png" alt="從手寫 LaTeX，到檢查 AI 產生的 LaTeX 差異，再到現在的 Papilot：直接審閱 PDF。" width="900">
  </picture>
</p>

**不必再於腦中編譯差異。**<br>
原始碼差異迫使你*想像* PDF 的樣貌。Papilot 則直接將排版後的結果*呈現*在你眼前。

<a id="-point-at-the-page-and-say-what-you-want"></a>

## 👉 指著頁面，說出你的需求

標記句子、公式或圖表，並寫下註解。<br>
**你的智慧代理會自動找到原始碼。你完全不必打開 `.tex` 檔案。**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/notes-app-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact.png">
    <img src="../assets/readme-showcase/notes-app.png" alt="Papilot 在 PDF 上將一個公式框起並標記一個句子，兩者皆附有註解，並已加入下一個任務。" width="900">
  </picture>
</p>

<a id="features"></a>

<a id="-your-files-stay-yours"></a>

## 🔒 你的檔案完全屬於你

<img src="../assets/readme-icons/folder.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**儲存在本機的純文字檔案。** 每次變更都會記錄在你的 Git 歷史紀錄中。

<img src="../assets/readme-icons/git.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**透過 Git 與共同作者同步。** 拉取、推送，並讓智慧代理解決衝突。

<img src="../assets/readme-icons/code.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**免費且開源。** 採用 MIT 授權條款，支援 macOS 與 Linux。

<a id="agents"></a>

<a id="-bring-the-ai-agent-you-already-use"></a>

## 🤖 接入你慣用的 AI 智慧代理

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

## 🚀 快速開始

1. **安裝。** [下載應用程式](https://github.com/PapilotAI/papilot/releases/latest)（支援 macOS 或 Linux），或執行 `npm install -g papilot`（需 Node.js 22.22+）。你還需要安裝 Git 以及 TeX Live 或 MacTeX。
2. **開啟專案。** 選擇包含 `.tex` 檔案的資料夾。Papilot 會自動建置 PDF。
3. **選擇智慧代理。** 使用你現有的 CLI 登入憑證或 API 金鑰，接著就能在頁面上標記。

想先試用範例嗎？請執行 `papilot demo`。詳細說明請參閱[使用指南](../guide.md#install-and-run)。

<a id="documentation-and-community"></a>

<a id="-community"></a>

## 🤝 社群

<img src="../assets/readme-icons/issue.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**發現錯誤或缺少某項功能？** 歡迎[建立 Issue](https://github.com/PapilotAI/papilot/issues/new/choose)，即使只是初步想法也沒問題。

<img src="../assets/readme-icons/discussion.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**有任何問題或點子？** 歡迎[發起討論](https://github.com/PapilotAI/papilot/discussions)。

<img src="../assets/readme-icons/pull-request.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**成為貢獻者。** 非常歡迎提交 Pull Request，包含由 AI 智慧代理協助撰寫的程式碼。請從[貢獻指南](../../.github/CONTRIBUTING.md)開始。

---

<div align="center">

<p data-language-switcher><sub><a href="../../README.md">English</a>&nbsp;· <a href="README.zh-CN.md">简体中文</a>&nbsp;· <a href="README.zh-Hant.md">繁體中文</a>&nbsp;· <a href="README.ja.md">日本語</a>&nbsp;· <a href="README.ko.md">한국어</a>&nbsp;· <a href="README.de.md">Deutsch</a>&nbsp;· <a href="README.fr.md">Français</a>&nbsp;· <a href="README.es.md">Español</a>&nbsp;· <a href="README.pt.md">Português</a>&nbsp;· <a href="README.it.md">Italiano</a>&nbsp;· <a href="README.sv.md">Svenska</a></sub></p>

</div>

<p align="center"><sub><a href="../../LICENSE">MIT</a> © 2026 PapilotAI. 感謝 <a href="https://linux.do/">LINUX DO</a> 夥伴們的支持。</sub></p>
