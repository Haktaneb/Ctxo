---
title: "ctxo init"
description: "Bootstrap a project: rules, skills, safe-edit guard, MCP config, git hooks, and plugin install."
---

# ctxo init

Bootstraps a project for ctxo. It installs six parts, always in this order:

1. `config`: ensures `.ctxo/index/` and `.ctxo/config.yaml` exist and adds
   `.ctxo/.cache/` to `.gitignore`.
2. `skills`: copies the three model-invoked skills (Claude Code and Cursor).
3. `guard`: registers the safe-edit guard hook (Claude Code only).
4. `rules`: writes the ctxo rules block into the instruction file of each AI
   tool you use. Supported tool ids: `claude-code`, `cursor`, `github-copilot`,
   `windsurf`, `antigravity`, `augment`, `amazonq`, `gemini-cli`, `continue`.
5. `mcp`: registers the ctxo MCP server in each tool's config file.
6. `git-hooks`: installs git hooks that re-index each commit
   (`ctxo index --commit HEAD`, once per commit) and rebuild the SQLite cache
   on merge.

Skills and the guard go before the rules, so the rules tier is chosen from
what is installed by then (see [The rules block](#the-rules-block)). Init also
offers to install missing language plugins. That step is not a part: `--only`
and `--rules` skip it, `--skip` keeps it, and `--no-install` turns it off.

Requires a git repository (run `git init` first).

## Synopsis

```shell
ctxo init [options]
```

## Parts

| Part | Files |
| --- | --- |
| `config` | `.ctxo/index/`, `.ctxo/config.yaml`, `.gitignore` |
| `skills` | `.claude/skills/ctxo-*/SKILL.md` (Claude Code), `.cursor/rules/ctxo-*.mdc` (Cursor) |
| `guard` | `.claude/settings.json` (Claude Code only) |
| `rules` | One rules file per selected tool: `CLAUDE.md`, `.cursor/rules/ctxo.mdc`, `AGENTS.md` and the rest (see [What it writes](#what-it-writes)) |
| `mcp` | One MCP config per selected tool: `.mcp.json`, `.vscode/mcp.json`, `.amazonq/mcp.json`, `.gemini/settings.json`, `.continue/mcpServers/ctxo.json` |
| `git-hooks` | `post-commit` and `post-merge` in the hooks directory git resolves |

`--only` and `--skip` take a comma-separated list of these names
(`--only guard,skills` or `--only=guard,skills`); repeating the flag merges
the lists.

## Flags

| Flag | Short | Default | Description |
| --- | --- | --- | --- |
| `--yes` | `-y` | `false` | Non-interactive: no prompts. Combine with `--tools` to pick the AI tools; without it no AI tool is selected |
| `--tools <list>` | | | Comma-separated list of AI tool ids (for example `claude-code,cursor`). Implies non-interactive |
| `--only <parts>` | | | Install only these parts. Also skips the plugin step. Cannot be combined with `--skip` or `--rules` |
| `--skip <parts>` | | | Install every part except these. The plugin step still runs (subject to `--no-install`) |
| `--no-guard` | | `false` | Never install the safe-edit guard and never ask about it. Combines with `--only` and `--skip`. Without a guard on disk, Claude Code gets the full rules block |
| `--rules` | | `false` | Deprecated: the same as `--skip git-hooks,guard`, and it still skips the plugin step. Prints a deprecation notice; use `--only` or `--skip` instead |
| `--no-install` | | `false` | Skip the language-plugin detection prompt (and the implicit install under `--yes`) |
| `--dry-run` | | `false` | Lists every file init would create or change, and writes nothing. See [Dry run](#dry-run) |

An unknown part name, `--only` or `--skip` without a value, and `--only`
together with `--skip` or `--rules` exit with code 1 before anything is
written. A selection that leaves nothing to do prints
`[ctxo] Nothing to install: every part is excluded.` and exits 0.

## What it writes

| Path | Notes |
| --- | --- |
| `.ctxo/index/` | Created if missing (holds per-file JSON indices) |
| `.ctxo/config.yaml` | Default config is dropped if absent. See [config reference](./config-yaml.md) |
| `.gitignore` | `.ctxo/.cache/` appended if not already present |
| AI rule files | Per selected tool: `CLAUDE.md`, `.cursor/rules/ctxo.mdc`, `.github/copilot-instructions.md`, `.windsurfrules`, `AGENTS.md`, `augment-guidelines.md`, `.amazonq/rules/ctxo.md`, `GEMINI.md`, `.continue/rules/ctxo.md`. One marked ctxo block each; the rest of the file is yours (see [The rules block](#the-rules-block)) |
| AI MCP configs | Per selected tool: `.mcp.json` (Claude Code / Cursor / Windsurf / Antigravity / Augment), `.vscode/mcp.json` (Copilot), `.amazonq/mcp.json`, `.gemini/settings.json`, `.continue/mcpServers/ctxo.json` |
| `.claude/settings.json` | Registers the `ctxo gate-hook` PreToolUse hook (Claude Code only) |
| `.claude/skills/ctxo-understand/SKILL.md` | Model-invoked skill: orient at task start (Claude Code) |
| `.claude/skills/ctxo-safe-edit/SKILL.md` | Model-invoked skill: blast radius + why-context before edits (Claude Code) |
| `.claude/skills/ctxo-review-pr/SKILL.md` | Model-invoked skill: PR risk via `get_pr_impact` (Claude Code) |
| `.cursor/rules/ctxo-understand.mdc` | Same skill for Cursor |
| `.cursor/rules/ctxo-safe-edit.mdc` | Same skill for Cursor |
| `.cursor/rules/ctxo-review-pr.mdc` | Same skill for Cursor |
| `post-commit` hook | Re-indexes the files the commit changed with `ctxo index --commit HEAD` (versioned block, marked `# ctxo-start v2` / `# ctxo-end`) |
| `post-merge` hook | Runs `ctxo sync` after `git pull` (block marked `# ctxo-start` / `# ctxo-end`) |

The hooks live in the directory git resolves for the repository (`git rev-parse --git-path hooks`): `.git/hooks`, or the directory `core.hooksPath` names. See [Git hooks](#git-hooks) below.

Each file is reported as `created`, `updated` or `unchanged`; a file init left alone on purpose is reported with a warning instead.

### The rules block

- **Versioned markers.** Every rules file gets one block between `<!-- ctxo-rules-start v<version> -->` and `<!-- ctxo-rules-end -->`. The version is the rules template version (currently `0.13`): the ctxo minor in which the rules text last changed, not the ctxo version you run.
- **Your content is kept.** A missing file is created. An existing file keeps every byte outside the block, including its line endings and UTF-8 BOM, and gets the block appended when it has none. This holds for every tool: `.cursor/rules/ctxo.mdc`, `AGENTS.md` and the other files that older ctxo versions overwrote whole now keep what you wrote.
- **Replaced in place.** Re-running init replaces the block where it is. It also finds an unversioned `<!-- ctxo-rules-start -->` block and the unmarked body older versions wrote, replaces it, and collapses duplicate blocks into one. The old unmarked body is recognised only word for word: if a formatter rewrote it, init appends a new block and you can delete the old text.
- **Left alone with a warning.** A block written by a newer ctxo (a teammate upgraded first), and a start marker without an end marker. Upgrade ctxo, or repair the markers, and run init again.
- **Tier.** Claude Code gets a compact block (4 lines that point at the skills and the guard) when the guard hook is registered, all three skills are in `.claude/skills/`, and `gate.enabled` is not `false` in `.ctxo/config.yaml`. Every other tool, and Claude Code without one of those, gets the full block with the complete tool guide. The tier follows what is on disk after the skills and guard steps: `--no-guard` and `--skip skills` give Claude Code the full block unless the guard and skills are already installed, and they remove nothing.

### Skills

A skill that differs from the bundled copy (other than in line endings or a BOM) is replaced by `ctxo init` and by `ctxo doctor --fix`. To customise a skill, copy it under another name.

## Safe-edit guard prompt

Interactive `ctxo init` asks whether to install the safe-edit guard only when Claude Code is among the selected tools. Answering yes writes the hook entry to `.claude/settings.json`; the skills are a separate part and are copied either way. `--no-guard` skips both the question and the guard. A non-interactive run (`--yes` or `--tools`) installs the guard for Claude Code unless you pass `--no-guard`. Cursor gets the skills and the full rules block, but no guard question and no hook: Cursor has no blocking pre-edit hook.

A `.claude/settings.json` that is not valid JSON (JSONC comments included) or not a settings object is never overwritten. Init leaves it unchanged, prints a warning, and writes the full rules block. Repair the file, then run `ctxo init --only guard,rules --tools claude-code --yes`.

The guard is enabled by default at `balanced` sensitivity; tune it via `gate:` in `.ctxo/config.yaml`:

```yaml
gate:
  enabled: true
  sensitivity: balanced   # strict | balanced | lenient
```

Use `ctxo gate --preview` to see which symbols the current sensitivity level would flag before committing to it. See the [Safe-Edit Guard guide](/concepts/safe-edit-guard) for the full explanation.

::: tip Skills are passive instructions
Skills are markdown files the model reads - they do not execute code. The PreToolUse hook in `.claude/settings.json` is the only thing that actually blocks an edit. Skills guide the agent toward running `get_blast_radius` proactively.
:::

::: tip Hooks are safe to re-run
The hook installer finds the `# ctxo-start` / `# ctxo-end` block, replaces it
in place when it is outdated, and leaves the rest of the hook file as it was.
You can safely re-run `ctxo init` to pick up new AI tool rules or a newer hook.
:::

## Dry run

`ctxo init --dry-run` runs the same pipeline over the same parts and writes
nothing: no file, no directory, no exec bit. It lists every file init would
create or change, one row per file. For `ctxo init --dry-run --tools claude-code`
in a repository with a `.gitignore` and a `CLAUDE.md`:

```text
[ctxo] Dry run: nothing is written. Files init would touch:
  .ctxo/index/                                 would create
  .ctxo/config.yaml                            would create
  .gitignore                                   would update
  .claude/skills/ctxo-understand/SKILL.md      would create
  .claude/skills/ctxo-safe-edit/SKILL.md       would create
  .claude/skills/ctxo-review-pr/SKILL.md       would create
  .claude/settings.json                        would create
  CLAUDE.md                                    would update
  .mcp.json                                    would create
  .git/hooks/post-commit (git hook)            would create
  .git/hooks/post-merge (git hook)             would create
```

- Each row reads `would create`, `would update` or `unchanged`.
- `--only`, `--skip`, `--no-guard` and `--rules` select the parts as they would
  for a real run. Without `--tools`, the dry run previews every tool.
- The `CLAUDE.md` row uses the tier init would write, counting the skills and
  the guard it would install as present.
- A file init would leave alone prints as a `⚠` line with the reason (for
  example an unreadable `.claude/settings.json`). A shared hooks directory
  prints the same warning as a real run, and no hook rows.
- The hook rows name the hooks directory git resolves, so `core.hooksPath`
  shows up.
- The dry run never installs language plugins.

## Git hooks

The post-commit block (version 2) is:

```sh
# ctxo-start v2
# Incremental re-index of the files changed by this commit (one run per commit)
if [ -d .ctxo ] && command -v ctxo >/dev/null 2>&1; then
  ctxo index --commit HEAD >/dev/null 2>&1 || true
fi
# ctxo-end
```

- **One run per commit.** Version 1 ran `ctxo index --file <path>` once per changed file, which re-parsed the project for every file and wrote one community snapshot per run. Version 2 re-indexes the commit once, refreshes the co-change matrix from git, and records one snapshot for the commit. See [`ctxo index`](./index.md#incremental-runs-files-commit).
- **Guarded.** The block does nothing unless the repository has a `.ctxo` directory and `ctxo` is on `PATH`, and it never fails a commit. The post-merge block has the same guard.
- **Upgrades in place.** `ctxo init` and [`ctxo doctor --fix`](./doctor.md) replace an older block (including the unversioned v1 block) with the current one, keep the lines you wrote before and after it, and collapse duplicate ctxo blocks into one.
- **Shared hooks directories are not written to.** When `core.hooksPath` is set in your global or system git config, the hooks directory is shared by every repository on the machine. `ctxo init` and `ctxo doctor --fix` then write nothing, print the two blocks to add by hand, and suggest giving this repository its own path with `git config --local core.hooksPath <dir>`. A local `core.hooksPath` is honoured. Detecting the scope needs git 2.26 or newer; on an older git the directory is treated as not shared.
- If you decline the hooks, `ctxo init` prints which signals degrade and suggests running `ctxo index --commit HEAD` after commits. `ctxo index --check` verifies freshness only and records no snapshot.

## Examples

::: code-group
```shell [interactive]
ctxo init
```

```shell [non-interactive]
# Pick tools explicitly and install everything without prompts.
ctxo init --tools claude-code,cursor --yes
```

```shell [guard and skills]
# Add the safe-edit guard and the skills to an existing setup; nothing else.
ctxo init --only guard,skills --tools claude-code -y
```

```shell [no git hooks]
# Everything except the git hooks (the plugin step still runs).
ctxo init --skip git-hooks
```

```shell [rules only]
# Refresh AI tool rules after a ctxo upgrade. Don't touch plugins or hooks.
ctxo init --only rules
```

```shell [no guard]
# No safe-edit guard: CLAUDE.md gets the full rules block (unless a guard is already registered).
ctxo init --tools claude-code -y --no-guard
```

```shell [no plugin install]
# Set everything up but defer plugin installation to a later step.
ctxo init --no-install --yes --tools claude-code
```

```shell [preview]
ctxo init --dry-run
```
:::

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Setup completed, the dry run printed, or nothing was left to install |
| `1` | Not a git repository, an unknown tool id passed to `--tools`, an unknown part, `--only` or `--skip` without a value, or `--only` combined with `--skip` or `--rules` |

## See also

- [`ctxo install`](./install.md) - the plugin installer invoked by `init`.
- [`ctxo index`](./index.md) - the next command to run after setup.
- [`ctxo doctor`](./doctor.md) - reports drifted rules blocks, skills and the guard hook, and `--fix` repairs them.
- [.ctxo/config.yaml reference](./config-yaml.md) - customize ignore globs and
  opt out of stats.
