<div align="center">

<img src="../assets/wordmark.svg#gh-light-mode-only" width="220" height="69" alt="Papilot"><img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="220" height="69" alt="Papilot"><br>**Éditeur LaTeX IA de nouvelle génération**

# Ne lisez ni n'écrivez de `.tex`<br>Travaillez directement sur le <img src="../assets/pdf.svg" width="34" height="41" align="absmiddle" alt="PDF">

Un **nouveau paradigme** pour une rédaction et une composition responsables avec l'IA.

**[Télécharger Papilot](https://github.com/PapilotAI/papilot/releases/latest)** pour <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/apple-dark.svg"><img src="../assets/readme-icons/apple.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;macOS (Apple&nbsp;Silicon&nbsp;/&nbsp;Intel)<br>et <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/linux-dark.svg"><img src="../assets/readme-icons/linux.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;Linux (AppImage / <img src="../assets/readme-icons/ubuntu.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Ubuntu / <img src="../assets/readme-icons/debian.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Debian / <img src="../assets/readme-icons/nixos.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;NixOS),<br>ou exécutez `npm install -g papilot`.

<a href="https://papilot.ai">
<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/hero-compact-dark.png">
  <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/hero-dark.png">
  <source media="(max-width: 600px)" srcset="../assets/readme-showcase/hero-compact.png">
  <img src="../assets/readme-showcase/hero.png" alt="Papilot affiche une modification de l'IA sous forme de comparatif avant/après composé sur le PDF, avec les options Accepter, Rejeter et Commenter." width="900">
</picture>
</a>

</div>

<a id="-you-care-about-the-pdfbrnot-the-tex-behind-it"></a>

## 📄 Ce qui vous importe, c'est le PDF<br>Pas le `.tex` derrière

Articles, thèses, livres, diapositives : les lecteurs ne voient jamais que la page composée.<br>
**C'est donc aussi sur la page que vous devriez travailler.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/paradigm-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact.png">
    <img src="../assets/readme-showcase/paradigm.png" alt="Écrire du LaTeX à la main, puis vérifier les diffs LaTeX de l'IA, et maintenant Papilot : la révision directement sur le PDF." width="900">
  </picture>
</p>

**Fini la compilation mentale des diffs.**<br>
Un diff du code source vous oblige à *imaginer* le PDF. Papilot vous le *montre*, déjà composé.

<a id="-point-at-the-page-and-say-what-you-want"></a>

## 👉 Pointez la page et dites ce que vous voulez

Sélectionnez une phrase, une équation ou une figure, et rédigez une annotation.<br>
**Votre agent trouve le code source. Vous n'ouvrez jamais de fichier `.tex`.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/notes-app-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact.png">
    <img src="../assets/readme-showcase/notes-app.png" alt="Papilot avec une équation encadrée et une phrase surlignée sur le PDF, chacune accompagnée d'une annotation, toutes deux ajoutées à la prochaine tâche." width="900">
  </picture>
</p>

<a id="features"></a>

<a id="-your-files-stay-yours"></a>

## 🔒 Vos fichiers restent les vôtres

<img src="../assets/readme-icons/folder.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**De simples fichiers sur votre machine.** Chaque modification est enregistrée dans votre historique Git.

<img src="../assets/readme-icons/git.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Synchronisez avec vos coauteurs via Git.** Récupérez (pull), publiez (push) et laissez un agent résoudre les conflits.

<img src="../assets/readme-icons/code.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Gratuit et open source.** Sous licence MIT, pour macOS et Linux.

<a id="agents"></a>

<a id="-bring-the-ai-agent-you-already-use"></a>

## 🤖 Utilisez l'agent IA que vous connaissez déjà

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

## 🚀 Prise en main

1. **Installation.** [Téléchargez l'application](https://github.com/PapilotAI/papilot/releases/latest) pour macOS ou Linux, ou exécutez `npm install -g papilot` (Node.js 22.22+). Vous aurez également besoin de Git et de TeX Live ou MacTeX.
2. **Ouvrez votre projet.** Choisissez le dossier contenant vos fichiers `.tex`. Papilot génère le PDF.
3. **Choisissez un agent.** Utilisez la connexion CLI ou la clé API dont vous disposez déjà, puis annotez la page.

Vous voulez d'abord voir un exemple ? Exécutez `papilot demo`. Tous les détails figurent dans le [guide](../guide.md#install-and-run).

<a id="documentation-and-community"></a>

<a id="-community"></a>

## 🤝 Communauté

<img src="../assets/readme-icons/issue.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Vous avez trouvé un bug ou il vous manque une fonctionnalité ?** [Ouvrez un ticket](https://github.com/PapilotAI/papilot/issues/new/choose), même succinct.

<img src="../assets/readme-icons/discussion.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Vous avez une question ou une idée ?** [Lancez une discussion](https://github.com/PapilotAI/papilot/discussions).

<img src="../assets/readme-icons/pull-request.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Devenez contributeur.** Les pull requests sont les bienvenues, y compris celles rédigées avec des agents IA. Consultez le [guide de contribution](../../.github/CONTRIBUTING.md) pour commencer.

---

<div align="center">

<p data-language-switcher><sub><a href="../../README.md">English</a>&nbsp;· <a href="README.zh-CN.md">简体中文</a>&nbsp;· <a href="README.zh-Hant.md">繁體中文</a>&nbsp;· <a href="README.ja.md">日本語</a>&nbsp;· <a href="README.ko.md">한국어</a>&nbsp;· <a href="README.de.md">Deutsch</a>&nbsp;· <a href="README.fr.md">Français</a>&nbsp;· <a href="README.es.md">Español</a>&nbsp;· <a href="README.pt.md">Português</a>&nbsp;· <a href="README.it.md">Italiano</a>&nbsp;· <a href="README.sv.md">Svenska</a></sub></p>

</div>

<p align="center"><sub><a href="../../LICENSE">MIT</a> © 2026 PapilotAI. Merci à nos amis de <a href="https://linux.do/">LINUX DO</a>.</sub></p>
