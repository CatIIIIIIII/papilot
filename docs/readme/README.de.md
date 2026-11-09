<div align="center">

<img src="../assets/wordmark.svg#gh-light-mode-only" width="220" height="69" alt="Papilot"><img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="220" height="69" alt="Papilot"><br>**KI-LaTeX-Editor der nächsten Generation**

# Lesen oder schreiben Sie kein `.tex`<br>Arbeiten Sie direkt am <img src="../assets/pdf.svg" width="34" height="41" align="absmiddle" alt="PDF">

Ein **neues Paradigma** für verantwortungsvolles Schreiben und Setzen mit KI.

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
  <img src="../assets/readme-showcase/hero.png" alt="Papilot zeigt eine KI-Bearbeitung als gesetzten Vorher-Nachher-Vergleich im PDF, mit Annehmen, Ablehnen und Kommentieren." width="900">
</picture>
</a>
</p>

<a id="-you-care-about-the-pdfbrnot-the-tex-behind-it"></a>

## 📄 Ihnen geht es um das PDF<br>Nicht um das `.tex` dahinter

Artikel, Abschlussarbeiten, Bücher, Folien: Leser sehen immer nur die gesetzte Seite.<br>
**Deshalb sollten Sie auch direkt auf der Seite arbeiten.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/paradigm-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact.png">
    <img src="../assets/readme-showcase/paradigm.png" alt="LaTeX von Hand schreiben, dann LaTeX-Diffs der KI prüfen und jetzt Papilot: Überprüfung des PDFs." width="900">
  </picture>
</p>

**Kein Kompilieren von Diffs im Kopf mehr.**<br>
Bei einem Quelltext-Diff müssen Sie sich das PDF *vorstellen*. Papilot *zeigt* es Ihnen fertig gesetzt.

<a id="-point-at-the-page-and-say-what-you-want"></a>

## 👉 Zeigen Sie auf die Seite und sagen Sie, was Sie möchten

Markieren Sie einen Satz, eine Gleichung oder eine Abbildung und schreiben Sie eine Anmerkung.<br>
**Ihr Agent findet die Stelle im Quelltext. Sie öffnen nie eine `.tex`-Datei.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/notes-app-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact.png">
    <img src="../assets/readme-showcase/notes-app.png" alt="Papilot mit einem Rahmen um eine Gleichung und einem hervorgehobenen Satz im PDF, jeweils mit einer Anmerkung, beide zur nächsten Aufgabe hinzugefügt." width="900">
  </picture>
</p>

<a id="features"></a>

<a id="-your-files-stay-yours"></a>

## 🔒 Ihre Dateien bleiben Ihre Dateien

<img src="../assets/readme-icons/folder.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Gewöhnliche Dateien auf Ihrem Rechner.** Jede Änderung landet in Ihrer Git-Historie.

<img src="../assets/readme-icons/git.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Mit Koautorinnen und Koautoren über Git synchronisieren.** Pullen, pushen und lassen Sie einen Agenten Konflikte lösen.

<img src="../assets/readme-icons/code.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Kostenlos und Open Source.** MIT-lizenziert, für macOS, Linux und Windows.

<a id="agents"></a>

<a id="-bring-the-ai-agent-you-already-use"></a>

## 🤖 Nutzen Sie den KI-Agenten, den Sie bereits verwenden

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

## 📥 Downloads

