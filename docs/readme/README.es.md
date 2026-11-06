<div align="center">

<img src="../assets/wordmark.svg#gh-light-mode-only" width="220" height="69" alt="Papilot"><img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="220" height="69" alt="Papilot"><br>**Editor de LaTeX con IA de nueva generación**

# No leas ni escribas `.tex`<br>Trabaja directamente sobre el <img src="../assets/pdf.svg" width="34" height="41" align="absmiddle" alt="PDF">

Un **nuevo paradigma** para la escritura y composición tipográfica responsable con IA.

**[Descargar Papilot](https://github.com/PapilotAI/papilot/releases/latest)** para <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/apple-dark.svg"><img src="../assets/readme-icons/apple.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;macOS (Apple&nbsp;Silicon&nbsp;/&nbsp;Intel)<br>y <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/readme-icons/linux-dark.svg"><img src="../assets/readme-icons/linux.svg" width="18" height="18" align="absmiddle" alt=""></picture>&nbsp;Linux (AppImage / <img src="../assets/readme-icons/ubuntu.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Ubuntu / <img src="../assets/readme-icons/debian.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;Debian / <img src="../assets/readme-icons/nixos.svg" width="16" height="16" align="absmiddle" alt="">&nbsp;NixOS),<br>o ejecuta `npm install -g papilot`.

<a href="https://papilot.ai">
<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/hero-compact-dark.png">
  <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/hero-dark.png">
  <source media="(max-width: 600px)" srcset="../assets/readme-showcase/hero-compact.png">
  <img src="../assets/readme-showcase/hero.png" alt="Papilot muestra una edición con IA como un antes y un después compuesto sobre el PDF, con las opciones Aceptar, Rechazar y Comentar." width="900">
</picture>
</a>

</div>

<a id="-you-care-about-the-pdfbrnot-the-tex-behind-it"></a>

## 📄 Lo que te importa es el PDF<br>No el `.tex` que hay detrás

Artículos, tesis, libros, presentaciones: los lectores solo ven la página compuesta.<br>
**Por eso la página también es donde deberías trabajar.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/paradigm-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/paradigm-compact.png">
    <img src="../assets/readme-showcase/paradigm.png" alt="Escribir LaTeX a mano, luego comprobar diffs de LaTeX de la IA y ahora Papilot: revisar el PDF." width="900">
  </picture>
</p>

**Olvídate de compilar diferencias en tu cabeza.**<br>
Un diff del código fuente te obliga a *imaginar* el PDF. Papilot te lo *muestra* directamente compuesto.

<a id="-point-at-the-page-and-say-what-you-want"></a>

## 👉 Señala en la página y di lo que quieres

Marca una oración, una ecuación o una figura y escribe una anotación.<br>
**Tu agente localiza el código fuente. Nunca tendrás que abrir un archivo `.tex`.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact-dark.png">
    <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-showcase/notes-app-dark.png">
    <source media="(max-width: 600px)" srcset="../assets/readme-showcase/notes-app-compact.png">
    <img src="../assets/readme-showcase/notes-app.png" alt="Papilot con un recuadro alrededor de una ecuación y una oración resaltada en el PDF, cada una con una anotación y ambas añadidas a la siguiente tarea." width="900">
  </picture>
</p>

<a id="features"></a>

<a id="-your-files-stay-yours"></a>

## 🔒 Tus archivos siguen siendo tuyos

<img src="../assets/readme-icons/folder.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Archivos simples en tu equipo.** Cada cambio queda registrado en tu historial de Git.

<img src="../assets/readme-icons/git.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Sincroniza con coautores mediante Git.** Extrae cambios, súbelos y deja que un agente resuelva los conflictos.

<img src="../assets/readme-icons/code.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Gratuito y de código abierto.** Bajo licencia MIT, para macOS y Linux.

<a id="agents"></a>

<a id="-bring-the-ai-agent-you-already-use"></a>

## 🤖 Usa el agente de IA que ya utilizas

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

## 🚀 Primeros pasos

1. **Instalar.** [Descarga la aplicación](https://github.com/PapilotAI/papilot/releases/latest) para macOS o Linux, o ejecuta `npm install -g papilot` (Node.js 22.22+). También necesitarás Git y TeX Live o MacTeX.
2. **Abrir tu proyecto.** Elige la carpeta con tus archivos `.tex`. Papilot compila el PDF.
3. **Elegir un agente.** Usa el inicio de sesión por CLI o la clave de API que ya tengas y haz anotaciones en la página.

¿Quieres probar primero con un ejemplo? Ejecuta `papilot demo`. Encontrarás los detalles en la [guía](../guide.md#install-and-run).

<a id="documentation-and-community"></a>

<a id="-community"></a>

## 🤝 Comunidad

<img src="../assets/readme-icons/issue.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**¿Has encontrado un error o echas en falta alguna función?** [Abre un issue](https://github.com/PapilotAI/papilot/issues/new/choose), aunque sea un borrador.

<img src="../assets/readme-icons/discussion.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**¿Tienes una pregunta o una idea?** [Inicia un debate](https://github.com/PapilotAI/papilot/discussions).

<img src="../assets/readme-icons/pull-request.svg" width="20" height="20" align="absmiddle" alt=""> &nbsp;**Conviértete en colaborador.** Los pull requests son muy bienvenidos, incluidos los redactados con agentes de IA. Empieza consultando la [guía de contribución](../../.github/CONTRIBUTING.md).

---

<div align="center">

<p data-language-switcher><sub><a href="../../README.md">English</a>&nbsp;· <a href="README.zh-CN.md">简体中文</a>&nbsp;· <a href="README.zh-Hant.md">繁體中文</a>&nbsp;· <a href="README.ja.md">日本語</a>&nbsp;· <a href="README.ko.md">한국어</a>&nbsp;· <a href="README.de.md">Deutsch</a>&nbsp;· <a href="README.fr.md">Français</a>&nbsp;· <a href="README.es.md">Español</a>&nbsp;· <a href="README.pt.md">Português</a>&nbsp;· <a href="README.it.md">Italiano</a>&nbsp;· <a href="README.sv.md">Svenska</a></sub></p>

</div>

<p align="center"><sub><a href="../../LICENSE">MIT</a> © 2026 PapilotAI. Gracias a nuestros amigos de <a href="https://linux.do/">LINUX DO</a>.</sub></p>
