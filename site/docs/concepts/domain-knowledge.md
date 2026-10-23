---
title: "Domain Knowledge Layer"
description: "Named contexts, markdown cards and deterministic checks that keep domain knowledge in step with code."
---

# Domain Knowledge Layer

An agent changes the lending rules in code, and the card that describes them stays as it was. The
domain knowledge layer is the opt-in `@ctxo/domain` package that closes that gap. A team names its
bounded contexts in a registry, keeps one markdown card per context in its own repository, and Ctxo
checks the structure around them: that the code a session changed has a card update (or a commit that says
nothing changed), that rule IDs exist, that links resolve, that edges respect the contracts between
contexts.

Ctxo never writes domain text. No LLM calls, no generated card text, no fetching of external documentation.
Everything it derives can be rebuilt from the repository and its git history.

```shell
ctxo install domain
ctxo init --domain
```

## The pieces

| Piece | What it is |
| --- | --- |
| Registry | `docs/domain/contexts.yaml`: each context has an `id`, `paths`, a `card`, a `rung` and optional `contracts` |
| Card | A markdown file with five headings (Language; Rules and invariants; Boundary contracts; Decisions; Open questions); rules are `### LEND-03 title` headings |
| Fold guard | A Claude Code hook that blocks a session once when its commits changed a context without a card update |
| Trailer | `Domain-Unchanged: <id> (reason)` in a commit: the code changed, the behaviour did not |
| Loader rules | Generated, path-scoped pointers (`.claude/rules`, `.cursor/rules`) that send the agent to the card |
| CI gate | `ctxo verify-domain`: eleven structural checks |
| Boundaries and drift | Edges between contexts, checked against `contracts`, and each context's share of cross-context edges over time |

## What the agent sees

With `@ctxo/domain` and a registry, core tools carry additive fields: `context` on symbols in
`search_symbols`, `get_blast_radius`, `find_importers`, `get_logic_slice` and `get_pr_impact`;
`contextBoundaryViolations` on `get_pr_impact`; `contextDrift` on `get_why_context`. A repository without
the package or a registry sees none of them. The fold guard and the loader rules are what get the agent to
read the card in the first place.

## Adoption ladder

A context's `rung` in the registry says how far it has come. No level requires code changes.

- level 0: install and index
- 1: registry with paths
- 2: cards
- 3: rule IDs and test links, through card `Tests:` lines, test names or framework tags
- 4: contracts and shadow-spec resolutions

`verify-domain` is green on day one: unowned files and a missing context map are warnings until the team
sets `domain.coverage.unowned: error`. Boundary violations are errors only for the rungs in
`domain.boundaries.blockingRungs` (default `bounded` and `boring`) unless the mode is `report`.

## One copy

A repository without `package.json` (a .NET repository, say) installs globally:
`npm i -g @ctxo/cli @ctxo/domain @ctxo/lang-sql`, so the MCP server, the hooks and the CLI run the same
copy. `ctxo init` from a global install writes MCP entries that call the global `ctxo`. The `install_copies`
doctor check warns when the MCP entry and the hooks start different copies.

## Where to go next

- [Domain commands](/cli/domain): `verify-domain`, `contexts-touched`, `domain rules`, `domain discover`
- [`ctxo init`](/cli/init): the `domain` part and `--domain`
- [Config schema](/reference/config-schema#domain): the `domain:` keys
- The feature doc in the repository, [Ctxo domain conventions v1](https://github.com/alperhankendi/Ctxo/blob/master/docs/features/domain-knowledge.md#ctxo-domain-conventions-v1): the registry JSON Schema, the card template, the rule ID rules and the trailer
- [ADR-018](https://github.com/alperhankendi/Ctxo/blob/master/docs/architecture/ADR/adr-018-domain-knowledge-layer.md): the design record
