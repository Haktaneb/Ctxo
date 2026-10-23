# PR 2B, Part 2: `verify-domain`, Loader Rules, Boundaries and Drift by Named Context, Enrichers, Convention Discovery and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete `@ctxo/domain` with the `verify-domain` CI gate (checks 1 to 11), generated path-scoped loader rules, boundaries and drift by named context, the `context`, `contextBoundaryViolations` and `contextDrift` fields, convention discovery, the library-lending sample with the PR 2B acceptance tests, and the docs (Phase 2 of #156; K1, K6, K11, K17, K19).

**Architecture:**
- Pure `core/` modules in `@ctxo/domain` parse cards (rule headings, rule lines, links), scan test files for rule IDs (K6), compute boundaries and per-context metrics, evaluate the verify-domain checks, render loader rules and discover conventions. Adapters read repo files and the index and write artifacts under `.ctxo/index/domain/` only when their content changed.
- The domain index pass (Part 1's `indexPass` seam) writes `contexts.json`, `boundaries.json` and `history/`; the enrichers (Part 1's `enrich` seam) read them. `verify-domain` computes from the registry, the index and the repo directly, never from artifacts.
- Commands `verify-domain` and `domain` (`rules`, `discover`) register through Part 1's `registerCommands`; `init --domain` and three doctor checks extend Part 1's contributions.

**Tech Stack:** TypeScript (ESM, Node >= 20), yaml, vitest, @modelcontextprotocol/sdk (test client only), pnpm workspace, changesets.

**Spec:** `docs/superpowers/specs/2026-10-20-domain-knowledge-layer-design.md`, sections 10.5 to 10.7, 10.9 and 10.10, with 11.1 (card micro-syntax, consumed by PR 3), 13, 14, 15 and 18. Part 1: `docs/superpowers/plans/2026-10-21-pr2b-1-domain-package.md`.

## Global Constraints

- **Base:** the same branch as Part 1 (`feat/domain-package-156`), after Part 1's Task 12. Consumed from Part 1 by name: `CtxoHost`, `CtxoHostServices` (`readIndex`, `buildGraph`, `createTestFileCheck`, `createGit`, `makeGlobMatcher`, `readCoChangeWindow`), `IndexPassContext`, `ResponseEnricher`, `CoreToolName`, `ModuleCommand`, `InitPartContext`, `InitFileResult`, `TestFileCheck`, `createModuleHost` (`@ctxo/cli/internal`); `IGitPort.listTrackedFiles`, `getRefs`, `getRangeLog`; `readRegistry`, `LoadedRegistry`, `parseRegistry`, `registryHash`, `RUNGS`, `Rung`, `DomainRegistry`, `createOwnership`, `Ownership`, `GlobMatcherFactory`, `resolveDomainConfig`, `DomainConfig`, `ConfigProblem`, `BoundaryMode`; `computeTouched`, `TouchedReport`, `GitChangeReader`; `domainInit`, `mergeDomainDefaults`; `register`.
- **Rules carried from Part 1:** hexagonal layers in both packages and no barrels; `@ctxo/domain` imports `@ctxo/cli` as types only (lint-enforced); never `console.log` (human output to `console.error`, JSON to `process.stdout.write`, logs through `createLogger`); determinism (`compareCodepoint`, no wall clock in results, write only on change; same input twice gives byte-identical artifacts); tests in `__tests__/`, kebab-case, temp repos via `git init -b main`, where every git operation that creates commits (commit, merge, rebase, cherry-pick, amend, revert, tag) passes `-c commit.gpgsign=false -c user.name=Test -c user.email=test@test.com`, plus `-c tag.gpgsign=false` for tags; domain tests use the built cli (`pnpm --filter @ctxo/cli build` after cli changes); never run `ctxo init` or `ctxo doctor --fix` on the worktree.
- **Git on the branch:** stage the Files block paths only, never `.ctxo/` or `.claude/settings.local.json`; `git commit -S`, and a signing failure means stop and report BLOCKED; the post-commit hook may take minutes; no `Co-Authored-By` or AI attribution; no push, PR, publish or issue comment without the owner's approval. Before editing an existing symbol, call `get_blast_radius` and `get_why_context` on it. The session's ctxo MCP server indexes the main checkout (older code), so `found: false` from either tool for a symbol added on these branches is expected: call the tools as the project rule asks, then proceed.
- **Spec values, verbatim:**
  - verify-domain checks and severities as in spec 10.5; exit 0 without errors (warnings allowed), 1 on errors, 2 on internal failure; with no registry a hint and exit 0; `domain.coverage.unowned: warn | error` (default `warn`).
  - Card H2 template in order: `Language`, `Rules and invariants`, `Boundary contracts`, `Decisions`, `Open questions`. Rules are H3 `### <ID> <title>` under `Rules and invariants`; `Tests:`, `Code:`, `Untested:` lines start a rule body.
  - Rule-ID variants `LEND-03`, `LEND03`, `Lend03`, `lend_03` at token boundaries; test declarations `it(`, `test(`, `describe(`, `t.Run(`, `@DisplayName(`, `[Fact(DisplayName =`.
  - Loader files `.claude/rules/ctxo-context-<id>.md` and `.cursor/rules/ctxo-context-<id>.mdc`, prefix `ctxo-context-` (not `ctxo-domain-`: the Cursor copy of the `ctxo-domain-fold` skill is `.cursor/rules/ctxo-domain-fold.mdc`, which a context with id `fold` would otherwise overwrite), marker `<!-- generated by ctxo domain rules; do not edit -->`.
  - Artifacts `.ctxo/index/domain/contexts.json`, `boundaries.json`, `history/` (one entry per commit, 10 entries).
  - `domain.boundaries.enforce: by-rung | report`, `blockingRungs: [bounded, boring]`; an edge from A into B is allowed when its target file matches `A.contracts.B`; edges into unowned files are allowed.
  - Discovery: tracker keys `\b[A-Z][A-Z0-9]{1,9}-\d+\b` in co-change-window commit subjects and branch names, a tracker prefix at 5 or more; `domain.rules.idPattern` default `^[A-Z][A-Z0-9]*-\d+$`.
  - Budgets on the fixture: domain index pass at most 2 s, `ctxo domain-guard-hook` under 1 s.
- **Tarball:** the CLI limit is 1350 KB; when crossed, raise it with the measured size and the reason in the PR description.
- **Text:** English only, no em dashes. **Privacy:** nothing from the private fixture in the repo, tests, docs, commits or PR text; aggregate numbers only.

## Review Focus

1. **Card text that looks like structure but is not:** `### LEND-99` inside fenced code, links inside inline code, setext headings, closing `#`s, CRLF and a BOM. Expected: only ATX H3 headings under the Rules H2 outside code are rules; links in code are ignored. Tests: Task 1 `ignores headings and links inside code`, `CRLF and a BOM parse like LF`.
2. **Rule-ID look-alikes:** tracker keys, `LEND-030`, `XLEND-03`, `LEND-03a`, IDs inside string literals, PascalCase method names. Expected: links only to card IDs at token boundaries; "unknown ID" only from structured references. Tests: Task 2 `rejects look-alikes`, `plain mentions never produce unknown IDs`.
3. **A top-level source folder named `domain/`** (common in DDD repos), whose index lives in `.ctxo/index/domain/` beside the artifacts. Expected: its FileIndex files are still read; artifacts are never read as FileIndex. Test: Task 3 `reads FileIndex files under a source folder named domain/`.
4. **CRLF on disk** (`core.autocrlf=true`) for generated loader files and committed artifacts. Expected: `domain rules --check` and check 8 pass; artifacts are not rewritten for line endings alone. Tests: Task 4 `the diff reports missing, outdated, stale and foreign files and ignores CRLF and a BOM`; Task 3 `writeIfChanged ignores CRLF-only differences`.
5. **A registry edited after the last `ctxo index`.** Expected: verify-domain judges the current registry; enrichers add nothing until the next index run instead of reporting stale contexts. Tests: Task 6 `uses the current registry, not the artifacts`; Task 7 `stale artifacts add nothing`.

## Designer calls (spec gaps decided here; the owner may override)

