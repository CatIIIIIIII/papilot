<div align="center">

<h1>
  <img src="../assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>使用 AI 修訂 LaTeX 論文，並在 PDF 上審閱變更。</b></p>

<p><a href="https://papilot.ai">網站</a> · <a href="../guide.md">說明文件</a></p>

<p data-language-switcher><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.it.md">Italiano</a> · <a href="README.sv.md">Svenska</a></p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](../../LICENSE)

<p><img src="../assets/demo.gif" alt="Papilot：在 PDF 上標記段落、交由智慧代理處理，並審閱排版後的變更" width="100%"></p>

</div>

Papilot 是用於與 AI 智慧代理共同撰寫及修訂 LaTeX 論文的本機工作區。在 PDF 上標記段落與公式，讓智慧代理編輯獨立的原始碼副本，接著審閱排版後的變更並選擇要保留的修改。

<a id="features"></a>

## 功能特色

<table>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-note.jpg"><img src="../assets/readme-note.jpg" alt="PDF 上依顏色分組的段落註解與框選的公式註解"></a>
<h3>在 PDF 上加上註解</h3>
選取句子或框選公式，並說明需要修改的內容。依顏色將相關註解分組，即可對多個段落同時下達同一條指令。
</td>
<td width="50%" valign="top">
<a href="../assets/readme-review.jpg"><img src="../assets/readme-review.jpg" alt="頁面上的排版前後差異對比，附有接受、拒絕與評論按鈕"></a>
<h3>審閱每一項變更</h3>
對比修改前後的排版頁面，包含公式重新編號等其他位置的連帶變更。您可以接受、拒絕或評論每一處修改，並在審閱過程中隨時復原決定。
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-deliver.jpg"><img src="../assets/readme-deliver.jpg" alt="將已接受的修改套用至論文原稿"></a>
<h3>選擇修改的套用位置</h3>
每項新任務都會在獨立的論文副本上運作。審閱修改後，選擇 **提交至論文原稿** 將此任務儲存為目前分支上的一次提交，或選擇 **套用至工作區** 保留修改而不提交。若同一段落在這段期間也發生了變更，AI 會自動解決衝突，僅在目標內容不明確時向您詢問。儲存前可先審閱合併後的 PDF，準備就緒後即可從 Git 面板推送。
</td>
<td width="50%" valign="top">
<a href="../assets/readme-git.jpg"><img src="../assets/readme-git.jpg" alt="顯示已暫存檔案、自動產生的提交訊息與提交圖表的 Git 面板"></a>
<h3>搭配 Git 使用</h3>
在工作區中暫存並提交檔案、拉取及推送變更。智慧代理可協助起草提交訊息並解決合併衝突；提交圖表則會顯示每項任務的工作樹。
</td>
</tr>
</table>

- **[技能](../guide.md#skills)與[附件](../guide.md#task-attachments)：** 執行 `/` 技能以潤飾文句、校對或檢查數學公式，在「設定」中定義自訂技能，並將參考檔案或圖片附加至任務與訊息中。
- **閱讀與工作區：** 透過 PDF 目錄與全文搜尋瀏覽論文原稿，支援淺色與深色主題，以及英文或中文介面。

<a id="quick-start"></a>

## 快速開始

如需 macOS 與 Linux 桌面版應用程式以及本機建置說明，請參閱 [Papilot Desktop](../../desktop/README.md)。桌面版 CI 會建置 Apple Silicon 與 Intel Mac 安裝程式，以及 Linux x64 AppImage 與 deb 套件。

Papilot 需要 **Node.js 22.22+**、**Git**，以及包含 `latexmk` 與 `synctex` 的完整 **TeX** 發行版（[MacTeX](https://www.tug.org/mactex/) 或 [TeX Live](https://www.tug.org/texlive/)）。修訂論文還需要至少設定一個[智慧代理](#agents)。

```sh
npm install -g papilot
papilot demo
```

開啟 [http://127.0.0.1:7274](http://127.0.0.1:7274) 並在側邊欄選取 **論文原稿**，即可瀏覽內建的範例論文。

若要處理您自己的論文原稿，請執行 `papilot` 並選擇 **新增論文…** 以開啟本機 LaTeX 資料夾或 ZIP 壓縮檔。Papilot 會尋找主要的 `.tex` 檔案、在需要時準備 Git 歷史紀錄，並嘗試編譯。若主檔案不明確或建置失敗，匯入對話框會協助您選擇檔案或修正問題。

可在 **設定 → 執行環境** 下的 **智慧代理** 或 **LaTeX** 中檢查您的環境設定。執行 `papilot doctor` 可進行環境檢查，或執行 `papilot doctor --repo /path/to/paper` 一併檢查論文原稿（[診斷說明](../guide.md#diagnostics)）。

<a id="agents"></a>

## 智慧代理

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

您可以為每項任務選擇智慧代理與模型。根據整合方式的不同，Papilot 會使用智慧代理的本機 CLI 登入狀態或您提供的服務商 API 憑證來執行智慧代理，且不會儲存您的金鑰。

開啟 **設定 → 執行環境 → 智慧代理** 以查看狀態、可用模型與設定說明（例如 `papilot codex login`）。若在 Papilot 執行期間安裝或登入智慧代理，請點擊 **重新連線**；若變更了環境變數，請重新啟動 `papilot`。各智慧代理的系統需求與功能請參閱[智慧代理指南](../guide.md#agents)。

<a id="documentation-and-community"></a>

## 說明文件與社群

- **說明文件：** 閱讀[使用者指南](../guide.md)，了解工作區工作流程、環境設定、[應用程式內更新](../guide.md#updates)、[透過 Tailscale 遠端存取](../guide.md#remote-access-with-tailscale)，以及[與協作者分享通行金鑰](../guide.md#collaborators)。
- **設計與歷史紀錄：** 瀏覽 [`examples/papilot-paper`](../../examples/papilot-paper) 以查閱正式設計論文與證明，並查看[更新日誌](../../CHANGELOG.md)了解版本發行說明。
- **社群與支援：** 在 [Discussions](https://github.com/PapilotAI/papilot/discussions) 中提問、在 [Issues](https://github.com/PapilotAI/papilot/issues) 中回報錯誤，或閱讀 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) 了解如何參與貢獻。

---

[MIT](../../LICENSE) © 2026 PapilotAI

友情連結：[LINUX DO](https://linux.do/)。
