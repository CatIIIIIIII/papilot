<div align="center">

<h1>
  <img src="../assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>LaTeX-Artikel mit KI überarbeiten und die Änderungen im PDF überprüfen.</b></p>

<p><a href="https://papilot.ai">Website</a> · <a href="../guide.md">Dokumentation</a></p>

<p data-language-switcher><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.it.md">Italiano</a> · <a href="README.sv.md">Svenska</a></p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](../../LICENSE)

<p><img src="../assets/demo.gif" alt="Papilot: Eine Textstelle im PDF markieren, an einen Agenten übergeben und die gesetzte Änderung überprüfen" width="100%"></p>

</div>

Papilot ist ein lokaler Arbeitsbereich zum Schreiben und Überarbeiten von LaTeX-Artikeln mit KI-Agenten. Markieren Sie Textstellen und Gleichungen im PDF, lassen Sie einen Agenten eine separate Kopie des Quelltexts bearbeiten, überprüfen Sie anschließend die gesetzten Änderungen und wählen Sie aus, welche übernommen werden sollen.

<a id="features"></a>

## Funktionen

<table>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-note.jpg"><img src="../assets/readme-note.jpg" alt="Farblich gruppierte Textstellen-Anmerkungen und eine eingerahmte Gleichungs-Anmerkung im PDF"></a>
<h3>PDF mit Anmerkungen versehen</h3>
Markieren Sie einen Satz oder rahmen Sie eine Gleichung ein und geben Sie an, was geändert werden soll. Gruppieren Sie zusammengehörige Anmerkungen nach Farbe, um mehreren Textstellen eine gemeinsame Anweisung zu geben.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-review.jpg"><img src="../assets/readme-review.jpg" alt="Gesetzter Vorher-Nachher-Vergleich auf der Seite mit Schaltflächen zum Annehmen, Ablehnen und Kommentieren"></a>
<h3>Jede Änderung überprüfen</h3>
Vergleichen Sie die gesetzten Seiten vorher und nachher, einschließlich Änderungen an anderen Stellen wie neu nummerierten Gleichungen. Nehmen Sie jede Bearbeitung an, lehnen Sie sie ab oder kommentieren Sie sie, und machen Sie Entscheidungen während der Überprüfung jederzeit rückgängig.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-deliver.jpg"><img src="../assets/readme-deliver.jpg" alt="Angenommene Bearbeitungen auf das Manuskript anwenden"></a>
<h3>Ziel für Bearbeitungen wählen</h3>
Jede neue Aufgabe arbeitet mit einer eigenen Kopie des Artikels. Überprüfen Sie die Bearbeitungen und wählen Sie anschließend **Ins Manuskript committen**, um diese Aufgabe als einzelnen Commit auf Ihrem aktuellen Branch zu speichern, oder **Auf Arbeitsbereich anwenden**, um die Bearbeitungen ohne Commit zu übernehmen. Falls dieselbe Textstelle in der Zwischenzeit geändert wurde, löst die KI den Konflikt automatisch auf und fragt nur nach, wenn der beabsichtigte Inhalt unklar ist. Überprüfen Sie das zusammengeführte PDF vor dem Speichern. Pushen Sie über das Git-Panel, sobald Sie bereit sind.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-git.jpg"><img src="../assets/readme-git.jpg" alt="Git-Panel mit vorgemerkten Dateien, generierter Commit-Nachricht und Commit-Graph"></a>
<h3>Mit Git arbeiten</h3>
Merken Sie Dateien vor (Stage), erstellen Sie Commits und führen Sie Pull und Push direkt aus dem Arbeitsbereich aus. Ein Agent kann Commit-Nachrichten entwerfen und beim Auflösen von Merge-Konflikten helfen; der Commit-Graph zeigt den Arbeitsbaum jeder Aufgabe.
</td>
</tr>
</table>