- **E1 Artifact marker:** domain artifacts carry `"ctxoArtifact": "domain-contexts" | "domain-boundaries" | "domain-history"`. `JsonIndexReader` skips any JSON object with a string `ctxoArtifact` instead of skipping the `domain/` directory, so a source folder `domain/` keeps its index (Review Focus 3). PR 3's `graph.json` uses `domain-graph`.
- **E2 Artifact content:** `contexts.json` and `boundaries.json` hold no `commitSha` or timestamp, so their bytes depend on the registry and the index only. History entries carry `commitSha` and HEAD's `committedAt`, are named `<committedAt>-<sha7>.json` and keep the newest 10 by `committedAt`. Every artifact carries `registryHash`. Write-if-changed compares with CRLF normalised.
- **E3 Enrichers:** they use artifacts only when their `registryHash` equals the current registry's. Files with no single owner get no `context`. `contextBoundaryViolations` appears (possibly empty) whenever valid artifacts exist. Tool descriptions stay unchanged, because the fields appear only with a registry.
- **E4 Boundaries:** in `by-rung` mode a violation is an error when the source or the target context's rung is blocking (a bounded context has no undeclared crossings in or out). Edges from test files and unresolved two-part targets are ignored. `contexts.json` lists every singly-owned indexed file, tests included; checks 4a and 4b skip test files.
- **E5 verify-domain inputs:** registry, config, index and repo files, never artifacts. A missing index exits 2. `domain:` config problems are check 1 errors. Checks 2 to 11 are skipped when the registry has problems.
- **E6 Check 5:** the five template H2s must appear as an ordered subsequence; extra H2s are allowed; only ATX headings count.
- **E7 Check 6:** an explicit reference (a `Trait` whose key is in `domain.tests.ruleTraitKeys`, or a `rule:` comment) with an ID-shaped value not in any card is an error. Test titles and `Category`, `TestCategory` and `Tag` values raise it only for known rule prefixes. A `Tests:` value whose file does not exist is an error.
- **E8 Variant boundaries:** the regex in Task 2: nothing alphanumeric before, no digit or lowercase letter after, so `Lend03RejectsSixthLoan` matches and `LEND-030`, `XLEND-03`, `LEND-03a` do not.
- **E9 Check details:** check 9 matches a row to a context by id or name (case-insensitive, markup stripped) and warns on unknown rows. Check 4b is one finding with the count and up to 20 sample paths. Check 11 uses the committed range only.
- **E10 Loader rules:** Claude Code files are always written; Cursor files only when `.cursor/` exists. Stale means prefix plus marker; a prefixed file without the marker is reported and kept. The Cursor description is `<Name> context: read <card> before changing this code`.
- **E11 Drift:** `crossShare = out / (internal + out)` over edges from non-test files, rounded to 3 decimals. The trend uses entries with the current `registryHash`. Confidence uses spec 6.4's thresholds (fewer than 3 distinct commits low, 3 to 6 medium, 7 or more high). Moved files come from raw renames in the co-change window and are kept from the previous artifact when no change log is available.
- **E12 Discovery:** a prefix counts once per commit subject or branch name. `ruleTraitKeys` proposes `Trait` keys with at least one ID-shaped value. Annotated test files outside the path globs propose `index.tests` globs `<dir>/**`. `discover` runs without a registry. `--write` only adds values.
- **E13 Doctor:** three warn-only checks (`domain_registry`, `domain_agent_setup`, `domain_conventions`); they never edit config and have no `--fix` mapping.
- **E14 Sample:** `packages/domain/test-fixtures/library-lending/{csharp,typescript}`. The MCP acceptance test talks to the built server over stdio with the SDK client, so `@modelcontextprotocol/sdk` becomes a devDependency of `@ctxo/domain`.

## File map

| File (all new, under `packages/domain/`) | Responsibility |
|---|---|
| `src/core/card-parser.ts` | ATX headings outside code, rules and rule lines, links, GitHub slugs |
| `src/core/rule-id-scan.ts`, `src/adapters/test-file-source.ts` | K6 scan of test files; listing and reading them |
| `src/core/boundaries.ts`, `src/core/context-metrics.ts` | Cross-context edges and violations; history entries, drift, moved files |
| `src/adapters/artifact-store.ts`, `src/index-pass/domain-index-pass.ts` | Artifacts under `.ctxo/index/domain/`; the index pass |
| `src/core/loader-rules.ts`, `src/adapters/loader-rules-files.ts` | Loader rule rendering and diff; disk side |
| `src/core/verify-checks.ts`, `src/commands/verify-domain-command.ts` | The eleven checks; the CLI gate |
| `src/mcp/enrichers.ts` | The six enrichers |
| `src/core/discovery.ts`, `src/adapters/discovery-sources.ts` | Convention discovery |
| `src/commands/domain-command.ts`, `src/doctor/domain-checks.ts` | `ctxo domain rules` and `discover`; doctor checks |
| `test-fixtures/library-lending/**`, `e2e/__tests__/acceptance.test.ts` | Sample and acceptance |

---

### Task 0: Setup

- [ ] **Step 1:** Continue in the Part 1 worktree. Confirm Part 1 is complete: `git grep -n -e "export function createModuleHost" -e "export const register" -e "export function computeTouched" -e "export function ensureClaudeHookEntry" -e "export function applyEnricher" -- packages`. Expected: one match each. Otherwise stop and report BLOCKED.
- [ ] **Step 2:** `pnpm install --frozen-lockfile && pnpm -r build && pnpm --filter @ctxo/domain test`. Expected: all green; note the counts.

---

### Task 1: Minimal card parser

**Files:**
- Create: `packages/domain/src/core/card-parser.ts`
- Test: `packages/domain/src/core/__tests__/card-parser.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CARD_H2_TEMPLATE = ['Language', 'Rules and invariants', 'Boundary contracts', 'Decisions', 'Open questions'] as const;
  export interface MdHeading { readonly level: number; readonly text: string; readonly line: number }   // 1-based
  export interface CardRule { readonly id: string; readonly title: string; readonly line: number;
    readonly tests: readonly string[]; readonly code: readonly string[]; readonly untested?: string }
  export interface CardLink { readonly target: string; readonly line: number }   // inline links, images and reference definitions
  export interface ParsedCard { readonly headings: readonly MdHeading[]; readonly rules: readonly CardRule[]; readonly links: readonly CardLink[] }
  export function parseMarkdownHeadings(text: string): MdHeading[];
  export function parseCard(text: string): ParsedCard;
  export function githubSlugs(headings: readonly MdHeading[]): Set<string>;
  export function headingOrderProblems(headings: readonly MdHeading[]): string[];   // check 5 (E6)
  ```
- Rules:
  - Strip a BOM; split lines on `\r?\n`.
  - A fence is a line of up to three spaces then three or more backticks or tildes; it closes on the same character with at least the same length. Nothing inside a fence counts.
  - ATX heading: `/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/`. Setext headings are ignored.
  - Rules: H3 headings between the H2 `Rules and invariants` and the next H2. `id` is the first whitespace-separated token, `title` the rest (check 6 validates the id).
  - Rule lines: in the rule body, skip blank lines, then read consecutive lines starting with `Tests:`, `Code:` or `Untested:`. `Tests:` and `Code:` values are the backticked items; `Untested:` keeps the trimmed remainder. Reading stops at the first other line.
  - Links: `[text](target)` and `![alt](target)` (target up to the first whitespace, `<...>` unwrapped) and reference definitions `/^\s{0,3}\[[^\]]+\]:\s*(\S+)/`, outside fences and inline code spans.
  - Slugs (GitHub): lowercase; drop characters that are not letters, digits, spaces, `-` or `_` (any script); spaces become `-`; repeats get `-1`, `-2` in document order.

