# Papilot v0.1

Your paper agents, anywhere.

## Confirmed scope

- A personal, self-hosted TypeScript app on the user's Mac mini.
- One LaTeX Git repository is sufficient; multiple independent Codex sessions must work.
- The agents are official Codex, not a custom LLM/tool execution loop.
- Create tasks, monitor work, review PDF differences, accept/reject/comment, and continue from a phone, tablet, or computer.
- Browser closure must not stop work. Instructions and review history persist.
- Reuse latex-review-skill for isolated worktrees, rendering, review decisions and merging.

## First usable version

1. Register a local LaTeX Git repository, or open the included example paper.
2. Create a task with instructions; the review engine creates an isolated worktree.
3. Start a real Codex conversation in that worktree. Stream useful messages and tool activity to the browser.
4. Surface Codex permission and user-input requests in the task UI.
5. On successful turn completion, compile and publish the worktree using the review engine.
6. Review the actual PDF comparison. Accepted edits go into the manuscript's working tree, uncommitted.
7. Save comments while reviewing, then explicitly send feedback to the same Codex conversation for another round.
8. Keep tasks and messages after restart; interrupted work is shown honestly and can be resumed.

## Concurrency and conflicts

- Each editing task has its own worktree and Codex thread.
- The review engine owns all manuscript writes and its existing transactional three-way merge checks.
- Failed acceptance must preserve both proposals and the manuscript; display the conflict rather than overwriting.
- A Codex revision after a conflict is a new review round, not implicitly accepted.
- Do not change a running agent's worktree through rejection/undo; interrupt it first.
- Semantic consistency still requires review; compilation and clean Git merges are not proof of correctness.

## Remote use

- Listen on loopback. Expose the UI through Tailscale Serve with a configured owner identity, not an unauthenticated public port.
- Keep Codex's app-server transport local to the backend.
- Build and render on the Mac mini, reuse immutable review assets, lazy-load images, and keep the previous round readable while a new one builds.
- This version reuses the existing review viewer. Section-level data pagination and text-layer virtualization are later performance work, not claimed complete.

## Acceptance

- Two task conversations for one example paper can run independently.
- A real Codex turn can edit the example, publish a review, receive a saved comment, and produce another round.
- A second browser can reconnect to the same persisted state.
- Review requests and assets work through the remote origin without referring to localhost on the user's phone.
- Automated checks cover task persistence, RPC request routing, review proxy boundaries and feedback delivery.

## Implementation choices

React/Vite frontend, Fastify backend, SQLite state, official Codex app-server over stdio, Papilot's own review engine in `engine/` (started from latex-review-skill), and launchd for the macOS service. The initial supported use is a single owner over Tailscale.
