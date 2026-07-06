---
description: Use when you need to open websites, inspect pages, fill forms, click controls, capture screenshots, test web apps, or extract page content through a real browser.
---

# Agent Browser

Use the `agent-browser` CLI from the sandbox shell for browser automation. It drives Chrome/Chromium through CDP and returns compact accessibility snapshots with stable element refs like `@e1`.

## Before First Use

The Marketplace sandbox setup should already install `agent-browser` and Chrome. If a command says `agent-browser` is missing, repair the sandbox in place:

```bash
npm install -g agent-browser@0.31.1
agent-browser install --with-deps
agent-browser doctor
```

If `doctor` still fails, report the failing check and stop.

## Core Workflow

1. Navigate: `agent-browser open <url>`
2. Inspect: `agent-browser snapshot -i`
3. Act using refs from the latest snapshot: `agent-browser click @e1`, `agent-browser fill @e2 "text"`
4. Wait after navigation or async UI changes: `agent-browser wait --load networkidle`
5. Re-snapshot before using refs again.

## Common Commands

```bash
agent-browser open https://example.com
agent-browser snapshot -i
agent-browser click @e1
agent-browser fill @e2 "value"
agent-browser press Enter
agent-browser get title
agent-browser get url
agent-browser get text body
agent-browser screenshot /workspace/home/agent-browser/screenshots/page.png
agent-browser close
```

Use `--json` when you need machine-readable output:

```bash
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

## Rules

- Always take a fresh `snapshot -i` after page navigation, reloads, major DOM updates, or failed clicks.
- Prefer refs from snapshots for precise interaction.
- Use semantic fallbacks when refs are unavailable: `agent-browser find role button click --name "Submit"`.
- Keep screenshots and saved state under `/workspace/home/agent-browser/` so they survive the agent's durable sessions.
- Do not use `--headed`; Eden sandboxes are headless.
- Close browser sessions when finished unless you need state for the next step.

For the installed CLI's current guidance, run:

```bash
agent-browser skills get core
```