- **[Skills](../guide.md#skills) und [Anhänge](../guide.md#task-attachments):** Führen Sie `/`-Skills aus, um Texte sprachlich zu verfeinern, Korrektur zu lesen oder mathematische Ausdrücke zu prüfen, definieren Sie eigene Skills in den Einstellungen und hängen Sie Referenzdateien oder Bilder an Aufgaben und Nachrichten an.
- **Lesen und Arbeitsbereich:** Navigieren Sie durch Manuskripte mithilfe des PDF-Inhaltsverzeichnisses und der Volltextsuche – mit hellem und dunklem Design sowie einer Benutzeroberfläche auf Englisch oder Chinesisch.

<a id="quick-start"></a>

## Schnellstart

Informationen zu den Desktop-Apps für macOS und Linux sowie Anleitungen zum lokalen Erstellen finden Sie unter [Papilot Desktop](../../desktop/README.md). Die Desktop-CI erstellt Installationsprogramme für Apple-Silicon- und Intel-Macs sowie Linux-x64-AppImage- und deb-Pakete.

Papilot erfordert **Node.js 22.22+**, **Git** und eine vollständige **TeX**-Distribution mit `latexmk` und `synctex` ([MacTeX](https://www.tug.org/mactex/) oder [TeX Live](https://www.tug.org/texlive/)). Für das Überarbeiten eines Artikels ist außerdem mindestens ein konfigurierter [Agent](#agents) erforderlich.

```sh
npm install -g papilot
papilot demo
```

Öffnen Sie [http://127.0.0.1:7274](http://127.0.0.1:7274) und wählen Sie in der Seitenleiste **Manuskript**, um den mitgelieferten Beispielartikel zu erkunden.

Um an Ihrem eigenen Manuskript zu arbeiten, führen Sie `papilot` aus und wählen Sie **Artikel hinzufügen…**, um einen lokalen LaTeX-Ordner oder ein ZIP-Archiv zu öffnen. Papilot sucht nach der `.tex`-Hauptdatei, bereitet bei Bedarf den Git-Verlauf vor und versucht eine Kompilierung. Falls die Hauptdatei nicht eindeutig ist oder das Kompilieren fehlschlägt, hilft Ihnen der Importdialog dabei, eine Datei auszuwählen oder das Problem zu beheben.

Überprüfen Sie Ihre Einrichtung unter **Einstellungen → Laufzeit** im Bereich **Agenten** oder **LaTeX**. Führen Sie `papilot doctor` aus, um die Umgebung zu prüfen, oder `papilot doctor --repo /path/to/paper`, um zusätzlich ein Manuskript zu prüfen ([Diagnose](../guide.md#diagnostics)).

<a id="agents"></a>

## Agenten

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

Sie können für jede Aufgabe einen Agenten und ein Modell auswählen. Je nach Integration führt Papilot Agenten über deren lokale CLI-Anmeldung oder über von Ihnen bereitgestellte API-Zugangsdaten des Anbieters aus, ohne Ihre Schlüssel zu speichern.

Öffnen Sie **Einstellungen → Laufzeit → Agenten**, um Status, Modelle und Einrichtungsanleitungen (wie `papilot codex login`) zu prüfen. Klicken Sie auf **Neu verbinden**, nachdem Sie bei laufendem Papilot einen Agenten installiert oder sich angemeldet haben, oder starten Sie `papilot` nach dem Ändern von Umgebungsvariablen neu. Weitere Informationen zu den Anforderungen und Funktionen der einzelnen Agenten finden Sie im [Agenten-Leitfaden](../guide.md#agents).

<a id="documentation-and-community"></a>

## Dokumentation und Community

- **Dokumentation:** Lesen Sie das [Benutzerhandbuch](../guide.md) für Arbeitsabläufe im Arbeitsbereich, Konfiguration, [In-App-Updates](../guide.md#updates), [Fernzugriff mit Tailscale](../guide.md#remote-access-with-tailscale) und [Passkey-Freigabe für Mitwirkende](../guide.md#collaborators).
- **Design und Verlauf:** Sehen Sie sich [`examples/papilot-paper`](../../examples/papilot-paper) für den formalen Design-Artikel und die Beweise an, und lesen Sie das [Changelog](../../CHANGELOG.md) für die Versionshinweise.
- **Community und Support:** Stellen Sie Fragen in den [Discussions](https://github.com/PapilotAI/papilot/discussions), melden Sie Fehler in den [Issues](https://github.com/PapilotAI/papilot/issues) oder lesen Sie [CONTRIBUTING.md](../../.github/CONTRIBUTING.md), um zum Projekt beizutragen.

---

[MIT](../../LICENSE) © 2026 PapilotAI

Freunde: [LINUX DO](https://linux.do/).
