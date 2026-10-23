---
title: "Quick Start"
description: "From zero to your first MCP tool call in five steps and under five minutes."
---

# Quick Start

Five steps, five minutes. At the end you will have a committed index of your
repo and an agent making dependency-aware queries against it.

::: info Prerequisites
Node.js >= 20, git, and a repo with TypeScript, Go, C#, Java or T-SQL code. See
[Installation](/introduction/installation) for details.
:::

::: tip Get `ctxo` on your PATH
This guide assumes `ctxo` is already callable. The one-time install:

```bash
npm install -g @ctxo/cli
```

Prefer not to install globally? Substitute `npx @ctxo/cli` for `ctxo` in
every command below.
:::

## 1. Install and initialize

From the root of your repo:

```bash
ctxo init
```

The interactive run asks which AI tools to set up, offers a plugin for each
detected language that has none, and asks whether to install the git hooks and
(when Claude Code is selected) the safe-edit guard. The same setup without
prompts, for Claude Code:

```bash
ctxo init --tools claude-code -y
```

Expected output on a fresh repo:

```
[ctxo] ✓ .ctxo/index/ (created)
[ctxo] ✓ .ctxo/config.yaml (created)
[ctxo] ✓ .gitignore (created)
[ctxo] ✓ .claude/skills/ctxo-understand/SKILL.md (created)
[ctxo] ✓ .claude/skills/ctxo-safe-edit/SKILL.md (created)
[ctxo] ✓ .claude/skills/ctxo-review-pr/SKILL.md (created)
[ctxo] ✓ .claude/settings.json (created)
[ctxo] ✓ CLAUDE.md (created)
[ctxo] ✓ .mcp.json (created)
[ctxo] ✓ .git/hooks/post-commit (created)
[ctxo] ✓ .git/hooks/post-merge (created)
```

Each line is `[ctxo] ✓ <file> (<created|updated|unchanged>)`; a re-run reports
`unchanged` for files that are already current. When a detected language has
no plugin yet, `-y` also installs it (`[ctxo] Installing missing plugins: ...`).
Use `--only`, `--skip` or `--no-guard` to pick the parts, and `--dry-run` to
see what init would write.

## 2. Build the index

```bash
ctxo index
```

This walks every file tracked by git, parses symbols and edges, and enriches
with git commit intent. Expect a few seconds on small repos, a minute or two
on large ones.

```
[ctxo] Building codebase index... Found 312 source files
[ctxo] Community detection: 18 clusters (modularity 0.712)
[ctxo] Index complete: 312 files indexed
[ctxo]   TypeScript/JS: 312 files (full tier)
```

::: tip Fast re-index
Use `ctxo index --skip-history` during iterative work to skip the git-history
pass. Run a full `ctxo index` before committing.
:::

## 3. Check status

```bash
ctxo status
```

```
[ctxo] Index Status
  Schema version: 1.0.0
  Indexed files:  312
  Total symbols:  4812
  Total edges:    11507
  SQLite cache:   present
```

A per-file list (timestamp, symbol and edge counts) follows.

If anything looks off, run `ctxo doctor` for a detailed health report.

## 4. Wire up an MCP client

`ctxo init` already wrote the MCP config of every tool you selected. To add it
by hand, edit your client's MCP config. For Claude Code, `.mcp.json` in your
repo root:

```json
{
  "mcpServers": {
    "ctxo": {
      "command": "npx",
      "args": ["-y", "@ctxo/cli"]
    }
  }
}
```

Full config blocks for Cursor, Copilot, Windsurf, and Cline are in
[MCP Client Setup](/introduction/mcp-client-setup).

Restart your client. You should see `ctxo` listed as a connected MCP server
with 14 tools (16 with `@ctxo/domain`) and 1 resource (`ctxo://status`).

## 5. Make your first tool call

In your agent, try this prompt:

> "Use `get_ranked_context` to find code related to 'index storage'. Then
> call `get_blast_radius` on the top result."

Or call directly via your client's MCP tool UI. Example `get_logic_slice`
request:

```json
{
  "symbolId": "packages/cli/src/adapters/storage/sqlite.ts::SqliteStorageAdapter::class",
  "detail": "L2"
}
```

Expected response shape:

```json
{
  "symbol": { "name": "SqliteStorageAdapter", "kind": "class" },
  "dependencies": [ /* transitive deps */ ],
  "_meta": { "totalItems": 42, "returnedItems": 42, "truncated": false }
}
```

## What's next

- [MCP Tools Overview](/mcp-tools/overview) - all 14 tools with examples
- [MCP Client Setup](/introduction/mcp-client-setup) - per-client config
- <a href="/Ctxo/ctxo-visualizer.html" target="_self">Visualize your index</a>
  - interactive graph of the repo you just indexed

::: tip Keep it fresh
The post-commit hook installed by `ctxo init` runs `ctxo index --commit HEAD`,
which re-indexes the files each commit changed; the post-merge hook runs
`ctxo sync` to rebuild the SQLite cache from the pulled index. For active
editing sessions, run `ctxo watch` in a spare terminal for incremental
re-indexing on save.
:::
