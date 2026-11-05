<div align="center">

<img src="../assets/wordmark.svg#gh-light-mode-only" width="220" height="69" alt="Papilot"><img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="220" height="69" alt="Papilot"><br>**Editor LaTeX com IA de Nova Geração**

# Não leia nem escreva `.tex`<br>Trabalhe diretamente no <img src="../assets/pdf.svg" width="34" height="41" align="absmiddle" alt="PDF">

Um **novo paradigma** para escrita e diagramação responsáveis com IA.

**[Baixar o Papilot](https://github.com/PapilotAI/papilot/releases/latest)** para <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/apple-dark.svg"><img src="../assets/readme-icons/apple.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;macOS (Apple&nbsp;Silicon&nbsp;/&nbsp;Intel)<br>e <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/linux-dark.svg"><img src="../assets/readme-icons/linux.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;Linux (AppImage / <img src="../assets/readme-icons/ubuntu.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Ubuntu / <img src="../assets/readme-icons/debian.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Debian / <img src="../assets/readme-icons/nixos.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;NixOS),<br>ou execute `npm install -g papilot`.

<a href="https://papilot.ai">
<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/hero-compact-dark.png">
  <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/hero-dark.png">
  <source media="(max-width: 600px)" srcset="../assets/readme-showcase/hero-compact.png">
  <img src="../assets/readme-showcase/hero.png" alt="O Papilot mostra uma edição de IA como um antes e depois diagramado no PDF, com Aceitar, Rejeitar e Comentar." width="900">
</picture>
</a>

</div>

<a id="-you-care-about-the-pdfbrnot-the-tex-behind-it"></a>

## 📄 O que importa é o PDF<br>Não o `.tex` por trás dele

Artigos, teses, livros, slides: os leitores só veem a página diagramada.<br>
**Portanto, é na página que você também deve trabalhar.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/paradigm-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact.png">
    <img src="../assets/readme-showcase/paradigm.png" alt="Escrever LaTeX à mão, depois verificar diffs de LaTeX gerados por IA e, agora, o Papilot: fazer a revisão do PDF." width="900">
  </picture>
</p>

**Chega de compilar diffs na cabeça.**<br>
Um diff no código-fonte faz você *imaginar* o PDF. O Papilot *mostra* o resultado diagramado para você.

<a id="-point-at-the-page-and-say-what-you-want"></a>

## 👉 Aponte para a página e diga o que deseja

Marque uma frase, uma equação ou uma figura e escreva uma anotação.<br>
**Seu agente encontra o código-fonte. Você nunca abre um arquivo `.tex`.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/notes-app-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact.png">
    <img src="../assets/readme-showcase/notes-app.png" alt="O Papilot com um quadro ao redor de uma equação e uma frase destacada no PDF, cada uma com uma anotação, ambas adicionadas à próxima tarefa." width="900">
  </picture>
</p>

<a id="features"></a>

<a id="-your-files-stay-yours"></a>

## 🔒 Seus arquivos continuam sendo seus

<img src="../assets/readme-icons/folder.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Arquivos simples na sua máquina.** Cada alteração é registrada no seu histórico do Git.

<img src="../assets/readme-icons/git.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Sincronize com coautores pelo Git.** Faça pull, push e deixe um agente resolver conflitos.

<img src="../assets/readme-icons/code.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Gratuito e de código aberto.** Licenciado sob MIT, para macOS e Linux.

<a id="agents"></a>

<a id="-bring-the-ai-agent-you-already-use"></a>

## 🤖 Traga o agente de IA que você já usa

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

## 🚀 Comece a usar

1. **Instale.** [Baixe o aplicativo](https://github.com/PapilotAI/papilot/releases/latest) para macOS ou Linux, ou execute `npm install -g papilot` (Node.js 22.22+). Você também precisa do Git e do TeX Live ou MacTeX.
2. **Abra seu projeto.** Escolha a pasta com seus arquivos `.tex`. O Papilot compila o PDF.
3. **Escolha um agente.** Use o login de CLI ou a chave de API que você já tem e faça marcações na página.

Quer ver um exemplo primeiro? Execute `papilot demo`. Os detalhes estão no [guia](../guide.md#install-and-run).

<a id="documentation-and-community"></a>

<a id="-community"></a>

## 🤝 Comunidade

<img src="../assets/readme-icons/issue.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Encontrou um bug ou sentiu falta de um recurso?** [Abra uma issue](https://github.com/PapilotAI/papilot/issues/new/choose), mesmo que seja um rascunho.

<img src="../assets/readme-icons/discussion.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Tem uma dúvida ou uma ideia?** [Inicie uma discussão](https://github.com/PapilotAI/papilot/discussions).

<img src="../assets/readme-icons/pull-request.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Torne-se um colaborador.** Pull requests são muito bem-vindos, inclusive os escritos com agentes de IA. Comece pelo [guia de contribuição](../../.github/CONTRIBUTING.md).

---

<div align="center">

<p data-language-switcher><sub><a href="../../README.md">English</a>&nbsp;· <a href="README.zh-CN.md">简体中文</a>&nbsp;· <a href="README.zh-Hant.md">繁體中文</a>&nbsp;· <a href="README.ja.md">日本語</a>&nbsp;· <a href="README.ko.md">한국어</a>&nbsp;· <a href="README.de.md">Deutsch</a>&nbsp;· <a href="README.fr.md">Français</a>&nbsp;· <a href="README.es.md">Español</a>&nbsp;· <a href="README.pt.md">Português</a>&nbsp;· <a href="README.it.md">Italiano</a>&nbsp;· <a href="README.sv.md">Svenska</a></sub></p>

</div>

<p align="center"><sub><a href="../../LICENSE">MIT</a> © 2026 PapilotAI. Agradecimentos aos nossos amigos da <a href="https://linux.do/">LINUX DO</a>.</sub></p>
