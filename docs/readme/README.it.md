<div align="center">

<h1>
  <img src="../assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>Rivedi gli articoli LaTeX con l'IA e revisiona le modifiche sul PDF.</b></p>

<p><a href="https://papilot.ai">Sito web</a> · <a href="../guide.md">Documentazione</a></p>

<p data-language-switcher><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.it.md">Italiano</a> · <a href="README.sv.md">Svenska</a></p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](../../LICENSE)

<p><img src="../assets/demo.gif" alt="Papilot: annota un passaggio sul PDF, affidalo a un agente e revisiona la modifica impaginata" width="100%"></p>

</div>

Papilot è uno spazio di lavoro locale per scrivere e rivedere articoli LaTeX con agenti IA. Annota passaggi ed equazioni sul PDF, lascia che un agente modifichi una copia separata del sorgente, quindi revisiona le modifiche impaginate e scegli quali mantenere.

<a id="features"></a>

## Funzionalità

<table>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-note.jpg"><img src="../assets/readme-note.jpg" alt="Annotazioni sui passaggi raggruppate per colore e un'annotazione con riquadro su un'equazione nel PDF"></a>
<h3>Annota il PDF</h3>
Seleziona una frase o racchiudi un'equazione in un riquadro e indica cosa modificare. Raggruppa le annotazioni correlate per colore per fornire un'unica istruzione a più passaggi.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-review.jpg"><img src="../assets/readme-review.jpg" alt="Confronto prima e dopo dell'impaginato sulla pagina con i pulsanti Accetta, Rifiuta e Commenta"></a>
<h3>Revisiona ogni modifica</h3>
Confronta le pagine impaginate prima e dopo, incluse le modifiche in altri punti come le equazioni rinumerate. Accetta, rifiuta o commenta ogni modifica e annulla le decisioni durante la revisione.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-deliver.jpg"><img src="../assets/readme-deliver.jpg" alt="Applica le modifiche accettate al manoscritto"></a>
<h3>Scegli dove applicare le modifiche</h3>
Ogni nuova attività lavora su una propria copia dell'articolo. Revisiona le modifiche, quindi scegli **Esegui commit nel manoscritto** per salvare questa attività come un singolo commit sul ramo corrente, oppure **Applica allo spazio di lavoro** per lasciare le modifiche senza commit. Se lo stesso passaggio è cambiato nel frattempo, l'IA risolve il conflitto automaticamente e ti interpella solo quando il contenuto desiderato non è chiaro. Revisiona il PDF unito prima di salvare. Esegui il push dal pannello Git quando sei pronto.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-git.jpg"><img src="../assets/readme-git.jpg" alt="Pannello Git con file preparati per il commit, messaggio di commit generato e grafico dei commit"></a>
<h3>Lavora con Git</h3>
Prepara i file ed esegui commit, pull e push dallo spazio di lavoro. Un agente può redigere i messaggi di commit e aiutare a risolvere i conflitti di unione; il grafico dei commit mostra l'albero di lavoro di ciascuna attività.
</td>
</tr>
</table>

- **[Abilità](../guide.md#skills) e [allegati](../guide.md#task-attachments):** Esegui le abilità con `/` per perfezionare la prosa, correggere le bozze o verificare la matematica, definisci abilità personalizzate nelle Impostazioni e allega file o immagini di riferimento ad attività e messaggi.
- **Lettura e spazio di lavoro:** Naviga nei manoscritti con l'indice del PDF e la ricerca a tutto testo, con temi chiaro e scuro e un'interfaccia in inglese o cinese.

<a id="quick-start"></a>

## Avvio rapido

Per le app desktop per macOS e Linux e le istruzioni di compilazione locale, consulta [Papilot Desktop](../../desktop/README.md). La CI desktop genera programmi di installazione per Mac Apple Silicon e Intel, oltre a pacchetti AppImage e deb per Linux x64.

Papilot richiede **Node.js 22.22+**, **Git** e una distribuzione **TeX** completa con `latexmk` e `synctex` ([MacTeX](https://www.tug.org/mactex/) o [TeX Live](https://www.tug.org/texlive/)). Per rivedere un articolo è inoltre necessario almeno un [agente](#agents) configurato.

```sh
npm install -g papilot
papilot demo
```

Apri [http://127.0.0.1:7274](http://127.0.0.1:7274) e seleziona **Manoscritto** nella barra laterale per esplorare l'articolo di esempio incluso.

Per lavorare sul tuo manoscritto, esegui `papilot` e scegli **Aggiungi articolo…** per aprire una cartella LaTeX locale o un archivio ZIP. Papilot cerca il file `.tex` principale, prepara la cronologia Git quando necessario e tenta la compilazione. Se il file principale è ambiguo o la compilazione non riesce, la finestra di importazione ti aiuta a scegliere un file o a risolvere il problema.

Verifica la configurazione in **Impostazioni → Runtime**, sotto **Agenti** o **LaTeX**. Esegui `papilot doctor` per i controlli dell'ambiente, oppure `papilot doctor --repo /path/to/paper` per controllare anche un manoscritto ([diagnostica](../guide.md#diagnostics)).

<a id="agents"></a>

## Agenti

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

Puoi scegliere un agente e un modello per ciascuna attività. A seconda dell'integrazione, Papilot esegue gli agenti utilizzando l'accesso della relativa CLI locale o le credenziali API del fornitore da te indicate, senza memorizzare le tue chiavi.

Apri **Impostazioni → Runtime → Agenti** per verificare stato, modelli e istruzioni di configurazione (come `papilot codex login`). Fai clic su **Riconnetti** dopo aver installato o effettuato l'accesso a un agente mentre Papilot è in esecuzione, oppure riavvia `papilot` dopo aver modificato le variabili d'ambiente. Consulta la [guida agli agenti](../guide.md#agents) per i requisiti e le funzionalità di ciascun agente.

<a id="documentation-and-community"></a>

## Documentazione e comunità

- **Documentazione:** Leggi la [Guida utente](../guide.md) per i flussi di lavoro dello spazio di lavoro, la configurazione, gli [aggiornamenti nell'app](../guide.md#updates), l'[accesso remoto con Tailscale](../guide.md#remote-access-with-tailscale) e la [condivisione tramite passkey per i collaboratori](../guide.md#collaborators).
- **Progettazione e cronologia:** Esplora [`examples/papilot-paper`](../../examples/papilot-paper) per l'articolo formale di progettazione e le dimostrazioni, e consulta il [Changelog](../../CHANGELOG.md) per le note di rilascio.
- **Comunità e supporto:** Poni domande in [Discussions](https://github.com/PapilotAI/papilot/discussions), segnala bug in [Issues](https://github.com/PapilotAI/papilot/issues) o leggi [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) per contribuire.

---

[MIT](../../LICENSE) © 2026 PapilotAI

Amici: [LINUX DO](https://linux.do/).
