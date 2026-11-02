# Security policy

## Supported versions

Security fixes go into the latest web and desktop releases. Update the web server with `npm install -g papilot@latest`; update the desktop app using the matching installer from [GitHub Releases](https://github.com/PapilotAI/papilot/releases).

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's vulnerability reporting](https://github.com/PapilotAI/papilot/security/advisories/new) rather than in a public issue. Include the Papilot version, how Papilot was reached (on the same computer, over Tailscale or through an SSH tunnel) and the steps to reproduce. You should hear back within a week.

## What Papilot protects

Papilot listens only on `127.0.0.1`. Remote access goes through Tailscale Serve, and every remote request must match the configured origin and Tailscale login. Agents edit only their task's worktree, and accepted changes reach the manuscript only through the review. Reports about getting around any of this are especially welcome, for example:

- reaching Papilot from another device without the configured Tailscale identity;
- reading or writing files outside a paper's repository and its task worktrees;
- running commands that an agent's sandbox or approval should have stopped;
- review actions that change the manuscript without the author's decision.

Credentials for the agents stay with the agents' own command-line tools; Papilot never reads or stores them.
