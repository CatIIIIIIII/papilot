<div align="center">

<h1>
  <img src="../assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>AI で LaTeX 論文を改訂し、PDF 上で変更をレビューします。</b></p>

<p><a href="https://papilot.ai">ウェブサイト</a> · <a href="../guide.md">ドキュメント</a></p>

<p data-language-switcher><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.it.md">Italiano</a> · <a href="README.sv.md">Svenska</a></p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](../../LICENSE)

<p><img src="../assets/demo.gif" alt="Papilot: PDF 上の箇所を指定してエージェントに渡し、組版された変更をレビュー" width="100%"></p>

</div>

Papilot は、AI エージェントとともに LaTeX 論文を執筆・改訂するためのローカルワークスペースです。PDF 上で文章や数式を指定し、ソースの別コピーをエージェントに編集させ、組版された変更をレビューして採用する変更を選択できます。

<a id="features"></a>

## 機能

<table>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-note.jpg"><img src="../assets/readme-note.jpg" alt="PDF 上の色分けされた文章の注釈と矩形で囲まれた数式の注釈"></a>
<h3>PDF に注釈を付ける</h3>
文を選択するか数式を矩形で囲み、変更内容を指示します。関連する注釈を色分けしてグループ化すれば、複数の箇所にまとめて 1 つの指示を出せます。
</td>
<td width="50%" valign="top">
<a href="../assets/readme-review.jpg"><img src="../assets/readme-review.jpg" alt="承認・却下・コメントボタンを備えたページ上の組版前後の差分表示"></a>
<h3>各変更をレビュー</h3>
数式番号の振り直しなど他箇所への影響も含め、変更前後の組版ページを比較できます。各編集に対して承認、却下、またはコメントを行い、レビュー中に判断を元に戻すことも可能です。
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-deliver.jpg"><img src="../assets/readme-deliver.jpg" alt="承認した編集を原稿に適用"></a>
<h3>編集の反映先を選択</h3>
新しいタスクはそれぞれ論文の独立したコピー上で動作します。編集をレビューしたら、現在のブランチに 1 つのコミットとして保存する場合は **原稿にコミット** を、コミットせずに編集を反映する場合は **ワークスペースに適用** を選択します。その間に同じ箇所が変更されていた場合、AI が自動的に競合を解決し、意図された内容が不明確な場合にのみ確認を求めます。保存前にマージ後の PDF をレビューし、準備ができたら Git パネルからプッシュできます。
</td>
<td width="50%" valign="top">
<a href="../assets/readme-git.jpg"><img src="../assets/readme-git.jpg" alt="ステージされたファイル、生成されたコミットメッセージ、コミットグラフを表示した Git パネル"></a>
<h3>Git との連携</h3>
ワークスペースからファイルのステージやコミット、プル、プッシュを行えます。エージェントがコミットメッセージの下書きやマージ競合の解決を支援し、コミットグラフには各タスクの作業ツリーが表示されます。
</td>
</tr>
</table>

- **[スキル](../guide.md#skills)と[添付ファイル](../guide.md#task-attachments):** `/` スキルを実行して文章の推敲、校正、数式のチェックを行えるほか、設定でカスタムスキルを定義したり、タスクやメッセージに参考ファイルや画像を添付したりできます。
- **閲覧とワークスペース:** PDF の目次や全文検索を使って原稿内を移動でき、ライト・ダークテーマおよび英語または中国語のインターフェースに対応しています。

<a id="quick-start"></a>

## クイックスタート

macOS および Linux 向けデスクトップアプリとローカルでのビルド手順については、[Papilot Desktop](../../desktop/README.md) を参照してください。デスクトップ CI は、Apple Silicon および Intel Mac 向けインストーラーと、Linux x64 向けの AppImage および deb パッケージをビルドします。

Papilot には **Node.js 22.22+**、**Git**、および `latexmk` と `synctex` を含む完全な **TeX** ディストリビューション（[MacTeX](https://www.tug.org/mactex/) または [TeX Live](https://www.tug.org/texlive/)）が必要です。論文の改訂には、設定済みの[エージェント](#agents)も少なくとも 1 つ必要です。

```sh
npm install -g papilot
papilot demo
```

[http://127.0.0.1:7274](http://127.0.0.1:7274) を開き、サイドバーで **原稿** を選択すると、同梱のサンプル論文を確認できます。

自身の原稿で作業するには、`papilot` を実行し、**論文を追加…** を選択してローカルの LaTeX フォルダまたは ZIP アーカイブを開きます。Papilot はメインの `.tex` ファイルを検出し、必要に応じて Git 履歴を準備してコンパイルを試みます。メインファイルが一意に定まらない場合やビルドに失敗した場合は、インポートダイアログからファイルを選択したり問題を修正したりできます。

環境設定は **設定 → ランタイム** の **エージェント** または **LaTeX** で確認できます。環境のチェックには `papilot doctor` を実行し、原稿もあわせてチェックするには `papilot doctor --repo /path/to/paper` を実行してください（[診断](../guide.md#diagnostics)）。

<a id="agents"></a>

## エージェント

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

タスクごとにエージェントとモデルを選択できます。連携方式に応じて、Papilot はローカル CLI のサインイン情報またはユーザーが指定したプロバイダーの API 認証情報を使用してエージェントを実行し、キーを保存しません。

ステータス、モデル、およびセットアップ手順（`papilot codex login` など）を確認するには、**設定 → ランタイム → エージェント** を開きます。Papilot の実行中にエージェントをインストールまたはサインインした後は **再接続** をクリックし、環境変数を変更した後は `papilot` を再起動してください。各エージェントの要件と機能については、[エージェントガイド](../guide.md#agents)を参照してください。

<a id="documentation-and-community"></a>

## ドキュメントとコミュニティ

- **ドキュメント:** ワークスペースのワークフロー、設定、[アプリ内アップデート](../guide.md#updates)、[Tailscale によるリモートアクセス](../guide.md#remote-access-with-tailscale)、および[共同執筆者とのパスキー共有](../guide.md#collaborators)については、[ユーザーガイド](../guide.md)を参照してください。
- **設計と変更履歴:** 正式な設計論文と証明については [`examples/papilot-paper`](../../examples/papilot-paper) を、リリースノートについては[変更履歴](../../CHANGELOG.md)を確認してください。
- **コミュニティとサポート:** [Discussions](https://github.com/PapilotAI/papilot/discussions) で質問したり、[Issues](https://github.com/PapilotAI/papilot/issues) でバグを報告したりできます。コントリビュートする場合は [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) を参照してください。

---

[MIT](../../LICENSE) © 2026 PapilotAI

フレンド: [LINUX DO](https://linux.do/).
