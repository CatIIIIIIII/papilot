<div align="center">

<h1>
  <img src="../assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>Retravaillez vos articles LaTeX avec l’IA et révisez les modifications sur le PDF.</b></p>

<p><a href="https://papilot.ai">Site web</a> · <a href="../guide.md">Documentation</a></p>

<p data-language-switcher><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.it.md">Italiano</a> · <a href="README.sv.md">Svenska</a></p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](../../LICENSE)

<p><img src="../assets/demo.gif" alt="Papilot : annotez un passage sur le PDF, confiez-le à un agent et révisez la modification compilée" width="100%"></p>

</div>

Papilot est un espace de travail local pour rédiger et retravailler des articles LaTeX avec des agents IA. Annotez des passages et des équations sur le PDF, laissez un agent modifier une copie séparée des sources, puis révisez les modifications compilées et choisissez celles à conserver.

<a id="features"></a>

## Fonctionnalités

<table>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-note.jpg"><img src="../assets/readme-note.jpg" alt="Annotations de passages regroupées par couleur et annotation d’équation encadrée sur le PDF"></a>
<h3>Annoter le PDF</h3>
Sélectionnez une phrase ou encadrez une équation et indiquez ce qui doit changer. Regroupez les annotations liées par couleur pour donner une seule instruction à plusieurs passages.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-review.jpg"><img src="../assets/readme-review.jpg" alt="Comparaison avant/après de la page compilée avec les boutons Accepter, Rejeter et Commenter"></a>
<h3>Réviser chaque modification</h3>
Comparez les pages compilées avant et après, y compris les modifications ailleurs dans le document telles que les équations renumérotées. Acceptez, rejetez ou commentez chaque modification, et annulez vos décisions au fil de la révision.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-deliver.jpg"><img src="../assets/readme-deliver.jpg" alt="Appliquer les modifications acceptées au manuscrit"></a>
<h3>Choisir la destination des modifications</h3>
Chaque nouvelle tâche travaille sur sa propre copie de l’article. Révisez les modifications, puis choisissez **Valider dans le manuscrit** pour enregistrer cette tâche en un seul commit sur votre branche actuelle, ou **Appliquer à l’espace de travail** pour laisser les modifications non validées. Si le même passage a été modifié entre-temps, l’IA résout automatiquement le conflit et ne vous sollicite que lorsque le contenu souhaité est ambigu. Révisez le PDF fusionné avant d’enregistrer. Poussez les modifications depuis le panneau Git lorsque vous êtes prêt.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-git.jpg"><img src="../assets/readme-git.jpg" alt="Panneau Git avec fichiers indexés, message de commit généré et graphe des commits"></a>
<h3>Travailler avec Git</h3>
Indexez et validez des fichiers, récupérez et poussez les modifications depuis l’espace de travail. Un agent peut rédiger des messages de commit et aider à résoudre les conflits de fusion ; le graphe des commits affiche l’arbre de travail de chaque tâche.
</td>
</tr>
</table>

- **[Compétences](../guide.md#skills) et [pièces jointes](../guide.md#task-attachments) :** Exécutez des compétences via `/` pour peaufiner le style, relire le texte ou vérifier les mathématiques, définissez des compétences personnalisées dans les Paramètres et joignez des fichiers de référence ou des images aux tâches et aux messages.
- **Lecture et espace de travail :** Parcourez vos manuscrits grâce à la table des matières du PDF et à la recherche plein texte, avec des thèmes clair et sombre et une interface en anglais ou en chinois.

<a id="quick-start"></a>

## Démarrage rapide

Pour les applications de bureau macOS et Linux ainsi que les instructions de compilation locale, consultez [Papilot Desktop](../../desktop/README.md). L’intégration continue (CI) génère des installateurs Mac pour Apple Silicon et Intel, ainsi que des paquets Linux x64 AppImage et deb.

Papilot nécessite **Node.js 22.22+**, **Git** et une distribution **TeX** complète incluant `latexmk` et `synctex` ([MacTeX](https://www.tug.org/mactex/) ou [TeX Live](https://www.tug.org/texlive/)). La révision d’un article nécessite également au moins un [agent](#agents) configuré.

```sh
npm install -g papilot
papilot demo
```

Ouvrez [http://127.0.0.1:7274](http://127.0.0.1:7274) et sélectionnez **Manuscrit** dans la barre latérale pour explorer l’article d’exemple inclus.

Pour travailler sur votre propre manuscrit, exécutez `papilot` et choisissez **Ajouter un article…** pour ouvrir un dossier LaTeX local ou une archive ZIP. Papilot recherche le fichier `.tex` principal, prépare l’historique Git si nécessaire et lance la compilation. Si le fichier principal est ambigu ou si la compilation échoue, la boîte de dialogue d’importation vous aide à choisir un fichier ou à corriger le problème.

Vérifiez votre configuration dans **Paramètres → Environnement d’exécution**, sous **Agents** ou **LaTeX**. Exécutez `papilot doctor` pour vérifier l’environnement, ou `papilot doctor --repo /path/to/paper` pour vérifier également un manuscrit ([diagnostics](../guide.md#diagnostics)).

<a id="agents"></a>

## Agents

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

Vous pouvez choisir un agent et un modèle pour chaque tâche. Selon l’intégration, Papilot exécute les agents via leur connexion CLI locale ou à l’aide des identifiants d’API du fournisseur que vous indiquez, sans stocker vos clés.

Ouvrez **Paramètres → Environnement d’exécution → Agents** pour vérifier l’état, les modèles et les instructions de configuration (comme `papilot codex login`). Cliquez sur **Reconnecter** après avoir installé un agent ou vous y être connecté pendant que Papilot est en cours d’exécution, ou redémarrez `papilot` après avoir modifié des variables d’environnement. Consultez le [guide des agents](../guide.md#agents) pour connaître les prérequis et les capacités de chaque agent.

<a id="documentation-and-community"></a>

## Documentation et communauté

- **Documentation :** Consultez le [Guide d’utilisation](../guide.md) pour découvrir les flux de travail de l’espace de travail, la configuration, les [mises à jour intégrées](../guide.md#updates), l’[accès à distance avec Tailscale](../guide.md#remote-access-with-tailscale) et le [partage par clé d’accès pour les collaborateurs](../guide.md#collaborators).
- **Conception et historique :** Explorez [`examples/papilot-paper`](../../examples/papilot-paper) pour consulter l’article formel de conception et les démonstrations, et consultez le [Journal des modifications](../../CHANGELOG.md) pour les notes de version.
- **Communauté et assistance :** Posez vos questions dans [Discussions](https://github.com/PapilotAI/papilot/discussions), signalez des bogues dans [Issues](https://github.com/PapilotAI/papilot/issues) ou lisez [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) pour contribuer.

---

[MIT](../../LICENSE) © 2026 PapilotAI

Amis : [LINUX DO](https://linux.do/).
