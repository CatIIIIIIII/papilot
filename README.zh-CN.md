<div align="center">

<h1>
  <img src="docs/assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="docs/assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>在 PDF 上批注和审阅，让 AI 修改 LaTeX 论文。</b></p>

<p><a href="https://papilot.ai">官网</a> · <a href="docs/guide.md">使用指南</a> · <a href="README.md">English</a> · 简体中文</p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)

<p><img src="docs/assets/demo.gif" alt="Papilot：在 PDF 上批注一段话，交给智能体修改，并审阅排版后的改动" width="100%"></p>

</div>

Papilot 是运行在本机的 LaTeX 论文工作台。你在 PDF 上批注，智能体在独立副本中修改源码；改好后先看排版对比，再决定接受哪些改动、保存到哪里。

macOS、Linux 桌面版与本地构建方法见 [Papilot Desktop](desktop/README.md)。桌面 CI 构建 Apple Silicon、Intel Mac 安装包，以及 Linux x64 的 AppImage、deb 安装包。

## 功能

<table>
<tr>
<td width="50%" valign="top">
<a href="docs/assets/readme-note.zh-CN.jpg"><img src="docs/assets/readme-note.zh-CN.jpg" alt="PDF 上的同色分组文字批注与公式框选批注"></a>
<h3>在 PDF 上批注</h3>
选中句子或框出公式，写下修改要求。相关批注可以按颜色归成一组，一次说明多处修改。
</td>
<td width="50%" valign="top">
<a href="docs/assets/readme-review.zh-CN.jpg"><img src="docs/assets/readme-review.zh-CN.jpg" alt="排版页面上的修改前后对比，带接受、拒绝和评论按钮"></a>
<h3>逐处审阅改动</h3>
对比修改前后的排版，也能看到公式重编号等连带变化。逐条接受、拒绝或评论，做过的决定可以撤销。
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/assets/readme-deliver.zh-CN.jpg"><img src="docs/assets/readme-deliver.zh-CN.jpg" alt="将接受的改动应用到论文"></a>
<h3>选择保存方式</h3>
每个新任务在独立副本里改稿。审阅完成后，可以选择 **提交到论文**，将这个任务的改动保存为当前分支上的一个 commit；也可以选择 **应用到工作区**，保留为未提交改动。如果同一段落期间有了其他修改，AI 会自动处理冲突，只有无法确定内容时才询问你。审核合并后的 PDF，再确认保存。需要推送时，在 Git 面板操作。
</td>
<td width="50%" valign="top">
<a href="docs/assets/readme-git.zh-CN.jpg"><img src="docs/assets/readme-git.zh-CN.jpg" alt="Git 面板：已暂存文件、自动生成的提交说明与提交关系图"></a>
<h3>内置 Git</h3>
在工作台里暂存、提交、拉取和推送，提交关系图也会显示各任务的工作树。提交说明和合并冲突，可以请智能体帮忙。
</td>
</tr>
</table>

- **[技能](docs/guide.md#skills)与[任务附件](docs/guide.md#task-attachments)：** 输入 `/` 选择润色、校对、检查数学等技能，也能在设置里写自己的技能。任务和消息可以附带参考文件与图片。
- **阅读与界面：** 支持通过 PDF 目录跳转章节与全文搜索，提供浅色/深色主题及中英文界面。

## 快速开始

运行需要 **Node.js 22.22+**、**Git**，以及包含 `latexmk` 和 `synctex` 的完整 **TeX** 发行版（[MacTeX](https://www.tug.org/mactex/) 或 [TeX Live](https://www.tug.org/texlive/)）。修改论文还需要配置至少一个[智能体](#智能体)。

```sh
npm install -g papilot
papilot demo
```

打开 [http://127.0.0.1:7274](http://127.0.0.1:7274)，在侧栏选择 **稿件** 即可体验内置的示例论文。

处理自己的论文时，运行 `papilot` 并在论文菜单中选择 **添加论文…**，打开本地 LaTeX 文件夹或拖入 ZIP 压缩包。Papilot 会自动识别主 `.tex` 文件、准备 Git 记录并尝试编译，遇到问题时可在导入界面中选择主文件或尝试修复。

在 **设置 → 运行环境** 的 **智能体** 或 **LaTeX** 页面查看配置状态。运行 `papilot doctor` 检查环境，加上 `--repo /path/to/paper` 可一并检查论文（[诊断说明](docs/guide.md#diagnostics)）。

## 智能体

<!-- BEGIN AGENT ICONS -->
<p align="center">
  <a href="docs/guide.md#agents">
    <picture>
      <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="docs/assets/readme-agents/compact-dark.svg">
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-agents/desktop-dark.svg">
      <source media="(max-width: 600px)" srcset="docs/assets/readme-agents/compact.svg">
      <img src="docs/assets/readme-agents/desktop.svg" alt="Codex, Claude, Cursor, Copilot, Grok, Antigravity, Kimi, GLM, DeepSeek, Qwen, OpenCode" width="816">
    </picture>
  </a>
</p>
<!-- END AGENT ICONS -->

每个任务都可以选择智能体和模型。Papilot 使用智能体在本机的登录，或你为对应服务配置的 API 凭据，不另行保存密钥。

打开 **设置 → 运行环境 → 智能体** 可查看状态、可用模型与配置说明（例如运行 `papilot codex login` 登录 Codex）。安装或登录智能体后，点击 **重新连接** 刷新状态；修改环境变量后则需重启 `papilot`。各智能体的具体要求与支持范围见[智能体指南](docs/guide.md#agents)。

## 文档与社区

- **使用文档：** 阅读[使用指南](docs/guide.md)了解完整工作流、配置项、[应用内更新](docs/guide.md#updates)、[Tailscale 远程访问](docs/guide.md#remote-access-with-tailscale)以及[邀请协作者](docs/guide.md#collaborators)。
- **设计与版本：** 在 [`examples/papilot-paper`](examples/papilot-paper) 中查看阐述系统设计与证明的示例论文，在[更新日志](CHANGELOG.md)中查看各版本变更。
- **社区与支持：** 欢迎在 [Discussions](https://github.com/PapilotAI/papilot/discussions) 交流想法、在 [Issues](https://github.com/PapilotAI/papilot/issues) 反馈问题，或阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 参与贡献。

---

[MIT](LICENSE) © 2026 PapilotAI

友情链接：[LINUX DO](https://linux.do/)。
