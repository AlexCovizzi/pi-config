# pi-config

This is a personal configuration project for [pi](https://github.com/mariozechner/pi-coding-agent), a coding agent harness. It contains:

- **Extensions** (`extensions/`) — TypeScript extensions that plug into pi's extension API (`@mariozechner/pi-coding-agent`). Each extension is a `.ts` file (or directory with an `index.ts`) that registers tools, commands, or UI components.
- **Agents** (`agents/`) — Markdown-defined subagents with custom system prompts and tool access, usable via pi's `subagent` tool.
- **Skills** (`skills/`) — Skill files that provide specialized instructions for specific tasks.

The `extensions/`, `agents/`, and `skills/` directories are symlinked from `~/.pi/agent/`, so changes here take effect in pi immediately.

The project uses **TypeScript** and is linted/formatted with **Biome**.

## After modifying extensions

Always run these commands after making changes to any extension file:

1. **Format and auto-fix**: `npm run fix`
2. **Check** (lint + typecheck): `npm run check`
3. If any issues remain, fix them manually and re-run the checks until everything passes cleanly.
