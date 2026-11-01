# Contributing to Papilot

Thanks for helping. Papilot is young, so every bug report, idea and pull request shapes it.

## Ways to help

- **Try it and tell us what broke.** Open an [issue](https://github.com/cu1ch3n/papilot/issues/new/choose) with your Papilot version (`papilot --version`), your OS, Node.js and TeX distribution, and the steps to reproduce.
- **Share ideas and questions** in [Discussions](https://github.com/cu1ch3n/papilot/discussions), including how you use Papilot on your own papers.
- **Pick up an issue.** Issues labelled [good first issue](https://github.com/cu1ch3n/papilot/labels/good%20first%20issue) are small and well described; [help wanted](https://github.com/cu1ch3n/papilot/labels/help%20wanted) ones are larger.
- **Improve the docs**: the [README](README.md), its [Chinese version](README.zh-CN.md) and the [guide](docs/guide.md).

## Set up

You need Node.js 22.22+, Git and a full TeX distribution. An agent is only needed to run real tasks; the tests never start one.

```sh
git clone https://github.com/cu1ch3n/papilot && cd papilot
npm ci
npm run setup:review   # install and build the review engine
npm run build
npm start              # http://127.0.0.1:7274
```

`npm run demo` adds the example paper. Use another `PAPILOT_PORT` and `PAPILOT_DATA` to run beside an instance you already use.

`npm run dev` restarts the server when its code changes. After changing the interface, run `npm run build` and reload the page; the server serves the new build without a restart.

To run this checkout alongside your usual instance with separate state:

```sh
npm run build
PAPILOT_PORT=7276 PAPILOT_DATA="$HOME/.papilot-dev" PAPILOT_PUBLIC_ORIGIN= PAPILOT_ACCOUNT_ORIGIN= npm run dev
```

Open `http://127.0.0.1:7276`. For the latest committed development version without running a checkout, use **Settings → Updates → Dev (GitHub main)** in an installed Papilot.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/server` | The Fastify server, the agent adapters (Codex, Claude, Cursor, GLM, Antigravity, and Copilot, Grok, Kimi, DeepSeek, Qwen and OpenCode through ACP), tasks, Git and the PDF build |
| `src/web` | The React interface and the PDF viewer |
| `src/shared.ts` | Types shared by the server and the interface |
| `vendor/latex-review` | The review engine that builds and compares the PDFs, with its own tests |
| `bin/papilot.mjs` | The `papilot` command installed by npm |
| `examples/papilot-paper` | The example paper used by `papilot demo` |
| `tests`, `scripts/check-ui.mjs` | Unit tests and the browser checks |

## Before you open a pull request

```sh
npm run typecheck
npm test
npm run test:ui   # interface changes; needs Chrome
```

Changes to the review engine also need `npm test` in `vendor/latex-review`.

- Keep a pull request to one change, and add or update tests for any change in behavior.
- Match the code around you: its naming, comment density and idioms.
- Interface text is in English and says plainly what happens.
- Write commit messages as a short imperative summary, with a body that explains why.
- Attach screenshots for interface changes.

By contributing, you agree that your work is released under the [MIT License](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
