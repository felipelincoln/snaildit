<p align="center">
  <img src="web/public/logo.png" alt="github-ai-bot" width="96" />
</p>

<h1 align="center">github-ai-bot</h1>

<p align="center">A self-hosted GitHub AI bot running on your Codex subscription.</p>

---

Point it at your repositories, describe what you want in plain English, and it acts on issues and pull requests for you:

- **Review pull requests** — inline comments, summaries, approve/request-changes.
- **Triage issues** — label, answer, ask for missing details, close duplicates.
- **Write code** — push commits and open pull requests that fix the issue.
- **Reply in threads** — respond to review comments and issue comments.

It acts through the `gh` CLI as a GitHub App **you own**, so it can do anything you grant it — and nothing you don't.

Every run is your own [Codex](https://developers.openai.com/codex/cli/) CLI invocation on **your subscription**. No API keys, no per-token billing, no app backend to host. Your machine, your subscription, your bot.

## Quickstart

Not on npm yet — run it from source:

```sh
git clone https://github.com/felipelincoln/github-ai-bot
cd github-ai-bot
npm install
npm run build
npm start
```

This opens a local dashboard that walks you through three steps: connect Codex, create a GitHub App you own, and choose which repositories it can touch. After that it runs your automations from your machine.

## Requirements

- Node.js >= 24.15
- A [Codex](https://developers.openai.com/codex/cli/) subscription (logged in via the dashboard)
- The [`gh`](https://cli.github.com/) CLI on your PATH — the bot runs it to act on GitHub. It injects its own short-lived token, so you don't need to authenticate `gh` yourself.
- macOS or Linux (Windows isn't supported yet)

(`cloudflared` is downloaded automatically on first run — nothing to install.)
