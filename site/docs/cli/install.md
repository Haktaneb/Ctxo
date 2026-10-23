---
title: "ctxo install"
description: "Install detected or selected language plugins."
---

# ctxo install

Convenience wrapper that installs the official `@ctxo/lang-*` plugin
packages for one or more languages. It auto-detects your project's package
manager (`pnpm`, `npm`, `yarn`, `bun`) and runs the equivalent of
`<pm> add -D @ctxo/lang-typescript @ctxo/lang-go ...` for you.

For a manual alternative to this command, see [Installation](/introduction/installation#add-a-language-later).

When called with no arguments, `ctxo install` auto-detects languages used in
the repo (via file extensions and common manifest files) and installs the
plugins that are not yet present.

## Synopsis

```shell
ctxo install [languages...] [options]
```

## Flags

| Flag | Short | Default | Description |
| --- | --- | --- | --- |
| `--yes` | `-y` | `false` | Do not prompt. Assume yes for all decisions |
| `--global` | `-g` | `false` | Install plugins globally rather than into the project's `package.json` |
| `--dry-run` | | `false` | Print the plan (manager, packages, command) and exit without running it |
| `--pm <manager>` | | auto | Force a package manager. One of `npm`, `pnpm`, `yarn`, `bun` |
| `--version <spec>` | | latest | Pin plugins to a specific npm version or tag (for example `0.7.0-alpha.0` or `next`) |
| `--force` | | `false` | Override the CI lockfile guard. Required when `CI=true` with a frozen lockfile |

## Supported languages

Pass one or more of:

`typescript`, `javascript`, `go`, `csharp`, `python`, `java`, `kotlin`, `ruby`,
`rust`, `sql`.

Common aliases are accepted and normalized: `ts`, `js`, `py`, `c#`, `cs`,
`net`, `golang`, `kt`, `rb`, `rs`, `tsql` (for `sql`).

`sql` installs [`@ctxo/lang-sql`](/languages/sql), the T-SQL plugin for `.sql`
files. With it installed, the host-language plugins also add `reads`, `writes`
and `executes` edges for constant SQL at known call sites: C# (Roslyn tier),
TypeScript and JavaScript, Java (JDT full tier) and Go (analyzer full tier).
Without it, no language emits SQL edges. Annotations and test symbols do not
depend on it.

## The domain package and global installs without a package.json

`domain` is not a language. `ctxo install domain` installs the opt-in
[`@ctxo/domain`](/concepts/domain-knowledge) package, pinned to the running CLI's version (the two always
share one version, and a copy at another minor does not load). It can be combined with languages:
`ctxo install typescript sql domain --yes`.

A repository without a `package.json` (a .NET repository, say) has nowhere to declare a devDependency. There
`ctxo install` installs globally and says so: `[ctxo] No package.json here: installing globally, so the MCP
server, hooks and CLI share one copy.` The supported setup is one global copy of everything:

```shell
npm i -g @ctxo/cli @ctxo/domain @ctxo/lang-sql
```

[`ctxo init`](./init.md#the-domain-part) run from that install writes MCP entries that call the global
`ctxo`, so the MCP server and the hooks run the same copy. [`ctxo doctor`](./doctor.md) (`install_copies`)
warns when they do not.

## Package manager detection

The manager is resolved in this order:

1. `--pm` flag
2. `CTXO_PM` environment variable
3. `packageManager` field in the project's `package.json`
4. Lockfile sniff (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `package-lock.json`)
5. Fallback to `npm`

## Examples

::: code-group
```shell [auto-detect]
# Detect languages in the repo and install anything missing.
ctxo install
```

```shell [explicit]
# Install TypeScript and Go plugins, no prompts.
ctxo install typescript go --yes
```

```shell [sql]
# Install the T-SQL plugin next to the C# plugin.
ctxo install csharp sql --yes
# Or next to TypeScript, Java and Go.
ctxo install typescript java go sql --yes
```

```shell [dry run]
# Preview the plan without running the package manager.
ctxo install python --dry-run --pm pnpm
```

```shell [pinned version]
# Pin to an npm dist-tag.
ctxo install typescript --version next --yes
```

```shell [global]
# Install globally (useful for ad-hoc CLI usage without a package.json).
ctxo install typescript --global
```
:::

## CI behavior

::: warning Frozen lockfiles
When `CI=true` or `CI=1`, `ctxo install` refuses to mutate dependencies to
protect frozen lockfiles. Override with `--force` or switch to `--global`.
:::

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Install succeeded, or nothing to do |
| `1` | Unknown language or package name (the message lists `domain` among the known names), blocked by CI guard, or manager failure |
| other | Propagated from the underlying package manager |

## See also

- [`ctxo init`](./init.md) — runs `install` as part of interactive setup.
- [`ctxo doctor`](./doctor.md) — `doctor --fix` will invoke `install` for any
  missing plugins.
- [Environment variables](./env-vars.md) — `CTXO_PM` overrides manager detection.
