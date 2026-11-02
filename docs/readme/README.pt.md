<div align="center">

<h1>
  <img src="../assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>Aprimore artigos em LaTeX com IA e revise as alterações no PDF.</b></p>

<p><a href="https://papilot.ai">Site</a> · <a href="../guide.md">Documentação</a></p>

<p data-language-switcher><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.it.md">Italiano</a> · <a href="README.sv.md">Svenska</a></p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](../../LICENSE)

<p><img src="../assets/demo.gif" alt="Papilot: marque um trecho no PDF, entregue a um agente e revise a alteração diagramada" width="100%"></p>

</div>

O Papilot é um espaço de trabalho local para escrever e aprimorar artigos em LaTeX com agentes de IA. Marque trechos e equações no PDF, deixe um agente editar uma cópia separada do código-fonte e, em seguida, revise as alterações diagramadas e escolha quais manter.

<a id="features"></a>

## Funcionalidades

<table>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-note.jpg"><img src="../assets/readme-note.jpg" alt="Anotações de trechos agrupadas por cor e uma anotação de equação emoldurada no PDF"></a>
<h3>Faça anotações no PDF</h3>
Selecione uma frase ou contorne uma equação e indique o que deve mudar. Agrupe anotações relacionadas por cor para aplicar uma mesma instrução a vários trechos.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-review.jpg"><img src="../assets/readme-review.jpg" alt="Comparação visual de antes e depois na página diagramada com botões Aceitar, Rejeitar e Comentar"></a>
<h3>Revise cada alteração</h3>
Compare as páginas diagramadas antes e depois, incluindo alterações em outras partes, como equações renumeradas. Aceite, rejeite ou comente cada edição e desfaça decisões durante a revisão.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-deliver.jpg"><img src="../assets/readme-deliver.jpg" alt="Aplicar edições aceitas ao manuscrito"></a>
<h3>Escolha o destino das edições</h3>
Cada nova tarefa funciona em sua própria cópia do artigo. Revise as edições e escolha **Fazer commit no manuscrito** para salvar a tarefa como um único commit no branch atual, ou **Aplicar ao espaço de trabalho** para manter as edições sem commit. Se o mesmo trecho tiver sido alterado nesse meio-tempo, a IA resolve o conflito automaticamente e só pergunta a você quando o conteúdo pretendido não estiver claro. Revise o PDF mesclado antes de salvar. Faça push pelo painel do Git quando estiver tudo pronto.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-git.jpg"><img src="../assets/readme-git.jpg" alt="Painel do Git com arquivos preparados, mensagem de commit gerada e grafo de commits"></a>
<h3>Trabalhe com o Git</h3>
Prepare arquivos e faça commit, pull e push diretamente do espaço de trabalho. Um agente pode redigir mensagens de commit e ajudar a resolver conflitos de mesclagem; o grafo de commits mostra a árvore de trabalho de cada tarefa.
</td>
</tr>
</table>

- **[Habilidades](../guide.md#skills) e [anexos](../guide.md#task-attachments):** Execute habilidades com `/` para aprimorar a redação, revisar o texto ou verificar expressões matemáticas, defina habilidades personalizadas nas Configurações e anexe arquivos de referência ou imagens a tarefas e mensagens.
- **Leitura e espaço de trabalho:** Navegue pelos manuscritos usando o sumário do PDF e a busca em texto completo, com temas claro e escuro e interface em inglês ou chinês.

<a id="quick-start"></a>

## Início rápido

Para os aplicativos desktop para macOS e Linux e as instruções de compilação local, consulte [Papilot Desktop](../../desktop/README.md). O CI do aplicativo desktop gera instaladores para Mac com Apple Silicon e Intel, além de pacotes AppImage e deb para Linux x64.

O Papilot requer **Node.js 22.22+**, **Git** e uma distribuição **TeX** completa com `latexmk` e `synctex` ([MacTeX](https://www.tug.org/mactex/) ou [TeX Live](https://www.tug.org/texlive/)). A revisão de um artigo também requer pelo menos um [agente](#agents) configurado.

```sh
npm install -g papilot
papilot demo
```

Abra [http://127.0.0.1:7274](http://127.0.0.1:7274) e selecione **Manuscrito** na barra lateral para explorar o artigo de exemplo incluído.

Para trabalhar em seu próprio manuscrito, execute `papilot` e escolha **Adicionar artigo…** para abrir uma pasta LaTeX local ou um arquivo ZIP. O Papilot procura o arquivo `.tex` principal, prepara o histórico do Git quando necessário e tenta realizar a compilação. Se o arquivo principal for ambíguo ou a compilação falhar, a janela de importação ajudará você a escolher um arquivo ou corrigir o problema.

Verifique sua configuração em **Configurações → Ambiente de execução**, em **Agentes** ou **LaTeX**. Execute `papilot doctor` para verificações do ambiente ou `papilot doctor --repo /path/to/paper` para verificar também um manuscrito ([diagnóstico](../guide.md#diagnostics)).

<a id="agents"></a>

## Agentes

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

Você pode escolher um agente e um modelo para cada tarefa. Dependendo da integração, o Papilot executa os agentes usando a autenticação da CLI local de cada um ou as credenciais de API do provedor fornecidas por você, sem armazenar suas chaves.

Abra **Configurações → Ambiente de execução → Agentes** para verificar o status, os modelos e as instruções de configuração (como `papilot codex login`). Clique em **Reconectar** após instalar ou fazer login em um agente enquanto o Papilot estiver em execução, ou reinicie o `papilot` após alterar variáveis de ambiente. Consulte o [guia de agentes](../guide.md#agents) para ver os requisitos e recursos de cada agente.

<a id="documentation-and-community"></a>

## Documentação e comunidade

- **Documentação:** Leia o [Guia do Usuário](../guide.md) para conhecer os fluxos de trabalho do espaço de trabalho, a configuração, as [atualizações no aplicativo](../guide.md#updates), o [acesso remoto com Tailscale](../guide.md#remote-access-with-tailscale) e o [compartilhamento de chaves de acesso para colaboradores](../guide.md#collaborators).
- **Arquitetura e histórico:** Explore [`examples/papilot-paper`](../../examples/papilot-paper) para ler o artigo formal de projeto e as demonstrações, e consulte o [Changelog](../../CHANGELOG.md) para ver as notas de lançamento.
- **Comunidade e suporte:** Tire dúvidas em [Discussions](https://github.com/PapilotAI/papilot/discussions), relate problemas em [Issues](https://github.com/PapilotAI/papilot/issues) ou leia [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) para contribuir.

---

[MIT](../../LICENSE) © 2026 PapilotAI

Amigos: [LINUX DO](https://linux.do/).
