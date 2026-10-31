---
title: "CLI Overview"
description: "All ctxo commands at a glance."
---

# CLI Overview

`ctxo` is both a Model Context Protocol (MCP) server and a CLI. Running `ctxo`
with no arguments starts the stdio MCP server; any other argument dispatches to
a subcommand.

## Calling ctxo

`@ctxo/cli` ships as a scoped npm package; the binary name inside the package is `ctxo`. Three equivalent invocation forms:

| Form | When to use |
| --- | --- |
| `ctxo <subcommand>` (Recommended) | After `npm install -g @ctxo/cli`. Works from any directory |
| `pnpm ctxo <subcommand>` / `npx ctxo <subcommand>` | When `@ctxo/cli` is in the project's `devDependencies` (for example after `ctxo init`). Resolves via `node_modules/.bin/ctxo` |
| `npx -y @ctxo/cli <subcommand>` | Ad-hoc / CI / one-off, no install needed |

All three forms run the same binary. State always lives in `<project>/.ctxo/` regardless of how `ctxo` is invoked - there is no user-level or system-level config.

Examples below assume `ctxo` is on your PATH from a global install (or a local `node_modules/.bin/ctxo`).

## Command summary

| Command | Purpose |
| --- | --- |
| [`ctxo install`](./install.md) | Install language plugins and `@ctxo/domain` (auto-detects languages if omitted); installs globally when the project has no `package.json` |
| [`ctxo update`](./update.md) | Check the npm registry for newer ctxo releases and apply them |
| [`ctxo init`](./init.md) | Interactive setup: rules, skills, safe-edit guard, MCP config, git hooks (post-commit runs `ctxo index --commit HEAD`), plugin install. `--only`, `--skip` and `--no-guard` pick the parts; `--domain` adds the opt-in domain part |
| [`ctxo index`](./index.md) | Build the codebase index (symbols, edges, history, co-change); `--files` and `--commit` re-index part of it |
| [`ctxo watch`](./watch.md) | File watcher for incremental re-indexing |
| [`ctxo sync`](./sync.md) | Rebuild the SQLite cache from committed JSON |
| [`ctxo status`](./status.md) | Show index manifest, symbol counts, per-file freshness |
| [`ctxo doctor`](./doctor.md) | Health check every subsystem (with optional `--fix`) |
| [`ctxo visualize`](./visualize.md) | Generate an interactive dependency graph HTML |
| [`ctxo blast-radius`](./blast-radius.md) | Blast radius for one symbol, JSON to stdout |
| [`ctxo gate --preview`](./gate.md) | Preview which symbols the safe-edit guard would block |
| [`ctxo contexts`](./contexts.md) | Candidate bounded contexts as a table; `--json` prints the full `contexts-view.json` |
| [`ctxo verify-domain`](./domain.md) | Domain CI gate: registry, cards, rule IDs, loader rules, boundaries, shadow-spec resolutions (`--since`, `--boundaries`, `--json`). Needs `@ctxo/domain` |
| [`ctxo contexts-touched`](./domain.md#ctxo-contexts-touched) | Named contexts a change touched and whether each is resolved (`--since`, `--committed`, `--staged`, `--check`). Needs `@ctxo/domain` |
| [`ctxo domain rules`](./domain.md#ctxo-domain-rules) | Generate (`--write`) or check (`--check`) the path-scoped loader rules per context. Needs `@ctxo/domain` |
| [`ctxo domain discover`](./domain.md#ctxo-domain-discover) | Propose the domain config from the repo: tracker prefixes, rule trait keys and test conventions (folders, file names, Trait or Category values, custom test attributes); run it first when adopting the domain layer (`--json`, `--write`). Needs `@ctxo/domain` |
| [`ctxo domain map`](./domain.md#ctxo-domain-map) | The context map: rung, suggested rung, rules with tests, open candidates and criteria per context (`--json`). Needs `@ctxo/domain` |
| [`ctxo domain shadow-specs`](./domain.md#ctxo-domain-shadow-specs) | Shadow-spec candidates of a context with fingerprints and resolutions (`--kinds`, `--all`, `--json`). Needs `@ctxo/domain` |
| `ctxo verify-index` | CI gate: fail if index drifts from source |
| `ctxo stats` | Show MCP usage statistics (`--json`, `--days N`, `--clear`) |
| `ctxo version` | Verbose version report (`--json`, `--short`) |
| `ctxo --help` | Print compact help |

## Global flags

| Flag | Meaning |
| --- | --- |
| `--version`, `-v`, `-V` | Print core version. Combine with `--verbose` or `--json` |
| `--help`, `-h` | Print the bundled help block. Works after any subcommand (`ctxo index --help`, `ctxo init --help`); the subcommand is not run |

## Related references

- [.ctxo/config.yaml reference](./config-yaml.md) - project config for index
  ignore globs and opt-out flags.
- [Environment variables](./env-vars.md) - `DEBUG=ctxo:*` namespaces,
  `CTXO_RESPONSE_LIMIT`, and more.

::: tip Debug output
Every subcommand honors `DEBUG=ctxo:*`. Narrow the namespace (for example
`DEBUG=ctxo:git,ctxo:storage`) when you only want to see one subsystem.
:::

## Exit codes

Most commands exit `0` on success and `1` on failure. Two commands have richer
semantics:

| Command | Exit | Meaning |
| --- | --- | --- |
| `ctxo index --check` | `0` | Index up to date |
| `ctxo index --check` | `1` | Stale or missing files - run `ctxo index` |
| `ctxo doctor` | `0` | All checks passed |
| `ctxo doctor` | `1` | One or more checks failed |
| `ctxo doctor --fix` | `2` | Remediation halted before completing |
