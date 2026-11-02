<div align="center">

<h1>
  <img src="../assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>借助 AI 修订 LaTeX 论文，并在 PDF 上审阅修改。</b></p>

<p><a href="https://papilot.ai">官网</a> · <a href="../guide.md">文档</a></p>

<p data-language-switcher><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.it.md">Italiano</a> · <a href="README.sv.md">Svenska</a></p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](../../LICENSE)

<p><img src="../assets/demo.gif" alt="Papilot：在 PDF 上标注段落，交给智能体处理，并审阅排版后的修改" width="100%"></p>

</div>

Papilot 是一个与 AI 智能体协作撰写和修订 LaTeX 论文的本地工作区。在 PDF 上标注段落和公式，让智能体在独立的源码副本上进行编辑，随后审阅排版后的修改并选择要保留的内容。

<a id="features"></a>

## 功能特性

<table>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-note.jpg"><img src="../assets/readme-note.jpg" alt="PDF 上按颜色分组的段落批注与框选的公式批注"></a>
<h3>在 PDF 上添加批注</h3>
选中句子或框选公式，说明需要修改的内容。按颜色将相关批注分组，即可对多个段落统一下达指令。
</td>
<td width="50%" valign="top">
<a href="../assets/readme-review.jpg"><img src="../assets/readme-review.jpg" alt="页面上的排版前后对比差异，带有接受、拒绝和评论按钮"></a>
<h3>审阅每处修改</h3>
对比修改前后的排版页面，包括公式重新编号等其他位置的变动。对每处编辑执行接受、拒绝或评论操作，并可在审阅过程中随时撤销决定。
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-deliver.jpg"><img src="../assets/readme-deliver.jpg" alt="将已接受的编辑应用到论文原稿"></a>
<h3>选择编辑的去向</h3>
每个新任务都在各自的论文副本上运行。审阅编辑后，选择 **提交到论文原稿** 将此任务保存为当前分支上的一次提交，或选择 **应用到工作区** 使编辑保持未提交状态。如果同一段落在此期间发生了变动，AI 会自动解决冲突，仅在预期内容不明确时向你询问。保存前可先审阅合并后的 PDF，准备就绪后即可从 Git 面板推送。
</td>
<td width="50%" valign="top">
<a href="../assets/readme-git.jpg"><img src="../assets/readme-git.jpg" alt="包含已暂存文件、生成的提交说明和提交图的 Git 面板"></a>
<h3>与 Git 配合使用</h3>
在工作区中暂存和提交文件、拉取及推送更改。智能体可以起草提交说明并协助解决合并冲突；提交图会显示每个任务的工作树。
</td>
</tr>
</table>

- **[技能](../guide.md#skills)与[附件](../guide.md#task-attachments)：** 运行 `/` 技能来润色行文、校对文本或检查数学公式，在设置中定义自定义技能，并向任务和消息添加参考文件或图片附件。
- **阅读与工作区：** 通过 PDF 目录和全文搜索浏览论文原稿，支持浅色与深色主题以及英文或中文界面。

<a id="quick-start"></a>

## 快速开始

有关 macOS 和 Linux 桌面应用及本地构建说明，请参阅 [Papilot Desktop](../../desktop/README.md)。桌面端 CI 会构建 Apple Silicon 和 Intel Mac 安装程序，以及 Linux x64 AppImage 和 deb 软件包。

Papilot 需要 **Node.js 22.22+**、**Git**，以及包含 `latexmk` 和 `synctex` 的完整 **TeX** 发行版（[MacTeX](https://www.tug.org/mactex/) 或 [TeX Live](https://www.tug.org/texlive/)）。修订论文还需要至少配置一个[智能体](#agents)。

```sh
npm install -g papilot
papilot demo
```

打开 [http://127.0.0.1:7274](http://127.0.0.1:7274)，在侧边栏中选择 **论文原稿**，即可浏览内置的示例论文。

若要处理你自己的论文原稿，请运行 `papilot` 并选择 **添加论文…** 以打开本地 LaTeX 文件夹或 ZIP 压缩包。Papilot 会查找主 `.tex` 文件，在需要时准备 Git 历史记录，并尝试编译。如果主文件不明确或构建失败，导入对话框会协助你选择文件或修复问题。

可在 **设置 → 运行环境** 下的 **智能体** 或 **LaTeX** 中检查配置。运行 `papilot doctor` 进行环境检查，或运行 `papilot doctor --repo /path/to/paper` 一并检查论文原稿（[诊断说明](../guide.md#diagnostics)）。

<a id="agents"></a>

## 智能体

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

你可以为每个任务选择智能体和模型。根据集成方式的不同，Papilot 会使用智能体的本地 CLI 登录状态或你提供的服务商 API 凭据来运行智能体，且不会存储你的密钥。

打开 **设置 → 运行环境 → 智能体** 查看状态、模型和配置说明（例如 `papilot codex login`）。如果在 Papilot 运行期间安装或登录了智能体，请点击 **重新连接**；如果修改了环境变量，请重启 `papilot`。有关各智能体的要求与功能，请参阅[智能体指南](../guide.md#agents)。

<a id="documentation-and-community"></a>

## 文档与社区

- **文档：** 阅读[用户指南](../guide.md)，了解工作区流程、配置、[应用内更新](../guide.md#updates)、[通过 Tailscale 远程访问](../guide.md#remote-access-with-tailscale)以及[面向协作者的通行密钥共享](../guide.md#collaborators)。
- **设计与历史：** 浏览 [`examples/papilot-paper`](../../examples/papilot-paper) 查看正式的设计论文与证明，并查阅[更新日志](../../CHANGELOG.md)了解版本说明。
- **社区与支持：** 在 [Discussions](https://github.com/PapilotAI/papilot/discussions) 中提问，在 [Issues](https://github.com/PapilotAI/papilot/issues) 中报告问题，或阅读 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) 参与贡献。

---

[MIT](../../LICENSE) © 2026 PapilotAI

友情链接：[LINUX DO](https://linux.do/)。
