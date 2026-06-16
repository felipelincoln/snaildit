<p align="center">
  <img src="https://raw.githubusercontent.com/felipelincoln/snaildit/main/web/public/logo.png" alt="Snaild.it" width="96" />
</p>

<h1 align="center">Snaild.it</h1>

<p align="center">The open-source AI code reviewer that runs on your own Codex subscription.</p>

---

Snaild.it listens to your repository's webhooks and, on each event, runs `codex exec` on your machine with a prompt you wrote — so it reviews pull requests, triages issues, and pushes fixes exactly how you tell it to. It acts through the `gh` CLI as a GitHub App **you own**, on **your** Codex subscription: no API keys, no per-token billing, no backend to host.

> [!CAUTION]
> **Snaild.it runs `codex exec` on your machine** — an AI agent with write access to the working directory and network access. Use it deliberately:
> - A bad (or malicious) prompt can modify your checked-out code or exfiltrate data over the network.
> - On a **public** repo, anyone who opens an issue or PR feeds text into the agent's prompt — a prompt-injection path to your machine. Start with **private repos you trust**.
> - Scope the GitHub App's permissions to the minimum, and don't run it on a machine holding secrets you can't afford to leak.

## Quickstart

```sh
npx snaildit start
```

This opens a local dashboard with three steps: create a GitHub App you own, pick which repositories it can touch, and connect Codex. After that it runs your automations from your machine.

## Requirements

- Node.js >= 24.15
- A [Codex](https://developers.openai.com/codex/cli/) subscription (logged in via the dashboard)
- The [`gh`](https://cli.github.com/) CLI on your PATH — it injects its own short-lived token, so you don't authenticate `gh` yourself.
- macOS or Linux (Windows isn't supported yet)

(`cloudflared` is downloaded automatically on first run.)

## From source

```sh
git clone https://github.com/felipelincoln/snaildit
cd snaildit
npm install
npm run build
npm start
```
