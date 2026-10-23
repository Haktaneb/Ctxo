# ADR-018: In-Repo Domain Knowledge Layer and the CLI Internal API

| Field | Value |
|---|---|
| **Status** | Accepted (0.14) |
| **Date** | 2026-10-23 |
| **Deciders** | Alper Hankendi |
| **Decision** | Ship the domain knowledge layer as the opt-in package `@ctxo/domain`, which the CLI loads from the project or from next to itself through a type-only internal API (`@ctxo/cli/internal`), with a context registry, `ctxo contexts-touched`, a session-scoped domain fold guard and `Domain-Unchanged` commit trailers, while Ctxo supplies structure, linkage, verification and retrieval and never authors or fetches domain text. |
| **Relates to** | [#156](https://github.com/alperhankendi/Ctxo/issues/156), [ADR-004](adr-004-reject-external-docs-integration.md), [ADR-012](adr-012-plugin-architecture-and-monorepo.md), [ADR-015](adr-015-safe-edit-guard.md), [ADR-016](adr-016-co-change-engine-and-snapshot-policy.md), [ADR-017](adr-017-plugin-protocol-v2-and-data-coupling.md), [domain knowledge layer spec](../../superpowers/specs/2026-10-20-domain-knowledge-layer-design.md) (section 10) |

---

## Context

A team keeps its domain knowledge per bounded context as markdown cards in its own repository. It wants two things from its coding agent: read the right card before changing that context's code, and fold behaviour changes back into the card in the same branch. Spec-driven tools leave a record of past changes; the domain itself has no home in the repository, and the cards are meant to be that home.

Nothing in Ctxo connects that knowledge to code today. The contexts view (PR 1A) proposes candidate contexts and the data coupling of ADR-017 shows shared tables, but a team cannot name a context, say which paths it owns, or learn that a branch changed a context's code without touching its card. Rules and skills can ask the agent to keep cards current, and like the pre-edit rules before ADR-015 they are followed at the start of a task and forgotten in the middle of it.

ADR-004 rejected fetching and indexing external documentation: Ctxo is code intelligence, not content management. A domain layer must not reopen that decision by another route.

Two constraints shape the integration:

1. **The domain features need core services at runtime:** the merged index, the symbol graph, config, the test-file classifier, git access and the co-change window of ADR-016. A language plugin sees none of these, and ADR-012 lets plugins import only `@ctxo/plugin-api`.
2. **Not every repository can hold a devDependency.** Repositories without `package.json` (.NET repositories, for example) have nowhere to declare one, and a setup that starts the MCP server through `npx` while its hooks call a global `ctxo` runs two copies of the CLI, only one of which may have the domain package next to it.

---

## Decision

### 1. The in-repo knowledge layer and ADR-004

Ctxo supplies structure, linkage, verification and retrieval only:

- **Structure:** candidate contexts, data coupling, and the ownership of files by named contexts.
- **Linkage:** contexts to paths and cards; from PR 3, rules to tests and code and decisions to their provenance.
- **Verification:** deterministic checks (`contexts-touched`, the fold guard, and `verify-domain` in Part 2) that test structure, never meaning.
- **Retrieval:** additive fields and tools that hand the agent the right card.

Ctxo never authors domain text: no generated card text, definitions or summaries, and no LLM calls. The generated loader rules of Part 2 are pointers to a card, not knowledge. The cards, the registry (`docs/domain/contexts.yaml` by default), the glossary and provenance files are ordinary repository content, written and reviewed by the team, and everything Ctxo derives from them can be rebuilt from the repository and its history. External provenance such as an issue URL is stored as a string and never fetched. Nothing here fetches or indexes external documentation, so ADR-004 stands unchanged.

### 2. An opt-in package

The layer ships as `@ctxo/domain`, a published package separate from `@ctxo/cli`. Without it the core is unchanged: no domain tools, fields, commands or hooks (spec 13.2). With the package and no registry, the domain commands print a hint and exit 0, and no `context` fields appear.

The seams that let the core load the package are visible without it in a few small ways, each listed in the CHANGELOG:

- A known domain command name (`verify-domain`, `contexts-touched`, `domain`) prints an install hint and exits 1, so CI never passes silently. `ctxo domain-guard-hook` exits 0 without output.
- `ctxo --help` ends with one install hint line, and `ctxo version` gains a `Modules:` line.
- The `install_copies` doctor check (Decision 7) runs on every project; its message names `@ctxo/domain` only when the package is installed.
- `get_why_context` gains the `_meta` envelope the other tools already carry.

### 3. Integration through the CLI internal API (K7)

`@ctxo/cli` exposes an internal API on the subpath export `@ctxo/cli/internal`, built as a second tsup entry with code splitting. It exports types (the module API, the index and graph types, `IGitPort`, `IStoragePort`, `IMaskingPort`, config, logger, health-check and envelope types, `SymbolGraph`, `BlastRadiusCalculator`) and one runtime function, `createModuleHost`. It exposes no adapters.

The CLI resolves `@ctxo/domain`, imports it and calls its `register(host)` function. The host carries the CLI version, the mode (`mcp`, `cli` or `hook`), the project and `.ctxo` roots, and `host.services`: config loading, the logger, the shared glob matcher, the test-file classifier, the git port, the index reader, the graph builder, the co-change window and the git-root finder. The registration may contribute:

| Member | Purpose |
|---|---|
| `indexPass` | Runs after the core phases of `ctxo index`, on the merged index. A failing pass is reported and the run continues. |
| `registerTools` | New MCP tools. The core wraps masking, the `_meta` envelope, stats recording and the staleness warning. A tool named like a core tool is skipped with a warning. |
| `enrich` | Additive fields on core tools, applied before the envelope so that truncation and masking see them. A throwing enricher drops its fields, never the response. |
| `registerCommands` | CLI commands (`contexts-touched` and `domain-guard-hook`; `verify-domain` and `domain` in Part 2). A name that shadows a core command is dropped with a warning. |
| `init` | The `domain` part of `ctxo init`. |
| `doctorChecks` | Health checks, run after the core checks. |
| `indexCapabilities` | `facts: true` makes `ctxo index` request facts from plugins (the capability of ADR-017). |

**Loading.** The project's `node_modules` is tried first, then the copy next to the running CLI. A failure to load warns and continues.

**Versions (designer call D1).** A copy loads only when its numeric `major.minor` equals the running CLI's; prerelease tags are ignored. Candidates are tried in order and the first match loads; a warning appears only when copies exist and none of them matches. `@ctxo/domain` repeats the check against `host.cliVersion` and stays inactive on a mismatch. Because the domain may not import CLI runtime code (Decision 4), it carries its own copy of this rule; the duplicate is deliberate, and both copies cite this ADR.

**Releases.** The internal API changes only in minor releases. Changesets puts `@ctxo/cli` and `@ctxo/domain` in one `fixed` group, so they always share a version, and `@ctxo/domain` starts at the CLI's version.

**No second CLI.** `@ctxo/cli` is a devDependency of `@ctxo/domain`, neither a dependency nor a peer, so npm never installs a second CLI copy next to it. The CLI that runs is always the one that loaded the module.

### 4. The import exception

Language plugins still import only from `@ctxo/plugin-api` (ADR-012), with the utility-package exception of ADR-017. `@ctxo/domain` is not a language plugin: plugin discovery (`@ctxo/lang-*`, `ctxo-lang-*`) never finds it, it handles no file type, and it is loaded only as described in Decision 3.

- `@ctxo/domain` imports `@ctxo/cli` and `@ctxo/cli/internal` as types only (`import type`). Every runtime service arrives through `host.services`.
- Lint enforces this in production code with `no-restricted-imports` and `allowTypeImports`, with the message `@ctxo/domain imports the CLI internal API as types only (ADR-018)`. Tests may import `createModuleHost` at runtime to build a real host.
- `packages/cli/src/internal.ts` is a package entry that re-exports. It is the one exception to the no-barrel rule.
- `@ctxo/domain` keeps the hexagonal split: a pure `core/` that never imports `adapters/`, `adapters/` for files and git, and `commands/` and `init/` that wire them. It has no `ports/` layer. The port-first rule ("every adapter implements a port") applies to `@ctxo/cli`. In `@ctxo/domain`, an adapter implements an interface declared in the domain's own `core/` where a core function consumes it.

### 5. The fold guard (K9, K16)

`ctxo domain-guard-hook` (hidden) runs as a Claude Code hook on `SessionStart`, `Stop` and `TaskCompleted`, without a matcher; `ctxo init --domain` registers it. `SubagentStop` is off unless `domain.guard.subagents: true`. One command serves every event, which it reads from `hook_event_name`.

- **Scope.** The guard judges only committed changes of the current session. Uncommitted work never blocks. History from earlier sessions or from other people is left to CI (`contexts-touched --check`, and `verify-domain --since` from Part 2).
- **SessionStart record.** `SessionStart` writes `.ctxo/.cache/domain-guard/<session>.json` with `startHead` (the full HEAD SHA, or `null` before the first commit) and the fingerprints already blocked, and prints nothing, because its stdout would become session context. A resumed session keeps its original record. When a later event finds no record (the hook was installed mid-session), the guard records the current HEAD and allows that turn.
- **Branch range.** The evaluated commits are those in `startHead..HEAD` that also lie in the branch range. One base resolver serves the guard and `contexts-touched`, with the configured base first: `domain.guard.base` when set, else the merge base of HEAD and `origin/HEAD`, else `main` or `master`. On the default branch itself the range is the unpushed commits, `@{u}..HEAD`; without an upstream, the session range alone applies. The commits go through the same computation as `contexts-touched --committed`.
- **Anchoring (designer call D10).** When `startHead` is no longer an ancestor of HEAD (rebase, amend, reset, branch switch), the record is re-anchored to HEAD and the turn is allowed. `startHead: null` means every commit reachable from HEAD belongs to the session.
- **Decision order.**
  1. `SessionStart`: write the record when none exists, exit 0.
  2. `stop_hook_active: true`: allow.
  3. The guard is disabled, the event is `SubagentStop` without `domain.guard.subagents`, or the registry is missing or invalid: allow.
  4. No record: record HEAD and allow.
  5. HEAD cannot be resolved: allow. `startHead` is not an ancestor of HEAD: re-anchor and allow.
  6. No unresolved context in the evaluated commits: allow.
  7. The fingerprint (HEAD SHA plus the sorted unresolved IDs) already blocked in this session: allow. Otherwise record the fingerprint and block once.
- **Two block outputs.** `Stop` (and `SubagentStop`) writes `{"decision":"block","reason":"..."}` to stdout and exits 0. `TaskCompleted` writes the reason to stderr and exits 2, the only documented way to block that event. The reason names each unresolved context, up to three of its changed files, the card path and the exact trailer line.
- **Fail-open.** Any internal error allows: exit 0 and one line on stderr. Empty or malformed input, a missing `session_id`, an unknown event and a corrupt session file all allow. This follows ADR-015's guard, and Claude Code itself fails open for these events and ends a turn after 8 consecutive `Stop` continuations.
- **No MCP stack on the hook route.** `packages/cli/src/index.ts` becomes a thin argv router, and the MCP wiring moves to `mcp-server.ts`. `domain-guard-hook` takes a fast route that loads the module host and `@ctxo/domain` but neither the MCP SDK, the tool handlers nor the CLI router. An e2e test records the modules the hook route imports.
- **Budget.** Under 1 s on the validation fixture (spec 13.4).

### 6. Acknowledgement (K2)

A commit states that a change left a context's behaviour as it was with a trailer:

```
Domain-Unchanged: <id>[, <id>...] [(reason)]
```

- It is read with `git log --format=%(trailers:key=Domain-Unchanged,valueonly)`. The reason is the balanced parenthesised group that ends the value; the IDs are the comma-separated text before it.
- Only commits in the evaluated range count: the `--since` range for `contexts-touched`, the session's branch range for the guard. A trailer elsewhere in history acknowledges nothing.
- A card change in the range resolves a context too, and wins over an acknowledgement.
- Uncommitted work cannot be acknowledged, because a trailer lives in a commit. `contexts-touched` reports working-tree changes by default, and they are resolved only once committed.
- An empty commit that carries the trailer is fine (`git commit --allow-empty`), so an acknowledgement never needs a code change.
- An unknown ID in a trailer gives a warning, never an error.

### 7. Adoption decisions

- **K15, one copy for repositories without `package.json`.** A global install is the supported path: `npm i -g @ctxo/cli @ctxo/domain @ctxo/lang-sql`, so the MCP server, the hooks and the CLI run one copy. `ctxo install` without a `package.json` installs globally and says so, and `ctxo install domain` pins `@ctxo/domain` to the running CLI's version. When `ctxo init` runs from a global install, it writes MCP entries that call the global `ctxo` binary instead of `npx -y @ctxo/cli`; it replaces only ctxo's own default npx entry, never a custom one. Project-local installs keep working. The `install_copies` doctor check warns, and never fails, when the MCP entry and the hooks point at different copies (npx for MCP, `ctxo` from PATH for the hooks) or when the hooks call `ctxo` and none is on PATH.
- **K17, unowned files warn by default.** A file that belongs to no context and is not in `unowned.allow` is a warning until the team sets `domain.coverage.unowned: error`, so a brownfield repository is not failed on day one. The context-map check runs when the file exists.
- **K19, discover, propose, confirm (Part 2).** Conventions such as tracker prefixes, test annotation keys and test folders are discovered by `ctxo domain discover`, proposed by `ctxo init --domain` and confirmed by the team; `ctxo doctor` only warns later. The config is the single source of truth, so behaviour never shifts silently, and the rule-ID safeguards hold with any config.
- **Domain artifacts (Part 2).** The index pass writes `.ctxo/index/domain/` (`contexts.json`, `boundaries.json`, `history/`). Each artifact carries a string `ctxoArtifact` marker (`domain-contexts`, `domain-boundaries`, `domain-history`; PR 3 adds `domain-graph`). `JsonIndexReader` skips any JSON object that carries the marker, and `JsonIndexWriter` refuses to delete one as a stale index entry.

---

## Deviations from the spec text

The spec is not edited. Where the PR 2B plans depart from its text on purpose, this ADR is the record:

| # | Spec text | Decision | Why |
|---|---|---|---|
| C1 | `picomatch` is a dependency of `@ctxo/domain` (10.1) | Registry globs go through the host's `makeGlobMatcher` in `host.services`; `@ctxo/domain` has no `picomatch` dependency | One matcher, so the CLI and the domain match paths identically (picomatch with `dot: true`, backslashes normalised) |
| C2 | `@ctxo/cli` is a peer of `@ctxo/domain` (10.1, dependency list) | `@ctxo/cli` is a devDependency | The spec's own later text in 10.1 and section 18 ask for a devDependency, so npm never installs a second CLI next to the package (Decision 3) |
| C3 | `JsonIndexReader` skips the `domain/` directory (10.7, 13.5) | The reader skips JSON that carries a `ctxoArtifact` marker | Index entries mirror source paths (`.ctxo/index/<path>.json`), so a source folder named `domain/` at the repository root would lose its index under a directory skip |
| C4 | `contexts-touched` statuses are `card-changed`, `acknowledged` and `unresolved`, and the output has no `mode` or `warnings` (10.3) | A fourth status, `no-card`, and the fields `mode` and `warnings` | A context without a card (allowed at rung `fear`) has nothing to fold into and is never unresolved; `mode` says which changes were considered, and `warnings` carries unknown trailer IDs. The additions are documented in "Ctxo domain conventions v1" |
| C10 | `ctxo init --domain` registers the `Stop` and `TaskCompleted` hooks (10.8) | It also registers `SessionStart` | The guard needs the session's starting HEAD (10.4, K16) |

---

## Alternatives considered

- **An extension contract in `@ctxo/plugin-api`.** Rejected by K7: the domain needs core services (the merged index, the graph, config, git, the co-change window), not one file at a time, and a public contract would freeze internals that still change between minors. The internal API is versioned with the CLI instead.
- **A second MCP server for the domain.** Rejected: two processes per session, the index loaded twice, and a second entry in every client's MCP config.
- **Acknowledging in card front matter.** Rejected by K2: an acknowledgement belongs to the commits it covers, and only commits in the evaluated range count. A front-matter flag is tied to no range, stays in the card after the branch merges, and editing it is itself a card change.
- **Guarding uncommitted work.** Rejected by K9: it blocks work in progress that cannot be acknowledged yet, because a trailer needs a commit.
- **Judging the whole branch in the guard.** Rejected by K16: a new session on a branch with unresolved commits from an earlier session or another person would be blocked for work it did not do. CI covers the whole range.

---

## Consequences

**Positive**

- A team can name contexts, assign paths to them and keep cards in step with code, with a CI gate and an in-session guard, without Ctxo writing any domain text.
- Repositories without the package see no domain behaviour, and the domain layer evolves with the CLI without widening the public plugin protocol.
- Repositories without `package.json` get one copy for MCP, hooks and CLI through a global install.

**Negative and risks**

- **The internal API is not stable.** A minor CLI release may change it. Both packages always release together (the `fixed` group), and the loader refuses a copy at another minor, so a mixed install turns domain features off with a warning instead of failing.
- **Two copies.** A project copy and a global CLI at different minors, or npx for MCP and a global binary for hooks, can leave the domain active in one launcher and missing in another. The loader takes the first copy at the CLI's minor, and `install_copies` warns about mixed launchers.
- **Claude Code only for the guard.** Other clients get the `ctxo-domain-fold` skill and the CI gate; Cursor's stop hook cannot block (spec 13.6, deferred in spec 17).
- **The guard trusts commits, not meaning.** A trailer satisfies the guard whether or not behaviour really stayed the same. Judging that is out of scope.
- **The hook route must stay light.** A static import that pulls the MCP stack into `index.ts` would break the 1 s budget; the e2e import-recording test guards it.
- **Tarball size.** The internal entry adds to the CLI tarball; the PR records the measured size against the release-packaging limit.