- [ ] **Step 1: Write the failing tests.**
  - `parses the spec card example` (spec 11.1 verbatim): rules `LEND-03` (tests `['src/Lending.Tests/LoanLimitTests.cs']`, two `code` values) and `LEND-04` (`untested: 'covered by manual QA until the scheduler migration lands'`); `headingOrderProblems` is empty.
  - `ignores headings and links inside code` (Review Focus 1): a fenced block with `### LEND-99 fake` and `[x](missing.md)`, and the inline span `` `[y](gone.md)` ``.
  - `CRLF and a BOM parse like LF` (Review Focus 1).
  - `closing hashes are stripped and setext headings ignored`.
  - `rule lines stop at the first prose line`.
  - `headingOrderProblems reports a missing or out-of-order heading and allows extra H2s`.
  - `githubSlugs follows GitHub rules`: `Rules and invariants` gives `rules-and-invariants`; `LEND-03 A member holds at most five loans` gives `lend-03-a-member-holds-at-most-five-loans`; `Decisions!` gives `decisions`; a second `FAQ` gives `faq-1`; `Şube Kaydı` gives `şube-kaydı`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/card-parser.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** a line parser; no markdown library.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/card-parser.ts packages/domain/src/core/__tests__/card-parser.test.ts
  git commit -S -m "feat(domain): minimal card parser for rule headings, rule lines, links and anchors (#156)"
  ```

---

### Task 2: Rule-ID text scan of test files (K6)

**Files:**
- Create: `packages/domain/src/core/rule-id-scan.ts`, `src/adapters/test-file-source.ts`
- Test: `packages/domain/src/core/__tests__/rule-id-scan.test.ts`, `packages/domain/src/adapters/__tests__/test-file-source.test.ts`

**Interfaces:**
- Consumes: `FileIndex` with PR 1B `annotations` (type from `@ctxo/cli/internal`).
- Produces:
  ```ts
  export interface RuleIndex { readonly ids: ReadonlySet<string>; readonly prefixes: ReadonlySet<string> }   // card ids; prefixes of card ids and registry rulePrefix
  export type RuleRefKind = 'annotation' | 'rule-comment' | 'test-title' | 'category' | 'mention';
  export interface RuleRef { readonly file: string; readonly line: number; readonly raw: string; readonly id: string;   // id normalised to PREFIX-digits
    readonly kind: RuleRefKind; readonly testTitle?: string; readonly symbolId?: string }
  export interface ScanOptions { readonly rules: RuleIndex; readonly idPattern: RegExp; readonly trackerPrefixes: ReadonlySet<string>; readonly ruleTraitKeys: ReadonlySet<string> }
  export function scanTestText(file: string, text: string, index: FileIndex | undefined, options: ScanOptions): RuleRef[];
  export function annotationRefs(index: FileIndex, options: ScanOptions): RuleRef[];
  export interface RuleLinks { readonly links: ReadonlyMap<string, readonly RuleRef[]>; readonly unknown: readonly RuleRef[] }
  export function resolveRuleRefs(refs: readonly RuleRef[], options: ScanOptions): RuleLinks;
  // adapters/test-file-source.ts
  export interface TestFileText { readonly file: string; readonly text: string; readonly index?: FileIndex }
  export function readTestFiles(projectRoot: string, tracked: readonly string[], isTestFile: TestFileCheck, indices: readonly FileIndex[]): TestFileText[];   // codepoint order
  ```
- Matching (E8), exact regexes:
  ```text
  known-ID variant, one per prefix P (each letter of P written as [Xx], flag g):
      (?<![A-Za-z0-9]) P [-_]?(\d+)(?![0-9a-z])              canonical id: P-<digits>
  ID-shaped token (for unknown IDs; letters upper-cased, separator made '-', then tested with idPattern):
      [A-Za-z][A-Za-z0-9]*[-_]?\d+
  rule-comment (flags gim):
      (?:\/\/|\/\*|#|--|^\s*\*)\s*rule:\s*([A-Za-z][A-Za-z0-9]*[-_]?\d+)
  test declaration; group 2 is the title:
      (?:\b(?:it|test|describe)(?:\.(?:only|skip))?\s*\(|\bt\.Run\s*\(|@DisplayName\s*\(|\[(?:Fact|Theory)\s*\(\s*DisplayName\s*=)\s*(['"`])((?:\\.|(?!\1).)*)\1
  ```
  - Kinds: `rule-comment` from its regex; `test-title` when a declared title starts with an ID-shaped token (the title is also recorded as `testTitle` on every ref of that line); `annotation` for `Trait` with `args[0]` in `ruleTraitKeys` (value `args[1]`); `category` for `args[0]` of `Category`, `TestCategory` or `Tag`; `mention` for any other known-ID match. All kinds but `mention` are structured. Annotation refs use the symbol's `startLine`.
  - `symbolId`: the innermost indexed symbol whose lines span the match (smallest span, then index order); else none (a file-level link).
- `resolveRuleRefs` (K6, K19 safeguards):
  - A ref links to its id when the id is in `rules.ids`, and it is structured or the id's prefix is not in `trackerPrefixes`.
  - `unknown` holds `annotation` and `rule-comment` refs whose ID-shaped id is in no card, plus `test-title` and `category` refs whose id is in no card and whose prefix is in `rules.prefixes` (E7). Mentions are never unknown.

- [ ] **Step 1: Write the failing tests.**
  - `matches LEND-03, LEND03, Lend03, lend_03 and Lend03RejectsSixthLoan`.
  - `rejects look-alikes` (Review Focus 2): `LEND-030`, `XLEND-03`, `LEND-03a`, `JIRA-12` (not a card id).
  - `a rule: comment is structured in //, #, -- and block comments`.
  - `captures test titles from it(), test(), describe(), t.Run(), @DisplayName and [Fact(DisplayName = ...)]`; `a title starting with an ID is structured`.
  - `[Trait("Rule", "LEND-03")] links through the annotation` (FileIndex symbol with `{ name: 'Trait', args: ['Rule', 'LEND-03'] }`).
  - `links only to IDs that exist in cards`.
  - `plain mentions never produce unknown IDs` (Review Focus 2).
  - `with LEND as a tracker prefix, a comment mentioning LEND-456 neither links nor counts as unknown, and a structured LEND-03 still links` (10.10 acceptance).
  - `an unknown ID in a rule-trait annotation or a rule: comment is unknown whatever its prefix`.
  - `an unknown title ID counts only for rule prefixes`.
  - `links to the innermost symbol spanning the line, else to the file`.
  - `readTestFiles lists tracked test files by path and by annotation, in codepoint order`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/rule-id-scan.test.ts src/adapters/__tests__/test-file-source.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/rule-id-scan.ts packages/domain/src/adapters/test-file-source.ts packages/domain/src/core/__tests__/rule-id-scan.test.ts packages/domain/src/adapters/__tests__/test-file-source.test.ts
  git commit -S -m "feat(domain): rule-ID text scan of test files with structured references, test titles and tracker safeguards (#156)"
  ```

---

### Task 3: Domain index pass, boundaries, history and the reader skip

**Files:**
- Create: `packages/domain/src/core/boundaries.ts`, `src/core/context-metrics.ts`, `src/adapters/artifact-store.ts`, `src/index-pass/domain-index-pass.ts`
- Modify: `packages/domain/src/index.ts` (`indexPass`), `packages/cli/src/adapters/storage/json-index-reader.ts` (`readSingle`)
- Test: `packages/domain/src/core/__tests__/boundaries.test.ts`, `context-metrics.test.ts`, `packages/domain/src/adapters/__tests__/artifact-store.test.ts`, `packages/domain/src/index-pass/__tests__/domain-index-pass.test.ts`, `packages/cli/src/adapters/storage/__tests__/json-index-reader.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // boundaries.ts
  export interface ContextEnd { readonly symbolId: string; readonly file: string; readonly context: string }
  export interface BoundaryViolationRecord { readonly from: ContextEnd; readonly to: ContextEnd; readonly edgeKind: string; readonly severity: 'error' | 'warning' }
  export interface CrossContextSummary { readonly from: string; readonly to: string; readonly byKind: Readonly<Record<string, number>>; readonly allowed: number; readonly violations: number }
  export interface ContextEdgeCounts { readonly internal: number; readonly out: number; readonly in: number }
  export interface BoundaryResult { readonly crossEdges: readonly CrossContextSummary[]; readonly violations: readonly BoundaryViolationRecord[];
    readonly perContext: ReadonlyMap<string, ContextEdgeCounts> }
  export function computeBoundaries(edges: readonly GraphEdge[], input: { readonly registry: DomainRegistry; readonly ownership: Ownership;
    readonly isTestFile: (path: string) => boolean; readonly mode: BoundaryMode; readonly blockingRungs: readonly Rung[] }): BoundaryResult;
  // context-metrics.ts
  export interface ContextHistoryEntry { readonly ctxoArtifact: 'domain-history'; readonly version: 1; readonly commitSha: string; readonly committedAt: number;
    readonly registryHash: string; readonly contexts: readonly { readonly id: string; readonly files: number; readonly internalEdges: number;
      readonly crossOut: number; readonly crossIn: number; readonly crossShare: number }[] }
  export interface MovedFile { readonly file: string; readonly from: string; readonly fromContext?: string; readonly toContext?: string; readonly commit: string; readonly date: string }
  export function historyEntry(head: { sha: string; committedAt: number }, registryHash: string,
    files: ReadonlyMap<string, number>, boundaries: BoundaryResult): ContextHistoryEntry;   // files: non-test file count per context id
  export function movedFiles(windowCommits: readonly CommitChangeSet[], ownership: Ownership): MovedFile[];
  export interface ContextDrift { readonly context: string; readonly crossShare: { readonly current: number; readonly previous?: number; readonly delta?: number };
    readonly trend: readonly { readonly commitSha: string; readonly crossShare: number }[]; readonly movedFiles: readonly MovedFile[];
    readonly distinctCommits: number; readonly confidence: 'low' | 'medium' | 'high' }
  export function contextDrift(context: string, history: readonly ContextHistoryEntry[], moved: readonly MovedFile[], registryHash: string): ContextDrift | undefined;
  // artifact-store.ts
  export interface ContextsArtifact { readonly ctxoArtifact: 'domain-contexts'; readonly version: 1; readonly registryHash: string;
    readonly contexts: readonly { id: string; name: string; rung: Rung; card?: string; fileCount: number; files: readonly string[] }[];
    readonly unowned: { readonly count: number; readonly files: readonly string[] };
    readonly multiplyOwned: readonly { file: string; contexts: readonly string[] }[]; readonly movedFiles: readonly MovedFile[] }
  export interface BoundariesArtifact { readonly ctxoArtifact: 'domain-boundaries'; readonly version: 1; readonly registryHash: string; readonly mode: BoundaryMode;
    readonly blockingRungs: readonly Rung[]; readonly crossEdges: readonly CrossContextSummary[]; readonly violations: readonly BoundaryViolationRecord[] }
  export class DomainArtifactStore {
    constructor(ctxoRoot: string);
    writeIfChanged(name: 'contexts.json' | 'boundaries.json', artifact: ContextsArtifact | BoundariesArtifact): boolean;   // false when equal after CRLF normalisation
    writeHistory(entry: ContextHistoryEntry, keep?: number): void;                                // keep defaults to 10 (E2)
    readContexts(): ContextsArtifact | undefined; readBoundaries(): BoundariesArtifact | undefined; readHistory(): ContextHistoryEntry[];
    removeAll(): void;
  }
  // domain-index-pass.ts
  export function domainIndexPass(host: CtxoHost): (ctx: IndexPassContext) => Promise<void>;
  ```
- Rules:
  - Edges come from `ctx.graph().allEdges()`. A file is `symbolId.split('::')[0]`; targets with fewer than three parts are skipped. Edges from test files are skipped (E4). An edge counts as `internal` when both ends share one owner and as a cross edge when the owners differ; edges with an unowned end are skipped.
  - A cross edge is allowed when `ownership.isContract(fromContext, toFile)`. Severity: `report` gives `warning`; `by-rung` gives `error` when either context's rung is in `blockingRungs`, else `warning`.
  - Sort by `from.context`, `to.context`, `from.symbolId`, `to.symbolId`, `edgeKind` (codepoint).
  - `movedFiles`: `R` changes whose `ownerOf(oldPath)` differs from `ownerOf(path)`, newest first by date, then by file. `contextDrift` follows E11: `current` from the newest entry, `previous` from the newest entry with another `commitSha`.
  - Pass flow:
    1. `resolveDomainConfig` and `readRegistry`. No registry: `store.removeAll()`. Registry problems: log a warning and write nothing.
    2. Compute ownership over `ctx.indices`, the boundaries, the moved files (from `ctx.history`, else kept from the existing `contexts.json`) and, with `ctx.history`, a history entry for HEAD.
    3. Write the artifacts and log `Domain: <n> contexts, <m> cross-context edges, <v> boundary violations (<ms> ms)`.
  - `JsonIndexReader.readSingle` returns `undefined` without logging for a JSON object with a string `ctxoArtifact` (E1).

- [ ] **Step 1: Write the failing tests.**
  - Boundaries:
    - `an edge into another context outside its contracts is a violation; through a contract file it is allowed`.
    - `edges into unowned files and from test files are ignored`.
    - `by-rung gives an error when either context is bounded or boring and a warning otherwise; report always warns`.
    - `two-part name references are skipped`.
    - `the result is identical for shuffled input`.
  - Metrics:
    - `crossShare counts internal and outgoing edges`.
    - `movedFiles lists renames that cross contexts`.
    - `contextDrift compares with the newest entry of another commit and ignores entries of another registry`.
    - `confidence follows the distinct-commit thresholds`.
  - Store:
    - `writeIfChanged leaves an equal file untouched`.
    - `writeIfChanged ignores CRLF-only differences` (Review Focus 4).
    - `writeHistory keeps one entry per commit and the newest ten by committer date`.
    - `invalid artifacts read as missing`.
  - Pass (FileIndex fixtures written to a temp `.ctxo/index`, a host from `createModuleHost`, a hand-built `IndexPassContext`):
    - `writes contexts.json and boundaries.json, byte-identical on a second run` (spec 13.1).
    - `keeps movedFiles when the change log is unavailable`.
    - `removes the artifacts when the registry is gone`.
    - `writes nothing when the registry has problems`.
  - Cli reader:
    - `skips JSON carrying ctxoArtifact without logging`.
    - `reads FileIndex files under a source folder named domain/` (Review Focus 3): `.ctxo/index/domain/Order.ts.json` beside `.ctxo/index/domain/contexts.json`; `readAll` returns exactly the `domain/Order.ts` index.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain test:unit` and `pnpm --filter @ctxo/cli exec vitest run src/adapters/storage`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Before editing `JsonIndexReader.readSingle`, run `get_blast_radius` and `get_why_context` on it.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then `pnpm --filter @ctxo/cli build`.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/boundaries.ts packages/domain/src/core/context-metrics.ts packages/domain/src/adapters/artifact-store.ts packages/domain/src/index-pass/domain-index-pass.ts packages/domain/src/index.ts packages/domain/src/core/__tests__/boundaries.test.ts packages/domain/src/core/__tests__/context-metrics.test.ts packages/domain/src/adapters/__tests__/artifact-store.test.ts packages/domain/src/index-pass/__tests__/domain-index-pass.test.ts packages/cli/src/adapters/storage/json-index-reader.ts packages/cli/src/adapters/storage/__tests__/json-index-reader.test.ts
  git commit -S -m "feat(domain): index pass for named contexts, boundaries and per-commit context metrics (#156)"
  ```

---

### Task 4: Loader rules: `ctxo domain rules --write | --check`

**Files:**
- Create: `packages/domain/src/core/loader-rules.ts`, `src/adapters/loader-rules-files.ts`, `src/commands/domain-command.ts`
- Modify: `packages/domain/src/index.ts` (register `domain`)
- Test: `packages/domain/src/core/__tests__/loader-rules.test.ts`, `packages/domain/src/commands/__tests__/domain-command.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LOADER_RULE_PREFIX = 'ctxo-context-';   // never 'ctxo-domain-': that prefix belongs to the ctxo-domain-fold skill
  export const LOADER_RULE_MARKER = '<!-- generated by ctxo domain rules; do not edit -->';
  export type LoaderPlatform = 'claude-code' | 'cursor';
  export interface LoaderRuleFile { readonly path: string; readonly content: string }   // repo-relative
  export function renderLoaderRules(registry: DomainRegistry, platforms: readonly LoaderPlatform[]): LoaderRuleFile[];   // contexts with a card; path order
  export interface LoaderRulesDiff { readonly missing: readonly string[]; readonly outdated: readonly string[]; readonly stale: readonly string[]; readonly foreign: readonly string[] }
  export function diffLoaderRules(expected: readonly LoaderRuleFile[], existing: ReadonlyMap<string, string>): LoaderRulesDiff;   // CRLF and BOM normalised
  // loader-rules-files.ts
  export function loaderPlatforms(projectRoot: string): LoaderPlatform[];             // claude-code always; cursor when .cursor/ exists (E10)
  export function readExistingLoaderRules(projectRoot: string): Map<string, string>;  // every ctxo-context-* file in .claude/rules and .cursor/rules
  export function applyLoaderRules(projectRoot: string, expected: readonly LoaderRuleFile[], diff: LoaderRulesDiff): InitFileResult[];   // writes missing/outdated, deletes stale
  // domain-command.ts
  export function domainCommand(host: CtxoHost): ModuleCommand;   // 'domain': subcommands rules (here) and discover (Task 8)
  ```
- Claude Code file (exact; spec 10.6), with one `  - "<glob>"` line per path (globs written with `JSON.stringify`):
  ```markdown
  ---
  paths:
    - "src/Lending/**"
    - "src/Holds/**"
  ---
  <!-- generated by ctxo domain rules; do not edit -->
  # Lending context
  Before changing code under these paths, read `docs/domain/lending/domain.md` (rules, contracts, decisions).
  If behaviour changes, update that card in the same PR. If it does not, add `Domain-Unchanged: lending (reason)` to a commit.
  ```
  Cursor file: front matter `description: Lending context: read docs/domain/lending/domain.md before changing this code`, `globs: src/Lending/**,src/Holds/**`, `alwaysApply: false`, then the same lines from the marker on.
- `help` lines: `  ctxo domain rules --write|--check   Generate or check the path-scoped loader rules per context` and, from Task 8, `  ctxo domain discover      Propose domain conventions from cards, commits and tests (--json, --write)`.
- Command: `ctxo domain rules --write` applies the diff and lists the files; `--check` prints the diff and exits 1 when `missing`, `outdated` or `stale` is non-empty (`foreign` is reported only). Neither flag, or an unknown subcommand: usage, exit 1. `--help`: usage, exit 0. No registry: Part 1's hint, exit 0. Registry problems: exit 2.

- [ ] **Step 1: Write the failing tests.**
  - `renders the spec example for Claude Code and Cursor` (string equality).
  - `contexts without a card get no file`.
  - `the diff reports missing, outdated, stale and foreign files and ignores CRLF and a BOM` (Review Focus 4).
  - `--check passes right after --write and fails after a registry change` (10.10 acceptance).
  - `--write deletes stale generated files and keeps a prefixed file without the marker`.
  - `the file names use the ctxo-context- prefix and never touch the ctxo-domain-fold skill files`: a registry with a context `fold` and a pre-existing `.cursor/rules/ctxo-domain-fold.mdc` and `.claude/skills/ctxo-domain-fold/SKILL.md` writes `ctxo-context-fold.md` and `ctxo-context-fold.mdc`, and leaves both skill files unreported and undeleted.
  - `Cursor files appear only when .cursor/ exists`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/loader-rules.test.ts src/commands/__tests__/domain-command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/loader-rules.ts packages/domain/src/adapters/loader-rules-files.ts packages/domain/src/commands/domain-command.ts packages/domain/src/index.ts packages/domain/src/core/__tests__/loader-rules.test.ts packages/domain/src/commands/__tests__/domain-command.test.ts
  git commit -S -m "feat(domain): ctxo domain rules generates path-scoped loader rules for Claude Code and Cursor (#156)"
  ```

---

### Task 5: The eleven verify-domain checks

**Files:**
- Create: `packages/domain/src/core/verify-checks.ts`
- Test: `packages/domain/src/core/__tests__/verify-checks.test.ts`

**Interfaces:**
- Consumes: `ParsedCard`, `headingOrderProblems`, `githubSlugs` (Task 1); `RuleLinks` (Task 2); `BoundaryResult` (Task 3); `LoaderRulesDiff` (Task 4); `TouchedReport` (Part 1).
- Produces:
  ```ts
  export const VERIFY_CHECKS = ['1', '2', '3', '4a', '4b', '5', '6', '7', '8', '9', '10', '11'] as const;
  export type VerifyCheckId = (typeof VERIFY_CHECKS)[number];
  export interface Finding { readonly check: VerifyCheckId; readonly severity: 'error' | 'warning'; readonly message: string;
    readonly file?: string; readonly line?: number; readonly context?: string }
  export interface CheckOutcome { readonly id: VerifyCheckId; readonly title: string; readonly status: 'pass' | 'warn' | 'fail' | 'skipped'; readonly findings: readonly Finding[] }
  export interface VerifyInput {
    readonly registry: LoadedRegistry; readonly config: DomainConfig; readonly configProblems: readonly ConfigProblem[];
    readonly indexedFiles: readonly string[]; readonly isTestFile: (path: string) => boolean; readonly makeMatcher: GlobMatcherFactory;
    readonly cards: ReadonlyMap<string, ParsedCard | undefined>;   // by card path; undefined when the file is missing
    readonly fileExists: (repoPath: string) => boolean;
    readonly headingSlugs: (repoPath: string) => ReadonlySet<string> | undefined;   // anchors of a markdown target
    readonly ruleLinks: RuleLinks; readonly loaderDiff: LoaderRulesDiff;
    readonly contextMapText?: string; readonly boundaries: BoundaryResult;
    readonly touched?: TouchedReport;                               // only with --since
  }
  export function runVerifyChecks(input: VerifyInput): CheckOutcome[];
  export function contextMapRows(text: string): Map<string, string> | undefined;   // first table with Context and Rung columns: cell -> rung
  ```
- Checks (title, then what is an error or a warning):
  - `1` Registry and config: every registry and config problem is an error. With registry problems, checks 2 to 11 are `skipped`.
  - `2` Cards present: a context above `fear` without `card`, or a listed card that does not exist, is an error.
  - `3` Path globs match: a `paths` glob matching no indexed file is an error (`<id>: "<glob>" matches no indexed file`).
  - `4a` Single owner: a non-test indexed file with two or more owners is an error.
  - `4b` Unowned files: one finding, severity `domain.coverage.unowned`: `<n> indexed files belong to no context: <up to 20 paths>`; non-test, non-allowlisted files only.
  - `5` Card headings: each `headingOrderProblems` entry is an error.
  - `6` Rule IDs and test links, each an error:
    - an id not matching `idPattern`;
    - a duplicate id across cards;
    - an id without its context's `rulePrefix-`;
    - each `ruleLinks.unknown` ref (`file:line`);
    - a `Tests:` value whose file does not exist (E7);
    - a rule with no link, no `Tests:` value and no `Untested:` line.
  - `7` Card links: a relative target that does not exist, or an anchor missing from the target's slugs, is an error. Targets with a scheme (`https:`, `mailto:`) or `//` are skipped; paths are URL-decoded; `/` means the repo root.
  - `8` Generated loader rules: each missing, outdated or stale file is an error.
  - `9` Context map rungs: when the file exists, a missing table, a missing context or a different rung is an error, and an unknown row is a warning. A missing file with at least one context is a warning.
  - `10` Boundaries: each violation at its severity.
  - `11` Fold since `<ref>`: each unresolved context is an error naming `Domain-Unchanged: <id> (reason)`.
  - Status: `fail` with any error, `warn` with warnings only, else `pass`.

- [ ] **Step 1: Write the failing tests.** For each check, a passing and a failing input (`it.each`). Also:
  - `day one: the init skeleton with indexed files has warnings only` (no contexts; no context-map warning; spec anti-goal).
  - `a non-fear context without a card fails check 2` (10.10).
  - `a glob that matches nothing fails check 3` (10.10).
  - `an unknown rule ID in a test fails check 6` (10.10).
  - `domain.coverage.unowned: error turns 4b into an error`.
  - `the context map matches by id or name, case-insensitively, with markup stripped`.
  - `check 7 skips external URLs and resolves URL-encoded paths and anchors`.
  - `registry problems skip checks 2 to 11`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/verify-checks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/verify-checks.ts packages/domain/src/core/__tests__/verify-checks.test.ts
  git commit -S -m "feat(domain): the eleven verify-domain checks as pure functions (#156)"
  ```

---

### Task 6: `ctxo verify-domain`

**Files:**
- Create: `packages/domain/src/commands/verify-domain-command.ts`, `src/adapters/repo-files.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/commands/__tests__/verify-domain-command.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function verifyDomainCommand(host: CtxoHost): ModuleCommand;   // 'verify-domain'
  // repo-files.ts
  export function repoFileExists(projectRoot: string, repoPath: string): boolean;
  export function readRepoText(projectRoot: string, repoPath: string): string | undefined;
  ```
- Usage: `ctxo verify-domain [--since <ref>] [--boundaries by-rung|report] [--json]`. `help` line: `  ctxo verify-domain        CI gate for the registry, cards, rule IDs and boundaries (--since, --boundaries, --json)`.
- Flow:
  1. `resolveDomainConfig` and `readRegistry`. No registry: hint, exit 0.
  2. `readIndex`; an empty index: `[ctxo] No index found; run "ctxo index" first.` and exit 2.
  3. Parse the cards. Run the K6 scan over `readTestFiles(listTrackedFiles())` plus `annotationRefs`. Compute the loader diff (`renderLoaderRules` against disk). Read the context map. Compute `computeBoundaries` from `buildGraph(indices)` in the mode `--boundaries ?? config`.
  4. With `--since`: `GitChangeReader` committed mode only (E9); a failure exits 2 with Part 1's fetch-depth hint.
  5. `runVerifyChecks`.
- Output: human lines on stderr, `[ctxo] <✓|⚠|✗|-> <id> <title>`, then each finding as `    <error|warning> <file[:line]> <message>`, then `[ctxo] verify-domain: <e> errors, <w> warnings`. `--json`: `{ registry, checks, summary: { errors, warnings }, exitCode }` on stdout.
- Exit: 0 without errors, 1 with errors, 2 for a missing index, a git failure under `--since`, or any thrown error (message on stderr). `--help`: usage, exit 0. A bad `--boundaries` value: exit 1 with the usage.

- [ ] **Step 1: Write the failing tests** (temp repos, hand-written FileIndex JSON in `.ctxo/index`, the host from `createModuleHost`):
  - `no registry prints the hint and exits 0`.
  - `exits 1 on errors, 0 with warnings only, and 2 without an index`.
  - `--boundaries report turns boundary errors into warnings for this run`.
  - `--since adds check 11 and fails on an unresolved context`; `an unknown --since ref exits 2`.
  - `uses the current registry, not the artifacts` (Review Focus 5): stale `contexts.json` from an older registry changes nothing.
  - `--json prints the checks and the summary on stdout`; `--help prints the usage`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/commands/__tests__/verify-domain-command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/commands/verify-domain-command.ts packages/domain/src/adapters/repo-files.ts packages/domain/src/index.ts packages/domain/src/commands/__tests__/verify-domain-command.test.ts
  git commit -S -m "feat(domain): ctxo verify-domain CI gate with exit codes 0, 1 and 2 (#156)"
  ```

---

### Task 7: Enrichers: `context`, `contextBoundaryViolations`, `contextDrift`

**Files:**
- Create: `packages/domain/src/mcp/enrichers.ts`
- Modify: `packages/domain/src/index.ts` (`enrich`). `packages/cli/src/core/response-envelope.ts` stays unchanged: an additive array on an existing tool is capped at its source and is not a `TRUNCATABLE_FIELDS` entry.
- Test: `packages/domain/src/mcp/__tests__/enrichers.test.ts`, `packages/cli/src/core/__tests__/response-envelope.test.ts`

**Interfaces:**
- Consumes: `DomainArtifactStore`, `contextDrift` (Task 3); `registryHash`, `readRegistry` (Part 1).
- Produces: `export function createEnrichers(host: CtxoHost): Partial<Record<CoreToolName, ResponseEnricher>>;` with entries for `search_symbols`, `get_blast_radius`, `find_importers`, `get_logic_slice`, `get_pr_impact`, `get_why_context`.
- Rules:
  - Artifacts and the registry hash are cached by file mtime. Without a registry, or when `contexts.json`'s `registryHash` differs from the current registry, every enricher returns the payload unchanged (E3).
  - `context: "<id>"` goes on: `search_symbols` `results[]` (from `file`); `get_blast_radius` `impactedSymbols[]`; `find_importers` `importers[]`; `get_logic_slice` `root` (single) or each `results[].root` (batch); `get_pr_impact` `files[].symbols[]`. Only files with exactly one owner in `contexts.json` get it.
  - `contextBoundaryViolations` on `get_pr_impact`: the `boundaries.json` violations whose `from.symbolId` or `to.symbolId` is a changed symbol, in artifact order, capped at 50 at the source; when more exist the list keeps the first 50 and `contextBoundaryViolationsTotal` carries the full count (the field is absent when nothing was cut; `ctxo verify-domain --json` lists every violation).
  - `contextDrift` on `get_why_context`: `contextDrift(<context of args.symbolId's file>, history, movedFiles, hash)`, only when defined.
  - Envelope rule for additive arrays on existing tools (default cap 50, a `<name>Total` count when capped): `TRUNCATABLE_FIELDS` is not touched, so `wrapResponse` keeps truncating the tool's primary array (`files` for `get_pr_impact`) and never the capped additive one.

- [ ] **Step 1: Write the failing tests.**
  - One `it` per tool: `adds context to entries of singly-owned files and nothing for unowned files`.
  - `without a registry the payload is unchanged`; `stale artifacts add nothing` (Review Focus 5).
  - `contextBoundaryViolations lists the violations touching changed symbols`.
  - `contextBoundaryViolations is capped at 50 with contextBoundaryViolationsTotal`: 60 violations touching changed symbols give 50 entries in artifact order and `contextBoundaryViolationsTotal: 60`; 10 give 10 entries and no total field.
  - `contextDrift appears for a symbol whose context has history`.
  - Cli, `response-envelope.test.ts`: `two arrays in one response: the primary array is truncated, the capped additive array is not` (a payload with 300 `files`, 50 `contextBoundaryViolations` and `contextBoundaryViolationsTotal: 80` under `CTXO_RESPONSE_LIMIT=2048` gives `_meta.truncated: true`, `_meta.totalItems: 300` with the `files` hint, 50 violations kept and the total untouched); `contextBoundaryViolations alone is never truncated` (300 entries and no `files`: `_meta.truncated` is false).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/mcp` and `pnpm --filter @ctxo/cli exec vitest run src/core/__tests__/response-envelope.test.ts`. Expected: the enricher tests FAIL; the envelope tests already pass, because they pin the unchanged envelope behaviour.
- [ ] **Step 3: Implement** the enrichers and their cap. `response-envelope.ts` is not edited.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then `pnpm --filter @ctxo/cli build`.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/mcp/enrichers.ts packages/domain/src/index.ts packages/domain/src/mcp/__tests__/enrichers.test.ts packages/cli/src/core/__tests__/response-envelope.test.ts
  git commit -S -m "feat(domain): context fields on five tools, contextBoundaryViolations on get_pr_impact and contextDrift on get_why_context (#156)"
  ```

---

### Task 8: Convention discovery: `ctxo domain discover`

**Files:**
- Create: `packages/domain/src/core/discovery.ts`, `src/adapters/discovery-sources.ts`
- Modify: `packages/domain/src/commands/domain-command.ts` (`discover`), `packages/domain/src/adapters/config-writer.ts` (`mergeDiscoveryProposal`)
- Test: `packages/domain/src/core/__tests__/discovery.test.ts`, `packages/domain/src/commands/__tests__/domain-command.test.ts`, `packages/domain/src/adapters/__tests__/config-writer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TRACKER_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
  export const TRACKER_PREFIX_MIN = 5;
  export interface FolderCount { readonly folder: string; readonly files: number }
  export interface DiscoveryEvidence {
    readonly cardPrefixes: readonly { prefix: string; rules: number }[];
    readonly trackerKeys: readonly { prefix: string; occurrences: number; overlapsRulePrefix: boolean }[];
    readonly traitKeys: readonly { key: string; count: number; idLikeValues: number }[];
    readonly uncoveredTestFolders: readonly FolderCount[];
    readonly characterizationFolders: readonly FolderCount[]; readonly contractFolders: readonly FolderCount[];
    readonly provenanceFolders: readonly FolderCount[];
  }
  export interface DiscoveryProposal { readonly trackerPrefixes: readonly string[]; readonly ruleTraitKeys: readonly string[]; readonly indexTests: readonly string[] }
  export interface DiscoveryInput {
    readonly cards: readonly ParsedCard[]; readonly registry?: DomainRegistry;
    readonly commitSubjects: readonly string[]; readonly branches: readonly string[];
    readonly indices: readonly FileIndex[]; readonly trackedFiles: readonly string[];
    readonly isPathTestFile: (path: string) => boolean; readonly config: DomainConfig; readonly indexTests: readonly string[];
  }
  export function discoverConventions(input: DiscoveryInput): { readonly evidence: DiscoveryEvidence; readonly proposal: DiscoveryProposal };
  export function formatDiscovery(evidence: DiscoveryEvidence, proposal: DiscoveryProposal): string;   // the spec 10.9 layout
  export function proposalAddsSomething(proposal: DiscoveryProposal, config: DomainConfig, indexTests: readonly string[]): boolean;
  // config-writer.ts
  export function mergeDiscoveryProposal(text: string, proposal: DiscoveryProposal): { readonly text: string; readonly changed: boolean };   // union into domain.rules.trackerPrefixes, domain.tests.ruleTraitKeys, index.tests
  ```
- Rules (E12):
  - Subjects come from `readCoChangeWindow` and branches from `getRefs().branches`. A prefix counts once per subject and once per branch with a matching key. The proposal is every prefix at `TRACKER_PREFIX_MIN` or more, united with the configured ones. `overlapsRulePrefix` is true when the prefix is also a card or registry rule prefix.
  - `traitKeys` come from `Trait` annotations (`args[0]`) on symbols of test files; `ruleTraitKeys` proposes keys with at least one ID-shaped value (`idPattern`), united with the configured ones.
  - `uncoveredTestFolders`: parent directories of indexed files with a test-framework annotation that `isPathTestFile` rejects; nested directories collapse into their topmost listed parent; each becomes `<dir>/**`.
  - Folder counts: `characterizationFolders` for segments named `Characterization`; `contractFolders` for `Contract`, `Contracts` or `Contracts.Tests`; `provenanceFolders` for `adr`, `adrs`, `decisions`, `spec`, `specs`, `rfc`, `rfcs` holding `.md` files (case-insensitive), in codepoint order.
- Command: `ctxo domain discover [--json] [--write]` works without a registry. Human output goes to stderr in the spec 10.9 layout, with `<- overlaps a rule prefix` markers. `--json` prints `{ evidence, proposal }` on stdout. `--write` applies `mergeDiscoveryProposal` to `.ctxo/config.yaml` and lists the added values; nothing is written without it.

- [ ] **Step 1: Write the failing tests.**
  - `proposes trackerPrefixes [LEND] from five commit subjects` (10.10 acceptance); `four occurrences are not enough`; `branch names count`.
  - `flags a tracker prefix that overlaps a rule prefix`.
  - `proposes ruleTraitKeys from Trait keys with ID-like values`.
  - `annotated test files outside the path globs become index.tests globs`.
  - `counts provenance, characterization and contract folders`.
  - `formatDiscovery matches the spec layout` (substring checks for each section label).
  - `mergeDiscoveryProposal adds values without dropping existing ones`; `discover writes nothing without --write`; `--json prints evidence and proposal`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain test:unit`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/discovery.ts packages/domain/src/adapters/discovery-sources.ts packages/domain/src/commands/domain-command.ts packages/domain/src/adapters/config-writer.ts packages/domain/src/core/__tests__/discovery.test.ts packages/domain/src/commands/__tests__/domain-command.test.ts packages/domain/src/adapters/__tests__/config-writer.test.ts
  git commit -S -m "feat(domain): ctxo domain discover proposes tracker prefixes, rule trait keys and test folders (#156)"
  ```

---

### Task 9: `init --domain` confirms conventions and writes loader rules; domain doctor checks

**Files:**
- Modify: `packages/domain/src/init/domain-init.ts`, `packages/domain/src/index.ts` (`doctorChecks`)
- Create: `packages/domain/src/doctor/domain-checks.ts`
- Test: `packages/domain/src/init/__tests__/domain-init.test.ts`, `packages/domain/src/doctor/__tests__/domain-checks.test.ts`

**Interfaces:**
- Consumes: `discoverConventions`, `formatDiscovery`, `proposalAddsSomething`, `mergeDiscoveryProposal` (Task 8); `renderLoaderRules`, `diffLoaderRules`, `applyLoaderRules`, `loaderPlatforms` (Task 4).
- Produces: `export function domainDoctorChecks(host: CtxoHost): IHealthCheck[];`. The ids, titles and verdicts:
  - `domain_registry` "Domain registry". Pass: `no registry (domain layer not set up)` or `<n> contexts`. Warn: `<n> registry or config problems`, fix `Run "ctxo verify-domain" for details`.
  - `domain_agent_setup` "Domain agent setup" (only with at least one context). Warns for a missing SessionStart, Stop or TaskCompleted entry for `ctxo domain-guard-hook`, a missing or outdated `ctxo-domain-fold` skill, or a non-empty loader-rules diff. Fix `Run "ctxo init --only domain" and "ctxo domain rules --write"`.
  - `domain_conventions` "Domain conventions". Warns when discovery finds a tracker prefix at 5 or more that overlaps a rule prefix and is not in `domain.rules.trackerPrefixes`, or when the proposal adds something. Fix `Review with "ctxo domain discover", then confirm with "--write"`.
  - All return only `pass` or `warn`, catch their own errors as `warn`, and never write files (E13).
- Init additions, after step 4 of Part 1's `apply`:
  - Run discovery. When `proposalAddsSomething`, print `formatDiscovery` and ask `ctx.prompt.confirm('Apply the proposed conventions?', true)`; `--yes` accepts. On yes, apply `mergeDiscoveryProposal` (row `.ctxo/config.yaml`).
  - When the registry has a context with a card, apply the loader rules; one row per written or deleted file.

- [ ] **Step 1: Write the failing tests.**
  - Init: `--yes accepts the discovery proposal`; `a declined proposal leaves the config unchanged`; `loader rules are written when contexts with cards exist`; `a dry run writes nothing`.
  - Doctor: for each check, a `pass` case and a `warn` case; `doctor checks never write files` (bytes of `.ctxo/config.yaml` and `.claude/` unchanged); `a check that hits an error reports warn`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain test:unit`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/init/domain-init.ts packages/domain/src/index.ts packages/domain/src/doctor/domain-checks.ts packages/domain/src/init/__tests__/domain-init.test.ts packages/domain/src/doctor/__tests__/domain-checks.test.ts
  git commit -S -m "feat(domain): init --domain confirms discovered conventions and writes loader rules; three domain doctor checks (#156)"
  ```

---

### Task 10: Library-lending sample and the PR 2B acceptance tests

**Files:**
- Create: `packages/domain/test-fixtures/library-lending/csharp/**`, `packages/domain/test-fixtures/library-lending/typescript/**`, `packages/domain/e2e/__tests__/acceptance.test.ts`, `packages/domain/e2e/__tests__/sample-workspace.ts` (helpers: copy a variant to a temp dir, `git init -b main`, commit, junction `node_modules/@ctxo/domain`, run the built CLI)
- Modify: `packages/domain/package.json` (devDependency `@modelcontextprotocol/sdk` at the cli's version), `pnpm-lock.yaml`

**Sample content (both variants, synthetic):**
- `docs/domain/contexts.yaml`: `lending` (rung `pinned`, `rulePrefix: LEND`, card, `contracts.billing` naming the charge-service interface file); `billing` (rung `bounded`, `rulePrefix: BILL`, card); `catalog` (rung `fear`, no card). Each context's paths cover its code, its tests and its `db/migrations/<context>/` folder; `unowned.allow` covers the host entry file.
- Cards with the five template H2s. `docs/domain/lending/domain.md` has `LEND-01` to `LEND-05`; `LEND-03 A member holds at most five loans` has a `Tests:` line naming the variant's test file and every other rule an `Untested:` line. `docs/domain/billing/domain.md` has `BILL-01` to `BILL-03`, each `Untested:`. `docs/domain/context-map.md` has a `Context | Rung` table with all three contexts; `docs/domain/glossary.md` lists a few terms.
- An `Account` type in Lending (member account: member id, active loans) and in Billing (payer: payer id, balance).
- `db/migrations/lending/001_create_loans.sql` and `db/migrations/billing/001_create_invoices.sql` (`CREATE TABLE` plus one procedure each).
- Lending calls Billing only through the contract interface; Catalog reads one Lending internal (a warning, since both rungs are non-blocking).
- C#: an SDK-style `LibraryLending.csproj` (net8.0, no package references), a classic-format `LibraryLending.sln` at the variant root that lists the project (so the Roslyn tier opens a solution; written by hand or with `dotnet new sln --format sln`, because the SDK 10 default is `.slnx`), `tests/Stubs/Xunit.cs` defining `Xunit.FactAttribute` and `Xunit.TraitAttribute(string name, string value)`, and `tests/Lending.Tests/LoanLimitTests.cs` with `[Fact]` and `[Trait("Rule", "LEND-03")]`.
- TypeScript: `tsconfig.json`, `src/**` and `src/lending/__tests__/loan-limit.test.ts` with `it('LEND-03 rejects the sixth loan', ...)`.

- [ ] **Step 1: Write the acceptance tests** (`describe.each` over both variants where marked). Each copies the variant, commits, runs `ctxo index`, then the commands through the built CLI:
  - `the sample passes verify-domain with warnings only` (both).
  - `verify-domain fails on a non-fear context without a card` (`catalog` set to `named`) (both; 10.10).
  - `verify-domain fails on a glob that matches nothing` (a `src/Shipping/**` path) (both; 10.10).
  - `verify-domain fails on an unknown rule ID found in a test`: C# `[Trait("Rule", "LEND-99")]`, TypeScript `it('LEND-99 ...')` (both; 10.10).
  - `ctxo domain rules --check passes right after --write and fails after a registry change` (10.10).
  - `boundaries: a Lending edge into a Billing internal fails by-rung and passes with --boundaries report`.
  - `the guard blocks a sample session and lets it finish after a trailer commit` (C#, through `domain-guard-hook`; Part 1 Task 11 covers the full matrix).
  - `discovery proposes trackerPrefixes [LEND] from LEND-<n> commit subjects; once confirmed, a LEND-456 test comment neither links nor fails verify-domain` (TypeScript; 10.10).
  - `no registry: no new fields anywhere, and the commands print a hint and exit 0` (10.10): after deleting the registry and re-indexing, start the built server with the SDK `StdioClientTransport`. `search_symbols`, `get_blast_radius`, `find_importers`, `get_logic_slice`, `get_pr_impact` and `get_why_context` responses contain no `context`, `contextBoundaryViolations` or `contextDrift` key. `verify-domain`, `contexts-touched` and `domain rules --check` exit 0 with the hint. With the registry restored and re-indexed, `search_symbols` results carry `context: 'lending'`.
  - `the same input twice gives byte-identical domain artifacts` (spec 13.1).
- [ ] **Step 2: Run them.** `pnpm -r build && pnpm --filter @ctxo/domain test:e2e`. Expected: FAIL until the sample exists.
- [ ] **Step 3: Write the sample files,** the C# variant's `LibraryLending.sln` included (the committed copy of the workspace must list it in `git ls-files`). C# runs on the tree-sitter tier without dotnet and on Roslyn with it; both emit the `Trait` annotation (PR 1B).
- [ ] **Step 4: Run them.** Expected: PASS. If one fails, fix the code under test, not the expectation.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/test-fixtures/library-lending packages/domain/e2e/__tests__/acceptance.test.ts packages/domain/e2e/__tests__/sample-workspace.ts packages/domain/package.json pnpm-lock.yaml
  git commit -S -m "test(domain): library-lending sample in C# and TypeScript with the PR 2B acceptance tests (#156)"
  ```

---

### Task 11: Docs, help, changeset and full verification

**Files:**
- Modify:
  - `docs/features/domain-knowledge.md` (created by PR 1B; create it if absent), `docs/index.md`, `docs/roadmap.md`, `CHANGELOG.md`
  - `llms.txt`, `llms-full.txt`, `README.md`, `CLAUDE.md`, `packages/domain/README.md`
  - `site/docs/cli/init.md`, `install.md`, `doctor.md`, `overview.md`; `site/docs/reference/config-schema.md`, `ci-integration.md`; `site/docs/mcp-tools/search-symbols.md`, `get-blast-radius.md`, `find-importers.md`, `get-logic-slice.md`, `get-pr-impact.md`, `get-why-context.md`; `site/docs/.vitepress/config.ts`
- Create: `site/docs/cli/domain.md`, `site/docs/concepts/domain-knowledge.md`, `.changeset/domain-knowledge-layer.md`

- [ ] **Step 1: Write the feature doc.** Sections for: named contexts and the registry; `contexts-touched`; the fold guard and the trailer; `verify-domain` (the checks table, exit codes, day one); loader rules; boundaries and drift by named context; the `context` fields; `init --domain`; discovery and the ID safeguards; global installs (K15) and `install_copies`. Then **"Ctxo domain conventions v1"**:
  - the JSON Schema (embed `packages/domain/schema/contexts.schema.json`);
  - the headings-only card template (the five H2s and a `### <ID> <title>` example with `Tests:` and `Untested:`);
  - the rule ID rules (`idPattern`, permanence, `rulePrefix`, tracker overlap);
  - the trailer;
  - the adoption ladder, verbatim: "level 0: install and index; 1: registry with paths; 2: cards; 3: rule IDs and test links, through card `Tests:` lines, test names or framework tags; 4: contracts and shadow-spec resolutions", stating that no level requires code changes.
- [ ] **Step 2: Update the other docs.**
  - `site/docs/cli/domain.md` covers `verify-domain`, `contexts-touched`, `domain rules`, `domain discover`; `site/docs/concepts/domain-knowledge.md` summarises the feature doc; add both to the sidebar.
  - `init.md`: `--domain`, `--boundaries`, the `domain` part. `install.md`: `ctxo install domain`, global installs without `package.json`. `doctor.md`: `install_copies` and the three domain checks. `overview.md`: the new commands.
  - `config-schema.md`: the `domain:` section with every key and default. `ci-integration.md`: `ctxo verify-domain --since origin/main` with `actions/checkout` `fetch-depth: 0`.
  - The six tool pages describe their additive fields, present only with `@ctxo/domain` and a registry.
  - `llms.txt` and `llms-full.txt`: a "New in" section for the release with the commands, the config and the fields.
  - `README.md`: the commands list and the `@ctxo/domain` line.
  - `CLAUDE.md`:
    - the package layout gains `domain/  @ctxo/domain  # domain knowledge layer (opt-in, ADR-018)`;
    - the Key Rules read that `packages/cli/src/mcp-server.ts` is the MCP composition root and `src/index.ts` the entry, and record the domain import exception;
    - the Quick Reference gains the new commands.
  - `docs/roadmap.md`: PR 2B items shipped; Deferred rows for the "new violations only" boundary mode, domain isolation and bounded-context visualization, and the Cursor stop-hook reminder (triggers from spec 17).
  - `CHANGELOG.md` `[Unreleased]`:
    - Added: `@ctxo/domain`, the commands, the guard, `init --domain`, the fields, `ctxo install domain`, global installs, `install_copies`, `@ctxo/cli/internal`.
    - Changed: the entry split, global MCP entries, `ctxo install` without `package.json`.
  - `docs/index.md`: link ADR-018 and the feature doc.
- [ ] **Step 3: Write the changeset** `.changeset/domain-knowledge-layer.md` with `"@ctxo/cli": minor` and `"@ctxo/domain": minor`. The note, in two sentences naming #156: the opt-in `@ctxo/domain` package adds a context registry, `contexts-touched`, a fold guard, `verify-domain`, loader rules and boundary checks by named context; `@ctxo/cli` loads it through an internal API and supports one global install for MCP, hooks and CLI.
- [ ] **Step 4: Check help and text.**
  - In a temp project with the junction: `node packages/cli/dist/index.js --help` lists the domain commands; `verify-domain --help`, `contexts-touched --help` and `domain --help` print usages.
  - Without the junction, `--help` shows the install hint line.
  - `git grep -nP "\x{2014}"` over the touched docs shows no new lines.
- [ ] **Step 5: Full verification.**
  - `pnpm changeset status --verbose`. Expected: `@ctxo/cli` and `@ctxo/domain` at the same next version.
  - `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm --filter @ctxo/cli test:e2e && pnpm --filter @ctxo/domain test:e2e`. Expected: all green, the tarball test included; raise the limit with measurements if crossed.
  - `pnpm --filter @ctxo/domain pack --dry-run`. Expected: `dist/`, `skills/`, `schema/`, `README.md` only.
- [ ] **Step 6: Commit.**
  ```bash
  git add docs/features/domain-knowledge.md docs/index.md docs/roadmap.md CHANGELOG.md llms.txt llms-full.txt README.md CLAUDE.md packages/domain/README.md site/docs/cli/init.md site/docs/cli/install.md site/docs/cli/doctor.md site/docs/cli/overview.md site/docs/cli/domain.md site/docs/concepts/domain-knowledge.md site/docs/reference/config-schema.md site/docs/reference/ci-integration.md site/docs/mcp-tools/search-symbols.md site/docs/mcp-tools/get-blast-radius.md site/docs/mcp-tools/find-importers.md site/docs/mcp-tools/get-logic-slice.md site/docs/mcp-tools/get-pr-impact.md site/docs/mcp-tools/get-why-context.md site/docs/.vitepress/config.ts .changeset/domain-knowledge-layer.md
  git commit -S -m "docs: domain knowledge layer, Ctxo domain conventions v1, CLI help, site docs and changeset (#156)"
  ```

---

### Task 12: Scale and speed smoke on the private fixture (nothing committed)

- [ ] **Step 1:** In the private fixture clone (path from the owner's brief; never the original checkout), create `node_modules/@ctxo/domain` as a junction to the worktree's `packages/domain` (untracked, clone only). Run `node <worktree>/packages/cli/dist/index.js index`. Expected: no crash; the domain pass is skipped (no registry yet).
- [ ] **Step 2:** Derive the private registry mechanically with a script in the session scratchpad: from `ctxo contexts --json`, one context per candidate, id `c<id>`, name `Candidate <id>`, rung `fear`, no card, `paths` = the candidate's member files. Write it to `docs/domain/contexts.yaml` in the clone only.
- [ ] **Step 3:** Run `ctxo index` again. Expected: the `Domain:` log line, pass time at most 2 s.
- [ ] **Step 4:** Run `ctxo verify-domain --json`, `ctxo contexts-touched --since <default branch> --json` and `ctxo domain discover --json`. Expected: no crash; exit codes 0 or 1, never 2.
- [ ] **Step 5:** Time `domain-guard-hook` with a Stop payload ten times. Expected: median under 1 s.
- [ ] **Step 6:** Record only aggregate numbers (context count, cross-context edges, violations by severity, unowned count, pass time, hook median) in the scratchpad PR draft. Nothing from the fixture goes into the repo.