<!-- BEGIN DOWNLOADS -->
| System / Distribution | Download / Paket | Installieren / starten |
| --- | --- | --- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/apple-dark.svg"><img src="../assets/readme-icons/apple.svg" width="18" height="18" align="absmiddle" alt=""></picture> **macOS** | [Apple Silicon](https://github.com/PapilotAI/papilot/releases/latest) · [Intel](https://github.com/PapilotAI/papilot/releases/latest)<br>DMG / ZIP | DMG öffnen und Papilot in den Programme-Ordner ziehen. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/windows-dark.svg"><img src="../assets/readme-icons/windows.svg" width="18" height="18" align="absmiddle" alt=""></picture> **Windows** | [Installer](https://github.com/PapilotAI/papilot/releases/latest) · [Portable Version](https://github.com/PapilotAI/papilot/releases/latest)<br>x64 | Installer ausführen oder die portable Version direkt öffnen. |
| <img src="../assets/readme-icons/ubuntu.svg" width="18" height="18" align="absmiddle" alt=""> <img src="../assets/readme-icons/debian.svg" width="18" height="18" align="absmiddle" alt=""> **Ubuntu / Debian / Linux Mint** | [.deb](https://github.com/PapilotAI/papilot/releases/latest) | `sudo apt install ./Papilot-*.deb` |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/linux-dark.svg"><img src="../assets/readme-icons/linux.svg" width="18" height="18" align="absmiddle" alt=""></picture> **Fedora / Arch / openSUSE** | [AppImage](https://github.com/PapilotAI/papilot/releases/latest) | `chmod +x Papilot-*.AppImage`<br>`./Papilot-*.AppImage` |
| <img src="../assets/readme-icons/nixos.svg" width="18" height="18" align="absmiddle" alt=""> **NixOS** | [Nix flake](../nix.md#nixos-flake) | [In `flake.nix` eintragen](../nix.md#nixos-flake) |
| **macOS / Linux / Windows (CLI)** | [npm](https://www.npmjs.com/package/papilot) | `npm install -g papilot` |

Die Linux-Pakete sind für x86_64 und wurden unter Ubuntu 22.04 getestet. Abhängigkeiten und Hilfe zu AppImage/FUSE stehen in der [Desktop-Anleitung](../../desktop/README.md#build-and-run).

Das npm-Paket öffnet die Browseroberfläche und benötigt Node.js 22.22+. Für Nix müssen Flakes aktiviert sein; siehe [Nix-Anleitung](../nix.md#nixos-flake).
<!-- END DOWNLOADS -->

<a id="quick-start"></a>

<a id="-get-started"></a>

## 🚀 Erste Schritte

1. **Installieren.** [Laden Sie die App herunter](#downloads) für macOS, Linux oder Windows, oder führen Sie `npm install -g papilot` aus (Node.js 22.22+). Außerdem benötigen Sie Git sowie TeX Live oder MacTeX.
2. **Projekt öffnen.** Wählen Sie den Ordner mit Ihren `.tex`-Dateien aus. Papilot erstellt das PDF.
3. **Agenten auswählen.** Verwenden Sie Ihr vorhandenes CLI-Login oder Ihren API-Schlüssel und markieren Sie anschließend Stellen auf der Seite.

Möchten Sie zuerst ein Beispiel ausprobieren? Führen Sie `papilot demo` aus. Details finden Sie im [Handbuch](../guide.md#install-and-run).

<a id="documentation-and-community"></a>

<a id="-community"></a>

## 🤝 Community

<img src="../assets/readme-icons/issue.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Einen Fehler gefunden oder fehlt eine Funktion?** [Erstellen Sie ein Issue](https://github.com/PapilotAI/papilot/issues/new/choose), gern auch als ersten Entwurf.

<img src="../assets/readme-icons/discussion.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Haben Sie eine Frage oder eine Idee?** [Starten Sie eine Diskussion](https://github.com/PapilotAI/papilot/discussions).

<img src="../assets/readme-icons/pull-request.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Mitwirken.** Pull Requests sind herzlich willkommen, auch solche, die mit KI-Agenten erstellt wurden. Beginnen Sie mit dem [Leitfaden für Beitragende](../../.github/CONTRIBUTING.md).

---

<p align="center"><sub><a href="../../LICENSE">MIT</a> © 2026 PapilotAI. Vielen Dank an unsere Freunde bei <a href="https://linux.do/">LINUX DO</a>.</sub></p>
