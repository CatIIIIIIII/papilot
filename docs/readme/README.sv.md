<div align="center">

<img src="../assets/wordmark.svg#gh-light-mode-only" width="220" height="69" alt="Papilot"><img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="220" height="69" alt="Papilot"><br>**Nästa generations AI-drivna LaTeX-redigerare**

# Läs eller skriv inte `.tex`<br>Arbeta direkt i <img src="../assets/pdf.svg" width="34" height="41" align="absmiddle" alt="PDF">

Ett **nytt paradigm** för ansvarsfullt skrivande och typsättning med AI.

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
  <img src="../assets/readme-showcase/hero.png" alt="Papilot visar en AI-redigering som typsatt före-och-efter direkt i PDF:en, med Acceptera, Avvisa och Kommentera." width="900">
</picture>
</a>
</p>

<a id="-you-care-about-the-pdfbrnot-the-tex-behind-it"></a>

## 📄 Du bryr dig om PDF:en<br>Inte om `.tex`-koden bakom den

Artiklar, avhandlingar, böcker, presentationer: läsarna ser bara den typsatta sidan.<br>
**Därför är det också på sidan du bör arbeta.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/paradigm-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact.png">
    <img src="../assets/readme-showcase/paradigm.png" alt="Att skriva LaTeX för hand, sedan kontrollera LaTeX-diffar från AI, och nu Papilot: granskning av PDF:en." width="900">
  </picture>
</p>

**Sluta kompilera diffar i huvudet.**<br>
En källkodsdiff tvingar dig att *föreställa dig* PDF:en. Papilot *visar* den för dig, färdigtypsatt.

<a id="-point-at-the-page-and-say-what-you-want"></a>

## 👉 Peka på sidan och säg vad du vill ha

Markera en mening, en ekvation eller en figur och skriv en anteckning.<br>
**Din agent hittar källkoden. Du behöver aldrig öppna en `.tex`-fil.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/notes-app-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact.png">
    <img src="../assets/readme-showcase/notes-app.png" alt="Papilot med en ruta runt en ekvation och en markerad mening i PDF:en, var och en med en anteckning, båda tillagda i nästa uppgift." width="900">
  </picture>
</p>

<a id="features"></a>

<a id="-your-files-stay-yours"></a>

## 🔒 Dina filer förblir dina

<img src="../assets/readme-icons/folder.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Vanliga filer på din dator.** Varje ändring hamnar i din Git-historik.

<img src="../assets/readme-icons/git.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Synkronisera med medförfattare via Git.** Hämta, skicka och låt en agent lösa konflikter.

<img src="../assets/readme-icons/code.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Fri och öppen källkod.** MIT-licensierad, för macOS, Linux och Windows.

<a id="agents"></a>

<a id="-bring-the-ai-agent-you-already-use"></a>

## 🤖 Använd den AI-agent du redan har

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

## 📥 Nedladdningar

<!-- BEGIN DOWNLOADS -->
| System / distribution | Nedladdning / paket | Installera / starta |
| --- | --- | --- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/apple-dark.svg"><img src="../assets/readme-icons/apple.svg" width="18" height="18" align="absmiddle" alt=""></picture> **macOS** | [Apple Silicon](https://github.com/PapilotAI/papilot/releases/latest) · [Intel](https://github.com/PapilotAI/papilot/releases/latest)<br>DMG / ZIP | Öppna DMG-filen och dra Papilot till Program. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/windows-dark.svg"><img src="../assets/readme-icons/windows.svg" width="18" height="18" align="absmiddle" alt=""></picture> **Windows** | [Installationsprogram](https://github.com/PapilotAI/papilot/releases/latest) · [Portabel version](https://github.com/PapilotAI/papilot/releases/latest)<br>x64 | Kör installationsprogrammet eller öppna den portabla versionen direkt. |
| <img src="../assets/readme-icons/ubuntu.svg" width="18" height="18" align="absmiddle" alt=""> <img src="../assets/readme-icons/debian.svg" width="18" height="18" align="absmiddle" alt=""> **Ubuntu / Debian / Linux Mint** | [.deb](https://github.com/PapilotAI/papilot/releases/latest) | `sudo apt install ./Papilot-*.deb` |
| <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/linux-dark.svg"><img src="../assets/readme-icons/linux.svg" width="18" height="18" align="absmiddle" alt=""></picture> **Fedora / Arch / openSUSE** | [AppImage](https://github.com/PapilotAI/papilot/releases/latest) | `chmod +x Papilot-*.AppImage`<br>`./Papilot-*.AppImage` |
| <img src="../assets/readme-icons/nixos.svg" width="18" height="18" align="absmiddle" alt=""> **NixOS** | [Nix flake](../nix.md#nixos-flake) | [Lägg till i din `flake.nix`](../nix.md#nixos-flake) |
| **macOS / Linux / Windows (CLI)** | [npm](https://www.npmjs.com/package/papilot) | `npm install -g papilot` |

Linux-paketen är för x86_64 och har testats på Ubuntu 22.04. Se [skrivbordsguiden](../../desktop/README.md#build-and-run) för beroenden och hjälp med AppImage/FUSE.

npm-paketet öppnar webbläsargränssnittet och kräver Node.js 22.22+. Nix kräver att flakes är aktiverade; se [Nix-guiden](../nix.md#nixos-flake).
<!-- END DOWNLOADS -->

<a id="quick-start"></a>

<a id="-get-started"></a>

## 🚀 Kom igång

1. **Installera.** [Ladda ner appen](#downloads) för macOS, Linux eller Windows, eller kör `npm install -g papilot` (Node.js 22.22+). Du behöver även Git samt TeX Live eller MacTeX.
2. **Öppna ditt projekt.** Välj mappen med dina `.tex`-filer. Papilot bygger PDF:en.
3. **Välj en agent.** Använd den CLI-inloggning eller API-nyckel du redan har och markera sedan direkt på sidan.

Vill du prova ett exempel först? Kör `papilot demo`. Mer information finns i [guiden](../guide.md#install-and-run).

<a id="documentation-and-community"></a>

<a id="-community"></a>

## 🤝 Gemenskap

<img src="../assets/readme-icons/issue.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Hittat en bugg eller saknar du en funktion?** [Skapa ett ärende](https://github.com/PapilotAI/papilot/issues/new/choose), även ett enkelt utkast räcker.

<img src="../assets/readme-icons/discussion.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Har du en fråga eller en idé?** [Starta en diskussion](https://github.com/PapilotAI/papilot/discussions).

<img src="../assets/readme-icons/pull-request.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Bli en bidragsgivare.** Pull-förfrågningar är varmt välkomna, även sådana som skrivits med AI-agenter. Börja med [riktlinjerna för bidrag](../../.github/CONTRIBUTING.md).

---

<p align="center"><sub><a href="../../LICENSE">MIT</a> © 2026 PapilotAI. Tack till våra vänner på <a href="https://linux.do/">LINUX DO</a>.</sub></p>
