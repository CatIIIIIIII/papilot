<div align="center">

<img src="../assets/wordmark.svg#gh-light-mode-only" width="220" height="69" alt="Papilot"><img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="220" height="69" alt="Papilot"><br>**Editor LaTeX di nuova generazione con IA**

# Non leggere né scrivere `.tex`<br>Lavora direttamente sul <img src="../assets/pdf.svg" width="34" height="41" align="absmiddle" alt="PDF">

Un **nuovo paradigma** per la scrittura e l'impaginazione responsabile con l'IA.

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
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/hero-compact-dark.png">
  <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/hero-dark.png">
  <source media="(max-width: 600px)" srcset="../assets/readme-showcase/hero-compact.png">
  <img src="../assets/readme-showcase/hero.png" alt="Papilot mostra una modifica dell'IA come un prima e dopo impaginato sul PDF, con le azioni Accetta, Rifiuta e Commenta." width="900">
</picture>
</a>
</p>

<a id="-you-care-about-the-pdfbrnot-the-tex-behind-it"></a>

## 📄 Ti interessa il PDF<br>Non il `.tex` che c'è dietro

Articoli, tesi, libri, diapositive: i lettori vedono solo la pagina impaginata.<br>
**Quindi è sulla pagina che dovresti lavorare anche tu.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/paradigm-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact.png">
    <img src="../assets/readme-showcase/paradigm.png" alt="Dalla scrittura manuale in LaTeX al controllo dei diff LaTeX generati dall'IA, fino a Papilot: la revisione sul PDF." width="900">
  </picture>
</p>

**Basta compilare i diff a mente.**<br>
Un diff del codice sorgente ti costringe a *immaginare* il PDF. Papilot te lo *mostra*, già impaginato.

<a id="-point-at-the-page-and-say-what-you-want"></a>

## 👉 Indica il punto sulla pagina e chiedi ciò che vuoi

Seleziona una frase, un'equazione o una figura e scrivi un'annotazione.<br>
**Il tuo agente trova il codice sorgente. Non dovrai mai aprire un file `.tex`.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/notes-app-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact.png">
    <img src="../assets/readme-showcase/notes-app.png" alt="Papilot con un riquadro attorno a un'equazione e una frase evidenziata sul PDF, ciascuna con un'annotazione, entrambe aggiunte alla prossima attività." width="900">
  </picture>
</p>

<a id="features"></a>

<a id="-your-files-stay-yours"></a>

## 🔒 I tuoi file restano tuoi

<img src="../assets/readme-icons/folder.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**File normali sul tuo computer.** Ogni modifica viene registrata nella tua cronologia Git.

<img src="../assets/readme-icons/git.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Sincronizza con i coautori tramite Git.** Esegui pull e push, e lascia che un agente risolva i conflitti.

<img src="../assets/readme-icons/code.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Gratuito e open source.** Rilasciato con licenza MIT, per macOS, Linux e Windows.

<a id="agents"></a>

<a id="-bring-the-ai-agent-you-already-use"></a>

## 🤖 Usa l'agente IA che già conosci

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

## 📥 Download

<!-- BEGIN DOWNLOADS -->
| Sistema / distribuzione | Download / pacchetto | Installare / avviare |
| --- | --- | --- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/apple-dark.svg"><img src="../assets/readme-icons/apple.svg" width="18" height="18" align="absmiddle" alt=""></picture> **macOS** | [Apple Silicon](https://github.com/PapilotAI/papilot/releases/latest) · [Intel](https://github.com/PapilotAI/papilot/releases/latest)<br>DMG / ZIP | Apri il DMG e trascina Papilot in Applicazioni. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/windows-dark.svg"><img src="../assets/readme-icons/windows.svg" width="18" height="18" align="absmiddle" alt=""></picture> **Windows** | [Programma di installazione](https://github.com/PapilotAI/papilot/releases/latest) · [Versione portatile](https://github.com/PapilotAI/papilot/releases/latest)<br>x64 | Esegui il programma di installazione o apri direttamente la versione portatile. |
| <img src="../assets/readme-icons/ubuntu.svg" width="18" height="18" align="absmiddle" alt=""> <img src="../assets/readme-icons/debian.svg" width="18" height="18" align="absmiddle" alt=""> **Ubuntu / Debian / Linux Mint** | [.deb](https://github.com/PapilotAI/papilot/releases/latest) | `sudo apt install ./Papilot-*.deb` |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/linux-dark.svg"><img src="../assets/readme-icons/linux.svg" width="18" height="18" align="absmiddle" alt=""></picture> **Fedora / Arch / openSUSE** | [AppImage](https://github.com/PapilotAI/papilot/releases/latest) | `chmod +x Papilot-*.AppImage`<br>`./Papilot-*.AppImage` |
| <img src="../assets/readme-icons/nixos.svg" width="18" height="18" align="absmiddle" alt=""> **NixOS** | [Nix flake](../nix.md#nixos-flake) | [Aggiungi al tuo `flake.nix`](../nix.md#nixos-flake) |
| **macOS / Linux / Windows (CLI)** | [npm](https://www.npmjs.com/package/papilot) | `npm install -g papilot` |

I pacchetti Linux sono per x86_64 e sono stati testati su Ubuntu 22.04. Consulta la [guida desktop](../../desktop/README.md#build-and-run) per le dipendenze e le istruzioni su AppImage/FUSE.

Il pacchetto npm apre l’interfaccia nel browser e richiede Node.js 22.22+. Nix richiede i flakes attivi; consulta la [guida Nix](../nix.md#nixos-flake).
<!-- END DOWNLOADS -->

<a id="quick-start"></a>

<a id="-get-started"></a>

## 🚀 Per iniziare

1. **Installa.** [Scarica l'applicazione](#downloads) per macOS, Linux o Windows, oppure esegui `npm install -g papilot` (Node.js 22.22+). Sono necessari anche Git e TeX Live o MacTeX.
2. **Apri il tuo progetto.** Scegli la cartella con i tuoi file `.tex`. Papilot compila il PDF.
3. **Scegli un agente.** Usa l'accesso CLI o la chiave API che già possiedi, poi annota la pagina.

Vuoi prima provare un esempio? Esegui `papilot demo`. I dettagli sono nella [guida](../guide.md#install-and-run).

<a id="documentation-and-community"></a>

<a id="-community"></a>

## 🤝 Community

<img src="../assets/readme-icons/issue.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Hai trovato un bug o manca una funzionalità?** [Apri una segnalazione](https://github.com/PapilotAI/papilot/issues/new/choose), anche abbozzata.

<img src="../assets/readme-icons/discussion.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Hai una domanda o un'idea?** [Avvia una discussione](https://github.com/PapilotAI/papilot/discussions).

<img src="../assets/readme-icons/pull-request.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Diventa un collaboratore.** Le pull request sono benvenute, incluse quelle scritte con agenti IA. Inizia dalla [guida per contribuire](../../.github/CONTRIBUTING.md).

---

<p align="center"><sub><a href="../../LICENSE">MIT</a> © 2026 PapilotAI. Grazie ai nostri amici di <a href="https://linux.do/">LINUX DO</a>.</sub></p>
