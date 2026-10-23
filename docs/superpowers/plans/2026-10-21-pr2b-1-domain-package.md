# PR 2B, Part 1: `@ctxo/domain` Package, CLI Internal API, Registry, `contexts-touched` and the Domain Fold Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the opt-in `@ctxo/domain` package and the `@ctxo/cli` internal API it plugs into, with the context registry, `ctxo contexts-touched`, the session-scoped domain fold guard, `ctxo init --domain` and global-install support (Phase 2 of #156; K1, K2, K7, K9, K15, K16).

**Architecture:**
- `@ctxo/cli` gains a type-only internal API (`@ctxo/cli/internal`, a second tsup entry with code splitting) and a module host. The MCP server, the CLI router and a fast hook route resolve `@ctxo/domain` (project `node_modules` first, then next to the running CLI), check its version and call `register(host)`. The registration contributes commands, an index pass, enrichers, tools, an init part and doctor checks; the CLI wraps masking, `_meta`, recording and staleness.
- `@ctxo/domain` has hexagonal layers of its own: pure `core/` (config, registry, ownership, trailers, touched contexts, guard decision), `adapters/` (registry file, git changes through the host's `IGitPort`, guard session store, config writer), and `commands/` and `init/` that wire them. It imports `@ctxo/cli` only as types; every runtime service arrives through `host.services`.
- The guard is `ctxo domain-guard-hook` for SessionStart, Stop and TaskCompleted, on a route that loads neither the CLI router nor the MCP stack.

**Tech Stack:** TypeScript (ESM, Node >= 20), tsup (code splitting), yaml, simple-git, zod 4 (cli only), @clack/prompts, vitest, pnpm workspace, changesets.

**Spec:** `docs/superpowers/specs/2026-10-20-domain-knowledge-layer-design.md`, sections 10.1 to 10.4 and 10.8, with 3, 4, 5, 13, 15 and 18 (owner decisions K1, K2, K7, K9, K15, K16, K17; the PR 2B calls in 18). Part 2 (`docs/superpowers/plans/2026-10-21-pr2b-2-domain-checks-and-surfaces.md`) covers 10.5 to 10.7, 10.9, 10.10 and the docs. Both parts run on one branch and become one PR; Part 2 writes the changeset.

## Global Constraints

- **Base:** branch `feat/domain-package-156` in its own worktree, stacked on the tip of the PR 2A branch `feat/tiered-agent-rules-159` once PRs 0, 1A, 1B, 1C and 2A are complete. Consumed by name (Task 0 confirms each):
  - PR 0: `IGitPort.getChangeLog`, `getCommitFileChanges`; `canonicalizeChangeLog`; `selectWindow`, `parseCoChangeSince`, `sinceCutoff`; `resolveCoChangeConfig`; `IndexCommand.run({ files, commit })`.
  - PR 1A: `createTestFileClassifier`, `indexTestPatterns`; the contexts-view phase of `ctxo index`. Existing: `compareCodepoint`, `makeGlobMatcher`, `loadConfig`.
  - PR 1B: `annotations` on `SymbolNode`; the rule that a file whose index holds a symbol annotated `Fact`, `Theory`, `Test`, `TestCase` or `TestMethod` is a test file; the facts request switch (`capabilities.facts`); `@ctxo/lang-sql`.
  - PR 2A: `INIT_PARTS`, `resolveInitParts`, `InitPartFlags`, `applyParts`, `InstallResult.warning`, `ensureClaudeHook`, `installSkills`, `InitCommand.plan`, the `.claude/settings.local.json` read-only detection.
- **Hexagonal rules** in both packages: `core/` never imports `adapters/` or `ports/`; `ports/` never imports `adapters/`; no barrel exports (the one exception is the package entry `packages/cli/src/internal.ts`, ADR-018); every adapter implements a port. `cli/` commands construct adapters, as they already do.
- **Type-only rule (K7, ADR-018):** `@ctxo/domain` production code imports `@ctxo/cli` and `@ctxo/cli/internal` with `import type` only, enforced by `@typescript-eslint/no-restricted-imports` with `allowTypeImports`. Tests may import runtime values from `@ctxo/cli/internal`.
- **Versions:** `@ctxo/domain` starts at the cli's version and joins it in a changesets `fixed` group. A module runs only when its `major.minor` equals the running cli's; the internal API changes only in minor releases.
- **Output channels:** never `console.log` (eslint bans it in both packages). Human output to `console.error`, machine JSON to `process.stdout.write`, library logs through `createLogger('ctxo:<ns>')`. Adapters warn and continue; MCP handlers never throw; every MCP payload passes through `wrapResponse` and `masking.mask`.
- **Determinism (spec 13.1):** sort with `compareCodepoint`, never `localeCompare`; no wall clock in analysis results; rewrite a file only when its content changed.
- **Spec values, verbatim:**
  - Registry default `docs/domain/contexts.yaml` (`domain.registry`); rungs `fear | pinned | named | bounded | boring`; `version: 1`; `unowned.allow`; `glossary` default `docs/domain/glossary.md`; `contextMap` default `docs/domain/context-map.md`.
  - Trailer `Domain-Unchanged: <id>[, <id>...] [(reason)]`, read with `%(trailers:key=Domain-Unchanged,valueonly)`; only commits of the evaluated range count.
  - `contexts-touched` statuses `card-changed`, `acknowledged`, `unresolved`; `--check` exits 1 when anything is unresolved.
  - Guard command `ctxo domain-guard-hook`; events SessionStart, Stop, TaskCompleted, no matcher; `SubagentStop` off unless `domain.guard.subagents: true`; session file `.ctxo/.cache/domain-guard/<session>.json`; Stop block = stdout `{"decision":"block","reason":"..."}`, exit 0; TaskCompleted block = reason on stderr, exit 2; `stop_hook_active: true` always allows; any internal error allows (exit 0, log to stderr); budget under 1 s on the fixture.
  - Config defaults: `domain.coverage.unowned: warn`, `domain.boundaries.enforce: by-rung`, `domain.boundaries.blockingRungs: [bounded, boring]`, `domain.rules.idPattern: "^[A-Z][A-Z0-9]*-\\d+$"`.
- **Tests:** vitest in `__tests__/` (the repo's write hook rejects test files outside `__tests__`), kebab-case names without extra dots. Temp dirs from `mkdtempSync(join(tmpdir(), 'ctxo-...'))`; temp repos start with `git init -b main`; every git operation that creates commits in a temp repo (commit, merge, rebase, cherry-pick, amend, revert, tag) passes `-c commit.gpgsign=false -c user.name=Test -c user.email=test@test.com`, plus `-c tag.gpgsign=false` for tags (the guard tests create many). Never run `ctxo init` or `ctxo doctor --fix` against the worktree itself. Domain tests use the built cli: run `pnpm --filter @ctxo/cli build` after any cli change.
- **Git on the branch:** stage the paths in the task's Files block only (`git add <path>...`, never `-A` or `.`), never `.ctxo/` or `.claude/settings.local.json`. Commits are GPG-signed (`git commit -S`); on a signing failure stop and report BLOCKED. The post-commit hook may take minutes; wait for the commit to return. No `Co-Authored-By` or AI attribution lines. No push, PR, publish or issue comment without the owner's approval.
- **Before editing an existing symbol,** call the ctxo MCP tools `get_blast_radius` and `get_why_context` on it. The session's ctxo MCP server indexes the main checkout (older code), so `found: false` from either tool for a symbol added on these branches is expected: call the tools as the project rule asks, then proceed.
- **Tarball:** the CLI limit is 1350 KB (`packages/cli/tests/e2e/release-packaging.test.ts`); when crossed, raise it with the measured size and the reason in the PR description (sourcemaps keep shipping).
- **Text:** English only, no em dashes in anything new.
- **Privacy:** nothing from the private fixture (code, paths, names, table names, rules) in code, tests, docs, commits or PR text; aggregate numbers only.

## Review Focus

1. **CI checkouts: shallow clones, detached HEAD, no `origin/HEAD`, no local base branch** (GitHub Actions checks out one commit at depth 1 by default). Expected: `contexts-touched` exits 2 with the fetch-depth hint instead of reporting nothing; the default base falls back from `origin/HEAD` to `main` to `master`; the guard works on a detached HEAD. Tests: Task 10 `an unknown --since ref exits 2 with the fetch-depth hint` and `the default base falls back to main, then master`; Task 11 `a detached HEAD uses the merge base with the default branch`.
2. **History rewritten or switched mid-session** (rebase, amend, reset, `git checkout` of another branch). Expected: the guard re-anchors and allows instead of blocking on commits of earlier sessions. Test: Task 11 `re-anchors and allows after a rebase or a branch switch`.
3. **Malformed hook input and damaged state:** empty stdin, non-JSON, no `session_id`, an unknown `hook_event_name`, a corrupt session file. Expected: exit 0, nothing on stdout, one stderr line, never a block. Tests: Task 11 `parseGuardPayload rejects ...`, `a corrupt record reads as missing`, `fails open on a git failure or a corrupt registry`.
4. **Two copies:** a project-local `@ctxo/domain` at another minor than a global CLI, or MCP through npx while hooks run the global binary. Expected: the loader uses the first copy whose minor matches and warns only when none does; doctor's `install_copies` warns about mixed launchers. Tests: Task 4 `falls back to the copy next to the CLI when the project copy has another minor`; Task 7 `assessInstallCopies` table.
5. **Windows paths and files:** backslashes and non-ASCII names in registry globs and git output, CRLF and a BOM in `contexts.yaml` and `.ctxo/config.yaml`. Expected: ownership matches after normalisation, the registry parses like LF, `init --domain` keeps the config's line endings. Tests: Task 9 `CRLF and a BOM parse like LF`, `matches backslash paths, spaces and non-ASCII characters`; Task 12 `keeps CRLF line endings and a BOM`.

## Designer calls (spec gaps decided here; the owner may override)

- **D1 Version rule and copies:** same numeric `major.minor` (prerelease tags ignored). Candidates are tried in order (project, then next to the running CLI); the first matching copy loads; a warning appears only when copies exist and none matches. The domain repeats the check on `host.cliVersion`.
- **D2 Entry split:** `packages/cli/src/index.ts` becomes a thin argv router; the MCP wiring moves verbatim to `packages/cli/src/mcp-server.ts` (the MCP composition root; CLAUDE.md is updated in Part 2). `getVersion` and `locateGitRoot` move to `cli/cli-paths.ts`. A static `FAST_ROUTE_COMMANDS` set (`domain-guard-hook`) takes the fast route.
- **D3 Enrichers:** applied inside the six handlers right before `wrapResponse` (`get_why_context`, which has no envelope today, is routed through `wrapResponse` in Task 6), so truncation and masking see the added fields. A throwing enricher drops the enrichment, never the response.
- **D4 Module tools:** input schemas are factories that receive the host's `zod`, so `@ctxo/domain` needs no zod dependency. PR 2B registers no tools; the seam is tested with a stub for PR 3.
- **D5 Git ranges:** optional `IGitPort` methods. A committed range is a commit set (`git log HEAD ^a ^b`); changed paths are the union of per-commit changes; merge commits contribute trailers but no files.
- **D6 Domain config:** the cli schema keeps `domain:` as passthrough (the root is already `.passthrough()`); `@ctxo/domain` validates its section per key, so a domain typo never resets the core config. Invalid values fall back per key and are reported (verify-domain check 1 in Part 2, doctor).
- **D7 Globs:** through the host's `makeGlobMatcher`, so cli and domain match paths identically; `picomatch` is not a domain dependency.
- **D8 `no-card`:** a touched context without a `card` gets status `no-card` and is never unresolved: there is no card to fold into.
- **D9 contexts-touched:** `--since` defaults to the guard's base resolution; exit 2 when git cannot evaluate (unknown ref, no merge base, invalid registry). `unowned` lists changed, indexed, non-test files outside every context and outside `unowned.allow`. Output adds `mode` and `warnings`.
- **D10 Guard anchoring:** when `startHead` is no longer an ancestor of HEAD (rebase, amend, reset, branch switch) the record is re-anchored to HEAD and the turn is allowed. `startHead: null` (no commits at SessionStart) means every commit reachable from HEAD is this session's.
- **D11 Reason text:** lists at most three files per context, then `, ...`.
- **D12 K15 install kind:** `npx` when the CLI's package path has a segment `_npx`, `dlx`, `dlx-*` or `bunx-*`; `project` when it lies inside the project; `global` otherwise. A global install writes the MCP entry `{ "command": "ctxo", "args": [] }` and replaces only ctxo's own default npx entry.
- **D13 Install:** `ctxo install domain` pins `@ctxo/domain` to the running CLI's version (unless `--version`); any `ctxo install` without `package.json` installs globally with a notice.
- **D14 Init part:** `domain` is opt-in: `--domain` adds it to the default parts, `--only domain` selects it alone, `--skip domain` removes it. Without the package, init installs it only interactively or with `--yes`; otherwise it prints the install command and exits 1 after the other parts. With no `--tools`, the domain part targets the detected platforms.
- **D15 Config writer:** `init --domain` calls the cli's `ensureConfig` first, then adds only missing `domain.*` keys (an absent section is appended as a commented block), keeping comments, key order, a BOM and CRLF. The registry skeleton has no contexts and no cards.
- **D16 Hooks:** one command for every event; the event comes from `hook_event_name`. SessionStart prints nothing (its stdout would become session context).
- **D17 Missing module:** a known module command (`verify-domain`, `contexts-touched`, `domain`) prints an install hint and exits 1, so CI never passes silently; `domain-guard-hook` exits 0 silently.
- **D18 Facts:** `ctxo index` requests facts when a loaded module declares `indexCapabilities.facts` (completes spec 8.3's "@ctxo/domain installed" switch); `@ctxo/domain` declares it.
- **D19 Help:** each module command answers `--help` with its usage; `ctxo --help` lists loaded module commands, or one install hint line.

**Layout:** new cli files are the module API (`ports/i-ctxo-module.ts`), the `internal.ts` entry, the host (`cli/module-host.ts`), light paths (`cli/cli-paths.ts`), the loader (`adapters/modules/module-loader.ts`), command dispatch and the fast route (`cli/module-commands.ts`), the MCP composition root (`mcp-server.ts`), two MCP helpers, the install-kind core and the `install_copies` check. Everything else is new under `packages/domain/` (`core/`, `adapters/`, `commands/`, `init/`, `skills/`, `schema/`).

---

### Task 0: Branch setup

- [ ] **Step 1:** Create the worktree with superpowers:using-git-worktrees: branch `feat/domain-package-156` from the tip of `feat/tiered-agent-rules-159`.
- [ ] **Step 2:** Copy both PR 2B plans into the worktree's gitignored `docs/superpowers/plans/` if missing. Do not commit yet: ADR-018 is the PR's first commit (Task 1).
- [ ] **Step 3:** `pnpm install --frozen-lockfile && pnpm -r build`. Expected: success.
- [ ] **Step 4:** Confirm the consumed pieces. Each of these must print matches, otherwise stop and report BLOCKED:
  - `git grep -n -e "getChangeLog" -e "getCommitFileChanges" -- packages/cli/src/ports/i-git-port.ts`; `git grep -n -e "export function selectWindow" -e "export function sinceCutoff" -- packages/cli/src/core/co-change`
  - `git grep -n -e "createTestFileClassifier" -e "indexTestPatterns" -- packages/cli/src/core`; `git grep -n "annotations" -- packages/cli/src/core/types.ts packages/plugin-api/src`; `git grep -n -e "INIT_PARTS" -e "applyParts" -- packages/cli/src/cli`
- [ ] **Step 5:** Record the PR 1B names for Tasks 3 and 5 in the scratchpad: the test-framework annotation helpers, expected `filesWithTestAnnotations(indices)` and `createTestFileClassifier(extraGlobs?, annotatedFiles?)` (PR 1B Task 15; `git grep -n -e "filesWithTestAnnotations" -e "annotatedFiles" -- packages/cli/src/core/test-files`), and the facts switch (`git grep -n "facts" -- packages/cli/src/cli/plugin-loader.ts packages/cli/src/cli/index-command.ts`).
- [ ] **Step 6:** Baseline: `pnpm --filter @ctxo/cli test:unit`. Expected: all pass; note the count for the PR description.

---

### Task 1: ADR-018 (first commit of the PR)

**Files:**
- Create: `docs/architecture/ADR/adr-018-domain-knowledge-layer.md`

- [ ] **Step 1: Write the ADR** in the header-table format of ADR-015 (Status `Accepted`, Date `2026-10-21`, Deciders, a one-sentence Decision, Relates to ADR-004, ADR-012, ADR-015, ADR-016, ADR-017). Sections:
  - **Context:** cards per bounded context in the consumer repo; the agent should read the right card and fold behaviour changes back into it; ADR-004 rejected fetching external docs.
  - **Decision 1, the in-repo knowledge layer and ADR-004:** Ctxo supplies structure, linkage, verification and retrieval only; it never authors domain text and calls no LLM. In-repo cards, the registry, the glossary and provenance files are repository content. External provenance (issue URLs) is stored as a string and never fetched, so ADR-004 stands unchanged.
  - **Decision 2, opt-in package:** `@ctxo/domain`; without it the core is unchanged (the spec 13.2 rows for a missing package and a missing registry).
  - **Decision 3, integration through the CLI internal API (K7):** the `@ctxo/cli/internal` subpath (types plus `createModuleHost`); the registration members (`indexPass`, `registerTools`, `enrich`, `registerCommands`, `init`, `doctorChecks`, `indexCapabilities`); the core wraps masking, `_meta`, recording and staleness; loading from the project, then next to the CLI; D1's version rule; the `fixed` changesets group; `@ctxo/cli` as a devDependency so npm never installs a second CLI.
  - **Decision 4, the import exception:** language plugins still import only `@ctxo/plugin-api` (ADR-012); `@ctxo/domain` is not a language plugin and imports CLI internals as types only, with every runtime service injected; lint enforces it.
  - **Decision 5, the fold guard (K9, K16):** committed changes of the current session only; the SessionStart record; the branch range; the decision order; the two block outputs; fail-open; no MCP stack on the hook route; the 1 s budget; D10.
  - **Decision 6, acknowledgement (K2):** the trailer format; only commits in the evaluated range count; uncommitted work cannot be acknowledged; an empty commit is fine.
  - **Decision 7, adoption decisions:** K15 (global install for repos without `package.json`, MCP entries for the global binary, the `install_copies` check), K17 (unowned files warn by default), K19 (discover, propose, confirm; Part 2), and the domain artifacts under `.ctxo/index/domain/` carrying a `ctxoArtifact` marker that `JsonIndexReader` skips (Part 2).
  - **Alternatives considered:** an extension contract in `@ctxo/plugin-api` (rejected by K7: the domain needs core services, and a public contract would freeze internals); a second MCP server (two processes, the index loaded twice); acknowledging in card front matter (rejected by K2); guarding uncommitted work (rejected by K9: it blocks work in progress that cannot be acknowledged).
  - **Consequences:** a minor cli release may change the internal API; both packages always release together.
- [ ] **Step 2: Check the text.** `git grep -nP "\x{2014}" -- docs/architecture/ADR/adr-018-domain-knowledge-layer.md`. Expected: no output.
- [ ] **Step 3: Commit.**
  ```bash
  git add docs/architecture/ADR/adr-018-domain-knowledge-layer.md
  git commit -S -m "docs(adr): ADR-018 in-repo domain knowledge layer and the CLI internal API (#156)"
  ```
- [ ] **Step 4: Commit the plans.**
  ```bash
  git add -f docs/superpowers/plans/2026-10-21-pr2b-1-domain-package.md docs/superpowers/plans/2026-10-21-pr2b-2-domain-checks-and-surfaces.md
  git commit -S -m "docs: add PR 2B domain package plans"
  ```

---

### Task 2: Git primitives for the domain layer

**Files:**
- Modify: `packages/cli/src/core/types.ts` (next to `ChangeLog`), `packages/cli/src/ports/i-git-port.ts`, `packages/cli/src/adapters/git/simple-git-adapter.ts`
- Test: `packages/cli/src/adapters/git/__tests__/simple-git-adapter-ranges.test.ts`

**Interfaces:**
- Produces (`core/types.ts`):
  ```ts
  export interface GitRange { readonly head: string; readonly exclude: readonly string[] }   // reachable from head, from none of exclude
  export interface RangeCommit {
    readonly hash: string;                      // full SHA
    readonly subject: string;
    readonly isMerge: boolean;                  // more than one parent
    readonly trailers: readonly string[];       // values of the requested key, message order, trimmed, no empties
    readonly changes: readonly FileChange[];    // [] for merge commits
  }
  export interface GitRefs {
    readonly currentBranch?: string;            // undefined on a detached HEAD
    readonly upstream?: string;                 // e.g. 'origin/feat'
    readonly originHead?: string;               // e.g. 'origin/main'
    readonly branches: readonly string[];       // local and remote-tracking short names without '*/HEAD', codepoint order
  }
  ```
- Produces (`IGitPort`, all optional; each returns `undefined` when git fails and refuses refs that start with `-`):
  ```ts
  resolveCommit?(ref: string): Promise<string | undefined>;                 // full SHA of <ref>^{commit}
  mergeBase?(a: string, b: string): Promise<string | undefined>;            // full SHA
  isAncestor?(ancestor: string, descendant: string): Promise<boolean | undefined>;
  getRangeLog?(range: GitRange, options?: { readonly trailerKey?: string }): Promise<RangeCommit[] | undefined>;   // newest first
  getWorkingTreeChanges?(scope: 'all' | 'staged'): Promise<FileChange[] | undefined>;   // all: staged, unstaged and untracked, not ignored
  getRefs?(): Promise<GitRefs | undefined>;
  listTrackedFiles?(): Promise<string[] | undefined>;                       // git ls-files -z
  ```

- [ ] **Step 1: Write the failing tests** with a temp-repo builder (`git init -b main`, signed-off flags from Global Constraints):
  - `getRangeLog lists commits reachable from head and from no excluded ref, newest first`: `c1` on main, `c2`, `c3` on `feat`; `{ head: 'HEAD', exclude: [c1] }` gives `[c3, c2]`.
  - `getRangeLog honours several excluded refs`: `exclude: [c1, c2]` gives `[c3]`.
  - `getRangeLog marks merge commits, gives them no changes and keeps their trailers`: `git merge --no-ff -m "merge" -m "Domain-Unchanged: lending"` gives `isMerge: true`, `changes: []`, `trailers: ['lending']`.
  - `getRangeLog reads the requested trailer key only, in message order`: body `Domain-Unchanged: lending (refactor only)`, `Domain-Unchanged: billing`, `Signed-off-by: T` gives `['lending (refactor only)', 'billing']`.
  - `getRangeLog keeps renames and paths with spaces and non-ASCII characters`: `git mv src/a.ts "src/şube kaydı.ts"` gives `{ status: 'R', path: 'src/şube kaydı.ts', oldPath: 'src/a.ts' }`.
  - `getRangeLog returns [] for an empty range and undefined for an unknown ref`.
  - `getWorkingTreeChanges reports staged, unstaged and untracked files, and only staged ones for 'staged'`: a staged new file (`A`), an unstaged edit (`M`), an untracked file (`A`), a staged `git mv` (`R` with `oldPath`).
  - `mergeBase, isAncestor and resolveCommit describe branch relationships`; each refuses `-x`.
  - `getRefs reports the branch, upstream, origin/HEAD and branch list`: a bare remote, `git push -u origin main`, `git remote set-head origin main` give `currentBranch 'main'`, `upstream 'origin/main'`, `originHead 'origin/main'`, branches `['main', 'origin/main']`; after `git checkout --detach`, `currentBranch` and `upstream` are undefined.
  - `listTrackedFiles returns repo-relative forward-slash paths`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/adapters/git/__tests__/simple-git-adapter-ranges.test.ts`. Expected: FAIL (`getRangeLog is not a function`).
- [ ] **Step 3: Implement** in `SimpleGitAdapter`, with `STABLE_OUTPUT_CONFIG` and `parseNameStatus` reused:
  - `getRangeLog`: `log -M --name-status -z --format=%x1e%H%x1f%P%x1f%s%x1f%(trailers:key=<key>,valueonly)%x1f <head> ^<ex>... --`; the trailer field is empty when no key is given; split trailer values on `\n`.
  - `getWorkingTreeChanges('all')`: `status --porcelain=v1 -z --untracked-files=all` (`?` maps to `A`, a `D` in either column to `D`, `R` to `R` with the second path as `oldPath`, `A` to `A`, anything else to `M`); `'staged'`: `diff --cached -M --name-status -z`.
  - `getRefs`: `symbolic-ref --quiet --short HEAD`, `rev-parse --abbrev-ref --symbolic-full-name @{u}`, `symbolic-ref --quiet --short refs/remotes/origin/HEAD`, `for-each-ref --format=%(refname:short) refs/heads refs/remotes`; a failing sub-call leaves its field undefined (logged at debug, not error).
  - `isAncestor`: `merge-base --is-ancestor`, exit 0 true, exit 1 false, anything else undefined.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then `pnpm --filter @ctxo/cli exec vitest run src/adapters/git`. Expected: the existing adapter tests still pass.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/core/types.ts packages/cli/src/ports/i-git-port.ts packages/cli/src/adapters/git/simple-git-adapter.ts packages/cli/src/adapters/git/__tests__/simple-git-adapter-ranges.test.ts
  git commit -S -m "feat(git): range log with trailers, merge base, working-tree changes, refs and tracked files on the git port (#156)"
  ```

---

### Task 3: The CLI internal API and the module host

**Files:**
- Create: `packages/cli/src/ports/i-ctxo-module.ts`, `packages/cli/src/cli/module-host.ts`, `packages/cli/src/internal.ts`, `packages/cli/src/cli/cli-paths.ts`
- Modify: `packages/cli/src/cli/cli-router.ts` (`getVersion` and `locateGitRoot` move to `cli-paths.ts`; update every importer found by `git grep -n -e "getVersion" -e "locateGitRoot" -- packages/cli/src`), `packages/cli/src/cli/index-cochange.ts` (new `selectRawWindow`), `packages/cli/tsup.config.ts`, `packages/cli/package.json` (`exports`), `packages/cli/tests/e2e/release-packaging.test.ts`
- No change to `packages/cli/src/core/test-files/test-file-classifier.ts`: PR 1B Task 15 already provides `TEST_FRAMEWORK_ANNOTATIONS`, `filesWithTestAnnotations(indices)` and `createTestFileClassifier(extraGlobs?, annotatedFiles?)`, which this task calls (no second copy of the annotation rule)
- Test: `packages/cli/src/cli/__tests__/module-host.test.ts`, `packages/cli/src/cli/__tests__/index-cochange.test.ts`

**Interfaces:**
- Produces (`ports/i-ctxo-module.ts`, types only; `import type { z, ZodRawShape } from 'zod'`):
  ```ts
  export type CoreToolName = 'get_logic_slice' | 'get_why_context' | 'get_change_intelligence' | 'get_blast_radius'
    | 'get_architectural_overlay' | 'find_dead_code' | 'get_context_for_task' | 'get_ranked_context' | 'search_symbols'
    | 'get_changed_symbols' | 'find_importers' | 'get_class_hierarchy' | 'get_symbol_importance' | 'get_pr_impact';
  export type ResponseEnricher = (payload: Record<string, unknown>, args: Readonly<Record<string, unknown>>) => Record<string, unknown>;   // additive only
  export interface ModuleToolDefinition {
    readonly name: string; readonly description: string;
    readonly inputSchema: (zod: typeof z) => ZodRawShape;
    handler(args: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  }
  export interface ToolRegistrar { registerTool(tool: ModuleToolDefinition): void }
  export interface ModuleCommandContext { readonly projectRoot: string; readonly ctxoRoot: string; readStdin(): Promise<string> }
  export interface ModuleCommand {
    readonly name: string; readonly help: readonly string[]; readonly hidden?: boolean;
    run(args: readonly string[], ctx: ModuleCommandContext): Promise<number>;   // resolves to the exit code
  }
  export interface CommandRegistrar { registerCommand(command: ModuleCommand): void }
  export type TestFileCheck = (path: string) => boolean;   // a PR 1B TestFileClassifier: it already holds the annotated files
  export interface CoChangeWindowCommits { readonly head: string; readonly headCommittedAt: number; readonly commits: readonly CommitChangeSet[] }
  export interface IndexPassContext {
    readonly projectRoot: string; readonly ctxoRoot: string; readonly config: CtxoConfig;
    readonly indices: readonly FileIndex[];          // the merged full index
    graph(): SymbolGraph;                             // built on first call, then reused
    readonly isTestFile: TestFileCheck;
    readonly history?: CoChangeWindowCommits;         // raw window commits, renames intact; absent with --skip-history or without git
  }
  export interface InitFileResult { readonly file: string; readonly action: 'created' | 'updated' | 'skipped'; readonly warning?: string }
  export interface ClaudeHookEntry { readonly event: string; readonly matcher?: string; readonly command: string }
  export interface InitPrompter {
    confirm(message: string, initial: boolean): Promise<boolean>;
    select<T extends string>(message: string, options: readonly { readonly value: T; readonly label: string }[], initial: T): Promise<T>;
  }
  export interface InitPartContext {
    readonly projectRoot: string; readonly toolIds: readonly string[];
    readonly dryRun: boolean; readonly yes: boolean; readonly boundaries?: 'by-rung' | 'report';
    readonly prompt: InitPrompter;                    // returns `initial` when not interactive or with --yes
    ensureConfigFile(): InitFileResult;
    ensureClaudeHookEntry(entry: ClaudeHookEntry): InitFileResult;
    installSkill(platformId: string, name: string, content: string): InitFileResult | undefined;
  }
  export interface InitContribution { readonly part: 'domain'; apply(ctx: InitPartContext): Promise<readonly InitFileResult[]> }
  export interface CtxoModuleRegistration {
    readonly id: 'domain';
    readonly indexCapabilities?: { readonly facts?: boolean };
    indexPass?(ctx: IndexPassContext): Promise<void>;
    registerTools?(registrar: ToolRegistrar): void;
    readonly enrich?: Partial<Record<CoreToolName, ResponseEnricher>>;
    registerCommands?(registrar: CommandRegistrar): void;
    readonly init?: InitContribution;
    readonly doctorChecks?: readonly IHealthCheck[];
  }
  export interface CtxoHostServices {
    createLogger(namespace: string): Logger;
    loadConfig(ctxoRoot: string): LoadedConfig;
    makeGlobMatcher(patterns: readonly string[]): (path: string) => boolean;
    createTestFileCheck(config: CtxoConfig, indices: readonly FileIndex[]): TestFileCheck;   // createTestFileClassifier(indexTestPatterns(config), filesWithTestAnnotations(indices)): PR 1A globs plus the PR 1B annotation rule
    createGit(projectRoot: string): IGitPort;
    readIndex(ctxoRoot: string): FileIndex[];
    buildGraph(indices: readonly FileIndex[]): SymbolGraph;
    readCoChangeWindow(projectRoot: string, config: CtxoConfig): Promise<CoChangeWindowCommits | undefined>;
    findGitRoot(dir: string): string | undefined;
  }
  export interface CtxoHost {
    readonly cliVersion: string; readonly mode: 'mcp' | 'cli' | 'hook';
    readonly projectRoot: string; readonly ctxoRoot: string; readonly services: CtxoHostServices;
  }
  export type CtxoModuleRegister = (host: CtxoHost) => Promise<CtxoModuleRegistration | undefined>;
  ```
- Produces (`cli/module-host.ts`): `export function createModuleHost(options: { readonly projectRoot: string; readonly mode: CtxoHost['mode']; readonly cliVersion?: string }): CtxoHost` (`ctxoRoot = join(projectRoot, '.ctxo')`, `cliVersion` defaults to `getVersion()`).
- Produces (`cli/cli-paths.ts`): `getVersion(): string`, `getCliPackageRoot(): string` (directory of the cli's `package.json`), `locateGitRoot(startDir: string): string | null` (moved unchanged).
- Produces (`cli/index-cochange.ts`): `export function selectRawWindow(commits: readonly CommitChangeSet[], coChange: ResolvedCoChangeConfig, headCommittedAt: number): CommitChangeSet[]`, the semantics of `selectWindow` on raw commits.
- Produces (`internal.ts`): `export type` of every module API type above, plus `FileIndex`, `SymbolNode`, `GraphEdge`, `SymbolKind`, `EdgeKind`, `FileChange`, `FileChangeStatus`, `CommitChangeSet`, `ChangeLog`, `RangeCommit`, `GitRange`, `GitRefs`, `CoChangeEntry` (core types), `IGitPort`, `IStoragePort`, `IMaskingPort`, `CtxoConfig`, `LoadedConfig`, `Logger`, `IHealthCheck`, `CheckContext`, `CheckResult`, `CheckStatus`, `SymbolGraph`, `BlastRadiusCalculator`, `ResponseMeta`; runtime: `export { createModuleHost }`.
- tsup: `entry: { index: 'src/index.ts', internal: 'src/internal.ts' }`, `splitting: true`, the rest unchanged. `package.json`:
  ```json
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./internal": { "types": "./dist/internal.d.ts", "import": "./dist/internal.js" },
    "./package.json": "./package.json"
  }
  ```

- [ ] **Step 1: Write the failing tests.**
  - `module-host.test.ts`:
    - `createModuleHost reports the cli version and the project paths`: `cliVersion === getVersion()`, `ctxoRoot === join(root, '.ctxo')`; `cliVersion` can be overridden.
    - `host services load config, match globs, classify test files and read the index`: a temp project with `.ctxo/config.yaml` (`index: { tests: ['**/Specs/**'] }`) and two FileIndex JSON files, `src/a.ts` and `src/Lending.Checks/LoanChecks.cs` with a symbol annotated `{ name: 'Fact' }`. Expect `createTestFileCheck(config, readIndex(ctxoRoot))` true for `src/x/Specs/a.cs`, `src/a.test.ts` and `src/Lending.Checks/LoanChecks.cs` (through its `Fact` annotation), false for `src/a.ts`; `readIndex` returns both; `makeGlobMatcher(['src/**'])('src\\a.ts')` is true.
    - `createGit binds the git port to the project root`: in a temp repo, `resolveCommit('HEAD')` equals `git rev-parse HEAD`.
    - `readCoChangeWindow returns the commits of the configured window`: four commits, config `cochange: { maxCommits: 2 }`, gives two commits, newest first, with `head` and `headCommittedAt`.
    - `findGitRoot walks up to the repository root`.
  - `index-cochange.test.ts`: `selectRawWindow keeps the newest maxCommits and applies the since cutoff`.
  - `release-packaging.test.ts`:
    - `exports publish the entry and the internal API`: `pkg.exports['./internal']` equals the object above; `dist/internal.js` and `dist/internal.d.ts` exist after the build.
    - `the internal API resolves through the package name`: in a temp dir with `node_modules/@ctxo/cli` as a junction (`symlinkSync(ROOT, ..., 'junction')`), `node --input-type=module -e "import('@ctxo/cli/internal').then(m => process.stdout.write(typeof m.createModuleHost))"` prints `function`.
    - `npm pack --dry-run` lists `dist/internal.js` and `dist/internal.d.ts`.
- [ ] **Step 2: Run them and record the baseline size.** `pnpm --filter @ctxo/cli exec vitest run src/cli/__tests__/module-host.test.ts src/cli/__tests__/index-cochange.test.ts`. Expected: FAIL (module not found). Before any source change, run `pnpm --filter @ctxo/cli build` and, in `packages/cli`, `npm pack --dry-run --json`; note `unpackedSize` in the scratchpad PR draft.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `getVersion` and `locateGitRoot`. `createTestFileCheck(config, indices)` returns `createTestFileClassifier(indexTestPatterns(config), filesWithTestAnnotations(indices))` (the PR 1A and PR 1B names recorded in Task 0 Step 5; no new annotation helper). `readCoChangeWindow` calls `getChangeLog(maxCommits)` with `resolveCoChangeConfig(config)` and cuts with `selectRawWindow`. `module-host.ts` imports neither `cli-router.ts` nor `mcp-server.ts` nor `ai-rules.ts`.
- [ ] **Step 4: Build, measure and run.** `pnpm --filter @ctxo/cli build`, then `npm pack --dry-run --json` again and note the new `unpackedSize`. Run the Step 2 command and `pnpm --filter @ctxo/cli test:e2e -- release-packaging`. Expected: PASS. If the size crosses 1350 KB, raise the limit to the measured size rounded up to the next 50 KB, with a comment naming the internal entry, and put both numbers in the PR description draft.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/ports/i-ctxo-module.ts packages/cli/src/cli/module-host.ts packages/cli/src/internal.ts packages/cli/src/cli/cli-paths.ts packages/cli/src/cli/cli-router.ts packages/cli/src/cli/index-cochange.ts packages/cli/tsup.config.ts packages/cli/package.json packages/cli/tests/e2e/release-packaging.test.ts packages/cli/src/cli/__tests__/module-host.test.ts packages/cli/src/cli/__tests__/index-cochange.test.ts
  git commit -S -m "feat(cli): @ctxo/cli/internal entry and the module host for @ctxo/domain (#156)"
  ```
  Also stage the other importers changed by the move.

---

### Task 4: Module loader and the version check

**Files:**
- Create: `packages/cli/src/adapters/modules/module-loader.ts`
- Modify: `packages/cli/src/adapters/language/plugin-discovery.ts` (new `resolvePackageCandidates`), `packages/cli/src/cli/version-command.ts` (`VersionInfo.modules`, `formatVerbose`, `VersionCommand.collect`), `packages/cli/src/adapters/diagnostics/checks/versions-check.ts` (`collectInfo`)
- Test: `packages/cli/src/adapters/modules/__tests__/module-loader.test.ts`, `packages/cli/src/cli/__tests__/version-command.test.ts`

**Interfaces:**
- Consumes: `CtxoHost`, `CtxoModuleRegister`, `CtxoModuleRegistration` (Task 3).
- Produces:
  ```ts
  // plugin-discovery.ts
  export interface ResolvedPackage { readonly name: string; readonly version: string; readonly pkgDir: string; readonly entryUrl: string; readonly source: 'project' | 'cli' }
  export function resolvePackageCandidates(specifier: string, projectRoot: string, cliAnchor?: string): ResolvedPackage[];
  // project copy first (createRequire(join(projectRoot, 'package.json'))), then next to the CLI (createRequire(cliAnchor ?? import.meta.url)); a real path appears once
  // module-loader.ts
  export const DOMAIN_MODULE_PACKAGE = '@ctxo/domain';
  export type ModuleStatus = 'active' | 'inactive' | 'version-mismatch' | 'load-failed' | 'not-installed';
  export interface ModuleReport { readonly name: string; readonly status: ModuleStatus; readonly version?: string; readonly source?: 'project' | 'cli'; readonly reason?: string }
  export interface LoadedModule { readonly name: string; readonly version: string; readonly registration: CtxoModuleRegistration }
  export interface ModuleLoadResult { readonly modules: readonly LoadedModule[]; readonly reports: readonly ModuleReport[] }
  export function sameMinor(a: string, b: string): boolean;
  export function loadCtxoModules(host: CtxoHost, options?: { readonly refresh?: boolean; readonly cliAnchor?: string }): Promise<ModuleLoadResult>;   // memoized per projectRoot and mode
  // version-command.ts: VersionInfo gains `modules: readonly ModuleReport[]`
  ```
- Messages (exact, through `createLogger('ctxo:modules')`):
  - `@ctxo/domain <v> does not match @ctxo/cli <cli>; domain features are off. Install @ctxo/domain@<cli> next to the CLI you run.`
  - `@ctxo/domain failed to load: <reason>; domain features are off.`

- [ ] **Step 1: Write the failing tests.** Stub packages are written into temp `node_modules/@ctxo/domain/` (`package.json` with `"type": "module"` and `exports`, `index.js` exporting `register`):
  - `loads a matching project copy and calls register with the host`: the stub returns `{ id: 'domain' }` and records `host.mode`; reports `[{ status: 'active', source: 'project' }]`.
  - `skips a copy whose minor differs and warns`: cliVersion `1.2.3`, stub `1.3.0` gives `version-mismatch` and the warning text.
  - `falls back to the copy next to the CLI when the project copy has another minor` (Review Focus 4): a second stub under a temp `cliAnchor` directory gives `source: 'cli'`, no warning.
  - `reports not-installed without a warning when no copy exists`.
  - `an import error, a missing register export, a rejected register or a wrong id is load-failed and never throws`.
  - `register returning undefined leaves the module inactive`.
  - `sameMinor compares numeric major and minor only`: `('0.13.0', '0.13.4')` true, `('0.13.0', '0.14.0')` false, `('1.0.0-alpha.1', '1.0.2')` true, `('x', '1.0.0')` false.
  - `memoizes per project and mode; refresh resolves again`.
  - `version-command.test.ts`: `formatVerbose lists modules with their status`: `Modules:    @ctxo/domain 1.2.0 (active)`; `--json` output has `modules`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/adapters/modules src/cli/__tests__/version-command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `pickEsmEntry` for the entry URL. Candidates are imported in order until one passes `sameMinor`; the module must export `register` as a function.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/adapters/modules/module-loader.ts packages/cli/src/adapters/language/plugin-discovery.ts packages/cli/src/cli/version-command.ts packages/cli/src/adapters/diagnostics/checks/versions-check.ts packages/cli/src/adapters/modules/__tests__/module-loader.test.ts packages/cli/src/cli/__tests__/version-command.test.ts
  git commit -S -m "feat(cli): load @ctxo/domain from the project or next to the CLI with a version check (#156)"
  ```

---

### Task 5: Entry split, fast hook route, module commands, index-pass and doctor seams

**Files:**
- Create: `packages/cli/src/mcp-server.ts`, `packages/cli/src/cli/module-commands.ts`
- Modify: `packages/cli/src/index.ts` (argv routing only), `packages/cli/src/cli/cli-router.ts` (`route` default case, `printHelp`, `index`, `doctor` and `--version` branches), `packages/cli/src/cli/index-command.ts` (`run` options, a Phase 2e after Phase 2d and the contexts-view phase, the facts capability), `packages/cli/src/cli/doctor-command.ts` (`run`)
- Test: `packages/cli/src/cli/__tests__/module-commands.test.ts`, `cli-router.test.ts`, `index-command.test.ts`, `doctor-command.test.ts`

**Interfaces:**
- Consumes: `createModuleHost` (Task 3), `loadCtxoModules`, `LoadedModule` (Task 4), `selectRawWindow` (Task 3).
- Produces:
  ```ts
  // module-commands.ts
  export const MODULE_COMMAND_PACKAGES: Readonly<Record<string, string>>;   // verify-domain, contexts-touched, domain, domain-guard-hook -> '@ctxo/domain'
  export const FAST_ROUTE_COMMANDS: ReadonlySet<string>;                    // { 'domain-guard-hook' }
  export function collectModuleCommands(modules: readonly LoadedModule[], coreCommands: ReadonlySet<string>): Map<string, ModuleCommand>;   // a name shadowing a core command is dropped with a warning
  export function runModuleCommand(command: string, args: readonly string[], options: { readonly projectRoot: string; readonly modules: readonly LoadedModule[] }): Promise<number | undefined>;   // undefined: no such module command
  export function moduleHelpLines(modules: readonly LoadedModule[]): string[];
  export function runFastRoute(args: readonly string[], cwd: string): Promise<number>;   // 0 when the module or command is missing, or on any error
  // mcp-server.ts
  export function startMcpServer(options: { readonly httpPort?: number }): Promise<void>;
  // index-command.ts run options gain: modules?: readonly LoadedModule[]
  // doctor-command.ts DoctorOptions gain: modules?: readonly LoadedModule[]
  ```
- Behaviour:
  - `index.ts`: no static import of the MCP SDK, the handlers or `cli-router.ts`. HTTP or no args: `(await import('./mcp-server.js')).startMcpServer(...)`. `FAST_ROUTE_COMMANDS.has(args[0])`: `process.exitCode = await (await import('./cli/module-commands.js')).runFastRoute(args, process.cwd())`. Otherwise the `CliRouter` as today.
  - `mcp-server.ts` holds the moved code verbatim (`loadMaskingConfig`, `readStatsEnabled`, `PKG_VERSION`, `registerTools`, the server start); Task 6 extends it.
  - `runFastRoute`: `projectRoot = locateGitRoot(cwd) ?? cwd`, host mode `hook`, `ModuleCommandContext.readStdin` reads all of stdin.
  - `CliRouter`: modules load lazily (`createModuleHost({ mode: 'cli' })` and `loadCtxoModules`) only for help, unknown commands, `index`, `doctor`, `init` (Task 12), `version`. Unknown command: `runModuleCommand`; when it returns undefined and the name is in `MODULE_COMMAND_PACKAGES`, print `[ctxo] "ctxo <command>" needs @ctxo/domain. Install it with "ctxo install domain".` and exit 1; otherwise the existing message. Exit codes are set with `process.exitCode`.
  - `printHelp` (now async) ends with a `Domain commands (@ctxo/domain):` block from `moduleHelpLines`, or the single line `  Domain commands need @ctxo/domain: run "ctxo install domain"`.
  - `IndexCommand`: plugin capabilities request facts when any module has `indexCapabilities.facts` (OR with PR 1B's switch). Keep the Phase 2 change log in a variable. Phase 2e, after Phase 2d and the contexts view, runs each `indexPass` with `indices = mergedIndex()`, a memoized `SymbolGraph`, `isTestFile` from `createTestFileCheck(config, indices)`, and `history` from `selectRawWindow` when the change log exists. A failing pass prints `[ctxo] <name> index pass failed: <message>` and the run continues. `--check` runs no pass.
  - `DoctorCommand`: module checks run after the core checks.

- [ ] **Step 1: Write the failing tests.**
  - `module-commands.test.ts` (in-memory stub modules unless noted):
    - `runModuleCommand runs a registered command with the remaining args and returns its exit code`.
    - `runModuleCommand returns undefined for an unknown command`.
    - `a module command named like a core command is dropped with a warning` (`index`).
    - `moduleHelpLines lists visible commands, hides hidden ones and prints the install hint without modules`.
    - `runFastRoute exits 0 when @ctxo/domain is not installed` (empty temp dir).
    - `runFastRoute runs the module's command and returns its exit code` (stub package registering `domain-guard-hook` that returns 3).
    - `runFastRoute exits 0 when the command throws`.
  - `cli-router.test.ts`:
    - `a known domain command without @ctxo/domain prints an install hint and exits 1`: `route(['verify-domain'])`.
    - `help lists module commands when the module is loaded` (temp project with a stub package).
    - Existing help tests keep passing (the help route is awaited).
  - `index-command.test.ts`:
    - `ctxo index runs module index passes on the merged index and survives a failing pass`: a stub registration records `ctx.indices.length` and `ctx.history?.commits.length`; a second run with a throwing pass completes and stderr contains `index pass failed`.
    - `facts are requested when a module asks for them`: the PluginContext built for plugins has `capabilities.facts === true`.
  - `doctor-command.test.ts`: `doctor runs module checks after the core checks`: a stub check `stub_check` is last in `--json` output.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/cli/__tests__/module-commands.test.ts src/cli/__tests__/cli-router.test.ts src/cli/__tests__/index-command.test.ts src/cli/__tests__/doctor-command.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `main` and `registerTools` (index.ts), `CliRouter.route`, `CliRouter.printHelp`, `IndexCommand.run`, `DoctorCommand.run`.
- [ ] **Step 4: Run the tests and the e2e suite.** The command above, then `pnpm --filter @ctxo/cli build && pnpm --filter @ctxo/cli test:e2e`. Expected: PASS (the MCP spec-compliance and smoke tests spawn `dist/index.js` and must be unaffected).
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/index.ts packages/cli/src/mcp-server.ts packages/cli/src/cli/module-commands.ts packages/cli/src/cli/cli-router.ts packages/cli/src/cli/index-command.ts packages/cli/src/cli/doctor-command.ts packages/cli/src/cli/__tests__/module-commands.test.ts packages/cli/src/cli/__tests__/cli-router.test.ts packages/cli/src/cli/__tests__/index-command.test.ts packages/cli/src/cli/__tests__/doctor-command.test.ts
  git commit -S -m "feat(cli): fast hook route, module commands, index-pass and doctor seams; the MCP server moves to mcp-server.ts (#156)"
  ```

---

### Task 6: MCP: module tools and response enrichers

**Files:**
- Create: `packages/cli/src/adapters/mcp/enrich-payload.ts`, `packages/cli/src/adapters/mcp/module-tool-handler.ts`
- Modify: `packages/cli/src/mcp-server.ts` (`registerTools` takes `modules`; exported for tests), the handler factories `handleSearchSymbols`, `handleGetBlastRadius`, `handleFindImporters`, `handleGetLogicSlice`, `handleGetPrImpact`, `handleGetWhyContext` (a new last parameter `enrich?: ResponseEnricher`)
- Test: `packages/cli/src/adapters/mcp/__tests__/enrich-payload.test.ts`, `module-tool-handler.test.ts` (new); `search-symbols.test.ts`, `get-blast-radius.test.ts`, `find-importers.test.ts`, `get-logic-slice.test.ts`, `get-pr-impact.test.ts`, `get-why-context.test.ts` (same folder); `packages/cli/src/__tests__/mcp-server-modules.test.ts` (new)

**Interfaces:**
- Consumes: `ResponseEnricher`, `CoreToolName`, `ModuleToolDefinition` (Task 3), `LoadedModule` (Task 4).
- Produces:
  ```ts
  export function applyEnricher(enrich: ResponseEnricher | undefined, payload: Record<string, unknown>,
    args: Readonly<Record<string, unknown>>, tool: CoreToolName): Record<string, unknown>;   // payload unchanged when absent or when it throws (warned once per call)
  export function collectEnrichers(modules: readonly LoadedModule[]): Map<CoreToolName, ResponseEnricher>;   // several modules compose in load order
  export function handleModuleTool(tool: ModuleToolDefinition, masking: IMaskingPort,
    staleness: StalenessCheck | undefined, indexedFiles: () => readonly string[]): (args: Record<string, unknown>) => Promise<McpToolResult>;
  ```
- Rules: each handler calls `applyEnricher` on its body right before `wrapResponse`; for `get_logic_slice` on the single result or the `{ batch, results }` object. `get_why_context` has no `_meta` envelope today (it only sets a hand-made `_meta.snapshotStaleness`), so this task routes it through `wrapResponse` like the other five: `wrapResponse(body, extras)` with the `snapshotStaleness` extras, exactly as `get_pr_impact` passes them, replaces the manual `responsePayload._meta = ...`; the enricher runs right before it and `masking.mask` after it, so enrichment, the envelope and masking see one payload. Module tools register after the core tools with the core `toolAnnotations` and `withRecording`; a module tool named like a core tool is skipped with a warning. `handleModuleTool` returns `{ content: [staleness warning?, masked JSON of wrapResponse(result)] }` and turns a throw into `{ error: true, message }`.

- [ ] **Step 1: Write the failing tests.**
  - `applyEnricher returns the enriched payload`; `applyEnricher keeps the original payload when the enricher throws`.
  - `handleModuleTool wraps the result in _meta and masks it`: a handler returning `{ results: [1, 2], key: 'AKIAIOSFODNN7EXAMPLE' }` gives `_meta.totalItems === 2` and the key masked; `handleModuleTool turns a thrown error into { error: true, message }`; `prefixes the staleness warning when the index is stale`.
  - In each of the six handler test files: `applies the enricher before the envelope and masking`: an enricher adding `enrichedBy: 'stub'` at the top level (and, for list tools, on each entry) shows in the response; without an enricher the existing assertions hold.
  - In `get-why-context.test.ts`: `get_why_context wraps its payload in the _meta envelope`: a plain response carries `_meta` with `totalItems`, `returnedItems`, `truncated: false` and `totalBytes`; with a stale snapshot `_meta.snapshotStaleness` is still present next to them; a commit message holding a secret-like token (`AKIAIOSFODNN7EXAMPLE`) is still masked after wrapping.
  - `mcp-server-modules.test.ts` (InMemoryTransport client): `registerTools adds module tools and skips one named like a core tool`; `listTools` returns the 14 core tools plus the stub tool, and calling the stub returns its wrapped payload.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/adapters/mcp src/__tests__/mcp-server-modules.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on the six handler factories and `registerTools`. In `handleGetWhyContext`, import `wrapResponse` from `core/response-envelope.js`, build the `extras` the way `handleGetPrImpact` does, and return `masking.mask(JSON.stringify(wrapResponse(enriched, extras)))`.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then `pnpm --filter @ctxo/cli test:unit`. Expected: all pass (the existing `get_why_context` assertions on `snapshotStaleness` keep passing).
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/adapters/mcp/enrich-payload.ts packages/cli/src/adapters/mcp/module-tool-handler.ts packages/cli/src/mcp-server.ts packages/cli/src/adapters/mcp/search-symbols.ts packages/cli/src/adapters/mcp/get-blast-radius.ts packages/cli/src/adapters/mcp/find-importers.ts packages/cli/src/adapters/mcp/get-logic-slice.ts packages/cli/src/adapters/mcp/get-pr-impact.ts packages/cli/src/adapters/mcp/get-why-context.ts packages/cli/src/__tests__/mcp-server-modules.test.ts
  git add packages/cli/src/adapters/mcp/__tests__/enrich-payload.test.ts packages/cli/src/adapters/mcp/__tests__/module-tool-handler.test.ts packages/cli/src/adapters/mcp/__tests__/search-symbols.test.ts packages/cli/src/adapters/mcp/__tests__/get-blast-radius.test.ts packages/cli/src/adapters/mcp/__tests__/find-importers.test.ts packages/cli/src/adapters/mcp/__tests__/get-logic-slice.test.ts packages/cli/src/adapters/mcp/__tests__/get-pr-impact.test.ts packages/cli/src/adapters/mcp/__tests__/get-why-context.test.ts
  git commit -S -m "feat(mcp): module tools and additive response enrichers on six core tools (#156)"
  ```

---

### Task 7: Global installs (K15)

**Files:**
- Create: `packages/cli/src/core/install/install-kind.ts`, `packages/cli/src/adapters/diagnostics/checks/install-copies-check.ts`
- Modify: `packages/cli/src/cli/install-command.ts` (`InstallCommand.run`, `resolveLanguages`, `buildPluginSpecifiers`), `packages/cli/src/cli/update-command.ts` (`defaultDiscoverInstalled`, `projectHasCtxoDep`), `packages/cli/src/cli/ai-rules.ts` (`CTXO_MCP_ENTRY`, `ensureMcpConfig`), `packages/cli/src/cli/init-command.ts` (pass the install kind to `ensureMcpConfig` in `applyParts`), `packages/cli/src/cli/doctor-command.ts` (register the check), `packages/cli/src/cli/cli-router.ts` (`printHelp` install lines)
- Test: `packages/cli/src/core/install/__tests__/install-kind.test.ts` (new), `packages/cli/src/cli/__tests__/install-command.test.ts` (new), `update-command.test.ts`, `ai-rules.test.ts`, `packages/cli/src/adapters/diagnostics/__tests__/install-copies-check.test.ts` (new)

**Interfaces:**
- Consumes: `getVersion`, `getCliPackageRoot` (Task 3), `resolvePackageCandidates` (Task 4).
- Produces:
  ```ts
  // core/install/install-kind.ts (pure)
  export type CliInstallKind = 'project' | 'npx' | 'global';
  export function cliInstallKind(cliPackageRoot: string, projectRoot: string, platform?: NodeJS.Platform): CliInstallKind;   // D12
  export type McpLauncher = 'npx' | 'path-binary' | 'other';
  export function mcpLauncherOf(entry: unknown): McpLauncher | undefined;   // npx (or cmd /c npx) with @ctxo/cli; ctxo (or cmd /c ctxo); undefined when not an entry object
  export interface InstallCopiesFacts { readonly launchers: readonly McpLauncher[]; readonly hooksCallCtxo: boolean; readonly ctxoOnPath: boolean }
  export type InstallCopiesVerdict = { readonly status: 'pass'; readonly message: string } | { readonly status: 'warn'; readonly message: string; readonly fix: string };
  export function assessInstallCopies(facts: InstallCopiesFacts): InstallCopiesVerdict;
  // cli/install-command.ts
  export const INSTALL_EXTRAS: Readonly<Record<string, string>>;   // { domain: '@ctxo/domain' }
  export function resolveInstallTargets(raw: readonly string[]): { readonly languages: KnownLanguage[]; readonly extras: string[]; readonly unknown: string[] };
  // buildPluginSpecifiers(languages, opts) gains opts.extras and opts.cliVersion; extras are pinned to `version ?? cliVersion`
  // cli/ai-rules.ts
  export function ctxoMcpEntry(kind: CliInstallKind): { command: string; args: string[] };   // global: ctxo with no args; else npx -y @ctxo/cli
  // ensureMcpConfig(projectRoot, target, options?: { dryRun?: boolean; installKind?: CliInstallKind })
  // install-copies-check.ts
  export class InstallCopiesCheck implements IHealthCheck { readonly id = 'install_copies'; readonly title = 'Install copies'; constructor(options?: { readonly pathDirs?: readonly string[] }) }
  ```
- Exact texts:
  - Install notice: `[ctxo] No package.json here: installing globally, so the MCP server, hooks and CLI share one copy.`
  - `assessInstallCopies` checks in this order: the PATH warning, the npx warning, then the pass messages `one copy: MCP and hooks run ctxo from PATH` and `nothing to compare (no ctxo hooks or no MCP entry)`.
  - Warn (npx launcher and `hooksCallCtxo`): message `MCP starts "npx -y @ctxo/cli" while hooks run "ctxo" from PATH: two copies, and @ctxo/domain installed in one is missing from the other`; fix `Install once globally ("npm i -g @ctxo/cli @ctxo/domain"), then run "ctxo init --only mcp" from that install`.
  - Warn (`hooksCallCtxo` and not `ctxoOnPath`): message `hooks call "ctxo" but no ctxo is on PATH, so they never run`; fix `Install @ctxo/cli globally ("npm i -g @ctxo/cli")`.
  - Help line: `  ctxo install domain       Install @ctxo/domain at this CLI's version (globally without package.json)`.
- Rules:
  - `ensureMcpConfig` with `installKind: 'global'` writes `ctxoMcpEntry('global')` for a new entry and replaces an existing `ctxo` entry only when it equals ctxo's npx default (plus the target's extra fields); a custom entry is skipped.
  - `applyParts` passes `cliInstallKind(getCliPackageRoot(), projectRoot)`.
  - The check reads the `ctxo` server of `.mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.amazonq/mcp.json`, `.continue/mcpServers/ctxo.json`, and every hook command of `.claude/settings.json` and `.claude/settings.local.json` that starts with `ctxo `. `ctxoOnPath` looks for `ctxo` (`ctxo.cmd`, `ctxo.exe` on win32) in `pathDirs ?? process.env.PATH`. It never fails, only warns.
  - `ctxo update` lists `@ctxo/domain` with its resolved version when a copy exists; `projectHasCtxoDep` accepts `@ctxo/domain`.

- [ ] **Step 1: Write the failing tests.**
  - `cliInstallKind classifies project, npx, pnpm dlx, bunx and global installs` (`it.each`): `/repo/node_modules/@ctxo/cli` with `/repo` is `project`; `/home/u/.npm/_npx/ab12/node_modules/@ctxo/cli` is `npx`; `C:\\Users\\u\\AppData\\Local\\pnpm\\dlx\\x\\node_modules\\@ctxo\\cli` is `npx`; `/usr/lib/node_modules/@ctxo/cli` is `global`; `c:\\repo\\node_modules\\@ctxo\\cli` with `C:\\Repo` on win32 is `project`.
  - `mcpLauncherOf recognises npx, ctxo and cmd /c wrappers`.
  - `assessInstallCopies` (Review Focus 4): table over the three verdicts and both pass messages.
  - `ctxo install domain sql plans @ctxo/domain at the CLI version and @ctxo/lang-sql`: `--dry-run` output contains `@ctxo/domain@${getVersion()}` and `@ctxo/lang-sql`; `--version 1.2.3` pins the extra to `1.2.3`.
  - `installs globally without package.json and says so` (`--dry-run` in an empty temp dir: `-g` and the notice).
  - `ctxo update includes @ctxo/domain when a copy is installed` (temp project with a stub package).
  - `ensureMcpConfig writes the global binary entry from a global install`; `replaces ctxo's own npx entry from a global install, never a custom entry` (`{ command: 'node', args: ['x.js'] }` stays); `keeps npx for project installs`.
  - `install_copies warns when MCP uses npx and hooks call ctxo`; `warns when hooks call ctxo and none is on PATH`; `passes with one copy`; `doctor registers install_copies`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/core/install src/cli/__tests__/install-command.test.ts src/cli/__tests__/update-command.test.ts src/cli/__tests__/ai-rules.test.ts src/adapters/diagnostics`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `InstallCommand.run`, `buildPluginSpecifiers`, `ensureMcpConfig`, `defaultDiscoverInstalled`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/core/install/install-kind.ts packages/cli/src/adapters/diagnostics/checks/install-copies-check.ts packages/cli/src/cli/install-command.ts packages/cli/src/cli/update-command.ts packages/cli/src/cli/ai-rules.ts packages/cli/src/cli/init-command.ts packages/cli/src/cli/doctor-command.ts packages/cli/src/cli/cli-router.ts packages/cli/src/core/install/__tests__/install-kind.test.ts packages/cli/src/cli/__tests__/install-command.test.ts packages/cli/src/cli/__tests__/update-command.test.ts packages/cli/src/cli/__tests__/ai-rules.test.ts packages/cli/src/adapters/diagnostics/__tests__/install-copies-check.test.ts
  git commit -S -m "feat(install): global installs without package.json, ctxo install domain, global MCP entries and an install_copies check (#156)"
  ```

---

### Task 8: `@ctxo/domain` package and its registration

**Files:**
- Create: `packages/domain/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `vitest.config.e2e.ts`, `eslint.config.js`, `README.md`, `src/index.ts`, `src/version.ts`, `src/__tests__/register.test.ts`
- Modify: `.changeset/config.json` (`"fixed": [["@ctxo/cli", "@ctxo/domain"]]`), `.github/workflows/ci.yml` (add `@ctxo/domain` to the pack dry-run loop; `pnpm --filter @ctxo/domain test:unit` in the unit job and `pnpm --filter @ctxo/domain test:e2e` in the e2e job, both after `pnpm -r build`), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `CtxoModuleRegister`, `CtxoHost` (types, Task 3).
- Produces:
  ```ts
  // src/version.ts
  export const DOMAIN_PACKAGE = '@ctxo/domain';
  export function domainVersion(): string;            // the version field of this package's package.json
  export function sameMinor(a: string, b: string): boolean;   // the cli's rule (D1)
  // src/index.ts
  export const register: CtxoModuleRegister;
  // mismatch: warn through host.services.createLogger('ctxo:domain'):
  //   `@ctxo/domain <v> needs @ctxo/cli <major>.<minor>.x, running <cli>; staying inactive` and resolve undefined
  // match: { id: 'domain', indexCapabilities: { facts: true }, registerCommands(registrar) {} }   (later tasks add members)
  ```
- Package facts:
  - `version` equals `packages/cli/package.json`'s version at creation.
  - `dependencies: { "yaml": "^2.6.1" }`.
  - `devDependencies`: `@ctxo/cli: workspace:*`, plus `@types/node`, `eslint`, `typescript-eslint`, `tsup`, `typescript`, `vitest` at the cli's versions.
  - `files: ["dist/", "skills/", "schema/", "README.md"]`; `exports` like the lang plugins; `publishConfig` like the others.
  - Scripts: `build` (tsup), `typecheck` (`tsc --noEmit`), `lint` (`eslint src/`), `test` (`vitest run && vitest run --config vitest.config.e2e.ts`), `test:unit` (`vitest run`), `test:e2e` (`vitest run --config vitest.config.e2e.ts`).
- tsup: `entry: ['src/index.ts']`, esm, `dts`, `sourcemap`, `clean`, `target: 'node20'`, `splitting: true`, `external: ['@ctxo/cli', '@ctxo/cli/internal', 'yaml']`.
- vitest: unit includes `src/**/__tests__/**/*.test.ts`; e2e includes `e2e/__tests__/**/*.test.ts` with `testTimeout: 120_000`.
- eslint: the cli's rules (`no-console` allowing `error` and `warn`, the `core/` import restrictions) plus `@typescript-eslint/no-restricted-imports` for `@ctxo/cli` and `@ctxo/cli/internal` with `allowTypeImports: true` and the message `@ctxo/domain imports the CLI internal API as types only (ADR-018)`.

- [ ] **Step 1: Write the failing tests** (`register.test.ts`, host from `createModuleHost` imported from `@ctxo/cli/internal`):
  - `register returns the domain registration when the cli minor matches`: `cliVersion: domainVersion()` gives `id: 'domain'` and `indexCapabilities.facts === true`.
  - `register warns and resolves undefined when the minors differ`: `cliVersion: '0.0.0'`.
  - `the package version equals the cli version`.
- [ ] **Step 2: Run them.** `pnpm install && pnpm --filter @ctxo/cli build && pnpm --filter @ctxo/domain test:unit`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the package files and the CI and changesets edits.
- [ ] **Step 4: Verify.**
  - `pnpm --filter @ctxo/domain build && pnpm --filter @ctxo/domain typecheck && pnpm --filter @ctxo/domain lint && pnpm --filter @ctxo/domain test:unit`. Expected: PASS.
  - Lint rule check: add `import { createModuleHost } from '@ctxo/cli/internal';` to `src/index.ts`, run `pnpm --filter @ctxo/domain lint`. Expected: the restricted-import error. Revert the line.
  - `pnpm changeset status --verbose`. Expected: no config error.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/package.json packages/domain/tsconfig.json packages/domain/tsup.config.ts packages/domain/vitest.config.ts packages/domain/vitest.config.e2e.ts packages/domain/eslint.config.js packages/domain/README.md packages/domain/src/index.ts packages/domain/src/version.ts packages/domain/src/__tests__/register.test.ts .changeset/config.json .github/workflows/ci.yml pnpm-lock.yaml
  git commit -S -m "feat(domain): @ctxo/domain package with a version-checked registration (#156)"
  ```

---

### Task 9: Domain config, registry and ownership

**Files:**
- Create: `packages/domain/src/core/domain-config.ts`, `src/core/registry.ts`, `src/core/ownership.ts`, `src/adapters/registry-reader.ts`, `packages/domain/schema/contexts.schema.json`
- Test: `packages/domain/src/core/__tests__/domain-config.test.ts`, `registry.test.ts`, `ownership.test.ts`, `packages/domain/src/adapters/__tests__/registry-reader.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // registry.ts
  export const RUNGS = ['fear', 'pinned', 'named', 'bounded', 'boring'] as const;  export type Rung = (typeof RUNGS)[number];
  export const CONTEXT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  export const RULE_PREFIX_PATTERN = /^[A-Z][A-Z0-9]*$/;
  export interface DomainContext { readonly id: string; readonly name: string; readonly card?: string; readonly paths: readonly string[];
    readonly rung: Rung; readonly rulePrefix?: string; readonly contracts: Readonly<Record<string, readonly string[]>> }
  export interface DomainRegistry { readonly version: 1; readonly contexts: readonly DomainContext[]; readonly unownedAllow: readonly string[];
    readonly glossary: string; readonly contextMap: string }
  export interface RegistryProblem { readonly path: string; readonly message: string }   // e.g. 'contexts[1].id'
  export function parseRegistry(text: string): { readonly registry?: DomainRegistry; readonly problems: readonly RegistryProblem[] };   // registry only when problems is empty
  export function registryHash(text: string): string;   // first 16 hex of SHA-256 over the text, BOM stripped, CRLF normalised
  // domain-config.ts
  export type BoundaryMode = 'by-rung' | 'report';
  export interface DomainConfig {
    readonly registry: string;
    readonly coverage: { readonly unowned: 'warn' | 'error' };
    readonly boundaries: { readonly enforce: BoundaryMode; readonly blockingRungs: readonly Rung[] };
    readonly rules: { readonly idPattern: string; readonly trackerPrefixes: readonly string[] };
    readonly tests: { readonly ruleTraitKeys: readonly string[] };
    readonly guard: { readonly enabled: boolean; readonly base?: string; readonly subagents: boolean };
  }
  export const DEFAULT_DOMAIN_CONFIG: DomainConfig;   // registry 'docs/domain/contexts.yaml', unowned 'warn', 'by-rung', ['bounded', 'boring'],
                                                      // '^[A-Z][A-Z0-9]*-\\d+$', trackerPrefixes [], ruleTraitKeys ['Rule'], guard { enabled: true, subagents: false }
  export interface ConfigProblem { readonly path: string; readonly message: string }   // e.g. 'domain.boundaries.enforce'
  export function resolveDomainConfig(raw: unknown): { readonly config: DomainConfig; readonly problems: readonly ConfigProblem[] };   // per-key fallback (D6)
  // ownership.ts
  export type GlobMatcherFactory = (patterns: readonly string[]) => (path: string) => boolean;
  export interface Ownership {
    owners(path: string): readonly string[];            // ids of every context whose paths match, registry order
    ownerOf(path: string): string | undefined;          // exactly one owner, else undefined
    isAllowedUnowned(path: string): boolean;
    isContract(fromContext: string, targetFile: string): boolean;   // targetFile matches fromContext.contracts[ownerOf(targetFile)]
  }
  export function createOwnership(registry: DomainRegistry, makeMatcher: GlobMatcherFactory): Ownership;
  // adapters/registry-reader.ts
  export interface LoadedRegistry { readonly path: string; readonly text: string; readonly registry?: DomainRegistry; readonly problems: readonly RegistryProblem[] }
  export function readRegistry(projectRoot: string, registryPath: string): LoadedRegistry | undefined;   // undefined when the file does not exist
  ```
- Validation rules for `parseRegistry` (each a problem with its path; unknown keys are problems):
  - A YAML syntax error is one problem with path `''` and the line.
  - `version` must be `1`; `contexts` an array (may be empty).
  - Per context: `id` matches `CONTEXT_ID_PATTERN` and is unique; `name` non-empty; `card` optional non-empty; `paths` a non-empty array of non-empty strings; `rung` in `RUNGS`; `rulePrefix` optional, matches `RULE_PREFIX_PATTERN`, unique; `contracts` optional, keys are ids of other contexts, values non-empty string arrays.
  - `unowned.allow` (default `[]`), `glossary` and `contextMap` defaults; contexts keep file order.
- Config rules: `idPattern` must compile; `trackerPrefixes` match `RULE_PREFIX_PATTERN`; `blockingRungs` within `RUNGS`; `ruleTraitKeys` non-empty strings; `guard.base` non-empty and not starting with `-`; booleans are booleans.
- `contexts.schema.json`: JSON Schema draft 2020-12 for the same structure.

- [ ] **Step 1: Write the failing tests.**
  - `parses the spec example registry` (the 10.2 block verbatim): one context `lending` with `contracts.billing`, `unownedAllow ['src/Host/**']`. (The example's `billing` target is not defined there, so add a `billing` context to the fixture.)
  - `reports every problem with its path` (`it.each`): id `Lending`, a duplicate id, rung `pinnned`, empty `paths`, contracts to unknown `shipping`, contracts to itself, a duplicate `rulePrefix`, `version: 2`, unknown key `owner`.
  - `a YAML syntax error is one problem with its line`; `defaults glossary, contextMap and unowned.allow`.
  - `CRLF and a BOM parse like LF` (Review Focus 5); `registryHash ignores CRLF and changes with the text`.
  - `the JSON Schema agrees with the parser constants`: its rung enum equals `RUNGS`, the `id` and `rulePrefix` patterns equal the two patterns' sources, `version` is `const: 1`.
  - `resolveDomainConfig defaults when the section is absent`; `keeps valid values`; `falls back per key and reports each invalid value` (`enforce: 'strict'`, `unowned: 'eror'`, `idPattern: '(['`, `blockingRungs: ['gold']`): four problems with their paths, the other keys keep their values.
  - Ownership (with the host's `makeGlobMatcher`): `a file matching one context is owned by it`; `a file matching two contexts has two owners and no single owner`; `unowned.allow`; `contracts allow edges into listed target files only`; `matches backslash paths, spaces and non-ASCII characters` (Review Focus 5: `src\\Lending\\Şube Kaydı.cs` with `src/Lending/**`).
  - `readRegistry returns undefined for a missing file and reads the configured path`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain test:unit`. Expected: FAIL.
- [ ] **Step 3: Implement** with `yaml`'s `parseDocument` (errors carry line positions).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/domain-config.ts packages/domain/src/core/registry.ts packages/domain/src/core/ownership.ts packages/domain/src/adapters/registry-reader.ts packages/domain/schema/contexts.schema.json packages/domain/src/core/__tests__/domain-config.test.ts packages/domain/src/core/__tests__/registry.test.ts packages/domain/src/core/__tests__/ownership.test.ts packages/domain/src/adapters/__tests__/registry-reader.test.ts
  git commit -S -m "feat(domain): registry, domain config and ownership with exact problem paths (#156)"
  ```

---

### Task 10: `ctxo contexts-touched`

**Files:**
- Create: `packages/domain/src/core/trailer.ts`, `src/core/touched.ts`, `src/adapters/git-changes.ts`, `src/commands/contexts-touched-command.ts`
- Modify: `packages/domain/src/index.ts` (register the command)
- Test: `packages/domain/src/core/__tests__/trailer.test.ts`, `touched.test.ts`, `packages/domain/src/commands/__tests__/contexts-touched-command.test.ts`

**Interfaces:**
- Consumes: `IGitPort` range methods (Task 2), `DomainRegistry`, `Ownership`, `DomainConfig`, `readRegistry` (Task 9).
- Produces:
  ```ts
  // trailer.ts
  export const DOMAIN_UNCHANGED_TRAILER = 'Domain-Unchanged';
  export interface Acknowledgement { readonly ids: readonly string[]; readonly reason?: string }
  export function parseDomainUnchanged(value: string): Acknowledgement;
  // touched.ts
  export type TouchedStatus = 'card-changed' | 'acknowledged' | 'unresolved' | 'no-card';
  export interface TouchedContext { readonly id: string; readonly files: readonly string[]; readonly card?: string; readonly cardChanged: boolean;
    readonly acknowledged?: { readonly commit: string; readonly reason?: string }; readonly status: TouchedStatus }
  export interface TouchedReport { readonly mode: 'all' | 'committed' | 'staged'; readonly since?: string; readonly base?: string; readonly head?: string;
    readonly contexts: readonly TouchedContext[]; readonly unowned: readonly string[]; readonly unresolved: readonly string[]; readonly warnings: readonly string[] }
  export interface TouchedInput {
    readonly registry: DomainRegistry; readonly ownership: Ownership; readonly isTestFile: (path: string) => boolean;
    readonly indexedFiles?: ReadonlySet<string>;
    readonly commits: readonly RangeCommit[];             // newest first
    readonly workingTree: readonly FileChange[];
    readonly mode: TouchedReport['mode']; readonly since?: string; readonly base?: string; readonly head?: string;
  }
  export function computeTouched(input: TouchedInput): TouchedReport;
  // git-changes.ts
  export class GitChangeReader {
    constructor(git: IGitPort);
    defaultBase(config: DomainConfig): Promise<string | undefined>;   // guard.base, else originHead, else 'main', else 'master' (from getRefs().branches)
    resolveBase(since: string): Promise<{ readonly base: string; readonly head: string } | { readonly error: 'unknown-ref' | 'no-merge-base' }>;   // full SHAs
    committed(exclude: readonly string[]): Promise<RangeCommit[] | undefined>;   // getRangeLog({ head: 'HEAD', exclude }, { trailerKey: DOMAIN_UNCHANGED_TRAILER })
    workingTree(scope: 'all' | 'staged'): Promise<FileChange[] | undefined>;
  }
  // contexts-touched-command.ts
  export function contextsTouchedCommand(host: CtxoHost): ModuleCommand;   // 'contexts-touched'
  ```
- Rules for `parseDomainUnchanged`: when the trimmed value ends with `)`, the reason is the text inside the balanced group that closes at the end (`lending (refactor (no behaviour change))` gives `refactor (no behaviour change)`); the ids are the comma-separated text before it, trimmed, empties dropped.
- Rules for `computeTouched`:
  - Changed paths are every `path` and `oldPath` of the commits (modes `all` and `committed`) plus the working tree (modes `all` and `staged`), deduplicated.
  - A context is touched by a changed non-test path among its `owners` (a multiply-owned path touches each owner).
  - `cardChanged`: the context's `card` is a changed path.
  - `acknowledged`: the newest commit whose trailers name the id; `commit` is its first 7 characters.
  - Status order: no `card` gives `no-card` (D8); then `card-changed`; then `acknowledged`; else `unresolved`.
  - `unowned`: changed non-test paths in `indexedFiles`, without an owner, not allowlisted (D9).
  - `warnings`: `Domain-Unchanged in <sha7> names unknown context "<id>"`, once per pair.
  - Every list in codepoint order; `unresolved` holds the ids.
- Command rules (usage `ctxo contexts-touched [--since <ref>] [--committed | --staged] [--json] [--check]`):
  - `help` line for `ctxo --help`: `  ctxo contexts-touched     Named contexts changed since a ref (--since, --committed, --staged, --json, --check)`.
  - `--help` or `-h` prints the usage to stderr and exits 0. Unknown flag: `[ctxo] Unknown contexts-touched flag: <flag>`, exit 1. Both modes: `[ctxo] --committed and --staged cannot be combined`, exit 1.
  - No registry: `[ctxo] No domain registry at <path>. Create one with "ctxo init --domain".`, exit 0. Registry problems: `[ctxo] The domain registry at <path> has problems; run "ctxo verify-domain".`, exit 2.
  - No `--since` and no default base: `[ctxo] No base branch found (origin/HEAD, main or master); pass --since <ref>.`, exit 2. Unknown ref or no merge base: `[ctxo] Cannot find the merge base of <ref> and HEAD. In CI, fetch the base branch with full history (actions/checkout fetch-depth: 0).`, exit 2.
  - Commits come from `committed([base])`; `indexedFiles` from `readIndex(ctxoRoot)` (none for an empty index); `isTestFile` from `createTestFileCheck(config, indices)` with those same indices. Output fields `since`, `base`, `head` use 7-character SHAs; `--staged` reports no `since` and no `base`. JSON key order: `mode`, `since`, `base`, `head`, `contexts`, `unowned`, `unresolved`, `warnings`.
  - `--json`: the report as `JSON.stringify(report, null, 2)` on stdout. Otherwise stderr lines `  <id>  <status>  <n> file(s)  card <path|none>`, then `[ctxo] Unresolved: <ids>. Update the card, or add "Domain-Unchanged: <ids> (reason)" to a commit.` when any.
  - Exit 1 with `--check` when `unresolved` is non-empty; else 0.

- [ ] **Step 1: Write the failing tests.**
  - Trailer: `parses ids and a reason`; `parses ids without a reason`; `keeps nested parentheses in the reason`; `trims ids and drops empty ones`.
  - Touched (pure, stub ownership):
    - `a changed non-test file marks its context touched; a test file does not`.
    - `a card change wins over an acknowledgement`.
    - `the acknowledgement comes from the newest commit naming the context`.
    - `a context without a card is no-card, never unresolved`.
    - `renames count both the old and the new path`.
    - `an unknown id in a trailer gives one warning`.
    - `staged mode ignores commits`.
    - `unowned lists indexed, non-test, non-allowlisted changed files`.
    - `lists are in codepoint order`.
  - Command (real temp repos, the host from `createModuleHost`):
    - `reports the spec example as acknowledged`: on `feat` off `main`, a commit changing `src/Lending/LoanPolicy.cs` with the trailer `Domain-Unchanged: lending (refactor only)`. `--since main --json` gives the 10.3 shape: `status: 'acknowledged'`, `acknowledged.reason: 'refactor only'`, `since: 'main'`, `base` the merge base.
    - `--check exits 1 for an unresolved context and 0 after a card commit`.
    - `the default mode includes staged, unstaged and untracked changes; --committed ignores them`.
    - `uncommitted changes cannot be acknowledged`.
    - `the default base falls back to main, then master` (Review Focus 1).
    - `an unknown --since ref exits 2 with the fetch-depth hint` (Review Focus 1).
    - `no registry prints the hint and exits 0`; `--committed with --staged exits 1`; `--help prints the usage`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain test:unit`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/trailer.ts packages/domain/src/core/touched.ts packages/domain/src/adapters/git-changes.ts packages/domain/src/commands/contexts-touched-command.ts packages/domain/src/index.ts packages/domain/src/core/__tests__/trailer.test.ts packages/domain/src/core/__tests__/touched.test.ts packages/domain/src/commands/__tests__/contexts-touched-command.test.ts
  git commit -S -m "feat(domain): ctxo contexts-touched with trailers, modes and --check (#156)"
  ```

---

### Task 11: The domain fold guard

**Files:**
- Create: `packages/domain/src/core/guard.ts`, `src/adapters/guard-session-store.ts`, `src/commands/domain-guard-hook-command.ts`, `packages/domain/e2e/__tests__/guard-hook-route.test.ts`, `packages/domain/e2e/fixtures/record-imports.mjs` (calls `module.register('./import-recorder-hooks.mjs', import.meta.url)`), `packages/domain/e2e/fixtures/import-recorder-hooks.mjs` (a `resolve` hook that appends each resolved URL to the file named by `CTXO_IMPORT_LOG`)
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/core/__tests__/guard.test.ts`, `packages/domain/src/adapters/__tests__/guard-session-store.test.ts`, `packages/domain/src/commands/__tests__/domain-guard-hook-command.test.ts`, the e2e file

**Interfaces:**
- Consumes: `computeTouched`, `GitChangeReader` (Task 10); `readRegistry`, `createOwnership`, `resolveDomainConfig` (Task 9).
- Produces:
  ```ts
  // guard.ts
  export type HookEvent = 'SessionStart' | 'Stop' | 'SubagentStop' | 'TaskCompleted';
  export interface GuardPayload { readonly sessionId: string; readonly event: HookEvent; readonly stopHookActive: boolean; readonly cwd?: string }
  export function parseGuardPayload(raw: string): GuardPayload | undefined;   // undefined: not JSON, no session_id, or another event
  export interface BranchFacts { readonly currentBranch?: string; readonly originHead?: string; readonly branches: readonly string[]; readonly upstream?: string; readonly configuredBase?: string }
  export function branchExclude(facts: BranchFacts): { readonly kind: 'upstream' | 'merge-base' | 'none'; readonly ref?: string };
  // default branch = originHead without its remote, else 'main' or 'master' when listed. On it: the upstream, or none.
  // Elsewhere: merge base with configuredBase ?? originHead ?? 'main' ?? 'master', or none when nothing resolves.
  export function guardFingerprint(head: string, unresolved: readonly string[]): string;   // `${head}|${sorted ids joined by ','}`
  export function formatGuardReason(contexts: readonly TouchedContext[]): string;
  // guard-session-store.ts
  export interface GuardSessionRecord { readonly version: 1; readonly startHead: string | null; readonly blocked: readonly string[] }
  export class GuardSessionStore {
    constructor(cacheDir: string);                                  // <projectRoot>/.ctxo/.cache
    read(sessionId: string): GuardSessionRecord | undefined;        // missing or unreadable: undefined
    write(sessionId: string, record: GuardSessionRecord): void;     // never throws; file domain-guard/<sanitised id>.json
  }
  // domain-guard-hook-command.ts
  export interface GuardResult { readonly exitCode: 0 | 2; readonly stdout?: string; readonly stderr?: string }
  export function evaluateGuard(payload: GuardPayload, env: { readonly host: CtxoHost; readonly projectRoot: string }): Promise<GuardResult>;
  export function domainGuardHookCommand(host: CtxoHost): ModuleCommand;   // 'domain-guard-hook', hidden
  ```
- Decision (`evaluateGuard`), in order:
  1. `SessionStart`: when no record exists, write `{ version: 1, startHead: <full HEAD SHA or null>, blocked: [] }`. Print nothing; exit 0.
  2. `stopHookActive`: allow.
  3. Allow when `domain.guard.enabled` is false, when the event is `SubagentStop` and `domain.guard.subagents` is false, or when the registry is missing or invalid.
  4. No record: write one with the current HEAD and allow.
  5. HEAD unresolvable: allow. `startHead` not an ancestor of HEAD: re-anchor (`startHead` = HEAD, `blocked` kept) and allow (D10).
  6. `exclude` = `startHead` (unless null), plus the upstream for `upstream`, or `mergeBase(HEAD, ref)` for `merge-base` when it resolves. Commits come from `committed(exclude)`; `computeTouched` runs in `committed` mode with no working tree.
  7. No unresolved context: allow. The fingerprint is already in `blocked`: allow. Otherwise append it, write the record and block.
- Block output: Stop and SubagentStop write `JSON.stringify({ decision: 'block', reason })` plus `\n` to stdout and exit 0; TaskCompleted writes the reason to stderr and exits 2. Any throw allows: exit 0, the message on stderr through the logger. The project root is `findGitRoot(payload.cwd)` when `cwd` is set, else `ctx.projectRoot`.
- Reason text (exact copy of spec 10.4; files capped at three, D11):
  ```
  ctxo domain guard: <n> context(s) ha(s|ve) committed changes without a card update.
  - <id>: <k> file(s) (<up to 3 files, ', '>[, ...])
    card: <card path> (unchanged)
  Update the card if behaviour changed (rules, decisions, contracts), then commit it.
  If behaviour did not change, add this trailer to a commit:
    Domain-Unchanged: <ids, ', '> (reason)
  ```
  The context and card lines repeat per unresolved context. Singular forms: `1 context has`, `1 file`.

- [ ] **Step 1: Write the failing tests.**
  - `guard.test.ts`:
    - `parseGuardPayload reads the event, the session and stop_hook_active`.
    - `parseGuardPayload rejects empty input, malformed JSON, a missing session_id and unknown events` (Review Focus 3).
    - `branchExclude uses the upstream on the default branch, none without one, and the merge base elsewhere`.
    - `a detached HEAD uses the merge base with the default branch` (Review Focus 1).
    - `formatGuardReason matches the spec text for one context`: string equality with the 10.4 example, three files and `, ...`.
    - `formatGuardReason pluralises for two contexts and lists both in the trailer line`.
    - `guardFingerprint sorts the ids`.
  - `guard-session-store.test.ts`: `round-trips a record`; `a corrupt record reads as missing` (Review Focus 3); `sanitises session ids into file names` (`a/b\\c` becomes `a_b_c.json`).
  - `domain-guard-hook-command.test.ts`. Real temp repos: `main` with the registry and a Lending card, then a `feat` branch; payloads go through `evaluateGuard`.
    - `blocks once when this session's commits change a context without a card update` (10.10): SessionStart, a commit to `src/Lending/LoanPolicy.cs`, Stop gives stdout JSON `decision: 'block'` with a reason naming `lending`; a second Stop at the same HEAD allows with no stdout.
    - `allows after a card commit`.
    - `allows after an empty commit carrying the trailer`: `git commit --allow-empty -m "chore: fold" -m "Domain-Unchanged: lending (refactor only)"`.
    - `always allows when stop_hook_active is true` (10.10).
    - `does not block a new session for commits made before it started` (10.10).
    - `records HEAD and allows when the hook was installed mid-session`.
    - `re-anchors and allows after a rebase or a branch switch` (Review Focus 2).
    - `TaskCompleted blocks with exit 2 and the reason on stderr`.
    - `SubagentStop is ignored unless domain.guard.subagents is true`.
    - `uncommitted changes never block`.
    - `on the default branch only unpushed commits count`: blocks before `git push`, allows after it.
    - `a session that started before the first commit counts every commit`.
    - `fails open on a git failure or a corrupt registry` (Review Focus 3).
  - `guard-hook-route.test.ts` (e2e: the built CLI from `require.resolve('@ctxo/cli/package.json')`, a temp repo with `node_modules/@ctxo/domain` as a junction to `packages/domain`, payloads on stdin):
    - `the hook route blocks a Stop through the built CLI`.
    - `the hook route never loads the MCP SDK or the CLI router`: run with `node --import <record-imports.mjs>` and `CTXO_IMPORT_LOG` set; no logged URL contains `@modelcontextprotocol`, `cli-router` or `mcp-server`.
    - `the hook route exits 0 silently without @ctxo/domain`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain test:unit`. Expected: FAIL. Then `pnpm --filter @ctxo/domain build && pnpm --filter @ctxo/domain test:e2e`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/guard.ts packages/domain/src/adapters/guard-session-store.ts packages/domain/src/commands/domain-guard-hook-command.ts packages/domain/src/index.ts packages/domain/src/core/__tests__/guard.test.ts packages/domain/src/adapters/__tests__/guard-session-store.test.ts packages/domain/src/commands/__tests__/domain-guard-hook-command.test.ts packages/domain/e2e/__tests__/guard-hook-route.test.ts packages/domain/e2e/fixtures/record-imports.mjs packages/domain/e2e/fixtures/import-recorder-hooks.mjs
  git commit -S -m "feat(domain): session-scoped domain fold guard on SessionStart, Stop and TaskCompleted (#156)"
  ```

---

### Task 12: `ctxo init --domain`

**Files:**
- Modify (cli): `packages/cli/src/cli/init-parts.ts` (`INIT_PARTS`, `resolveInitParts`, `InitPartFlags`), `packages/cli/src/cli/init-command.ts` (`InitOptions`, `applyParts` step 7, `runInteractive`, the prompter), `packages/cli/src/cli/ai-rules.ts` (`ensureClaudeHookEntry`, `installSkillContent`; `ensureClaudeHook` and `installSkills` delegate), `packages/cli/src/cli/cli-router.ts` (`init` flags, help)
- Create (domain): `packages/domain/src/init/domain-init.ts`, `src/adapters/config-writer.ts`, `packages/domain/skills/ctxo-domain-fold/SKILL.md`, `packages/domain/e2e/__tests__/init-domain.test.ts`
- Modify (domain): `packages/domain/src/index.ts` (`init`)
- Test: cli `init-parts.test.ts`, `init-command.test.ts`, `ai-rules.test.ts`, `cli-router.test.ts`; domain `src/init/__tests__/domain-init.test.ts`, `src/adapters/__tests__/config-writer.test.ts`, the e2e file

**Interfaces:**
- Consumes: `InitContribution`, `InitPartContext`, `ClaudeHookEntry` (Task 3), `loadCtxoModules` (Task 4), `InstallCommand` with `domain` (Task 7), `DEFAULT_DOMAIN_CONFIG` (Task 9).
- Produces:
  ```ts
  // init-parts.ts
  export const INIT_PARTS = ['rules', 'skills', 'guard', 'mcp', 'git-hooks', 'config', 'domain'] as const;
  export const OPT_IN_PARTS: ReadonlySet<InitPart>;   // { 'domain' }; InitPartFlags gains `domain?: boolean` (D14)
  // init-command.ts: InitOptions gains `domain?: boolean; boundaries?: 'by-rung' | 'report'`
  // ai-rules.ts
  export function ensureClaudeHookEntry(projectRoot: string, entry: ClaudeHookEntry, options?: { readonly dryRun?: boolean }): InstallResult;
  export function installSkillContent(projectRoot: string, platformId: string, name: string, content: string,
    options?: { readonly dryRun?: boolean }): InstallResult | undefined;   // undefined for platforms without skills
  // domain
  export const DOMAIN_HOOK_COMMAND = 'ctxo domain-guard-hook';
  export function domainInit(host: CtxoHost): InitContribution;
  export function mergeDomainDefaults(text: string, mode: BoundaryMode): { readonly text: string; readonly changed: boolean };
  export const REGISTRY_SKELETON: string;
  ```
- Cli rules:
  - `ensureClaudeHookEntry` keeps PR 2A's handling: skipped when the same command already sits under the event (in `settings.json` or `settings.local.json`); an unreadable file is never written and returns a warning. `ensureClaudeHook` becomes `ensureClaudeHookEntry(root, { event: 'PreToolUse', matcher: 'Edit', command: 'ctxo gate-hook' })`.
  - Router: `--domain`; `--boundaries <by-rung|report>` (a missing or other value prints `[ctxo] --boundaries requires by-rung or report` and exits 1); the part lists in PR 2A's messages and help gain `domain`. New help lines:
    ```
      ctxo init --domain        Also set up the domain layer: registry, fold guard, skill (@ctxo/domain)
      ctxo init --boundaries <by-rung|report>   Boundary mode for --domain, without the prompt
    ```
  - `applyParts` step 7 (`domain`), after `git-hooks`:
    1. Without the module's `init`: a dry run lists `@ctxo/domain (package)` as `created`. With `noInstall`, or non-interactive without `--yes`: the warning `@ctxo/domain is not installed; run "ctxo install domain", then "ctxo init --only domain"`, and `run` ends with exit code 1. Otherwise ask `Install @ctxo/domain@<cli version>? It adds the registry, contexts-touched and the fold guard.` (default yes; `--yes` skips the question). Then run `InstallCommand.run({ languages: ['domain'], yes: true })` and `loadCtxoModules(host, { refresh: true })`; still missing gives the same warning.
    2. `registration.init.apply(ctx)`. `toolIds` is the selected tools, or the detected platforms without `--tools`. `prompt` wraps `@clack/prompts` when interactive without `--yes`, else returns `initial`. `ensureConfigFile` is `ensureConfig(root, { dryRun })`. The two writers come from `ai-rules.ts`.
  - `runInteractive` shows a `Domain Knowledge` step when `domain` is selected.
- Domain `apply` steps, all honouring `ctx.dryRun`:
  1. `ctx.ensureConfigFile()`.
  2. The mode is `ctx.boundaries`, else the existing `domain.boundaries.enforce`, else `ctx.prompt.select('Boundary violations between named contexts', [{ value: 'by-rung', label: 'by-rung: fail verify-domain for bounded and boring contexts, warn for the others' }, { value: 'report', label: 'report: warnings only' }], 'by-rung')`.
  3. `mergeDomainDefaults` into `.ctxo/config.yaml` gives the row `.ctxo/config.yaml`.
  4. `REGISTRY_SKELETON` at the configured registry path when missing.
  5. With `claude-code` in `toolIds`: one `ensureClaudeHookEntry({ event, command: DOMAIN_HOOK_COMMAND })` per event (`SessionStart`, `Stop`, `TaskCompleted`, plus `SubagentStop` when `domain.guard.subagents` is true), each row named `.claude/settings.json (<event>)`.
  6. `installSkill(<platform>, 'ctxo-domain-fold', <SKILL.md text>)` for `claude-code` and `cursor` when selected. The skill file is found by walking up from the module's directory.
- `mergeDomainDefaults` (D15): an absent `domain:` section is appended as this block. Otherwise only missing keys are added through the `yaml` Document API, existing values are never changed, and the BOM and CRLF are kept.
  ```yaml
  domain:
    registry: docs/domain/contexts.yaml
    coverage:
      unowned: warn            # warn | error
    boundaries:
      enforce: <mode>          # by-rung | report
      blockingRungs: [bounded, boring]
    rules:
      idPattern: "^[A-Z][A-Z0-9]*-\\d+$"
      trackerPrefixes: []
    tests:
      ruleTraitKeys: [Rule]
    guard:
      enabled: true
      subagents: false
  ```
- `REGISTRY_SKELETON` (exact):
  ```yaml
  # Ctxo domain registry: named contexts, their paths, cards and rungs.
  # Conventions: https://github.com/alperhankendi/Ctxo/blob/master/docs/features/domain-knowledge.md
  version: 1
  contexts: []
  unowned:
    allow: []
  glossary: docs/domain/glossary.md
  contextMap: docs/domain/context-map.md
  ```
- `ctxo-domain-fold/SKILL.md`: front matter `name: ctxo-domain-fold` and, verbatim, `description: Use BEFORE changing code under a named domain context and BEFORE finishing a branch, to read the context's card and fold behaviour changes back into it.` Three sections:
  - `## Before changing a context's code`: find the context in the generated path rule or `docs/domain/contexts.yaml`; read its card (rules, contracts, decisions).
  - `## When behaviour changes`: update the card in the same branch; rule IDs are permanent.
  - `## At branch finish`: run `ctxo contexts-touched --since <base>`; for each unresolved context commit a card update or add `Domain-Unchanged: <id> (reason)` to a commit (an empty commit is fine); the Stop guard blocks once when a commit changed a context without either.
  No em dashes.

- [ ] **Step 1: Write the failing tests.**
  - Cli:
    - `INIT_PARTS includes domain, which stays out of the default selection`.
    - `--domain adds domain to the default parts; --only domain selects it alone; --skip domain removes it`.
    - Router: `passes --domain and --boundaries to InitCommand.run`; `rejects an invalid --boundaries value`.
    - `ensureClaudeHookEntry adds a Stop entry without a matcher and keeps other hooks`; `does not duplicate an entry present in settings.local.json`; `leaves an unreadable settings.json unchanged and warns`; the existing `ensureClaudeHook` tests keep passing.
    - `installSkillContent writes Claude Code and Cursor skill files and skips identical content`.
    - `the domain part warns and exits 1 when @ctxo/domain is missing and --no-install is set`.
    - `the domain part runs the module's init contribution with the selected tools`: a stub package whose `init.apply` returns one row; the output contains it.
  - Domain:
    - `mergeDomainDefaults appends the commented block when the section is absent`; `adds missing keys and never changes existing values`; `keeps comments`; `keeps CRLF line endings and a BOM` (Review Focus 5).
    - With a recording `InitPartContext`: `writes config defaults with the chosen boundary mode`; `uses --boundaries without prompting`; `creates the registry skeleton only when missing`; `registers SessionStart, Stop and TaskCompleted, plus SubagentStop when guard.subagents is true`; `installs the skill for each selected platform`; `a dry run writes nothing`.
  - e2e `init-domain.test.ts` (built CLI, junction): `ctxo init --only domain --tools claude-code -y --boundaries report` in a temp git repo. Expect:
    - `.ctxo/config.yaml` has `domain.boundaries.enforce: report`;
    - `docs/domain/contexts.yaml` equals `REGISTRY_SKELETON`;
    - `.claude/settings.json` holds `ctxo domain-guard-hook` under SessionStart, Stop and TaskCompleted;
    - `.claude/skills/ctxo-domain-fold/SKILL.md` exists;
    - a second run writes nothing (every row unchanged).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/cli/__tests__/init-parts.test.ts src/cli/__tests__/init-command.test.ts src/cli/__tests__/ai-rules.test.ts src/cli/__tests__/cli-router.test.ts`, then `pnpm --filter @ctxo/cli build && pnpm --filter @ctxo/domain test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `ensureClaudeHook`, `installSkills`, `resolveInitParts`, `InitCommand.applyParts`, `InitCommand.runInteractive`.
- [ ] **Step 4: Run the tests, then the Part 1 checkpoint.** The commands above, then `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm --filter @ctxo/cli test:e2e`. Expected: all green, the tarball test included.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/cli/init-parts.ts packages/cli/src/cli/init-command.ts packages/cli/src/cli/ai-rules.ts packages/cli/src/cli/cli-router.ts packages/cli/src/cli/__tests__/init-parts.test.ts packages/cli/src/cli/__tests__/init-command.test.ts packages/cli/src/cli/__tests__/ai-rules.test.ts packages/cli/src/cli/__tests__/cli-router.test.ts packages/domain/src/init/domain-init.ts packages/domain/src/adapters/config-writer.ts packages/domain/skills/ctxo-domain-fold/SKILL.md packages/domain/src/index.ts packages/domain/src/init/__tests__/domain-init.test.ts packages/domain/src/adapters/__tests__/config-writer.test.ts packages/domain/e2e/__tests__/init-domain.test.ts
  git commit -S -m "feat(init): ctxo init --domain sets up the registry skeleton, domain config, fold guard hooks and the ctxo-domain-fold skill (#156)"
  ```
