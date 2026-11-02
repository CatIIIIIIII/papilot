<div align="center">

<h1>
  <img src="../assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>Revidera LaTeX-artiklar med AI och granska ändringarna i PDF:en.</b></p>

<p><a href="https://papilot.ai">Webbplats</a> · <a href="../guide.md">Dokumentation</a></p>

<p data-language-switcher><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.it.md">Italiano</a> · <a href="README.sv.md">Svenska</a></p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](../../LICENSE)

<p><img src="../assets/demo.gif" alt="Papilot: markera ett avsnitt i PDF:en, lämna över det till en agent och granska den typsatta ändringen" width="100%"></p>

</div>

Papilot är en lokal arbetsyta för att skriva och revidera LaTeX-artiklar med AI-agenter. Markera avsnitt och ekvationer i PDF:en, låt en agent redigera en separat kopia av källkoden, granska sedan de typsatta ändringarna och välj vilka du vill behålla.

<a id="features"></a>

## Funktioner

<table>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-note.jpg"><img src="../assets/readme-note.jpg" alt="Färggrupperade avsnittsanteckningar och en inramad ekvationsanteckning i PDF:en"></a>
<h3>Annotera PDF:en</h3>
Markera en mening eller rama in en ekvation och beskriv vad som ska ändras. Gruppera relaterade anteckningar efter färg för att ge flera avsnitt en gemensam instruktion.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-review.jpg"><img src="../assets/readme-review.jpg" alt="Typsatt jämförelse före och efter på sidan med knapparna Godkänn, Avvisa och Kommentera"></a>
<h3>Granska varje ändring</h3>
Jämför de typsatta sidorna före och efter, inklusive följdändringar på andra ställen såsom omnumrerade ekvationer. Godkänn, avvisa eller kommentera varje ändring och ångra beslut under granskningen.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-deliver.jpg"><img src="../assets/readme-deliver.jpg" alt="Tillämpa godkända ändringar i manuskriptet"></a>
<h3>Välj var ändringarna hamnar</h3>
Varje ny uppgift arbetar på en egen kopia av artikeln. Granska ändringarna och välj sedan **Committa till manuskript** för att spara denna uppgift som en commit på din aktuella gren, eller **Tillämpa i arbetsytan** för att lämna ändringarna utan commit. Om samma avsnitt har ändrats under tiden löser AI:n konflikten automatiskt och frågar dig endast när det avsedda innehållet är oklart. Granska den sammanfogade PDF:en innan du sparar. Gör en push från Git-panelen när du är redo.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-git.jpg"><img src="../assets/readme-git.jpg" alt="Git-panel med stageade filer, genererat commit-meddelande och commit-graf"></a>
<h3>Arbeta med Git</h3>
Stagea och committa filer samt gör pull och push från arbetsytan. En agent kan skriva utkast till commit-meddelanden och hjälpa till att lösa sammanslagningskonflikter; commit-grafen visar varje uppgifts arbetsträd.
</td>
</tr>
</table>

- **[Färdigheter](../guide.md#skills) och [bilagor](../guide.md#task-attachments):** Kör `/`-färdigheter för att finslipa prosa, korrekturläsa eller kontrollera matematik, definiera egna färdigheter i Inställningar och bifoga referensfiler eller bilder till uppgifter och meddelanden.
- **Läsning och arbetsyta:** Navigera i manuskript med PDF:ens innehållsförteckning och fulltextsökning, med ljust och mörkt tema samt ett gränssnitt på engelska eller kinesiska.

<a id="quick-start"></a>

## Snabbstart

För skrivbordsapparna till macOS och Linux samt instruktioner för att bygga lokalt, se [Papilot Desktop](../../desktop/README.md). Desktop CI bygger installationsprogram för Apple Silicon- och Intel-Mac, samt x64 AppImage- och deb-paket för Linux.

Papilot kräver **Node.js 22.22+**, **Git** och en fullständig **TeX**-distribution med `latexmk` och `synctex` ([MacTeX](https://www.tug.org/mactex/) eller [TeX Live](https://www.tug.org/texlive/)). För att revidera en artikel krävs även minst en konfigurerad [agent](#agents).

```sh
npm install -g papilot
papilot demo
```

Öppna [http://127.0.0.1:7274](http://127.0.0.1:7274) och välj **Manuskript** i sidofältet för att utforska den medföljande exempelartikeln.

För att arbeta med ditt eget manuskript kör du `papilot` och väljer **Lägg till artikel…** för att öppna en lokal LaTeX-mapp eller ett ZIP-arkiv. Papilot letar efter den huvudsakliga `.tex`-filen, förbereder Git-historik vid behov och försöker kompilera. Om huvudfilen är tvetydig eller om bygget misslyckas hjälper importdialogen dig att välja en fil eller åtgärda problemet.

Kontrollera din konfiguration i **Inställningar → Körmiljö**, under **Agenter** eller **LaTeX**. Kör `papilot doctor` för miljökontroller, eller `papilot doctor --repo /path/to/paper` för att även kontrollera ett manuskript ([diagnostik](../guide.md#diagnostics)).

<a id="agents"></a>

## Agenter

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

Du kan välja en agent och modell för varje uppgift. Beroende på integrationen kör Papilot agenter via deras lokala CLI-inloggning eller med API-uppgifter från leverantören som du anger, utan att lagra dina nycklar.

Öppna **Inställningar → Körmiljö → Agenter** för att kontrollera status, modeller och installationsanvisningar (till exempel `papilot codex login`). Klicka på **Anslut igen** efter att du har installerat eller loggat in i en agent medan Papilot körs, eller starta om `papilot` efter att ha ändrat miljövariabler. Se [agentguiden](../guide.md#agents) för krav och funktioner för respektive agent.

<a id="documentation-and-community"></a>

## Dokumentation och gemenskap

- **Dokumentation:** Läs [användarhandboken](../guide.md) för arbetsflöden i arbetsytan, konfiguration, [uppdateringar i appen](../guide.md#updates), [fjärråtkomst med Tailscale](../guide.md#remote-access-with-tailscale) och [delning av passkeys för samarbetspartner](../guide.md#collaborators).
- **Design och historik:** Utforska [`examples/papilot-paper`](../../examples/papilot-paper) för den formella designartikeln och bevisen, och läs [ändringsloggen](../../CHANGELOG.md) för versionsinformation.
- **Gemenskap och support:** Ställ frågor i [Discussions](https://github.com/PapilotAI/papilot/discussions), rapportera fel i [Issues](https://github.com/PapilotAI/papilot/issues) eller läs [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) för att bidra.

---

[MIT](../../LICENSE) © 2026 PapilotAI

Vänner: [LINUX DO](https://linux.do/).
