<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" width="304" height="92" alt="Papilot">
  </picture>
</h1>

<p><b>專為論文打造的 Cursor 風格工作區：直接標註並審閱 PDF，完全不必接觸 LaTeX。</b></p>

<p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 繁體中文</p>

[![CI](https://github.com/cu1ch3n/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/cu1ch3n/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.22-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white)](https://react.dev)
[![LaTeX](https://img.shields.io/badge/LaTeX-008080?logo=latex&logoColor=white)](https://www.latex-project.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-22c55e)](https://github.com/cu1ch3n/papilot/pulls)

**目錄：** [功能特色](#-features) · [快速開始](#-quick-start) · [智慧代理](#-agents) · [說明文件](#-documentation) · [社群](#-community) · [友站連結](#-friends) · [授權條款](#-license)

<img src="docs/assets/demo.gif" alt="Papilot：在 PDF 標註段落、交給智慧代理處理、接受排版變更並提交" width="100%">

</div>

你可以像指導教授批改草稿一樣閱讀並標註 PDF。AI 智慧代理會在 LaTeX 中進行修改，每項變更都會以排版頁面的前後對照形式呈現給你。在你接受之前，不會動到論文的任何內容。

> [!TIP]
> **0.7 版本新功能：** 全新設計的工作區、依顏色分組的註解、在任務中附加檔案與圖片、技能庫，以及選擇已接受變更的去向。請參閱[更新日誌](CHANGELOG.md)。

<a id="-features"></a>

## ✨ 功能特色

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/assets/readme-note.jpg" alt="黃色註解群組中的兩個段落與方程式上的區域註解">
<h3>📝 標註 PDF</h3>
選取句子或框選方程式，寫下要修改的內容。SyncTeX 會將精確的 LaTeX 行號交給智慧代理。你可以用顏色將相關註解歸入同一群組，並對整個群組下達單一指令。
</td>
<td width="50%" valign="top">
<img src="docs/assets/readme-review.jpg" alt="在排版頁面上顯示修改前後的差異，並附有接受、拒絕與評論按鈕">
<h3>✅ 逐一核准變更</h3>
每次修改都會以排版差異的形式回傳，並一併標示連帶變動的位置，例如重新編號的方程式與目錄。你可以接受、拒絕或加上評論，也能隨時復原任何決定。
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/assets/readme-deliver.jpg" alt="完成的審閱畫面，包含智慧代理撰寫的提交訊息、套用至工作目錄與提交按鈕">
<h3>📦 選擇變更的去向</h3>
在完成審閱前，已接受的變更會保留在任務中。接著，你可以將變更套用至工作目錄，或使用智慧代理撰寫的訊息提交到獨立的 <code>papilot/…</code> 分支。
</td>
<td width="50%" valign="top">
<img src="docs/assets/readme-git.jpg" alt="Git 面板顯示已暫存的檔案、產生的提交訊息、任務工作樹與提交圖表">
<h3>🌿 不離開頁面即可使用 Git</h3>
暫存檔案並使用智慧代理撰寫的訊息提交，接著執行拉取與推送。每個任務的工作樹都會顯示在提交圖表中，當你合併共同作者的變更時，智慧代理還能協助解決衝突。
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/assets/readme-contents.jpg" alt="開啟目錄面板的 PDF 檢視器">
<h3>📖 如實閱讀 PDF</h3>
從目錄跳轉至任何章節、搜尋每一頁，並清晰地放大檢視。選取文字時會精準對應實際排印出的字詞。
</td>
<td width="50%" valign="top">
<h3>🧰 更多功能</h3>
<ul>
<li>✨ <b>技能</b>：只需輸入 <code>/</code> 即可呼叫潤飾、校對與檢查數學公式等技能，也可在「設定」中自行撰寫。</li>
<li>📎 <b>檔案與圖片</b>：可附加至任何任務或訊息中</li>
<li>🤖 <b>Codex、Claude、Cursor、Kimi Code、GLM、DeepSeek、Qwen Code、OpenCode 或 Antigravity</b>：直接使用電腦上已安裝的工具與你自己的登入帳號</li>
<li>🌳 <b>每個任務皆有專屬的 Git 工作樹</b>，最多可同時執行兩個任務</li>
<li>🌗 <b>淺色與深色主題</b>，支援英文與中文介面</li>
<li>📱 <b>在你的電腦上執行</b>，並可從手機開啟瀏覽</li>
</ul>
</td>
</tr>
</table>

<a id="-quick-start"></a>

## 🚀 快速開始

> [!NOTE]
> 你需要安裝 **Node.js 22.22+**、**Git** 以及完整的 **TeX** 發行版（[MacTeX](https://www.tug.org/mactex/) 或 [TeX Live](https://www.tug.org/texlive/)）。修改論文另需至少一個[已登入的智慧代理](#-agents)。

```sh
npm install -g papilot
papilot demo
```

開啟 **http://127.0.0.1:7274** 並在側邊欄選擇 **論文原稿**。展示模式會加入一篇可供修改的範例論文：這是一篇長達 26 頁、充滿方程式且介紹 Papilot 本身的 LaTeX 論文。準備好之後，執行 `papilot` 並從論文選單選擇 **新增論文…**，即可選取 LaTeX 資料夾或拖放 ZIP 壓縮檔。Papilot 會自動識別主檔案、準備 Git 歷史紀錄並嘗試編譯，若匯入期間發生任何錯誤也會提供協助。

<a id="-agents"></a>

## 🤖 智慧代理

| 智慧代理 | 單次登入設定 | Papilot 執行方式 |
| --- | --- | --- |
| **Codex** | `papilot codex login` | 透過 Codex 應用程式伺服器，在其工作區沙盒中執行。若系統已有 `codex`，Papilot 會直接使用，否則會在首次啟動時自動安裝。 |
| **Claude** | 安裝 [Claude Code](https://code.claude.com) 並執行 `claude auth login`，或設定 `ANTHROPIC_API_KEY` 後啟動 `papilot` | 若已安裝 Claude Code，會使用你的登入資訊（Claude 方案或金鑰）在 Claude Code 的沙盒中執行 `claude -p`。若未安裝，則透過需要 API 金鑰的 Claude Agent SDK 執行。 |
| **Cursor** | 設定 `CURSOR_API_KEY` 後啟動 `papilot` | 透過首次使用時下載的 Cursor SDK，在 Cursor 的沙盒中執行。此 SDK 不會使用 Cursor 應用程式或 CLI 的登入狀態。 |
| **Kimi Code** | 安裝 [Kimi Code CLI](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started) 並執行 `kimi login` | 使用本機設定執行 `kimi acp`；支援串流回覆、恢復工作階段並轉發工具核准請求。 |
| **GLM** | 設定 `ZHIPU_API_KEY`（或 `ZAI_API_KEY`）後啟動 `papilot` | 依照智譜 GLM Coding Plan 文件說明，在智譜相容於 Anthropic 的端點上執行 Claude Code。 |
| **DeepSeek** | 安裝 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`npm install -g @deepseek-ai/dsh`）並在其中設定模型 | 在其工作區沙盒中執行 `dsh acp`；任何工作樹以外的操作都會要求核准。 |
| **Qwen Code** | 安裝 [Qwen Code](https://github.com/QwenLM/qwen-code) 並執行 `qwen` 完成登入 | 以自動編輯模式執行 `qwen --acp`：檔案編輯會直接進行，執行指令則會要求核准。 |
| **OpenCode** | 安裝 [OpenCode](https://opencode.ai) 並執行 `opencode auth login` 連結供應商 | 使用你設定的供應商執行 `opencode acp`；執行指令與任何工作樹以外的操作都會要求核准。 |
| **Antigravity** | 安裝 Antigravity 並登入 `agy` | 執行 `agy -p`，每輪對話啟動一個處理程序，僅限編輯檔案。若所在地區需要代理伺服器，請設定 `PAPILOT_AGY_PROXY`。 |

Papilot 會自動尋找電腦上已安裝的智慧代理並僅列出可用項目；Codex 則會常駐提供。若在 Papilot 執行期間安裝或登入了某個智慧代理，請選擇 **重新連線**。如果某個 CLI 不在伺服器的 `PATH` 環境變數中，請透過 `PAPILOT_KIMI_BIN`、`PAPILOT_DSH_BIN`、`PAPILOT_QWEN_BIN` 或 `PAPILOT_OPENCODE_BIN` 指定其路徑。關於各智慧代理支援的功能與測試過的版本，請參閱[智慧代理指南](docs/guide.md#agents)。

Papilot 絕不會儲存你的憑證。CLI 智慧代理會使用各自的登入機制，而你為 Claude、Cursor 或 GLM 設定的金鑰也只會傳送給該服務。系統找到但尚未登入的智慧代理會顯示為無法使用。

開始使用時遇到問題嗎？請開啟 **設定 → 執行環境**，選擇 **智慧代理** 查看智慧代理設定，或選擇 **LaTeX** 查看偵測到的發行版、版本與位置；你也可以執行 `papilot doctor` 進行環境檢查與修復，並透過 `papilot doctor --repo /path/to/paper` 一併檢查論文專案。加上 `--json` 可輸出機器可讀的報告。診斷工具不會安裝軟體、啟動伺服器或修改你的論文。關於檢查項目，請參閱[診斷指南](docs/guide.md#diagnostics)。

<details>
<summary><b>⚙️ 選項與遠端存取</b></summary>

<br>

```sh
papilot --port 4400            # another local port
papilot --data ~/papilot-data  # keep state somewhere else (default ~/.papilot)
papilot service install        # macOS: start after login, restart if it exits
npm uninstall -g papilot       # remove it; your state stays in ~/.papilot until you delete it
```

當有新版本發布時，**設定** 旁邊會顯示 **新版本**。點擊即可直接從瀏覽器安裝。Papilot 會等待執行中的任務與 PDF 建置完成，然後重新啟動並重新連線頁面。更新會保留你的資料，同時保留前一個安裝版本以便還原。請參閱[更新說明](docs/guide.md#updates)。

Papilot 預設僅監聽 `127.0.0.1`。若要從其他裝置使用，請透過 Tailscale Serve 將其發布至你的 tailnet，並設定 `PAPILOT_PUBLIC_ORIGIN` 與 `PAPILOT_TAILSCALE_LOGIN`。設定後，Papilot 會檢查每個請求的主機、瀏覽器來源與 Tailscale 身分。詳細步驟請參閱[指南](docs/guide.md#remote-access-with-tailscale)。

若要邀請指導教授或共同作者，請透過 `PAPILOT_ACCOUNT_ORIGIN` 為 Papilot 設定公開的 HTTPS 網址，並開啟 **設定 → 共用**：每個人皆使用通行金鑰登入，且只會看到你共用的論文。請僅邀請你信任、且放心讓其存取 Papilot 執行所在電腦的人員；詳情請參閱[協作者說明](docs/guide.md#collaborators)。

</details>

<details>
<summary><b>🛠️ 開發</b></summary>

<br>

```sh
git clone https://github.com/cu1ch3n/papilot && cd papilot
npm ci && npm run setup:review
npm run build && npm start
```

在送出拉取請求（Pull Request）之前，請先執行 `npm run typecheck`、`npm test` 與 `npm run test:ui`。

</details>

<a id="-documentation"></a>

## 📚 說明文件

**[使用指南](docs/guide.md)** 涵蓋了工作區的各個部分、設定變數、重啟後的狀態恢復以及開發說明。[`examples/papilot-paper`](examples/papilot-paper) 中的範例論文深入解析了系統設計與相關證明。每個版本的變更內容則記錄在[更新日誌](CHANGELOG.md)中。

<a id="-community"></a>

## 💬 社群

- 💡 **問題與想法**：[討論區 (Discussions)](https://github.com/cu1ch3n/papilot/discussions)
- 🐛 **回報問題**：[建立 Issue](https://github.com/cu1ch3n/papilot/issues/new/choose)
- 🤝 **參與貢獻**：挑選一個 [適合新手的 Issue (good first issue)](https://github.com/cu1ch3n/papilot/labels/good%20first%20issue) 並閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)

如果 Papilot 為你的論文節省了寶貴時間，歡迎按個 ⭐，幫助更多研究人員發現這個工具。

<a href="https://github.com/cu1ch3n/papilot/graphs/contributors"><img src="https://contrib.rocks/image?repo=cu1ch3n/papilot" alt="Papilot 貢獻者"></a>

<a id="-friends"></a>

## 🔗 友站連結

[LINUX DO](https://linux.do/)

<a id="-license"></a>

## 📄 授權條款

[MIT](LICENSE) © 2026 Cui Chen。內建於 [`vendor/latex-review`](vendor/latex-review) 的審閱引擎同樣採用 MIT 授權條款。
