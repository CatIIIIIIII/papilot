<div align="center">

<img src="../assets/wordmark.svg#gh-light-mode-only" width="220" height="69" alt="Papilot"><img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="220" height="69" alt="Papilot"><br>**下一代 AI LaTeX 编辑器**

# 不必读写 `.tex`<br>直接在 <img src="../assets/pdf.svg" width="34" height="41" align="absmiddle" alt="PDF"> 上工作

用 AI 负责任地写作与排版的**新范式**。

<!-- BEGIN BADGES -->
[![License: MIT](https://img.shields.io/github/license/PapilotAI/papilot?style=flat&color=22c55e)](../../LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/PapilotAI/papilot/ci.yml?branch=main&style=flat&label=CI)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/PapilotAI/papilot?style=flat&label=release&color=0969da)](https://github.com/PapilotAI/papilot/releases/latest)
[![GitHub total downloads](https://img.shields.io/github/downloads/PapilotAI/papilot/total?style=flat&logo=github&label=downloads&color=0969da)](https://github.com/PapilotAI/papilot/releases)
[![npm monthly downloads](https://img.shields.io/npm/dm/papilot?style=flat&logo=npm&label=downloads&color=cb3837)](https://www.npmjs.com/package/papilot)
<!-- END BADGES -->

<p data-language-switcher><sub><a href="../../README.md">English</a>&nbsp;· <a href="README.zh-CN.md">简体中文</a>&nbsp;· <a href="README.zh-Hant.md">繁體中文</a>&nbsp;· <a href="README.ja.md">日本語</a>&nbsp;· <a href="README.ko.md">한국어</a>&nbsp;· <a href="README.de.md">Deutsch</a>&nbsp;· <a href="README.fr.md">Français</a>&nbsp;· <a href="README.es.md">Español</a>&nbsp;· <a href="README.pt.md">Português</a>&nbsp;· <a href="README.it.md">Italiano</a>&nbsp;· <a href="README.sv.md">Svenska</a></sub></p>

</div>

<p align="center">
<a href="https://papilot.ai">
<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/hero-compact-dark.zh-CN.png">
  <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/hero-dark.zh-CN.png">
  <source media="(max-width: 600px)" srcset="../assets/readme-showcase/hero-compact.zh-CN.png">
  <img src="../assets/readme-showcase/hero.zh-CN.png" alt="Papilot 把 AI 的修改排成 PDF 上的修改前后对比，可以接受、拒绝或评论。" width="900">
</picture>
</a>
</p>

<a id="-you-care-about-the-pdfbrnot-the-tex-behind-it"></a>

## 📄 你在乎的是 PDF<br>不是背后的 `.tex`

论文、学位论文、书稿、幻灯片，读者看到的永远只是排好版的页面。<br>
**所以，你也应该在页面上工作。**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact-dark.zh-CN.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/paradigm-dark.zh-CN.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact.zh-CN.png">
    <img src="../assets/readme-showcase/paradigm.zh-CN.png" alt="从手写 LaTeX，到核对 AI 改出的 LaTeX 差异，再到 Papilot：直接审阅 PDF。" width="900">
  </picture>
</p>

**不用再在脑子里编译 diff。**<br>
源码 diff 只能让你*想象* PDF 的样子，Papilot 直接把排好版的结果*摆在*你面前。

<a id="-point-at-the-page-and-say-what-you-want"></a>

## 👉 指着页面，说出你想怎么改

选中一句话、一个公式或一张图，写下批注。<br>
**智能体自己找到源码，你永远不用打开 `.tex` 文件。**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact-dark.zh-CN.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/notes-app-dark.zh-CN.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact.zh-CN.png">
    <img src="../assets/readme-showcase/notes-app.zh-CN.png" alt="Papilot 中，PDF 上框出一个公式、标出一句话，各带一条批注，一起加入下一个任务。" width="900">
  </picture>
</p>

<a id="features"></a>

<a id="-your-files-stay-yours"></a>

## 🔒 你的文件始终属于你

<img src="../assets/readme-icons/folder.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**文件就在你的电脑上。** 每处改动都留在你的 Git 历史里。

<img src="../assets/readme-icons/git.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**通过 Git 与合作者同步。** 拉取、推送，冲突交给智能体解决。

<img src="../assets/readme-icons/code.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**免费开源。** MIT 许可，支持 macOS、Linux 和 Windows。

<a id="agents"></a>

<a id="-bring-the-ai-agent-you-already-use"></a>

## 🤖 带上你已经在用的 AI 智能体

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

<a id="downloads"></a>

<a id="-downloads"></a>

## 📥 下载

<!-- BEGIN DOWNLOADS -->
| 系统 / 发行版 | 下载 / 软件包 | 安装 / 运行 |
| --- | --- | --- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/apple-dark.svg"><img src="../assets/readme-icons/apple.svg" width="18" height="18" align="absmiddle" alt=""></picture> **macOS** | [Apple Silicon](https://github.com/PapilotAI/papilot/releases/latest) · [Intel](https://github.com/PapilotAI/papilot/releases/latest)<br>DMG / ZIP | 打开 DMG，将 Papilot 拖入“应用程序”。 |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/windows-dark.svg"><img src="../assets/readme-icons/windows.svg" width="18" height="18" align="absmiddle" alt=""></picture> **Windows** | [安装版](https://github.com/PapilotAI/papilot/releases/latest) · [便携版](https://github.com/PapilotAI/papilot/releases/latest)<br>x64 | 运行安装程序，或直接打开便携版。 |
| <img src="../assets/readme-icons/ubuntu.svg" width="18" height="18" align="absmiddle" alt=""> <img src="../assets/readme-icons/debian.svg" width="18" height="18" align="absmiddle" alt=""> **Ubuntu / Debian / Linux Mint** | [.deb](https://github.com/PapilotAI/papilot/releases/latest) | `sudo apt install ./Papilot-*.deb` |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/linux-dark.svg"><img src="../assets/readme-icons/linux.svg" width="18" height="18" align="absmiddle" alt=""></picture> **Fedora / Arch / openSUSE** | [AppImage](https://github.com/PapilotAI/papilot/releases/latest) | `chmod +x Papilot-*.AppImage`<br>`./Papilot-*.AppImage` |
| <img src="../assets/readme-icons/nixos.svg" width="18" height="18" align="absmiddle" alt=""> **NixOS** | [Nix flake](../nix.md#nixos-flake) | [加入 `flake.nix`](../nix.md#nixos-flake) |
| **macOS / Linux / Windows (CLI)** | [npm](https://www.npmjs.com/package/papilot) | `npm install -g papilot` |

Linux 安装包为 x86_64，已在 Ubuntu 22.04 上测试。依赖项及 AppImage/FUSE 使用说明见[桌面版安装指南](../../desktop/README.md#build-and-run)。

npm 版本使用浏览器界面，需要 Node.js 22.22+。Nix 需要启用 flakes，详见 [Nix 安装指南](../nix.md#nixos-flake)。
<!-- END DOWNLOADS -->

<a id="quick-start"></a>

<a id="-get-started"></a>

## 🚀 快速开始

1. **安装。** [下载应用](#downloads)（macOS、Linux 或 Windows），或运行 `npm install -g papilot`（需要 Node.js 22.22+）。另外还需要 Git 和 TeX Live 或 MacTeX。
2. **打开你的项目。** 选择存放 `.tex` 文件的文件夹，Papilot 会编译出 PDF。
3. **选择智能体。** 直接用你已有的 CLI 登录或 API 密钥，然后就可以在页面上批注了。

想先看个示例？运行 `papilot demo`。详细说明见[使用指南](../guide.md#install-and-run)。

<a id="documentation-and-community"></a>

<a id="-community"></a>

## 🤝 社区

<img src="../assets/readme-icons/issue.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**发现了 bug，或者缺少某个功能？** [提一个 issue](https://github.com/PapilotAI/papilot/issues/new/choose)，写得粗略也没关系。

<img src="../assets/readme-icons/discussion.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**有问题或想法？** [发起讨论](https://github.com/PapilotAI/papilot/discussions)。

<img src="../assets/readme-icons/pull-request.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**成为贡献者。** 非常欢迎提交 pull request，用 AI 智能体写的也一样欢迎。先看看[贡献指南](../../.github/CONTRIBUTING.md)。

---

<p align="center"><sub><a href="../../LICENSE">MIT</a> © 2026 PapilotAI。感谢朋友 <a href="https://linux.do/">LINUX DO</a>。</sub></p>
