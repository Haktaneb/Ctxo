# PR 3: Domain Graph, Links, Domain Fields, `get_domain_context`, `get_rule` and the Domain Search Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the domain graph in `@ctxo/domain` (cards parsed into context, rule, term and decision nodes; rule-to-test, rule-to-symbol, decision-to-provenance and term-to-identifier links, each carrying its source) and surface it through additive fields on core tools, the new tools `get_domain_context` and `get_rule`, and `get_ranked_context({ scope: "domain" })` (Phase 3 of #156; K6, K8, K19).

**Architecture:**
- Pure `core/` modules in `@ctxo/domain` parse cards and the glossary, build nodes, resolve links and compose one sorted `DomainGraph`. The domain index pass (PR 2B's `indexPass` seam) reads cards, the glossary, test files and indexed source files, and writes `.ctxo/index/domain/graph.json` (`"ctxoArtifact": "domain-graph"`) only when its content changed. PageRank, Louvain, snapshots, dead code and gate percentiles never read it (K8).
- At MCP time one `DomainState` loads the config, the registry and the graph (mtime cache, `registryHash` gate as in E3, `cardsHash` for stale cards). The enrichers, the two tools and the domain search scope are pure views over its snapshot; the CLI wraps masking, `_meta`, truncation and recording.
- `@ctxo/cli` gains document search in its BM25 engine and three internal-API seams: enrichers may return a Promise (awaited by async tools), a token reservation for `get_context_for_task`, and ranked-context scopes. They reach `@ctxo/domain` through `host.services` and the registration; the domain still imports `@ctxo/cli` as types only.
- Seams for PR 4 (spec 12): `rulesForSymbols` and `rulesWithoutTests` serve `find_shadow_specs` (auto-resolution by rule links, rules without tests) and `get_context_map` (share of rules with tests); term definitions keep their origin (card or glossary) for the `named` criterion; `domainTools` returns a list PR 4 extends; the graph keeps `version: 1` and facts stay in `FileIndex`.

**Tech Stack:** TypeScript (ESM, Node >= 20), yaml, vitest, @modelcontextprotocol/sdk (test client only), pnpm workspace, changesets.

**Spec:** `docs/superpowers/specs/2026-10-20-domain-knowledge-layer-design.md`, section 11 (11.1 to 11.5), with 3, 4, 5, 12 (seams), 13, 15 and 18 (K6, K8, K19; the PR 3 calls in 18). It builds on `docs/superpowers/plans/2026-10-21-pr2b-1-domain-package.md` and `docs/superpowers/plans/2026-10-21-pr2b-2-domain-checks-and-surfaces.md`.

## Global Constraints

- **Base:** branch `feat/domain-graph-156` in its own worktree, stacked on the tip of `feat/domain-package-156` once PR 2B (and before it PRs 0, 1A, 1B, 1C, 2A) is complete. Consumed by name (Task 0 confirms each):
  - PR 2B Part 1: `CtxoModuleRegistration`, `CtxoHost`, `CtxoHostServices`, `IndexPassContext`, `ResponseEnricher`, `CoreToolName`, `ModuleToolDefinition`, `ToolRegistrar`, `TestFileCheck`, `createModuleHost` (`@ctxo/cli/internal`); `loadCtxoModules`, `LoadedModule`; `applyEnricher`, `collectEnrichers`, `handleModuleTool`, `McpToolResult`, `registerTools` (`mcp-server.ts`); `IGitPort.getRangeLog`, `getWorkingTreeChanges`, `listTrackedFiles`; `readRegistry`, `LoadedRegistry`, `registryHash`, `DomainRegistry`, `DomainContext`, `Rung`, `createOwnership`, `Ownership`, `resolveDomainConfig`, `DomainConfig`, `GitChangeReader`, `computeTouched`, `TouchedContext`; `register`.
  - PR 2B Part 2: `parseCard`, `ParsedCard`, `CardRule`, `MdHeading`, `CARD_H2_TEMPLATE`; `scanTestText`, `annotationRefs`, `resolveRuleRefs`, `RuleRef`, `RuleRefKind`, `RuleIndex`, `ScanOptions`, `RuleLinks`, `readTestFiles`; `DomainArtifactStore`, `domainIndexPass`; `runVerifyChecks`, `VerifyInput`, `verifyDomainCommand`; `repoFileExists`, `readRepoText`; `createEnrichers`; the `ctxoArtifact` marker (E1), the `registryHash` gate (E3); the library-lending sample (`packages/domain/test-fixtures/library-lending/{csharp,typescript}`) and `packages/domain/e2e/__tests__/sample-workspace.ts`.
  - PR 1B and 1C: `SymbolNode.annotations` with simple names (xUnit `Trait`, `Fact`; NUnit `Category`; MSTest `TestCategory`; JUnit `Tag`, `DisplayName`); 0-based `startLine` and `endLine`; TypeScript `describe`/`it`/`test` blocks as synthetic `function` symbols annotated `{ name: 'test' }`; Go `_test.go` symbols. The PR 1C plan was not available when this plan was written, so these follow spec 8A.4. No language plugin changes are needed in this PR.
- **Hexagonal rules** in both packages: `core/` never imports `adapters/`, `ports/` or `mcp/`; `ports/` never imports `adapters/`; no barrel exports (the package entries `packages/cli/src/internal.ts` and `packages/domain/src/index.ts` excepted); every adapter implements a port. In the cli, `adapters/mcp/` imports `core/` and `ports/` only, plus the type-only `LoadedModule` import PR 2B's `collectEnrichers` already uses.
- **Type-only rule (K7, ADR-018):** `@ctxo/domain` production code imports `@ctxo/cli` and `@ctxo/cli/internal` with `import type` only (lint-enforced); every runtime service comes from `host.services`. Tests may import runtime values from `@ctxo/cli/internal`.
- **Output channels:** never `console.log`. Human output to `console.error`, machine JSON to `process.stdout.write`, library logs through `createLogger('ctxo:<ns>')`. Adapters warn and continue; MCP handlers never throw; every MCP payload, card text included, passes through `wrapResponse` (the `_meta` envelope) and `masking.mask`.
- **Determinism (spec 13.1):** codepoint order everywhere (the cli's `compareCodepoint`; in `@ctxo/domain` the comparator PR 2B uses, recorded in Task 0), never `localeCompare`; no wall clock and no network in results; artifacts rewritten only when their content changed; the same input twice gives a byte-identical `graph.json` and identical tool responses.
- **Spec values, verbatim:**
  - Nodes `context:<id>`, `rule:<ID>`, `term:<context>/<term>`, `decision:<context>/<date>-<n>`; artifact `.ctxo/index/domain/graph.json`, marker `"ctxoArtifact": "domain-graph"` (E1).
  - Card format (11.1): rules are H3 `### <ID> <title>` under `Rules and invariants`, IDs permanent; `Tests:`, `Code:` and `Untested:` lines at the start of a rule body, values comma-separated backticked paths or symbol IDs; terms are list items starting with `**Term**` in `Language` and in `glossary.md`, where items may add `(context: <id>)`; decisions are list items starting with an ISO date and a colon; relative links point to provenance files, `#123` and URLs are external provenance strings.
  - Rule-to-test sources: xUnit `Trait` with a key in `domain.tests.ruleTraitKeys` (default `Rule`), NUnit `Category`, MSTest `TestCategory` (and JUnit `Tag`, as PR 2B scans it) whose value is a rule ID; the K6 text scan for IDs that exist in cards with variants `LEND-03`, `LEND03`, `Lend03`, `lend_03` at token boundaries, linked to the innermost indexed symbol spanning the line, else to the file, with the title of `it(`, `test(`, `describe(`, `t.Run(`, `@DisplayName(`, `[Fact(DisplayName =` recorded as the test name; the card's `Tests:` line.
  - Rule-to-symbol: card `Code:` references and `rule: LEND-03` comments in any comment style. Term-to-identifier: case-insensitive match against symbol names split on camelCase and snake_case, and against table names.
  - Fields: `rulesAffected`, `cardsToUpdate` on `get_blast_radius`; the card excerpt (rules linked to the symbol and its neighbours, terms, contracts) within the token budget on `get_context_for_task`; `decisions[]` for the symbol's context, five, with provenance, rule-linked first, on `get_why_context`; `contextsTouched[]` over the tool's `since`, `cardsChanged` and `rulesWithoutTests` on `get_pr_impact`.
  - Tools `get_domain_context({ symbolId?, path? })` and `get_rule({ ruleId })`, truncation-aware; `get_ranked_context({ scope: "domain" })` over card sections, glossary entries and in-repo provenance files through the core search engine; default scope `code`, unchanged.
  - Tool count: 14 core tools, plus 2 from `@ctxo/domain` in this PR (2 more in PR 4) when it is installed; docs state both numbers.
  - External provenance is stored as a string and never fetched (ADR-004). No registry: no fields, no errors. Budget: the domain index pass at most 2 s on the fixture (spec 13.4).
- **Tests:** vitest in `__tests__/` (the repo's write hook rejects test files outside `__tests__`), kebab-case names without extra dots. Temp dirs from `mkdtempSync(join(tmpdir(), 'ctxo-...'))`; temp repos start with `git init -b main`; every git operation that creates commits in a temp repo (commit, merge, rebase, cherry-pick, amend, revert, tag) passes `-c commit.gpgsign=false -c user.name=Test -c user.email=test@test.com`, plus `-c tag.gpgsign=false` for tags. Never run `ctxo init` or `ctxo doctor --fix` against the worktree. Domain tests use the built cli: run `pnpm --filter @ctxo/cli build` after any cli change.
- **Git on the branch:** stage the paths of the task's Files block only (`git add <path>...`, never `-A` or `.`), never `.ctxo/` or `.claude/settings.local.json`. Commits are GPG-signed (`git commit -S`); on a signing failure stop and report BLOCKED. The post-commit hook may take minutes; wait for the commit to return. No `Co-Authored-By` or AI attribution lines. No push, PR, publish or issue comment without the owner's approval.
- **Before editing an existing symbol,** call the ctxo MCP tools `get_blast_radius` and `get_why_context` on it (each task's Step 3 names the symbols). The session's ctxo MCP server indexes the main checkout (older code), so `found: false` from either tool for a symbol added on these branches is expected: call the tools as the project rule asks, then proceed.
- **Tarball:** the CLI limit is 850 KB (source maps are no longer published, Task 0b; 766 KB measured) (`packages/cli/tests/e2e/release-packaging.test.ts`); when crossed, raise it to the measured size rounded up to the next 50 KB, with both numbers and the reason in the PR description.
- **Text:** English only, no em dashes. **Privacy:** nothing from the private fixture or any private repository (code, paths, names, table names, rules) in code, tests, docs, commits or PR text; all test data is the synthetic library-lending sample; aggregate numbers only.

## Review Focus

1. **C# symbol IDs in card `Code:` and `Tests:` lines that differ by analysis tier or went stale after a rename** (Roslyn writes `Ns.LoanPolicy.CanBorrow`, tree-sitter `Ns.LoanPolicy.CanBorrow(1)`). Expected: the link falls back to the symbol's file, `verify-domain` warns and never fails for the symbol part, and fails only when the file itself is gone. Tests: Task 6 `a Tests: symbol ID missing from the index links to its file and is recorded as not-a-symbol`; Task 7 `a Code: symbol ID missing from the index falls back to its file`, `check 6 warns for an unindexed symbol ID and accepts an indexed one`.
2. **Cards, the glossary or the registry edited after the last `ctxo index`** (`ctxo watch` does not run module passes). Expected: after a registry change the tools answer with the "run ctxo index" hint and the enrichers add nothing (E3); after a card change the answers still come from the graph, with `stale: true` and a hint. Tests: Task 10 `reports no-registry, invalid-registry, no-graph and stale-registry with their hints`, `marks stale cards after a card edit and clears after re-indexing`; Task 11 `adds nothing without a registry or with a stale registry`; Task 13 `get_rule adds stale and the hint after a card edit`.
3. **A commit that changes only a card,** re-indexed by the post-commit hook (`ctxo index --commit HEAD` with no indexable file in the commit). Expected: the domain pass still runs and `graph.json` follows the card. Tests: Task 9 `a commit that changed no indexable file still runs module index passes`; Task 15 `a card-only commit refreshes graph.json through ctxo index --commit HEAD`.
4. **`rule:` comments written above a declaration** (the usual style, often with attributes or decorators in between) instead of inside it. Expected: the link goes to the declared method, not to the enclosing class. Tests: Task 6 `leadingSymbol prefers a symbol starting within three lines after the comment, else the innermost spanning symbol`, `a rule: comment above a test method links to the method`; Task 7 `a rule: comment above a method links to the method`.
5. **Generic, short or plural terms** (`ID`, `Account` defined in two contexts, table `dbo.loans` for the term `Loan`, namespace segments such as `Lending`). Expected: matches stay inside the owning context, plural class and table names match, namespaces never match, terms made of tokens shorter than three characters link nothing, and lists are capped with counts. Tests: Task 8 the term `it.each`, `a context term matches only its context's symbols; a repo-wide term matches all; test symbols never match`, `links are capped at 50 per term with exact matches and types first, and the count is kept`.

## Designer calls (spec gaps decided here; the owner may override)

- **F1 Graph artifact:** one uniform, sorted `links` array whose entries carry `kind`, `from`, `to`, `source` and the evidence location `at`; nodes carry the card text the tools return (rule bodies, term definitions, decision lines, non-split sections), so MCP reads one artifact. Lines are 1-based. `registryHash` gates use (E3); `cardsHash` marks stale cards.
- **F2 Node IDs:** the term key is the term lowercased with whitespace runs as `-` (`term:lending/member-account`); repo-wide glossary terms (no `(context: <id>)`, or an unknown id, which also warns) use `*` as the context, which no context id can be; `n` in `decision:<context>/<date>-<n>` counts that card's decisions with the same date in document order from 1. Search-only section IDs are `section:<card>:<line>`.
- **F3 Card references:** a `Tests:` or `Code:` value with `::` is a symbol ID. A symbol missing from the index falls back to its file (C# symbol IDs differ between the Roslyn and tree-sitter tiers) and `verify-domain` check 6 warns; a file part or path that does not exist links nothing and is a check 6 error, now also for `Code:`. Values are repo-relative, as in the 11.1 example.
- **F4 `rule:` comments:** in test files they link rule to test, elsewhere rule to symbol. A comment links to the symbol that starts within three lines below it, else to the innermost symbol spanning it (this changes PR 2B's attribution for `rule-comment` refs only). Production comments are scanned in indexed non-test files up to 1 MiB; an unknown ID there is a check 6 warning only when its prefix is a rule prefix (`# rule: E501` stays silent).
- **F5 Test names:** the captured test title, else the linked symbol's `name`.
- **F6 Decisions:** rule IDs written exactly in a decision line are structured references (cards are curated text): they link even when their prefix is a tracker prefix, and only IDs that exist in cards link. Tracker keys with a configured `domain.rules.trackerPrefixes` prefix that are not rule IDs become external provenance strings. A relative link that leaves the repository is kept as an external string and never read; a pure anchor is not provenance.
- **F7 Terms:** matched against the last `.` segment of a symbol name (namespace and C# parameter suffix dropped) split with the core tokenizer, as a contiguous token run with plural folding (`s`, `es`, `y` to `ies`); only symbols in non-test files of the owning context (repo-wide terms: all); terms whose tokens are all shorter than 3 characters link nothing; at most 50 identifiers per term in the artifact (exact matches and types first) plus the total count.
- **F8 Field presence:** fields appear, possibly empty, whenever a valid graph exists (E3's convention); `get_pr_impact` adds nothing when git cannot resolve `since`.
- **F9 `get_why_context` decisions:** at most five, decisions that mention a rule linked to the symbol first, then the others, each group newest first ("newest five" read as the cap, so an older decision about the symbol's rule is not crowded out by newer unrelated ones).
- **F10 Card excerpt:** a new `reserveTaskContextTokens` seam lets the core hold back up to 25% of `tokenBudget` before packing code context; the excerpt then packs target rules (text capped at 600 chars), neighbour rules (titles only), terms (those linked to the target or neighbours first) and contracts into what remains, reporting `tokens` and `omitted`. The core's `totalTokens` and `tokenBudget` keep their meaning, and the sum never exceeds the budget.
- **F11 Async enrichers:** `ResponseEnricher` may return a Promise; the async tools (`get_blast_radius`, `get_pr_impact`, `get_why_context`) await it through `applyEnricherAsync`; synchronous tools drop a Promise with a warning. `get_pr_impact` needs git, hence the change.
- **F12 Ranked scopes:** a `rankedContextScopes` seam. The `scope` parameter is registered only when a module provides a scope, so the schema is unchanged without `@ctxo/domain`; `withRankedScopes` wraps the unchanged code handler (its exported `InputSchema` and PR 1A's registration test stay as they are). `strategy` and `searchMode` do not apply to the domain scope.
- **F13 Document search:** `SearchEngine.buildDocumentIndex` and `SymbolTokenizer.tokenizeText` in the core engine with BM25 `k1 1.2, b 0.75` and no PageRank boost; host services `createDocumentSearch` and `splitIdentifier`. Card sections and glossary entries come from `graph.json`; provenance file text is read at query time (regular files inside the repository up to 256 KB, mtime-cached).
- **F14 Tools:** registered whenever `@ctxo/domain` is loaded and answer graceful `found: false` hints without a registry or a graph (no errors). `get_domain_context` with neither parameter lists the contexts; `symbolId` wins over `path`; the file part of `symbolId` selects the context (the symbol need not exist); a context's card path also selects it. `get_rule` accepts ID variants. Caps per entry: 15 identifiers per term, 10 tests and 10 code links per rule in `get_domain_context`, with counts; ADR-018 gets an addendum for the internal-API additions.
- **F15 `get_pr_impact` fields:** `rulesWithoutTests` includes `Untested:` rules with their reason; `contextsTouched` caps files at 10 with `fileCount`; `cardsChanged` lists every registry card changed in the range or the working tree, touched or not. All three lists, like `rulesAffected`, `cardsToUpdate` and `decisions`, are additive arrays on existing tools: capped at 50 at the source (`decisions` at five) with a `<name>Total` count when cut, and not truncatable fields.
- **F16 Scope of change:** no new CLI commands, flags or config keys; the `ctxo-domain-fold` skill mentions the two tools (doctor reports installed copies as outdated until `ctxo init --only domain`).

## File map

| File | Responsibility |
|---|---|
| cli `core/search/search-engine.ts`, `symbol-tokenizer.ts`, `core/types.ts` | Document index, prose tokenizer, `SearchDocument` |
| cli `ports/i-ctxo-module.ts`, `internal.ts`, `cli/module-host.ts` | Seam types, internal API exports, host services |
| cli `adapters/mcp/enrich-payload.ts`, `get-context-for-task.ts`, `ranked-scope-handler.ts`, `mcp-server.ts`, `core/response-envelope.ts` | Async enrichers, token reservation, ranked scopes, truncatable fields |
| domain `core/card-parser.ts` | Sections, rule bodies, terms, decisions, open questions, glossary |
| domain `core/domain-graph.ts` | Graph types, node IDs, nodes, composition, sorting, hashes |
| domain `core/rule-test-links.ts`, `rule-symbol-links.ts`, `decision-links.ts`, `term-links.ts`, `rule-id-scan.ts` | The four link families |
| domain `index-pass/domain-index-pass.ts`, `adapters/artifact-store.ts`, `adapters/repo-files.ts` | `graph.json` at index time |
| domain `core/domain-graph-query.ts`, `core/token-estimate.ts`, `mcp/domain-state.ts` | Snapshot, queries, staleness |
| domain `core/card-excerpt.ts`, `mcp/graph-enrichers.ts`, `mcp/pr-impact-fields.ts`, `mcp/enrichers.ts` | The additive fields |
| domain `core/domain-views.ts`, `mcp/domain-tools.ts` | `get_domain_context`, `get_rule` |
| domain `core/domain-documents.ts`, `adapters/provenance-texts.ts`, `mcp/domain-scope.ts` | The domain search scope |
| domain `test-fixtures/library-lending/**`, `e2e/__tests__/acceptance-graph.test.ts`, `e2e/__tests__/mcp-client.ts` | Sample and acceptance |

---

### Task 0: Setup

- [ ] **Step 1:** Create the worktree with superpowers:using-git-worktrees: branch `feat/domain-graph-156` from the tip of `feat/domain-package-156`.
- [ ] **Step 2:** `pnpm install --frozen-lockfile && pnpm -r build`. Expected: success.
- [ ] **Step 3: Confirm the consumed pieces.** Each command must print matches, otherwise stop and report BLOCKED:
  - `git grep -n -e "export function parseCard" -e "export function scanTestText" -e "export function annotationRefs" -e "export function resolveRuleRefs" -e "export function readTestFiles" -- packages/domain/src`
  - `git grep -n -e "export class DomainArtifactStore" -e "export function domainIndexPass" -e "export function runVerifyChecks" -e "export function createEnrichers" -e "export function computeTouched" -e "export class GitChangeReader" -- packages/domain/src`
  - `git grep -n -e "export function applyEnricher" -e "export function collectEnrichers" -e "export function handleModuleTool" -- packages/cli/src/adapters/mcp`; `git grep -n "export function createModuleHost" -- packages/cli/src/cli/module-host.ts`
  - `git grep -n "annotations" -- packages/plugin-api/src packages/lang-typescript/src packages/lang-csharp/src` (PR 1B and 1C annotations, TypeScript test blocks included)
- [ ] **Step 4: Record in the scratchpad** (later tasks use these names):
  - the codepoint comparator `@ctxo/domain` uses (`git grep -n "codepoint" -i -- packages/domain/src/core`);
  - that PR 2B's `RuleRef.line` is 0-based: `annotationRefs` takes the symbol's `startLine` (`git grep -n "startLine" -- packages/domain/src/core/rule-id-scan.ts`); if it is 1-based, Task 6's `toLocation` drops its `+ 1`;
  - where `verify-domain-command.ts` builds its `ScanOptions` (Task 6 replaces that construction);
  - per sample variant, the Lending policy class and its borrow check that the `LEND-03` test calls, the hold class, and the test file (C# `tests/Lending.Tests/LoanLimitTests.cs`, TypeScript `src/lending/__tests__/loan-limit.test.ts`); Task 15 adds what is missing.
- [ ] **Step 5: Baseline.** `pnpm --filter @ctxo/cli test:unit && pnpm --filter @ctxo/domain test`. Expected: all pass; note the counts for the PR description.
- [ ] **Step 6: Commit the plan.**
  ```bash
  git add -f docs/superpowers/plans/2026-10-21-pr3-domain-graph.md
  git commit -S -m "docs: add PR 3 domain graph plan"
  ```

---

### Task 1: Document search in the core BM25 engine, and two host services

**Files:**
- Modify: `packages/cli/src/core/types.ts` (`SearchDocument` next to `SearchResult`), `packages/cli/src/core/search/symbol-tokenizer.ts` (`tokenizeText`), `packages/cli/src/core/search/search-engine.ts` (`buildDocumentIndex`, exported `BM25Config`, `SearchEngineConfig`, `DOCUMENT_SEARCH_CONFIG`), `packages/cli/src/ports/i-ctxo-module.ts` (`DocumentSearch`, `CtxoHostServices`), `packages/cli/src/cli/module-host.ts` (two services), `packages/cli/src/internal.ts` (type exports)
- Test: `packages/cli/src/core/search/__tests__/symbol-tokenizer.test.ts`, `packages/cli/src/core/search/__tests__/search-engine.test.ts`, `packages/cli/src/cli/__tests__/module-host.test.ts`

**Interfaces:**
- Consumes: `SearchEngine`, `SymbolTokenizer.splitName`, `SearchResponse` (existing); `CtxoHostServices`, `createModuleHost` (PR 2B).
- Produces:
  ```ts
  // core/types.ts
  export interface SearchDocument { readonly id: string; readonly title: string; readonly kind: string; readonly path: string; readonly text: string }
  // symbol-tokenizer.ts (instance method)
  tokenizeText(text: string): string[];
  // search-engine.ts
  export interface BM25Config { k1: number; b: number }
  export interface SearchEngineConfig { /* the existing fields, now exported */ }
  export const DOCUMENT_SEARCH_CONFIG: Partial<SearchEngineConfig>;   // { bm25: { k1: 1.2, b: 0.75 }, pageRankWeight: 0 }
  buildDocumentIndex(documents: readonly SearchDocument[]): void;    // hits carry id in symbolId, title in name, kind, path in filePath
  // ports/i-ctxo-module.ts
  export interface DocumentSearch { search(query: string, limit?: number): SearchResponse }
  // CtxoHostServices gains:
  createDocumentSearch(documents: readonly SearchDocument[]): DocumentSearch;
  splitIdentifier(name: string): string[];                           // SymbolTokenizer.splitName
  // internal.ts: export type SearchDocument, SearchResponse, SearchResult, SearchMetrics, DocumentSearch
  ```
- Rules (F13):
  - `tokenizeText`: words are runs of letters, digits, `_` and `-` (`/[^\p{L}\p{N}_-]+/u` separates them); each word goes through `splitName` and is lowercased; stop words are dropped; repeats are kept, so BM25 sees term frequency.
  - `buildDocumentIndex`: per document, tokens are `tokenize(title, path)` followed by `tokenizeText(text)`; trigrams come from the lowercased title; the PageRank map is empty. `buildIndex` and `buildDocumentIndex` share one private indexing helper, so `buildIndex` output is unchanged. A document index is rebuilt as a whole (`updateFile` does not apply).
  - `createDocumentSearch` builds `new SearchEngine(DOCUMENT_SEARCH_CONFIG)` and calls `buildDocumentIndex` once.

- [ ] **Step 1: Write the failing tests.**
  - `tokenizeText splits prose, camelCase words and rule IDs and keeps repeats`: `tokenizeText('A member holds at most five loans. LoanPolicy LEND-03 loans')` equals `['member', 'holds', 'most', 'five', 'loans', 'loan', 'policy', 'lend', '03', 'loans']`.
  - `buildDocumentIndex ranks documents by title and text`, with `new SearchEngine(DOCUMENT_SEARCH_CONFIG)` over three documents: `rule:LEND-03` (title `LEND-03 A member holds at most five loans`, text `The sixth loan is refused while five are open.`), `term:lending/hold` (title `Hold`, text `A reservation of a copy for a member.`), `file:docs/specs/loan-limit.md` (title `Loan limit`, text `The limit rose from three to five loans after the renewal study.`). The first hit of `sixth loan` is `rule:LEND-03`, of `reservation` is `term:lending/hold`, of `renewal study` is `file:docs/specs/loan-limit.md`, of `LEND-03` is `rule:LEND-03`.
  - `document search corrects a typo`: `search('renewel')` has `fuzzyCorrection` and its first hit is the provenance document.
  - `the same documents give identical results` (two engines, deep-equal hits).
  - `module-host.test.ts`: `createDocumentSearch returns BM25 hits over the documents`; `splitIdentifier splits camelCase, PascalCase and snake_case`: `'ILoanRepository'` gives `['I', 'Loan', 'Repository']`, `'member_account_id'` gives `['member', 'account', 'id']`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/core/search src/cli/__tests__/module-host.test.ts`. Expected: the new tests FAIL (`buildDocumentIndex is not a function`).
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `SearchEngine`, `SearchEngine.buildIndex`, `SymbolTokenizer` and `createModuleHost`.
- [ ] **Step 4: Run the tests.** The Step 2 command, then `pnpm --filter @ctxo/cli test:unit`. Expected: PASS, the existing search and tokenizer tests included.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/core/types.ts packages/cli/src/core/search/symbol-tokenizer.ts packages/cli/src/core/search/search-engine.ts packages/cli/src/ports/i-ctxo-module.ts packages/cli/src/cli/module-host.ts packages/cli/src/internal.ts packages/cli/src/core/search/__tests__/symbol-tokenizer.test.ts packages/cli/src/core/search/__tests__/search-engine.test.ts packages/cli/src/cli/__tests__/module-host.test.ts
  git commit -S -m "feat(search): document search in the core BM25 engine and host services for @ctxo/domain (#156)"
  ```

---

### Task 2: Async enrichers, and the `get_context_for_task` enricher with a token reservation

**Files:**
- Modify: `packages/cli/src/ports/i-ctxo-module.ts` (`ResponseEnricher`, `TokenReservation`, `CtxoModuleRegistration.reserveTaskContextTokens`), `packages/cli/src/adapters/mcp/enrich-payload.ts`, `packages/cli/src/adapters/mcp/get-blast-radius.ts`, `get-pr-impact.ts`, `get-why-context.ts`, `get-context-for-task.ts`, `packages/cli/src/mcp-server.ts` (`registerTools`), `packages/cli/src/internal.ts`
- Test: `packages/cli/src/adapters/mcp/__tests__/enrich-payload.test.ts`, `get-context-for-task.test.ts`, `get-pr-impact.test.ts`, `get-blast-radius.test.ts`, `get-why-context.test.ts` (same folder), `packages/cli/src/__tests__/mcp-server-modules.test.ts`

**Interfaces:**
- Consumes: `applyEnricher`, `collectEnrichers`, `LoadedModule`, the `enrich` parameter of six handlers (PR 2B Task 6).
- Produces:
  ```ts
  // ports/i-ctxo-module.ts
  export type ResponseEnricher = (payload: Record<string, unknown>, args: Readonly<Record<string, unknown>>)
    => Record<string, unknown> | Promise<Record<string, unknown>>;                    // widened (F11)
  export type TokenReservation = (args: Readonly<Record<string, unknown>>) => number;
  // CtxoModuleRegistration gains: readonly reserveTaskContextTokens?: TokenReservation;
  // enrich-payload.ts
  export function applyEnricherAsync(enrich: ResponseEnricher | undefined, payload: Record<string, unknown>,
    args: Readonly<Record<string, unknown>>, tool: CoreToolName): Promise<Record<string, unknown>>;
  export function collectTaskContextReservation(modules: readonly LoadedModule[]): TokenReservation | undefined;   // sum over modules
  // get-context-for-task.ts
  export const MAX_RESERVED_SHARE = 0.25;
  export function reservedTokens(reserve: TokenReservation | undefined, args: Readonly<Record<string, unknown>>, tokenBudget: number): number;
  export function handleGetContextForTask(storage: IStoragePort, masking: IMaskingPort, staleness?: StalenessCheck, ctxoRoot = '.ctxo',
    /* PR 0 Task 8's co-change parameter stays here, in its place, then: */ enrich?: ResponseEnricher, reserve?: TokenReservation);
  // internal.ts: export type TokenReservation
  ```
- Rules:
  - `applyEnricher` (the synchronous tools `search_symbols`, `find_importers`, `get_logic_slice`, `get_context_for_task`): a Promise result is dropped, its rejection swallowed, with the warning `<tool> enricher returned a Promise; a synchronous tool cannot wait for it`; the payload is returned unchanged.
  - `applyEnricherAsync`: awaits; a throw or a rejection keeps the payload (warned once per call). `get_blast_radius`, `get_pr_impact` and `get_why_context` switch to it at the same place in their flow.
  - `collectEnrichers` composition keeps a Promise chain: when one enricher returns a Promise, the next runs on its resolved value.
  - `reservedTokens`: 0 without a reservation, and 0 with a warning when it throws or returns a non-finite number; otherwise `Math.round(value)` clamped to `[0, Math.floor(tokenBudget * MAX_RESERVED_SHARE)]`.
  - `handleGetContextForTask`: `assembleForTask` packs into `tokenBudget - reserved`; the payload reports the requested `tokenBudget`; then `applyEnricher(enrich, payload, args, 'get_context_for_task')`, `wrapResponse` and `masking.mask` (F10).
  - Parameter order: PR 0 Task 8 already gave `handleGetContextForTask` a co-change parameter (the `CoChangeReader`, after `ctxoRoot`). `enrich` and `reserve` are appended after it, never inserted before it, so existing callers and tests keep their argument positions; the co-change reader keeps feeding `assembleForTask`'s `coChangeMap` as PR 0 wired it.
  - `registerTools` passes `enrichers.get('get_context_for_task')` and `collectTaskContextReservation(modules)` after the co-change reader argument.

- [ ] **Step 1: Write the failing tests.**
  - `enrich-payload.test.ts`: `applyEnricher drops a Promise result and warns`; `applyEnricherAsync awaits an async enricher`; `applyEnricherAsync keeps the payload when the enricher rejects`; `collectEnrichers chains an async enricher` (the second enricher sees the first one's field).
  - In `get-pr-impact.test.ts`, `get-blast-radius.test.ts` and `get-why-context.test.ts`: `awaits an async enricher before the envelope` (an enricher resolving `{ ...payload, enrichedBy: 'async' }` shows in the response).
  - `get-context-for-task.test.ts` (the existing indices):
    - `packs the code context into the budget left after the reservation and reports the requested budget`: budget 1000, reservation 400 give `totalTokens <= 600` and `tokenBudget === 1000`.
    - `reservedTokens caps the reservation at a quarter of the budget`: `reservedTokens(() => 5000, args, 1000) === 250`; `reservedTokens(() => Number.NaN, args, 1000) === 0`.
    - `a throwing reservation reserves nothing`: the payload equals the one without a reservation.
    - `applies the enricher before the envelope and masking`.
    - `the new parameters follow the co-change parameter`: a call that passes a co-change reader, an enricher and a reservation applies all three (the co-change upgrade tiers a dependent `likely`, `enrichedBy` shows, `totalTokens` stays within the reduced budget).
  - `mcp-server-modules.test.ts`: `get_context_for_task receives the module reservation and enricher`: a stub module with `reserveTaskContextTokens: () => 200` and an enricher adding `enrichedBy` gives a response with `enrichedBy` and `tokenBudget: 4000`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/adapters/mcp src/__tests__/mcp-server-modules.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `applyEnricher`, `collectEnrichers`, `handleGetContextForTask`, `handleGetBlastRadius`, `handleGetPrImpact`, `handleGetWhyContext` and `registerTools`.
- [ ] **Step 4: Run the tests.** The Step 2 command, then `pnpm --filter @ctxo/cli test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/ports/i-ctxo-module.ts packages/cli/src/adapters/mcp/enrich-payload.ts packages/cli/src/adapters/mcp/get-blast-radius.ts packages/cli/src/adapters/mcp/get-pr-impact.ts packages/cli/src/adapters/mcp/get-why-context.ts packages/cli/src/adapters/mcp/get-context-for-task.ts packages/cli/src/mcp-server.ts packages/cli/src/internal.ts
  git add packages/cli/src/adapters/mcp/__tests__/enrich-payload.test.ts packages/cli/src/adapters/mcp/__tests__/get-context-for-task.test.ts packages/cli/src/adapters/mcp/__tests__/get-pr-impact.test.ts packages/cli/src/adapters/mcp/__tests__/get-blast-radius.test.ts packages/cli/src/adapters/mcp/__tests__/get-why-context.test.ts packages/cli/src/__tests__/mcp-server-modules.test.ts
  git commit -S -m "feat(mcp): async enrichers for async tools and a token reservation for get_context_for_task (#156)"
  ```

---

### Task 3: Ranked-context scopes, the `scope` parameter and the truncatable domain fields

**Files:**
- Create: `packages/cli/src/adapters/mcp/ranked-scope-handler.ts`
- Modify: `packages/cli/src/ports/i-ctxo-module.ts` (`RankedContextScope`, `CtxoModuleRegistration.rankedContextScopes`), `packages/cli/src/mcp-server.ts` (`get_ranked_context` registration), `packages/cli/src/core/response-envelope.ts` (`TRUNCATABLE_FIELDS`), `packages/cli/src/internal.ts`
- Test: `packages/cli/src/adapters/mcp/__tests__/ranked-scope-handler.test.ts` (new), `packages/cli/src/__tests__/mcp-server-modules.test.ts`, `packages/cli/src/core/__tests__/response-envelope.test.ts`

**Interfaces:**
- Consumes: `handleGetRankedContext` (unchanged), `wrapResponse`, `IMaskingPort`, `McpToolResult` (PR 2B), `LoadedModule`.
- Produces:
  ```ts
  // ports/i-ctxo-module.ts
  export interface RankedContextScope {
    readonly scope: string;                 // never 'code'
    readonly description: string;           // one sentence appended to the scope parameter description
    search(args: { readonly query: string; readonly tokenBudget: number }): Promise<Record<string, unknown>> | Record<string, unknown>;
  }
  // CtxoModuleRegistration gains: readonly rankedContextScopes?: readonly RankedContextScope[];
  // ranked-scope-handler.ts
  export const CODE_SCOPE = 'code';
  export type McpHandler = (args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>;
  export function collectRankedScopes(modules: readonly LoadedModule[]): Map<string, RankedContextScope>;
  export function withRankedScopes(code: McpHandler, scopes: ReadonlyMap<string, RankedContextScope>, masking: IMaskingPort): McpHandler;
  // internal.ts: export type RankedContextScope
  ```
- Rules (F12):
  - `collectRankedScopes`: by scope name in load order; `code` and a name already taken are skipped with the warning `<module> scope "<name>" is skipped: <reserved|already registered>`.
  - `withRankedScopes`: without scopes it returns `code` itself. Otherwise an absent `scope` or `code` calls `code(args)`. A known scope validates `query` (non-empty string) and `tokenBudget` (number >= 100, default 4000), awaits `search`, and returns `{ content: [{ type: 'text', text: masking.mask(JSON.stringify(wrapResponse(result))) }] }`. An unknown scope gives `{ error: true, message: 'Unknown scope "<s>"; use one of: code, <names>' }`; an invalid query or a throw gives `{ error: true, message }`. `handleGetRankedContext` and its exported `InputSchema` stay unchanged, so PR 1A's `mcp-tool-registration.test.ts` keeps comparing an unchanged schema.
  - Registration: only when scopes exist, `get_ranked_context` gains `scope: z.enum(['code', ...names]).optional().default('code')` with the description `Where to search. "code" (default): rank symbols.` followed by each scope's description in name order, one space apart. HTTP sessions get the same registration.
  - `TRUNCATABLE_FIELDS` gains only the primary arrays of the new tools (`get_domain_context`, `get_rule`), with these exact hints:
    - `rules`: `Use get_rule with a ruleId for one rule's tests, code and decisions.`
    - `contexts`: `Use get_domain_context with a symbolId or path for one context's card.`
    - `terms`: `Read the card's Language section, or use get_ranked_context with scope "domain".`
    - `openQuestions`: `Read the card's Open questions section for the full list.`
    - `tests`: `Use search_symbols with a test file path as filePattern to list one file's tests.`
    - `symbols`: `Use get_blast_radius on one linked symbol for its impact.`
    - `provenance`: `Open the linked files directly; external references are never fetched.`
    - `unresolved`: `Run "ctxo verify-domain --json" for every unresolved card reference.`
  - Additive arrays on existing tools are NOT added to `TRUNCATABLE_FIELDS`. `wrapResponse` truncates only the largest truncatable array, so a long additive list would take over truncation from the tool's primary array (`impactedSymbols`, `files`) and `_meta.totalItems` would describe the wrong list. They are capped at their source instead, by the enrichers and views of Tasks 11 to 13: `rulesAffected` and `cardsToUpdate` (`get_blast_radius`), `contextsTouched`, `cardsChanged` and `rulesWithoutTests` (`get_pr_impact`) at 50 entries; `decisions` (`get_why_context`, where F9 already allows five, and the secondary `decisions` lists of `get_domain_context` and `get_rule`, 50), each with a `<name>Total` field holding the full count only when entries were cut.

- [ ] **Step 1: Write the failing tests.**
  - `ranked-scope-handler.test.ts`:
    - `without scopes the code handler is returned unchanged` (identity).
    - `an absent scope and scope code use the code handler`.
    - `a module scope gets the query and budget and its result is wrapped and masked`: a stub returning `{ results: [{ id: 'x' }], key: 'AKIAIOSFODNN7EXAMPLE' }` gives `_meta.totalItems === 1` and the key masked; the stub saw `{ query: 'loans', tokenBudget: 4000 }`.
    - `an unknown scope is an error`; `an empty query is an error`; `a throwing scope becomes { error: true, message }`.
    - `collectRankedScopes skips code and duplicates with a warning`.
  - `mcp-server-modules.test.ts`: `get_ranked_context registers scope only when a module provides one`: without modules `inputSchema.properties.scope` is undefined; with a stub scope `domain` it has `enum: ['code', 'domain']` and `default: 'code'`, and a call with `scope: 'domain'` returns the stub payload with `_meta`.
  - `response-envelope.test.ts`:
    - `the new tools' arrays are truncatable with their hints` (`it.each` over the eight names `rules`, `contexts`, `terms`, `openQuestions`, `tests`, `symbols`, `provenance` and `unresolved`: with `CTXO_RESPONSE_LIMIT=1024` and 100 items of 40 characters, `_meta.truncated` is true and `_meta.hint` equals the hint).
    - `the additive domain fields are not truncatable` (`it.each` over `rulesAffected`, `cardsToUpdate`, `decisions`, `contextsTouched`, `cardsChanged` and `rulesWithoutTests`: the same payload gives `_meta.truncated: false` and all 100 items).
    - `two arrays in one response: the primary array is truncated, the capped additive array is not` (200 `impactedSymbols` of 40 characters beside 50 `rulesAffected` and `rulesAffectedTotal: 80`, `CTXO_RESPONSE_LIMIT=2048`: `_meta.truncated` is true and `_meta.totalItems` is 200 with the `impactedSymbols` hint; the 50 rules and the total are intact).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/adapters/mcp/__tests__/ranked-scope-handler.test.ts src/__tests__/mcp-server-modules.test.ts src/core/__tests__/response-envelope.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `wrapResponse` and `registerTools`.
- [ ] **Step 4: Run the tests.** The Step 2 command, then `pnpm --filter @ctxo/cli build && pnpm --filter @ctxo/cli test:e2e`. Expected: PASS, `mcp-tool-registration.test.ts` and the tarball test included.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/cli/src/adapters/mcp/ranked-scope-handler.ts packages/cli/src/ports/i-ctxo-module.ts packages/cli/src/mcp-server.ts packages/cli/src/core/response-envelope.ts packages/cli/src/internal.ts packages/cli/src/adapters/mcp/__tests__/ranked-scope-handler.test.ts packages/cli/src/__tests__/mcp-server-modules.test.ts packages/cli/src/core/__tests__/response-envelope.test.ts
  git commit -S -m "feat(mcp): ranked-context scopes from modules and truncatable domain fields (#156)"
  ```

---

### Task 4: Card parser: sections, rule bodies, terms, decisions, open questions and the glossary

**Files:**
- Modify: `packages/domain/src/core/card-parser.ts` (`CardRule`, `ParsedCard`, `parseCard`)
- Test: `packages/domain/src/core/__tests__/card-parser.test.ts`

**Interfaces:**
- Consumes: PR 2B's line parser (BOM, `\r?\n`, fences, ATX headings, rules, rule lines, links, inline code spans).
- Produces:
  ```ts
  export interface CardRule { /* PR 2B fields */ readonly text: string; readonly endLine: number; readonly testsLine?: number; readonly codeLine?: number }
  export interface CardItem { readonly text: string; readonly line: number }
  export interface CardSection { readonly heading: string; readonly line: number; readonly endLine: number; readonly text: string }
  export interface CardTerm { readonly term: string; readonly definition: string; readonly line: number }
  export interface CardDecision { readonly date: string; readonly text: string; readonly line: number;
    readonly links: readonly { readonly label: string; readonly target: string }[]; readonly externalRefs: readonly string[] }
  export interface ParsedCard { /* PR 2B fields */ readonly title?: string; readonly intro?: CardItem; readonly sections: readonly CardSection[];
    readonly terms: readonly CardTerm[]; readonly decisions: readonly CardDecision[]; readonly openQuestions: readonly CardItem[];
    readonly contractRefs: readonly string[] }
  export interface GlossaryItem { readonly term: string; readonly context?: string; readonly definition: string; readonly line: number }
  export function parseGlossary(text: string): GlossaryItem[];
  ```
- Rules (lines 1-based; nothing inside a fence is structure; text keeps its markdown):
  - `title` is the first H1. `intro` is the trimmed text between that H1 and the first H2 (`line` = the H1's), absent when empty.
  - `sections`: every H2 in order; `text` is the trimmed body up to the next H2, H3 headings and fences included as written.
  - A rule's `text` is its body after the rule lines up to the next H1, H2 or H3, trimmed; `endLine` is the last line before that heading; `testsLine` and `codeLine` are the lines of those rule lines.
  - A list item is `^ {0,3}[-*+][ \t]+(.*)$`; following non-blank lines indented by at least two spaces continue it (joined with one space); a blank line, another item or a heading ends it.
  - A term item (in `Language`; anywhere outside fences in a glossary) has item text `^\*\*(.+?)\*\*(.*)$`. The term is the bold text trimmed with a trailing `:` removed. In the rest, a leading `(context: <id>)` sets `context` (glossary only); then a leading `:` and whitespace are dropped; what remains is `definition`.
  - A decision item (in `Decisions`) has item text `^(\d{4})-(\d{2})-(\d{2})[ \t]*:[ \t]*(.*)$` with month 01 to 12 and day 01 to 31; `text` is the remainder. `links` are the item's inline links outside code spans (`label` = link text). `externalRefs`, in text order: bare URLs `https?://[^\s<>()\[\]]+` outside link targets, trailing `.,;:!?` removed, and `#<digits>` not preceded by a letter, digit, `_`, `#`, `&` or `/` and not inside a link target.
  - `openQuestions`: the items of `Open questions`, or the whole section text as one item when it has no list.
  - `contractRefs`: the backticked values in `Boundary contracts`, in order, unique.

- [ ] **Step 1: Write the failing tests.**
  - `parses the spec card example into sections, terms, rules, decisions and open questions` (the 11.1 block verbatim, `# Lending` on line 1):
    - `title: 'Lending'`, `intro` undefined, section headings equal `CARD_H2_TEMPLATE`;
    - `terms` `[{ term: 'Loan', definition: '...', line: 4 }, { term: 'Hold', definition: '...', line: 5 }]`;
    - `rules[0]` has `id: 'LEND-03'`, `line: 8`, `testsLine: 9`, `codeLine: 10`, `text: 'Free text written by people.'`, `endLine: 13`; `rules[1]` has `id: 'LEND-04'`, `untested: 'covered by manual QA until the scheduler migration lands'`, `text: ''`, `endLine: 16`;
    - `decisions` `[{ date: '2026-09-12', line: 21, text: 'Loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)', links: [{ label: 'spec', target: '../../specs/loan-limit.md' }, { label: 'ADR-007', target: '../../adr/adr-007-loan-limit.md' }], externalRefs: ['#123'] }]`;
    - `openQuestions` `[{ text: '...', line: 24 }]`; `contractRefs` `[]`.
  - `glossary items carry an optional context`: `- **Loan** (context: lending): one copy lent to a member` gives `{ term: 'Loan', context: 'lending', definition: 'one copy lent to a member', line: 1 }`; `- **Member**: a registered patron` has no `context`.
  - `term items accept a colon inside the bold text and continuation lines`: `- **Loan:** first line` plus `  second line` gives `{ term: 'Loan', definition: 'first line second line' }`.
  - `decision items need a valid ISO date and a colon`: `- Sometime: x`, `- 2026-13-01: x` and `- 2026-09-12 no colon` give none; `- 2026-09-12: x` gives one.
  - `external refs are bare URLs without trailing punctuation and #digits outside words and link targets`: `See https://example.com/a/b. and #12, not x#13, [y](#14) or [z](https://example.com/c)` gives `externalRefs` `['https://example.com/a/b', '#12']` and links `y` (`#14`) and `z` (`https://example.com/c`).
  - `rule bodies stop at the next heading and exclude the rule lines`.
  - `the intro is the text between the H1 and the first H2`.
  - `contract references are the backticked values of Boundary contracts`.
  - `structure inside fenced code is ignored` (a fenced `- **Fake**: x` in Language and `- 2026-01-01: fake` in Decisions give nothing).
  - `CRLF and a BOM parse like LF` (deep-equal results).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/card-parser.test.ts`. Expected: the new tests FAIL; PR 2B's tests pass.
- [ ] **Step 3: Implement** in the same line parser. Before editing, run `get_blast_radius` and `get_why_context` on `parseCard`.
- [ ] **Step 4: Run the tests.** Expected: PASS, PR 2B's card-parser tests included.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/card-parser.ts packages/domain/src/core/__tests__/card-parser.test.ts
  git commit -S -m "feat(domain): card parser for sections, rule bodies, terms, decisions, open questions and the glossary (#156)"
  ```

---

### Task 5: Domain graph model and nodes

**Files:**
- Create: `packages/domain/src/core/domain-graph.ts`
- Test: `packages/domain/src/core/__tests__/domain-graph.test.ts`

**Interfaces:**
- Consumes: `ParsedCard`, `CardDecision`, `GlossaryItem` (Task 4); `DomainRegistry`, `DomainContext`, `Rung` (PR 2B).
- Produces (types and node builders; Tasks 6 to 8 build links, Task 9 composes):
  ```ts
  export const DOMAIN_GRAPH_ARTIFACT = 'domain-graph';
  export const REPO_WIDE_CONTEXT = '*';
  export interface Location { readonly file: string; readonly line: number }            // repo-relative, 1-based
  export interface ContextNode { readonly id: string; readonly context: string; readonly name: string; readonly rung: Rung; readonly card?: string; readonly rulePrefix?: string }
  export interface RuleNode { readonly id: string; readonly ruleId: string; readonly context: string; readonly card: string; readonly title: string;
    readonly line: number; readonly text: string; readonly untested?: string }
  export interface TermDefinition { readonly text: string; readonly at: Location; readonly origin: 'card' | 'glossary' }
  export interface TermNode { readonly id: string; readonly context: string; readonly key: string; readonly term: string;
    readonly definitions: readonly TermDefinition[]; readonly identifierCount: number }
  export interface DecisionNode { readonly id: string; readonly context: string; readonly card: string; readonly date: string; readonly n: number; readonly line: number; readonly text: string }
  export interface SectionNode { readonly id: string; readonly context: string; readonly card: string; readonly heading: string;
    readonly kind: 'intro' | 'contracts' | 'open-questions' | 'other'; readonly line: number; readonly text: string; readonly references?: readonly string[] }
  export interface OpenQuestion { readonly context: string; readonly card: string; readonly line: number; readonly text: string }
  export interface CodeTarget { readonly file: string; readonly symbolId?: string }      // no symbolId: a file-level link
  export type ProvenanceTarget = { readonly kind: 'file'; readonly path: string; readonly exists: boolean } | { readonly kind: 'external'; readonly value: string };
  export type RuleTestSource = 'annotation' | 'category' | 'test-title' | 'rule-comment' | 'mention' | 'card-tests';
  export type DomainLink =
    | { readonly kind: 'rule-test'; readonly from: string; readonly to: CodeTarget; readonly source: RuleTestSource; readonly at: Location;
        readonly annotation?: string; readonly testName?: string; readonly fallback?: true }
    | { readonly kind: 'rule-symbol'; readonly from: string; readonly to: CodeTarget; readonly source: 'card-code' | 'rule-comment'; readonly at: Location; readonly fallback?: true }
    | { readonly kind: 'decision-provenance'; readonly from: string; readonly to: ProvenanceTarget; readonly source: 'card-link' | 'card-text'; readonly at: Location; readonly label?: string }
    | { readonly kind: 'decision-rule'; readonly from: string; readonly to: string; readonly source: 'card-text'; readonly at: Location }
    | { readonly kind: 'term-identifier'; readonly from: string; readonly to: { readonly file: string; readonly symbolId: string };
        readonly source: 'symbol-name' | 'table-name'; readonly match: 'exact' | 'partial' };
  export interface UnresolvedRef { readonly rule: string; readonly field: 'Tests' | 'Code'; readonly value: string; readonly at: Location; readonly reason: 'missing-file' | 'not-a-symbol' }
  export interface DomainGraph {
    readonly ctxoArtifact: 'domain-graph'; readonly version: 1; readonly registryHash: string; readonly cardsHash: string;
    readonly contexts: readonly ContextNode[]; readonly rules: readonly RuleNode[]; readonly terms: readonly TermNode[];
    readonly decisions: readonly DecisionNode[]; readonly sections: readonly SectionNode[]; readonly openQuestions: readonly OpenQuestion[];
    readonly links: readonly DomainLink[]; readonly unresolved: readonly UnresolvedRef[];
  }
  export interface CardRuleRefs { readonly ruleId: string; readonly card: string; readonly tests: readonly string[]; readonly testsLine: number;
    readonly code: readonly string[]; readonly codeLine: number }
  export interface CardInput { readonly context: DomainContext; readonly path: string; readonly card?: ParsedCard }   // card absent: file missing
  export interface GraphNodes { readonly contexts: ContextNode[]; readonly rules: RuleNode[]; readonly terms: TermNode[]; readonly decisions: DecisionNode[];
    readonly sections: SectionNode[]; readonly openQuestions: OpenQuestion[]; readonly cardRefs: CardRuleRefs[];
    readonly parsedDecisions: ReadonlyMap<string, CardDecision> }                                  // by decision node id
  export function contextNodeId(context: string): string;
  export function ruleNodeId(ruleId: string): string;
  export function termKey(term: string): string;
  export function termNodeId(context: string, term: string): string;
  export function decisionNodeId(context: string, date: string, n: number): string;
  export function buildGraphNodes(input: { readonly registry: DomainRegistry; readonly cards: readonly CardInput[];
    readonly glossary?: { readonly path: string; readonly items: readonly GlossaryItem[] }; readonly warn?: (message: string) => void }): GraphNodes;
  export function cardsHash(files: readonly { readonly path: string; readonly text?: string }[]): string;
  export function sortGraph(graph: DomainGraph): DomainGraph;
  ```
- Rules (F1, F2):
  - `termKey`: trimmed, lowercased, whitespace runs become `-`.
  - Contexts in registry order. Rules come from each card's rules (context = the card's context). A duplicate rule ID keeps the first by card path, then line, and warns `rule <ID> is defined in <card> and <card>; keeping the first`.
  - Terms: the card's `Language` items (origin `card`) and glossary items (origin `glossary`). A glossary item's `context` must be a registry id; without one, or with an unknown id (warning `<glossary>:<line> names unknown context "<id>"`), the term is repo-wide (`*`). Items with the same key in the same context merge: `term` keeps the first spelling, definitions keep document order with card definitions first. `identifierCount` is 0 here (Task 9 sets it).
  - Decisions: `n` counts the card's decisions with the same date in document order, from 1.
  - Sections: the intro (`kind: 'intro'`, `heading` = the title), `Boundary contracts` (`contracts`, `references` = `contractRefs`), `Open questions` (`open-questions`) and every other H2 outside the template (`other`); `Language`, `Rules and invariants` and `Decisions` are split into terms, rules and decisions instead. Section ids are `section:<card>:<line>`.
  - `cardRefs`: one entry per kept rule with its `Tests:` and `Code:` values; a missing rule line falls back to the rule heading line.
  - `cardsHash`: first 16 hex of SHA-256 over `<path>\n<text>\n` per file in path order, text BOM-stripped and CRLF-normalised, `<missing>` for an absent text.
  - `sortGraph`: nodes by `id`; sections and open questions by card, then line; links by `kind`, `from`, target key (`symbolId ?? file`, `path`, `value` or rule node id), `source`, `at.file`, `at.line`; unresolved by `rule`, `field`, `value`. Codepoint order throughout.

- [ ] **Step 1: Write the failing tests.**
  - `node IDs follow the spec formats`: `context:lending`, `rule:LEND-03`, `term:lending/member-account` (from `Member account`), `term:*/loan`, `decision:lending/2026-09-12-2`.
  - `builds nodes from the spec card and a glossary`: the 11.1 card for `lending` plus a glossary `- **Member**: a registered patron` gives rules `rule:LEND-03`, `rule:LEND-04` (`untested` kept), terms `term:lending/hold`, `term:lending/loan`, `term:*/member`, decision `decision:lending/2026-09-12-1` (line 21), sections `section:docs/domain/lending/domain.md:17` (`contracts`) and `:23` (`open-questions`), one open question (line 24), and `cardRefs[0]` `{ ruleId: 'LEND-03', tests: ['src/Lending.Tests/LoanLimitTests.cs'], testsLine: 9, code: ['src/Lending/LoanPolicy.cs', 'src/Lending/LoanPolicy.cs::LoanPolicy.CanBorrow::method'], codeLine: 10 }`.
  - `decisions on the same date are numbered in document order`.
  - `a glossary item for a context merges into that context's card term` (two definitions, origins `card` then `glossary`).
  - `a glossary item without a context is repo-wide, and an unknown context warns and is repo-wide`.
  - `a duplicate rule ID keeps the first card and warns`.
  - `a context without a card, or whose card file is missing, has no rules`.
  - `cardsHash ignores CRLF and a BOM and changes with any card text`.
  - `sortGraph gives identical JSON for shuffled input`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/domain-graph.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** (new file; `node:crypto` for the hash, the domain's codepoint comparator for sorting).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/domain-graph.ts packages/domain/src/core/__tests__/domain-graph.test.ts
  git commit -S -m "feat(domain): domain graph model with context, rule, term, decision and section nodes (#156)"
  ```

---

### Task 6: Rule-to-test links

**Files:**
- Create: `packages/domain/src/core/rule-test-links.ts`
- Modify: `packages/domain/src/core/rule-id-scan.ts` (`RuleRef.annotation`, `annotationRefs`, the `rule-comment` attribution in `scanTestText`, new `leadingSymbol` and `buildScanOptions`), `packages/domain/src/commands/verify-domain-command.ts` (use `buildScanOptions`)
- Test: `packages/domain/src/core/__tests__/rule-test-links.test.ts`, `packages/domain/src/core/__tests__/rule-id-scan.test.ts`

**Interfaces:**
- Consumes: `RuleRef`, `RuleLinks`, `ScanOptions`, `RuleIndex`, `scanTestText`, `annotationRefs`, `resolveRuleRefs` (PR 2B); `CardRuleRefs`, `DomainLink`, `UnresolvedRef`, `CodeTarget`, `Location`, `ruleNodeId` (Task 5).
- Produces:
  ```ts
  // rule-id-scan.ts
  // RuleRef gains `readonly annotation?: string`: the annotation name of 'annotation' and 'category' refs (Trait, Category, TestCategory, Tag)
  export function buildScanOptions(config: DomainConfig, ruleIds: Iterable<string>, registry: DomainRegistry): ScanOptions;
  export function leadingSymbol(index: FileIndex | undefined, line: number): string | undefined;   // 0-based line
  // rule-test-links.ts
  export interface RefLookup { hasSymbol(symbolId: string): boolean; symbolName(symbolId: string): string | undefined; fileExists(repoPath: string): boolean }
  export interface CardRefResolution { readonly target?: CodeTarget; readonly problem?: 'missing-file' | 'not-a-symbol' }
  export function resolveCardRef(value: string, lookup: RefLookup): CardRefResolution;
  export function toLocation(file: string, zeroBasedLine: number): Location;
  export function ruleTestLinks(input: { readonly cardRefs: readonly CardRuleRefs[]; readonly testRefs: RuleLinks; readonly lookup: RefLookup }):
    { readonly links: DomainLink[]; readonly unresolved: UnresolvedRef[] };
  ```
- Rules:
  - `buildScanOptions`: `rules.ids` = the rule IDs; `rules.prefixes` = their prefixes plus every registry `rulePrefix`; `idPattern`, `trackerPrefixes` and `ruleTraitKeys` from `domain.rules` and `domain.tests`. `verify-domain-command.ts` replaces its inline construction (same values).
  - `leadingSymbol(index, line)` (F4): among symbols with `line < startLine <= line + 3`, the smallest `startLine`, then the smallest span, then index order; else the innermost symbol spanning the line (PR 2B's rule); else undefined. `scanTestText` uses it for `rule-comment` refs only.
  - `resolveCardRef(value)` (F3): backslashes become `/`, a leading `./` is dropped. A value with `::` is a symbol ID: indexed gives `{ target: { file, symbolId } }`; otherwise, when its file part exists, `{ target: { file }, problem: 'not-a-symbol' }`; else `{ problem: 'missing-file' }`. A path that exists gives `{ target: { file: value } }`, else `{ problem: 'missing-file' }`.
  - Every ref of `testRefs.links` becomes `{ kind: 'rule-test', from: ruleNodeId(id), to: { file: ref.file, symbolId: ref.symbolId }, source: ref.kind, at: toLocation(ref.file, ref.line), annotation: ref.annotation, testName }`; `testName` is `ref.testTitle`, else `lookup.symbolName(ref.symbolId)`, else absent (F5). `toLocation` adds 1.
  - Each `Tests:` value: `source: 'card-tests'`, `at` = card and `testsLine`, `fallback: true` for `not-a-symbol`; every problem becomes an `UnresolvedRef` with field `Tests`.
  - Equal `(from, to, source, at)` links are kept once.

- [ ] **Step 1: Write the failing tests.**
  - `rule-id-scan.test.ts`:
    - `annotation and category refs carry the annotation name` (`it.each`): `{ name: 'Trait', args: ['Rule', 'LEND-03'] }` gives kind `annotation`, annotation `Trait`; `{ name: 'Category', args: ['LEND-03'] }`, `TestCategory` and `Tag` give kind `category` with their names.
    - `leadingSymbol prefers a symbol starting within three lines after the comment, else the innermost spanning symbol` (Review Focus 4): class 0 to 20, method 5 to 9; line 3 gives the method, line 1 the class (the method starts four lines later), line 12 the class, line 30 undefined.
    - `a rule: comment above a test method links to the method` (`scanTestText`, `// rule: LEND-03` on the line before `[Fact]`).
    - `buildScanOptions collects card prefixes and registry rule prefixes`.
    - PR 2B's scan tests keep passing; if one expects the enclosing class for a comment directly above a declaration, update that expectation (the intended change) and say so in the commit body.
  - `rule-test-links.test.ts`:
    - `annotation, category, title, rule-comment and mention refs become rule-test links with their sources`.
    - `a Trait link names the test by its symbol and a title link by its title`: `LoanLimitTests.MemberHoldsAtMostFiveLoans` and `LEND-03 rejects the sixth loan`.
    - `a card Tests: path links the rule to the file with source card-tests`: `src/Lending.Tests/LoanLimitTests.cs`, `at` `{ file: 'docs/domain/lending/domain.md', line: 9 }`.
    - `a Tests: symbol ID missing from the index links to its file and is recorded as not-a-symbol` (Review Focus 1): `tests/Lending.Tests/LoanLimitTests.cs::LoanLimitTests.Gone::method` gives `to: { file: 'tests/Lending.Tests/LoanLimitTests.cs' }`, `fallback: true` and one `UnresolvedRef`.
    - `a Tests: path that does not exist links nothing and is recorded as missing-file`.
    - `with LEND as a tracker prefix, a LEND-03 mention does not link but a Trait does` (K19).
    - `links carry 1-based lines` (a ref at line 0 gives `at.line === 1`); `the same evidence links once`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/rule-test-links.test.ts src/core/__tests__/rule-id-scan.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `scanTestText`, `annotationRefs` and `verifyDomainCommand`.
- [ ] **Step 4: Run the tests.** The Step 2 command, then `pnpm --filter @ctxo/domain test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/rule-test-links.ts packages/domain/src/core/rule-id-scan.ts packages/domain/src/commands/verify-domain-command.ts packages/domain/src/core/__tests__/rule-test-links.test.ts packages/domain/src/core/__tests__/rule-id-scan.test.ts
  git commit -S -m "feat(domain): rule-to-test links from annotations, the text scan and card Tests: lines (#156)"
  ```

---

### Task 7: Rule-to-symbol links, and `verify-domain` checks for card references

**Files:**
- Create: `packages/domain/src/core/rule-symbol-links.ts`
- Modify: `packages/domain/src/core/rule-id-scan.ts` (`scanRuleComments`), `packages/domain/src/adapters/repo-files.ts` (`readRepoTexts`), `packages/domain/src/core/verify-checks.ts` (`VerifyInput`, check 6), `packages/domain/src/commands/verify-domain-command.ts` (the new inputs)
- Test: `packages/domain/src/core/__tests__/rule-symbol-links.test.ts`, `rule-id-scan.test.ts`, `verify-checks.test.ts` (same folder), `packages/domain/src/adapters/__tests__/repo-files.test.ts`, `packages/domain/src/commands/__tests__/verify-domain-command.test.ts`

**Interfaces:**
- Consumes: `resolveCardRef`, `RefLookup`, `leadingSymbol`, `buildScanOptions`, `ruleTestLinks` (Task 6); `buildGraphNodes`, `CardRuleRefs`, `UnresolvedRef` (Task 5); `runVerifyChecks`, `VerifyInput`, `resolveRuleRefs` (PR 2B).
- Produces:
  ```ts
  // rule-id-scan.ts
  export function scanRuleComments(file: string, text: string, index: FileIndex | undefined, options: ScanOptions): RuleRef[];   // 'rule-comment' refs only
  // rule-symbol-links.ts
  export function ruleSymbolLinks(input: { readonly cardRefs: readonly CardRuleRefs[]; readonly codeRefs: RuleLinks; readonly lookup: RefLookup }):
    { readonly links: DomainLink[]; readonly unresolved: UnresolvedRef[] };
  // repo-files.ts
  export const SOURCE_SCAN_MAX_BYTES = 1_048_576;
  export function readRepoTexts(projectRoot: string, files: readonly string[], maxBytes?: number): { readonly file: string; readonly text: string }[];
  // verify-checks.ts: VerifyInput gains
  readonly cardRefProblems: readonly UnresolvedRef[];   // unresolved of ruleTestLinks and ruleSymbolLinks
  readonly codeRuleRefs: readonly RuleRef[];            // resolveRuleRefs(...).unknown of scanRuleComments over indexed non-test files
  ```
- Rules (F3, F4):
  - `scanRuleComments` uses PR 2B's `rule-comment` regex and `leadingSymbol`; nothing else in a production file is a reference.
  - `Code:` values go through `resolveCardRef`: `source: 'card-code'`, `at` = card and `codeLine`, `fallback: true` for `not-a-symbol`; problems are recorded with field `Code`.
  - Resolved `rule:` comments of indexed non-test files become `{ kind: 'rule-symbol', source: 'rule-comment', to: { file, symbolId? }, at }`; a `rule:` comment in a test file stays a rule-test link (Task 6).
  - `readRepoTexts`: UTF-8, BOM stripped; skips missing files, files over `maxBytes` (default `SOURCE_SCAN_MAX_BYTES`) and files with a NUL byte in their first 8 KiB; codepoint order.
  - Check 6 (this replaces PR 2B's whole-value existence test for `Tests:`; E7 holds for the file part):
    - `missing-file` (`Tests` or `Code`): error `<field>: "<value>" names no file in the repository` at the card line;
    - `not-a-symbol`: warning `<field>: "<value>" is not an indexed symbol; it links to its file`;
    - a `codeRuleRefs` entry whose prefix is in `rules.prefixes`: warning `rule: comment names unknown rule <id>` at the comment; other prefixes are ignored (`# rule: E501`).
  - `verify-domain` computes both inputs from the index and the repo with the same functions the index pass uses (E5: never from artifacts): `buildGraphNodes` for the card refs, `readRepoTexts` over indexed non-test files.

- [ ] **Step 1: Write the failing tests.**
  - `rule-symbol-links.test.ts`:
    - `a Code: path links the rule to the file and a Code: symbol ID to the symbol` (the spec example values).
    - `a Code: symbol ID missing from the index falls back to its file` (Review Focus 1): the index holds `src/Lending/LoanPolicy.cs::LibraryLending.Lending.LoanPolicy.CanBorrow(1)::method`, the card names `...LoanPolicy.CanBorrow::method`; the link targets the file with `fallback: true`.
    - `a rule: comment above a method links to the method` (Review Focus 4).
    - `an unknown ID in a production rule: comment links nothing`.
  - `rule-id-scan.test.ts`: `scanRuleComments finds rule: comments in //, #, --, block and * lines and ignores plain mentions`.
  - `repo-files.test.ts`: `readRepoTexts skips missing, oversized and binary files and strips a BOM`.
  - `verify-checks.test.ts`: `check 6 fails for a Code: or Tests: file that does not exist`; `check 6 warns for an unindexed symbol ID and accepts an indexed one` (Review Focus 1); `check 6 warns for a production rule: comment with a rule prefix and ignores other prefixes`.
  - `verify-domain-command.test.ts`: `verify-domain reports card reference problems from the current index` (temp repo; a `Code:` symbol ID the index no longer holds gives one warning and exit 0).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core src/adapters/__tests__/repo-files.test.ts src/commands/__tests__/verify-domain-command.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `runVerifyChecks`, `verifyDomainCommand` and `readRepoText`.
- [ ] **Step 4: Run the tests.** The Step 2 command, then `pnpm --filter @ctxo/domain test`. Expected: PASS, PR 2B's acceptance tests included.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/rule-symbol-links.ts packages/domain/src/core/rule-id-scan.ts packages/domain/src/adapters/repo-files.ts packages/domain/src/core/verify-checks.ts packages/domain/src/commands/verify-domain-command.ts packages/domain/src/core/__tests__/rule-symbol-links.test.ts packages/domain/src/core/__tests__/rule-id-scan.test.ts packages/domain/src/core/__tests__/verify-checks.test.ts packages/domain/src/adapters/__tests__/repo-files.test.ts packages/domain/src/commands/__tests__/verify-domain-command.test.ts
  git commit -S -m "feat(domain): rule-to-symbol links from Code: lines and rule: comments; verify-domain checks card references (#156)"
  ```

---

### Task 8: Decision and term links

**Files:**
- Create: `packages/domain/src/core/decision-links.ts`, `packages/domain/src/core/term-links.ts`
- Test: `packages/domain/src/core/__tests__/decision-links.test.ts`, `packages/domain/src/core/__tests__/term-links.test.ts`

**Interfaces:**
- Consumes: `CardDecision` (Task 4); `DecisionNode`, `TermNode`, `DomainLink`, `ProvenanceTarget`, `REPO_WIDE_CONTEXT`, `ruleNodeId` (Task 5); `SymbolNode` (type).
- Produces:
  ```ts
  // decision-links.ts
  export type ResolvedTarget = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'external'; readonly value: string } | { readonly kind: 'anchor' };
  export function resolveProvenanceTarget(cardPath: string, target: string): ResolvedTarget;
  export function decisionLinks(input: { readonly decisions: readonly DecisionNode[]; readonly parsed: ReadonlyMap<string, CardDecision>;
    readonly ruleIds: ReadonlySet<string>; readonly trackerPrefixes: ReadonlySet<string>; readonly fileExists: (repoPath: string) => boolean }): DomainLink[];
  // term-links.ts
  export const TERM_IDENTIFIER_CAP = 50;
  export const TERM_KIND_ORDER: readonly string[];          // class, interface, type, table, view, procedure, function, method, variable
  export const DATA_RESOURCE_KIND_NAMES: readonly string[]; // ['table', 'view'], plugin-api's DATA_RESOURCE_KINDS (copied: types-only rule)
  export type SplitIdentifier = (name: string) => string[];
  export function termTokens(term: string, split: SplitIdentifier): string[];
  export function identifierTokens(name: string, split: SplitIdentifier): string[];
  export function tokensMatch(identifier: readonly string[], term: readonly string[]): 'exact' | 'partial' | undefined;
  export interface TermCandidate { readonly symbol: SymbolNode; readonly file: string; readonly context?: string }
  export function termIdentifierLinks(terms: readonly TermNode[], candidates: readonly TermCandidate[], split: SplitIdentifier):
    { readonly links: DomainLink[]; readonly counts: ReadonlyMap<string, number> };
  ```
- Rules (F6, F7):
  - `resolveProvenanceTarget`: a scheme (`^[A-Za-z][A-Za-z0-9+.-]*:`) or a leading `//` is external, kept as written; `#...` alone is an anchor; otherwise drop `#...` and `?...`, URL-decode (the raw text when decoding fails), resolve a leading `/` from the repository root and anything else against the card's folder with posix normalisation. A result that leaves the repository (starts with `..`) is external, kept as written, and never reaches the disk.
  - `decisionLinks`, per decision in text order, `at` = card and decision line:
    - each inline link: `file` (with `exists` from `fileExists`) or `external`, `source: 'card-link'`, `label`; anchors are skipped;
    - each `externalRefs` value: `external`, `source: 'card-text'`;
    - tracker keys `\b[A-Z][A-Z0-9]{1,9}-\d+\b` whose prefix is in `trackerPrefixes` and that are not rule IDs: `external`, `source: 'card-text'`;
    - rule IDs written exactly (`(?<![A-Za-z0-9])[A-Z][A-Z0-9]*-\d+(?![A-Za-z0-9])`) that are in `ruleIds`: a `decision-rule` link, whatever the tracker prefixes.
  - `termTokens`: the term split on whitespace, each word through `split`, lowercased, characters other than letters and digits removed, empties dropped. `identifierTokens`: the same over the last `.` segment of `name` with a trailing `(...)` removed.
  - `tokensMatch`: the term tokens appear as a contiguous run of identifier tokens, where an identifier token matches a term token when equal, or equal to it plus `s` or `es`, or to it with a final `y` replaced by `ies`; `exact` when the run covers the whole identifier.
  - `termIdentifierLinks`: candidates are the non-test symbols with their owning context; a term of context `c` matches candidates whose `context` is `c`, a repo-wide term matches all; a term whose tokens are all shorter than 3 characters links nothing. `source` is `table-name` for kinds in `DATA_RESOURCE_KIND_NAMES`, else `symbol-name`. Per term: exact before partial, then `TERM_KIND_ORDER`, then `symbolId`; the first `TERM_IDENTIFIER_CAP` are linked; `counts` holds every match.

- [ ] **Step 1: Write the failing tests.**
  - `decision-links.test.ts`:
    - `relative links resolve against the card's folder`: `../../specs/loan-limit.md` from `docs/domain/lending/domain.md` gives `docs/specs/loan-limit.md` with `exists: true`.
    - `a leading slash starts at the repository root; anchors and queries are dropped and %20 is decoded`.
    - `a link that leaves the repository is kept as an external string and never checked on disk` (a `fileExists` spy never receives it).
    - `URLs, mailto: and protocol-relative links are external, and anchors alone are not provenance`.
    - `the spec decision gives two file links and the external #123 in text order`.
    - `a missing file is kept with exists: false`.
    - `decisions link to rule IDs written exactly`: `LEND-03, LEND-3, Lend03 and LEND-99` with rule ids `{ LEND-03 }` give one `decision-rule` link.
    - `with LEND as a tracker prefix, LEND-03 still links and LEND-456 becomes external provenance` (F6).
    - `external provenance is never fetched`: a `globalThis.fetch` spy is never called.
  - `term-links.test.ts` (`split` = a copy of the core `splitName` rules or the host service from `createModuleHost`):
    - Review Focus 5, `it.each`: `Loan` matches `LoanPolicy` (partial), `ILoanRepository`, `LoansController` and the table `dbo.loans` (exact, `table-name`), not `Loaner`; `Member account` matches `MemberAccount` (exact) and `member_account_id`; `Category` matches `Categories`; `Borrow` matches `LibraryLending.Lending.LoanPolicy.CanBorrow(1)`; `Lending` does not match `LibraryLending.Lending.LoanPolicy`; `ID` links nothing.
    - `a context term matches only its context's symbols; a repo-wide term matches all; test symbols never match`.
    - `links are capped at 50 per term with exact matches and types first, and the count is kept` (60 candidates give 50 links and `counts` 60).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/decision-links.test.ts src/core/__tests__/term-links.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (new files; `node:path` `posix` for normalisation).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/decision-links.ts packages/domain/src/core/term-links.ts packages/domain/src/core/__tests__/decision-links.test.ts packages/domain/src/core/__tests__/term-links.test.ts
  git commit -S -m "feat(domain): decision-to-provenance, decision-to-rule and term-to-identifier links (#156)"
  ```

---

### Task 9: Graph composition and `graph.json` in the domain index pass

**Files:**
- Modify: `packages/domain/src/core/domain-graph.ts` (`DomainGraphInput`, `buildDomainGraph`), `packages/domain/src/index-pass/domain-index-pass.ts`, `packages/domain/src/adapters/artifact-store.ts` (`writeIfChanged`, `readGraph`, `removeAll`)
- Modify only if the cli test below fails: `packages/cli/src/cli/index-command.ts` (`IndexCommand.run`)
- Test: `packages/domain/src/core/__tests__/domain-graph.test.ts`, `packages/domain/src/index-pass/__tests__/domain-index-pass.test.ts`, `packages/domain/src/adapters/__tests__/artifact-store.test.ts`, `packages/cli/src/cli/__tests__/index-command.test.ts`

**Interfaces:**
- Consumes: Tasks 4 to 8; `IndexPassContext`, `host.services.splitIdentifier` (Task 1), `listTrackedFiles`, `readTestFiles`, `repoFileExists`, `readRepoText` (PR 2B).
- Produces:
  ```ts
  // domain-graph.ts
  export interface DomainGraphInput {
    readonly registry: DomainRegistry; readonly registryHash: string; readonly config: DomainConfig;
    readonly cards: readonly CardInput[]; readonly glossary?: { readonly path: string; readonly items: readonly GlossaryItem[] }; readonly cardsHash: string;
    readonly indices: readonly FileIndex[]; readonly isTestFile: TestFileCheck; readonly ownership: Ownership;
    readonly testRefs: RuleLinks; readonly codeRefs: RuleLinks;
    readonly fileExists: (repoPath: string) => boolean; readonly split: SplitIdentifier; readonly warn?: (message: string) => void;
  }
  export function buildDomainGraph(input: DomainGraphInput): DomainGraph;   // nodes, the four link families, unresolved; sortGraph applied
  // artifact-store.ts
  writeIfChanged(name: 'contexts.json' | 'boundaries.json' | 'graph.json', artifact: ContextsArtifact | BoundariesArtifact | DomainGraph): boolean;
  readGraph(): DomainGraph | undefined;   // undefined unless ctxoArtifact 'domain-graph', version 1 and every array present
  // removeAll() also removes graph.json
  ```
- Rules:
  - `buildDomainGraph`: `RefLookup` from `indices` (`hasSymbol`, `symbolName`) and `fileExists`; term candidates are the symbols of non-test files with `ownership.ownerOf(file)`; each term's `identifierCount` comes from `termIdentifierLinks(...).counts`.
  - Pass additions, for a valid registry only (PR 2B's steps and artifacts unchanged):
    1. Read each context's card with `readRepoText` and the glossary at `registry.glossary`; parse them; compute `cardsHash` over the card and glossary paths.
    2. `buildScanOptions` from the parsed rule IDs.
    3. Test refs: `readTestFiles(projectRoot, tracked, ctx.isTestFile, ctx.indices)` (tracked from `listTrackedFiles`, else the indexed paths), `scanTestText` plus `annotationRefs` per indexed test file, then `resolveRuleRefs`.
    4. Code refs: `readRepoTexts` over the indexed non-test files, `scanRuleComments`, `resolveRuleRefs`.
    5. `buildDomainGraph` with `fileExists` from `repoFileExists` and `split` from `host.services.splitIdentifier`; `store.writeIfChanged('graph.json', graph)`.
    6. The log line becomes `Domain: <n> contexts, <r> rules (<u> without tests), <l> links, <m> cross-context edges, <v> boundary violations (<ms> ms)`.

- [ ] **Step 1: Write the failing tests.**
  - `domain-graph.test.ts`: `buildDomainGraph is identical for shuffled indices and refs` (spec 13.1); `buildDomainGraph sets each term's identifierCount`.
  - `domain-index-pass.test.ts` (temp project with a registry, the 11.1 card, a glossary, `docs/specs/loan-limit.md`, hand-written FileIndex JSON for `src/Lending/LoanPolicy.cs` and `tests/Lending.Tests/LoanLimitTests.cs` whose test method carries `{ name: 'Trait', args: ['Rule', 'LEND-03'] }`, a host from `createModuleHost`):
    - `writes graph.json with nodes and links, byte-identical on a second run`: `rule:LEND-03` has a `rule-test` link with source `annotation` and annotation `Trait`, a `card-tests` link, a `rule-symbol` link from `card-code`; the decision has a `decision-provenance` file link to `docs/specs/loan-limit.md` with `exists: true` and an external `#123`.
    - `the JSON index reader skips graph.json` (`host.services.readIndex` returns as many indices as before).
    - `removes graph.json when the registry is gone`; `writes nothing when the registry has problems`.
    - `a missing card gives a context without rules`.
    - `never fetches external provenance` (a `globalThis.fetch` spy is never called).
    - `logs rules, links and the time` (the log line contains `rules (`).
  - `artifact-store.test.ts`: `readGraph reads what writeIfChanged wrote and rejects other shapes`; `writeIfChanged leaves an equal graph.json untouched`.
  - `index-command.test.ts`: `a commit that changed no indexable file still runs module index passes` (Review Focus 3): a temp repo with one indexed file, a stub module counting `indexPass` calls, a second commit changing only `docs/domain/lending/domain.md`, then `run({ commit: 'HEAD' })` gives one call.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain test:unit` and `pnpm --filter @ctxo/cli exec vitest run src/cli/__tests__/index-command.test.ts`. Expected: the domain tests FAIL. The cli test passes when PR 0's incremental path already reaches Phase 2e; if it fails, Step 3 includes the cli fix.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `domainIndexPass`, `DomainArtifactStore` and, for the cli fix only, `IndexCommand.run`. The cli fix, if needed: on the incremental path whose changed list holds no indexable file, still run Phase 2e on the committed index.
- [ ] **Step 4: Run the tests.** The Step 2 commands. Expected: PASS. Then `pnpm --filter @ctxo/cli build && pnpm --filter @ctxo/domain test`. Expected: PASS.
- [ ] **Step 5: Commit.** Add `packages/cli/src/cli/index-command.ts` only if it changed.
  ```bash
  git add packages/domain/src/core/domain-graph.ts packages/domain/src/index-pass/domain-index-pass.ts packages/domain/src/adapters/artifact-store.ts packages/domain/src/core/__tests__/domain-graph.test.ts packages/domain/src/index-pass/__tests__/domain-index-pass.test.ts packages/domain/src/adapters/__tests__/artifact-store.test.ts packages/cli/src/cli/__tests__/index-command.test.ts
  git commit -S -m "feat(domain): build the domain graph in the index pass and write graph.json (#156)"
  ```

---

### Task 10: Domain state and graph queries

**Files:**
- Create: `packages/domain/src/core/domain-graph-query.ts`, `packages/domain/src/core/token-estimate.ts`, `packages/domain/src/mcp/domain-state.ts`
- Test: `packages/domain/src/core/__tests__/domain-graph-query.test.ts`, `packages/domain/src/mcp/__tests__/domain-state.test.ts`

**Interfaces:**
- Consumes: `DomainGraph` and its node and link types (Task 5); `DomainArtifactStore.readGraph` (Task 9); `readRegistry`, `registryHash`, `resolveDomainConfig`, `createOwnership`, `CtxoHost` (PR 2B).
- Produces:
  ```ts
  // token-estimate.ts
  export function estimateTokens(value: unknown): number;   // Math.ceil(JSON.stringify(value).length / 4)
  // domain-graph-query.ts
  export type CodeLink = Extract<DomainLink, { readonly kind: 'rule-test' | 'rule-symbol' }>;
  export type ProvenanceLink = Extract<DomainLink, { readonly kind: 'decision-provenance' }>;
  export interface GraphIndex {
    readonly rules: ReadonlyMap<string, RuleNode>;                                // by ruleId
    readonly contexts: ReadonlyMap<string, ContextNode>;                          // by registry id
    readonly rulesByContext: ReadonlyMap<string, readonly RuleNode[]>;            // card line order
    readonly codeLinksByRule: ReadonlyMap<string, readonly CodeLink[]>;
    readonly codeLinksBySymbol: ReadonlyMap<string, readonly CodeLink[]>;
    readonly fileLinksByFile: ReadonlyMap<string, readonly CodeLink[]>;           // links without symbolId
    readonly decisionsByContext: ReadonlyMap<string, readonly DecisionNode[]>;    // date desc, then n asc
    readonly decisionRules: ReadonlyMap<string, readonly string[]>;               // decision id -> rule ids
    readonly decisionProvenance: ReadonlyMap<string, readonly ProvenanceLink[]>;  // text order
    readonly termsByContext: ReadonlyMap<string, readonly TermNode[]>;            // card terms by line, then glossary terms by line
    readonly termIdentifiers: ReadonlyMap<string, readonly string[]>;
    readonly sectionsByContext: ReadonlyMap<string, readonly SectionNode[]>;
    readonly openQuestionsByContext: ReadonlyMap<string, readonly OpenQuestion[]>;
    readonly unresolvedByRule: ReadonlyMap<string, readonly UnresolvedRef[]>;
  }
  export interface DomainSnapshot { readonly registry: DomainRegistry; readonly registryPath: string; readonly config: DomainConfig; readonly ownership: Ownership;
    readonly graph: DomainGraph; readonly index: GraphIndex; readonly staleCards: boolean; readonly generation: number }
  export function indexGraph(graph: DomainGraph): GraphIndex;
  export interface RuleMatch { readonly ruleId: string; readonly via: readonly { readonly symbolId: string; readonly link: 'code' | 'test' }[] }
  export function rulesForSymbols(index: GraphIndex, symbolIds: readonly string[]): RuleMatch[];
  export function canonicalRuleId(index: GraphIndex, raw: string): string | undefined;
  export function decisionsForContext(index: GraphIndex, context: string, preferRules: ReadonlySet<string>, limit?: number): DecisionNode[];
  export function rulesWithoutTests(index: GraphIndex, contexts: readonly string[]): RuleNode[];
  export interface LinkSourceView { readonly source: string; readonly annotation?: string; readonly file: string; readonly line: number }
  export interface TestRefView { readonly file: string; readonly symbolId?: string; readonly testName?: string; readonly sources: readonly LinkSourceView[] }
  export interface CodeRefView { readonly file: string; readonly symbolId?: string; readonly fallback?: true; readonly sources: readonly LinkSourceView[] }
  export type ProvenanceView = { readonly kind: 'file'; readonly path: string; readonly exists: boolean; readonly label?: string }
    | { readonly kind: 'external'; readonly value: string; readonly label?: string };
  export interface DecisionView { readonly id: string; readonly date: string; readonly text: string; readonly card: string; readonly line: number;
    readonly rules: readonly string[]; readonly provenance: readonly ProvenanceView[] }
  export function testRefs(index: GraphIndex, ruleId: string): TestRefView[];
  export function codeRefs(index: GraphIndex, ruleId: string): CodeRefView[];
  export function decisionView(index: GraphIndex, decision: DecisionNode): DecisionView;
  // mcp/domain-state.ts
  export type DomainStateReason = 'no-registry' | 'invalid-registry' | 'no-graph' | 'stale-registry';
  export type DomainStateResult = { readonly ok: true; readonly snapshot: DomainSnapshot } | { readonly ok: false; readonly reason: DomainStateReason; readonly hint: string };
  export interface DomainState { load(): DomainStateResult }
  export function createDomainState(host: CtxoHost): DomainState;
  export const STALE_CARDS_HINT = 'Cards or the glossary changed since the last "ctxo index"; run it to refresh rule links.';
  ```
- Rules:
  - `rulesForSymbols`: a code link matches a symbol when `to.symbolId` equals it, or when it has no `symbolId` and `to.file` is the symbol's file. `via` lists each matched symbol once per link kind (`rule-symbol` as `code`, `rule-test` as `test`) in input order; matches in `ruleId` order.
  - `canonicalRuleId`: trimmed input matching `^([A-Za-z][A-Za-z0-9]*?)[-_]?(\d+)$` becomes `<prefix in upper case>-<digits>`, returned only when it is a rule.
  - `decisionsForContext` (F9): decisions with a `decision-rule` link to a rule in `preferRules` first, then the others, each group date desc then `n` asc; `limit` defaults to 5.
  - `rulesWithoutTests`: rules of the given contexts with no `rule-test` link, in context then card order.
  - Views: tests grouped by target (`symbolId ?? file`), targets in codepoint order, sources ordered `annotation`, `category`, `test-title`, `rule-comment`, `card-tests`, `mention`, then file and line; `testName` from the first source that has one. Code refs the same way (`card-code` before `rule-comment`), `fallback` when every source fell back. Provenance in text order.
  - `load()`: config through `host.services.loadConfig` and `resolveDomainConfig`; `readRegistry` (missing: `no-registry` with PR 2B's hint text without the `[ctxo] ` prefix; problems: `invalid-registry`, hint `The domain registry at <path> has problems; run "ctxo verify-domain".`); `readGraph` (missing: `no-graph`, hint `No domain graph yet; run "ctxo index".`); `graph.registryHash` differs from `registryHash(text)`: `stale-registry`, hint `The domain registry changed since the last "ctxo index"; run it to rebuild the domain graph.` `staleCards` compares `graph.cardsHash` with the current cards and glossary. Results are cached by `mtimeMs` and size of the config, the registry, `graph.json`, each card and the glossary; `generation` increases on every reload.

- [ ] **Step 1: Write the failing tests.**
  - `domain-graph-query.test.ts` (graphs from `buildDomainGraph`):
    - `rulesForSymbols matches symbol links and file-level links of the symbol's file`; `a symbol link does not match other symbols of the same file`.
    - `canonicalRuleId accepts LEND-03, lend03 and Lend_03 and rejects LEND-030 and LEND-99`.
    - `decisionsForContext puts decisions about preferred rules first, then newest, and limits to five` (seven decisions).
    - `rulesWithoutTests lists rules without a rule-test link with their untested reason`.
    - `testRefs groups the Trait and card Tests: links of one test file`; `decisionView lists provenance in text order`.
  - `domain-state.test.ts` (temp projects, `createModuleHost`):
    - `reports no-registry, invalid-registry, no-graph and stale-registry with their hints` (Review Focus 2).
    - `marks stale cards after a card edit and clears after re-indexing` (Review Focus 2).
    - `reloads only after a file changes` (`generation` stays, then increases after a touch of `graph.json`).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/domain-graph-query.test.ts src/mcp/__tests__/domain-state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (new files).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/domain-graph-query.ts packages/domain/src/core/token-estimate.ts packages/domain/src/mcp/domain-state.ts packages/domain/src/core/__tests__/domain-graph-query.test.ts packages/domain/src/mcp/__tests__/domain-state.test.ts
  git commit -S -m "feat(domain): domain state with registry and card staleness, and graph queries (#156)"
  ```

---

### Task 11: Fields on `get_blast_radius`, `get_why_context` and `get_context_for_task`

**Files:**
- Create: `packages/domain/src/core/card-excerpt.ts`, `packages/domain/src/mcp/graph-enrichers.ts`
- Modify: `packages/domain/src/mcp/enrichers.ts` (`createEnrichers(host, state)`), `packages/domain/src/index.ts` (one `createDomainState(host)` per registration; `reserveTaskContextTokens`)
- Test: `packages/domain/src/core/__tests__/card-excerpt.test.ts`, `packages/domain/src/mcp/__tests__/graph-enrichers.test.ts`, `packages/domain/src/mcp/__tests__/enrichers.test.ts`

**Interfaces:**
- Consumes: `DomainState`, `DomainSnapshot`, `rulesForSymbols`, `decisionsForContext`, `decisionView`, `estimateTokens` (Task 10); `ResponseEnricher`, `TokenReservation` (Task 2).
- Produces:
  ```ts
  // card-excerpt.ts
  export const EXCERPT_RULE_TEXT_MAX = 600; export const EXCERPT_DEFINITION_MAX = 200; export const EXCERPT_CONTRACTS_TEXT_MAX = 400;
  export interface CardExcerpt {
    readonly context?: string; readonly card?: string;
    readonly rules: readonly { readonly ruleId: string; readonly title: string; readonly linkedTo: 'target' | 'neighbour'; readonly text?: string }[];
    readonly terms: readonly { readonly term: string; readonly definition: string }[];
    readonly contracts?: { readonly outbound: readonly { readonly target: string; readonly files: readonly string[] }[]; readonly text?: string };
    readonly tokens: number; readonly omitted: number;
  }
  export function buildCardExcerpt(snapshot: DomainSnapshot, target: string, neighbours: readonly string[], budget: number): CardExcerpt;
  export function targetExcerptTokens(snapshot: DomainSnapshot, target: string): number;
  // graph-enrichers.ts
  export function blastRadiusDomainFields(state: DomainState): ResponseEnricher;
  export function whyContextDomainFields(state: DomainState): ResponseEnricher;
  export function taskContextDomainFields(state: DomainState): ResponseEnricher;
  export function taskContextReservation(state: DomainState): TokenReservation;
  ```
- Rules (F8 to F10):
  - Each enricher returns the payload unchanged unless `state.load()` is ok (E3); then its fields appear, possibly empty.
  - `get_blast_radius`: the symbols are `payload.symbolId` and `payload.impactedSymbols[].symbolId`. `rulesAffected` entries `{ ruleId, title, context, card, via (first 5), viaCount }`, rules whose `via` holds the root first, then `ruleId` order. `cardsToUpdate` entries `{ context, card }`, unique, in card order. Both lists are additive arrays on an existing tool, so they are capped at 50 at the source, with `rulesAffectedTotal` and `cardsToUpdateTotal` holding the full counts only when entries were cut; they are not truncatable fields (Task 3).
  - `get_why_context`: the context is the single owner of the file part of `args.symbolId`; `decisions` = `decisionsForContext(index, context, <rule IDs of rulesForSymbols(index, [symbolId])>)` through `decisionView`, cut to five (F9) with `decisionsTotal` holding the full count only when more than five exist; `[]` without a single owner.
  - `get_context_for_task`: `cardExcerpt = buildCardExcerpt(snapshot, args.symbolId, payload.context[].symbolId, payload.tokenBudget - payload.totalTokens)`.
  - `buildCardExcerpt` packs greedily in this order, skipping what does not fit and counting it in `omitted`: rules linked to the target (with `text` capped at `EXCERPT_RULE_TEXT_MAX`), rules linked only to neighbours (no text), the target context's terms (those with an identifier among the target and neighbours first, then card order; definitions joined with ` / ` and capped at `EXCERPT_DEFINITION_MAX`), then the context's outbound registry contracts with the `Boundary contracts` text capped at `EXCERPT_CONTRACTS_TEXT_MAX`. Each entry costs `estimateTokens(entry)` and the empty wrapper costs `estimateTokens` of itself; `tokens` is the total and never exceeds `budget`. Cut texts end with `...`. `context` and `card` are absent when the target has no single owner (rules still come through links).
  - `targetExcerptTokens` is the `tokens` of the excerpt for the target alone with an unlimited budget; `taskContextReservation` returns it for `args.symbolId` (0 when not ok), and the core caps it at 25% (Task 2).
  - `createEnrichers(host, state)` composes PR 2B's per-tool enrichers with these; `register` passes one state to the enrichers, the tools (Task 13) and the scope (Task 14), and sets `reserveTaskContextTokens: taskContextReservation(state)`.

- [ ] **Step 1: Write the failing tests** (graphs from `buildDomainGraph` written to a temp `.ctxo/index/domain/graph.json`, a host from `createModuleHost`).
  - `card-excerpt.test.ts`:
    - `the excerpt holds the target's rules, terms and contracts and stays within the budget`.
    - `neighbour rules follow the target's rules without text`.
    - `entries that do not fit are counted in omitted` (budget 60).
    - `a target outside every context gets rules only through links`.
    - `targetExcerptTokens equals the unlimited excerpt for the target alone`.
  - `graph-enrichers.test.ts`:
    - `rulesAffected lists rules linked to the root through Code and to impacted tests, with their cards`: payload `{ symbolId: 'src/Lending/LoanPolicy.cs::LoanPolicy.CanBorrow::method', impactedSymbols: [{ symbolId: 'tests/Lending.Tests/LoanLimitTests.cs::LoanLimitTests.MemberHoldsAtMostFiveLoans::method' }] }` gives `rulesAffected[0]` `{ ruleId: 'LEND-03', context: 'lending', card: 'docs/domain/lending/domain.md', via: [{ symbolId: <root>, link: 'code' }, { symbolId: <test>, link: 'test' }], viaCount: 2 }` and `cardsToUpdate` `[{ context: 'lending', card: 'docs/domain/lending/domain.md' }]` (11.5 at unit level).
    - `rules linked to the root come first`; `a file-level link matches every symbol of its file`.
    - `adds empty lists when no rule is linked`; `adds nothing without a registry or with a stale registry` (Review Focus 2).
    - `decisions are the context's five, rule-linked ones first, with provenance` (F9).
    - `decisions beyond five add decisionsTotal`: seven decisions give five entries and `decisionsTotal: 7`; three give three entries and no total field.
    - `rulesAffected and cardsToUpdate are capped at 50 with their totals`: 60 rules linked to the root across 60 one-rule contexts give 50 entries each, `rulesAffectedTotal: 60` and `cardsToUpdateTotal: 60`; three rules give three entries and no total fields. The payload's own `impactedSymbols` stays untouched (the envelope behaviour with two arrays is pinned in Task 3).
    - `a symbol outside every context gets an empty decisions list`.
    - `cardExcerpt fits the budget left by the code context` (`totalTokens + cardExcerpt.tokens <= tokenBudget`).
    - `the reservation equals targetExcerptTokens`.
  - `enrichers.test.ts`: `createEnrichers composes PR 2B's fields with the graph fields` (a blast radius payload gets both `context` on impacted symbols and `rulesAffected`).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/card-excerpt.test.ts src/mcp`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Before editing, run `get_blast_radius` and `get_why_context` on `createEnrichers` and `register`.
- [ ] **Step 4: Run the tests.** Expected: PASS; PR 2B's enricher tests keep passing.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/card-excerpt.ts packages/domain/src/mcp/graph-enrichers.ts packages/domain/src/mcp/enrichers.ts packages/domain/src/index.ts packages/domain/src/core/__tests__/card-excerpt.test.ts packages/domain/src/mcp/__tests__/graph-enrichers.test.ts packages/domain/src/mcp/__tests__/enrichers.test.ts
  git commit -S -m "feat(domain): rulesAffected and cardsToUpdate, decisions and the card excerpt on core tools (#156)"
  ```

---

### Task 12: Fields on `get_pr_impact`: `contextsTouched`, `cardsChanged`, `rulesWithoutTests`

**Files:**
- Create: `packages/domain/src/mcp/pr-impact-fields.ts`
- Modify: `packages/domain/src/mcp/enrichers.ts` (compose after PR 2B's `get_pr_impact` enricher)
- Test: `packages/domain/src/mcp/__tests__/pr-impact-fields.test.ts`

**Interfaces:**
- Consumes: `DomainState`, `rulesWithoutTests` (Task 10); `GitChangeReader`, `computeTouched`, `TouchedContext` (PR 2B); `applyEnricherAsync` in the handler (Task 2).
- Produces:
  ```ts
  export const TOUCHED_FILES_CAP = 10;
  export function prImpactDomainFields(host: CtxoHost, state: DomainState): ResponseEnricher;   // returns a Promise
  ```
- Rules (F8, F15):
  - `since` is `args.since` when it is a non-empty string, else `HEAD~1` (the tool's default). With `new GitChangeReader(host.services.createGit(host.projectRoot))`: `resolveBase(since)`, then `committed([base])` and `workingTree('all')`. Any failure: the payload unchanged and one warning.
  - `computeTouched` in mode `all` with the snapshot's registry and ownership and `createTestFileCheck(config, indices)` (indices from `readIndex`).
  - `contextsTouched`: each `TouchedContext` as `{ id, status, card, cardChanged, acknowledged?, fileCount, files }` with `files` cut to `TOUCHED_FILES_CAP`.
  - `cardsChanged`: registry cards among every changed `path` and `oldPath` of the commits and the working tree, codepoint order.
  - `rulesWithoutTests`: `rulesWithoutTests(index, <touched ids>)` as `{ ruleId, title, context, card, untested? }`.
  - Caps (additive arrays on an existing tool, not truncatable fields; Task 3): each of the three lists keeps its first 50 entries, and `contextsTouchedTotal`, `cardsChangedTotal` and `rulesWithoutTestsTotal` hold the full counts only when entries were cut. `get_pr_impact` keeps `files` as the array the envelope truncates.

- [ ] **Step 1: Write the failing tests** (real temp repos: `main` with the registry, the Lending card and code, then a `feat` branch).
  - `reports a touched context, its unchanged card and its rules without tests`: a commit to `src/Lending/LoanPolicy.cs` and `{ since: 'main' }` give `contextsTouched[0]` `{ id: 'lending', status: 'unresolved', cardChanged: false, fileCount: 1 }` and `rulesWithoutTests` listing `LEND-04` with its `untested` reason.
  - `an acknowledged context shows the trailer reason` (`Domain-Unchanged: lending (refactor only)`).
  - `a card-only change lists the card in cardsChanged and touches no context`.
  - `working-tree changes count`.
  - `the three lists are capped at 50 with their totals`: 60 untested rules give 50 `rulesWithoutTests` entries and `rulesWithoutTestsTotal: 60`; 60 changed cards give 50 `cardsChanged` entries and `cardsChangedTotal: 60`; a small change gives no total fields.
  - `an unknown since ref adds nothing and warns once`.
  - `no registry adds nothing`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/mcp/__tests__/pr-impact-fields.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Before editing `enrichers.ts`, run `get_blast_radius` and `get_why_context` on `createEnrichers`.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then `pnpm --filter @ctxo/domain test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/mcp/pr-impact-fields.ts packages/domain/src/mcp/enrichers.ts packages/domain/src/mcp/__tests__/pr-impact-fields.test.ts
  git commit -S -m "feat(domain): contextsTouched, cardsChanged and rulesWithoutTests on get_pr_impact (#156)"
  ```

---

### Task 13: `get_domain_context` and `get_rule`

**Files:**
- Create: `packages/domain/src/core/domain-views.ts`, `packages/domain/src/mcp/domain-tools.ts`
- Modify: `packages/domain/src/index.ts` (`registerTools`)
- Test: `packages/domain/src/core/__tests__/domain-views.test.ts`, `packages/domain/src/mcp/__tests__/domain-tools.test.ts`

**Interfaces:**
- Consumes: `DomainState`, `DomainSnapshot`, `canonicalRuleId`, `testRefs`, `codeRefs`, `decisionView`, `STALE_CARDS_HINT` (Task 10); `ModuleToolDefinition`, `ToolRegistrar` (PR 2B).
- Produces:
  ```ts
  // domain-views.ts
  export const VIEW_CAPS = { identifiers: 15, testsPerRule: 10, codePerRule: 10 } as const;
  export type ContextLookup = { readonly context: string } | { readonly hint: string };
  export function contextForPath(snapshot: DomainSnapshot, path: string): ContextLookup;
  export function contextView(snapshot: DomainSnapshot, context: string): Record<string, unknown>;
  export function contextsOverview(snapshot: DomainSnapshot): Record<string, unknown>;
  export function ruleView(snapshot: DomainSnapshot, ruleId: string): Record<string, unknown>;
  // domain-tools.ts
  export const GET_DOMAIN_CONTEXT = 'get_domain_context';
  export const GET_RULE = 'get_rule';
  export function domainTools(host: CtxoHost, state: DomainState): ModuleToolDefinition[];   // PR 4 appends its tools here
  ```
- Copy (exact):
  - `get_domain_context` description: `Get the domain card of the named context that owns a symbol or file: the context (id, name, rung, card), its Language terms, its rules with linked tests and code, boundary contracts, decisions with provenance, and open questions. Use this BEFORE changing code in a named context, or to learn the business rules behind it. Pass symbolId or path; with neither, it lists every context. Large results are truncated with _meta.hint. For one rule and its tests, use get_rule. Needs a domain registry (docs/domain/contexts.yaml).`
  - Parameters: `symbolId` `Symbol ID (format: file::name::kind); its file selects the context`; `path` `Repo-relative file path, or a context's card path`.
  - `get_rule` description: `Get one domain rule by ID (for example LEND-03): its text, context and card, the tests linked to it with the source of each link (test annotations, test names, rule comments, the card's Tests: line), the symbols that implement it, and the decisions and provenance that mention it. Use this when a change may affect a business rule, or to find the tests that pin it. For a whole context, use get_domain_context.`
  - Parameter: `ruleId` `Rule ID as written in the card, e.g. LEND-03 (LEND03, Lend03 and lend_03 also match)`.
- Bodies (the lists sit at the top level, so the envelope can truncate the ones Task 3 names: `contexts`, `terms`, `rules`, `openQuestions`, `tests`, `symbols`, `provenance` and `unresolved`; `decisions` is not a truncatable field, so `contextView` and `ruleView` cap it at 50 entries at the source with `decisionsTotal` holding the full count only when entries were cut):
  - `contextView`: `{ context: { id, name, rung, card?, rulePrefix?, paths }, terms, rules, contracts, decisions, openQuestions }`; terms `{ term, key, definitions: [{ text, file, line, origin }], identifiers (first VIEW_CAPS.identifiers), identifierCount }`; rules in card order `{ ruleId, title, line, untested?, tests (first 10 TestRefView), testCount, code (first 10 CodeRefView), codeCount }`; contracts `{ outbound: [{ target, files }], inbound: [{ from, files }], text?, references }` (registry contracts out of and into the context, the `Boundary contracts` section text and its backticked references); decisions newest first as `DecisionView`; open questions `{ text, line }`.
  - `contextsOverview`: `{ contexts: [{ id, name, rung, card?, ruleCount, rulesWithTests, termCount, decisionCount }] }` in registry order.
  - `ruleView`: `{ rule: { ruleId, title, text, line, untested?, context: { id, name, rung }, card }, tests, symbols, decisions, provenance, unresolved? }`; `tests` all `TestRefView`, `symbols` all `CodeRefView`, `decisions` mentioning the rule (newest first), `provenance` the union of their provenance with a `decision` id, unique by `path` or `value`; `unresolved` only when the card has unresolved references for the rule.
- Rules (F14):
  - A not-ok state gives `{ found: false, hint }`; stale cards add `stale: true` and `hint: STALE_CARDS_HINT`.
  - `get_domain_context`: `symbolId` wins over `path`; its file part selects the context. `path`: backslashes become `/`, a leading `./` is dropped, an absolute path inside the project becomes relative; a context's `card` path selects that context. `contextForPath` hints: `No named context owns <path>.` and `<path> belongs to <n> contexts (<ids>); fix the registry, see "ctxo verify-domain".` (both as `{ found: false, hint }`). Neither parameter: `contextsOverview`.
  - `get_rule`: `canonicalRuleId`; an unknown ID gives `{ found: false, hint: 'No rule <raw> in any card.' }`.
  - Input schemas are factories over the host's `zod` (D4); handlers never throw (`handleModuleTool` adds `_meta`, masking and truncation).

- [ ] **Step 1: Write the failing tests.**
  - `domain-views.test.ts` (the 11.1 card with the Task 9 fixture):
    - `contextView returns the context, terms, rules with tests and code, contracts, decisions and open questions`.
    - `terms list at most 15 identifiers with the count`; `rules list at most 10 tests and 10 code links with their counts`.
    - `decisions are capped at 50 with decisionsTotal` (60 decisions in a context give 50 entries and `decisionsTotal: 60` in `contextView`, and the same for a rule mentioned by 60 decisions in `ruleView`; fewer give no total field).
    - `contracts list outbound and inbound registry contracts with the card text and references`.
    - `contextForPath resolves an owned file, a card path, an unowned file and a multiply owned file`.
    - `contextsOverview counts rules, tested rules, terms and decisions per context`.
    - `ruleView returns text, context, tests with sources, symbols, decisions, provenance and unresolved references`.
    - `lists sit at the top level so the envelope can truncate them`.
  - `domain-tools.test.ts`:
    - `get_domain_context answers by symbolId, by path and with neither`; `symbolId wins over path`.
    - `get_rule accepts LEND03 and lend_03`.
    - `get_rule returns the Trait-linked test with source annotation and the card Tests: link` (11.5 at unit level: one `tests` entry for the test file with sources `annotation` (annotation `Trait`) and `card-tests`).
    - `an unknown rule gives a graceful hint`.
    - `no registry gives found false with the hint, never an error` (11.5).
    - `get_rule adds stale and the hint after a card edit` (Review Focus 2).
    - `the same call twice gives identical payloads` (13.1).
    - `input schemas are built with the host's zod` (a recording stub of `z`).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/domain-views.test.ts src/mcp/__tests__/domain-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Before editing `index.ts`, run `get_blast_radius` and `get_why_context` on `register`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/domain-views.ts packages/domain/src/mcp/domain-tools.ts packages/domain/src/index.ts packages/domain/src/core/__tests__/domain-views.test.ts packages/domain/src/mcp/__tests__/domain-tools.test.ts
  git commit -S -m "feat(domain): get_domain_context and get_rule tools (#156)"
  ```

---

### Task 14: The domain scope of `get_ranked_context`

**Files:**
- Create: `packages/domain/src/core/domain-documents.ts`, `packages/domain/src/adapters/provenance-texts.ts`, `packages/domain/src/mcp/domain-scope.ts`
- Modify: `packages/domain/src/index.ts` (`rankedContextScopes`)
- Test: `packages/domain/src/core/__tests__/domain-documents.test.ts`, `packages/domain/src/adapters/__tests__/provenance-texts.test.ts`, `packages/domain/src/mcp/__tests__/domain-scope.test.ts`

**Interfaces:**
- Consumes: `RankedContextScope`, `SearchDocument`, `SearchResponse`, `host.services.createDocumentSearch` (Tasks 1, 3); `DomainState`, `estimateTokens`, `STALE_CARDS_HINT` (Task 10).
- Produces:
  ```ts
  // domain-documents.ts
  export const EXCERPT_MAX_CHARS = 300;
  export interface ProvenanceText { readonly path: string; readonly title: string; readonly text: string }
  export interface DomainDocument extends SearchDocument { readonly context?: string; readonly line?: number }
  export function buildSearchDocuments(graph: DomainGraph, provenance: readonly ProvenanceText[]): DomainDocument[];   // id order
  export interface DomainHit { readonly id: string; readonly kind: string; readonly title: string; readonly context?: string; readonly path: string;
    readonly line?: number; readonly excerpt: string; readonly relevanceScore: number; readonly tokens: number }
  export function packDomainHits(response: SearchResponse, documents: ReadonlyMap<string, DomainDocument>, tokenBudget: number):
    { readonly results: DomainHit[]; readonly totalTokens: number };
  // provenance-texts.ts
  export const PROVENANCE_MAX_BYTES = 262_144;
  export function readProvenanceTexts(projectRoot: string, paths: readonly string[]): ProvenanceText[];
  // domain-scope.ts
  export const DOMAIN_SCOPE = 'domain';
  export function domainRankedScope(host: CtxoHost, state: DomainState): RankedContextScope;
  ```
- Rules (F12, F13):
  - Documents: one per rule (`title` `<ID> <title>`, `text` the rule text), term (`title` the term, `text` its definitions), decision (`title` `<date> decision`, `text` the line), section node (`title` its heading), and in-repo provenance file (`id` `file:<path>`, kind `provenance`) for every `decision-provenance` file link with `exists: true`. `path` is the card or the file.
  - `readProvenanceTexts`: regular files whose real path lies inside the repository, up to `PROVENANCE_MAX_BYTES`, without a NUL byte in the first 8 KiB; `title` = the first ATX H1, else the file name.
  - The search index is built with `host.services.createDocumentSearch` and rebuilt only when the snapshot `generation` or a provenance file's mtime changes; `search(query, 100)`.
  - Packing in hit order: `excerpt` = the text with whitespace collapsed, cut at `EXCERPT_MAX_CHARS` with `...`; `relevanceScore` rounded to 3 decimals; `tokens = estimateTokens(hit)`; greedy within `tokenBudget`.
  - Payload `{ query, scope: 'domain', results, totalTokens, tokenBudget, searchMetrics, fuzzyCorrection? }`. A not-ok state gives `{ found: false, hint }`; stale cards add `stale: true` and the hint. `strategy` and `searchMode` do not apply.
  - `description`: `"domain": card sections, glossary entries and in-repo provenance files from @ctxo/domain.`

- [ ] **Step 1: Write the failing tests** (the Task 9 fixture with `docs/specs/loan-limit.md` holding `# Loan limit` and `The limit rose from three to five loans after the renewal study.`, a host from `createModuleHost`).
  - `domain-scope.test.ts`:
    - `finds a rule by words in its body`; `finds a glossary entry by its definition`; `finds a provenance file by its text` (`renewal study` gives `file:docs/specs/loan-limit.md` first).
    - `results stay within the token budget` (budget 100); `corrects a typo`.
    - `no registry gives the graceful hint`.
    - `the same query twice gives identical results` (13.1).
  - `domain-documents.test.ts`: `builds one document per rule, term, decision, section and existing provenance file`; `excerpts collapse whitespace and stop at 300 characters`.
  - `provenance-texts.test.ts`: `reads repository files up to 256 KB with their H1 as title`; `skips binary files, directories, missing files and paths outside the repository`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/domain-documents.test.ts src/adapters/__tests__/provenance-texts.test.ts src/mcp/__tests__/domain-scope.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Before editing `index.ts`, run `get_blast_radius` and `get_why_context` on `register`.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then `pnpm --filter @ctxo/domain build && pnpm --filter @ctxo/domain typecheck && pnpm --filter @ctxo/domain lint`. Expected: PASS (no runtime import of `@ctxo/cli`).
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/src/core/domain-documents.ts packages/domain/src/adapters/provenance-texts.ts packages/domain/src/mcp/domain-scope.ts packages/domain/src/index.ts packages/domain/src/core/__tests__/domain-documents.test.ts packages/domain/src/adapters/__tests__/provenance-texts.test.ts packages/domain/src/mcp/__tests__/domain-scope.test.ts
  git commit -S -m "feat(domain): domain scope for get_ranked_context over cards, glossary and provenance files (#156)"
  ```

---

### Task 15: Library-lending sample extension and the PR 3 acceptance tests

**Files:**
- Modify (both variants under `packages/domain/test-fixtures/library-lending/{csharp,typescript}/`): `docs/domain/lending/domain.md`, `docs/domain/glossary.md`, the Lending policy and hold source files (names from Task 0), `packages/domain/e2e/__tests__/acceptance.test.ts` (the PR 2B no-registry test)
- Create (both variants): `docs/specs/loan-limit.md`, `docs/adr/adr-007-loan-limit.md`; and `packages/domain/e2e/__tests__/acceptance-graph.test.ts`, `packages/domain/e2e/__tests__/mcp-client.ts`

**Interfaces:**
- Consumes: `sample-workspace.ts` (PR 2B: copy a variant, `git init -b main`, commit, junction `node_modules/@ctxo/domain`, run the built CLI); the built server.
- Produces (`mcp-client.ts`): `export async function connectServer(cwd: string, env?: Readonly<Record<string, string>>): Promise<McpTestClient>` with `McpTestClient { call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>; listTools(): Promise<readonly { name: string; inputSchema: Record<string, unknown> }[]>; close(): Promise<void> }`; `call` parses the last text content as JSON (a staleness warning line is skipped).
- Sample additions (synthetic, both variants):
  - Lending card: Language items `Loan`, `Hold`, `Member account`, `Account` (member account); `LEND-03` gains a `Code:` line, `src/Lending/LoanPolicy.cs` in C# (a file path, because C# method IDs differ between the Roslyn and tree-sitter tiers) and `src/lending/loan-policy.ts::LoanPolicy.canBorrow::method` in TypeScript; `Boundary contracts` text naming the charge-service interface file in backticks; Decisions `- 2026-09-12: Loan limit raised from 3 to 5 (LEND-03). [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)` and `- 2026-10-01: Holds expire after seven days (LEND-04). https://example.com/issues/45`; Open questions `- Should renewals count as new loans?`.
  - `docs/specs/loan-limit.md`: `# Loan limit` and `The limit rose from three to five loans after the renewal study.`; `docs/adr/adr-007-loan-limit.md`: `# ADR-007 Loan limit` and one sentence.
  - Glossary: `- **Loan** (context: lending): one copy lent to a member`, `- **Account** (context: billing): the payer who settles invoices`, `- **Member**: a registered patron of the library`.
  - Code: the Lending policy's borrow check that the `LEND-03` test calls (C# `LoanPolicy.CanBorrow`, TypeScript `LoanPolicy.canBorrow`), and a hold class whose expiry check is preceded by `// rule: LEND-04`; keep PR 2B's names where they exist.

- [ ] **Step 1: Write the acceptance tests** (`acceptance-graph.test.ts`; one indexed workspace per variant in `beforeAll`, tests that change files work on their own copy; symbol IDs come from `search_symbols`, never hard-coded C# IDs):
  - `get_blast_radius on the Lending borrow check lists LEND-03 and the Lending card` (both; 11.5): `rulesAffected` holds `{ ruleId: 'LEND-03', card: 'docs/domain/lending/domain.md' }`; `cardsToUpdate` holds `{ context: 'lending', card: 'docs/domain/lending/domain.md' }`.
  - `get_rule LEND-03 returns the linked tests with the source of each link` (11.5): C#, a `tests` entry whose `symbolId` contains `LoanLimitTests` has the source `{ source: 'annotation', annotation: 'Trait' }`, and the test file has a `card-tests` source; TypeScript, the test file entry has `testName: 'LEND-03 rejects the sixth loan'` and the source `test-title`.
  - `get_rule LEND-04 lists the rule: comment link to the hold expiry check and the 2026-10-01 decision with its external URL` (both).
  - `get_domain_context for the Lending policy file returns terms, rules, contracts, decisions and open questions` (both).
  - `get_why_context lists the Lending decisions, LEND-03's first, with resolved provenance` (C#; `docs/specs/loan-limit.md` has `exists: true`, `#123` is external).
  - `get_context_for_task carries a card excerpt within the token budget` (both; `cardExcerpt.rules[0].ruleId === 'LEND-03'`, `totalTokens + cardExcerpt.tokens <= 4000`).
  - `get_pr_impact reports contextsTouched, cardsChanged and rulesWithoutTests` (C#): a `feat` commit to the policy file and `{ since: 'main' }` give lending `unresolved` and `rulesWithoutTests` `LEND-01`, `LEND-02`, `LEND-04`, `LEND-05`; after a card commit, lending is `card-changed` and `cardsChanged` holds the card.
  - `get_ranked_context with scope domain finds LEND-03 by "five loans" and the spec file by "renewal study"` (both).
  - `tools/list holds 16 tools and the scope parameter lists code and domain` (C#).
  - `the same input twice gives a byte-identical graph.json and identical get_rule responses` (both; 13.1).
  - `a card-only commit refreshes graph.json through ctxo index --commit HEAD` (TypeScript; Review Focus 3).
  - `card text passes the masking pipeline` (a copy whose open question holds `AKIAIOSFODNN7EXAMPLE`; `get_domain_context` masks it).
  - `get_domain_context truncates a card with 200 rules through the envelope` (a copy with 200 generated `Untested:` rules, the server started with `CTXO_RESPONSE_LIMIT=4096`: `_meta.truncated` and the `rules` hint).
  - Extend PR 2B's `no registry: no new fields anywhere, and the commands print a hint and exit 0`: no `rulesAffected`, `cardsToUpdate`, `cardExcerpt`, `decisions`, `contextsTouched`, `cardsChanged` or `rulesWithoutTests` key in the core responses; `get_domain_context`, `get_rule` and `get_ranked_context` with scope `domain` return `found: false` and never `error` (11.5).
- [ ] **Step 2: Run them.** `pnpm -r build && pnpm --filter @ctxo/domain test:e2e`. Expected: the new tests FAIL until the sample exists.
- [ ] **Step 3: Write the sample files.** C# runs on the tree-sitter tier without dotnet and on Roslyn with it; both emit the `Trait` annotation (PR 1B).
- [ ] **Step 4: Run them.** Expected: PASS, PR 2B's acceptance tests included (the sample still passes `verify-domain` with warnings only). If one fails, fix the code under test, not the expectation.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/domain/test-fixtures/library-lending packages/domain/e2e/__tests__/acceptance-graph.test.ts packages/domain/e2e/__tests__/mcp-client.ts packages/domain/e2e/__tests__/acceptance.test.ts
  git commit -S -m "test(domain): library-lending cards, decisions and glossary with the PR 3 acceptance tests (#156)"
  ```

---

### Task 16: Docs, skill, changeset and full verification

**Files:**
- Modify: `docs/features/domain-knowledge.md`, `docs/architecture/ADR/adr-018-domain-knowledge-layer.md` (addendum), `docs/roadmap.md`, `CHANGELOG.md`, `llms.txt`, `llms-full.txt`, `README.md`, `CLAUDE.md`, `packages/domain/README.md`, `packages/domain/skills/ctxo-domain-fold/SKILL.md`, `site/docs/mcp-tools/overview.md`, `tool-selection-guide.md`, `get-ranked-context.md`, `get-blast-radius.md`, `get-context-for-task.md`, `get-why-context.md`, `get-pr-impact.md` (same folder), `site/docs/concepts/domain-knowledge.md`, `site/docs/cli/domain.md`, `site/docs/.vitepress/config.ts`
- Create: `site/docs/mcp-tools/get-domain-context.md`, `site/docs/mcp-tools/get-rule.md`, `.changeset/domain-graph.md`

- [ ] **Step 1: Feature doc** (`docs/features/domain-knowledge.md`), new sections:
  - **Cards, the consumer contract:** the 11.1 example and rules (rule headings, `Tests:`, `Code:` and `Untested:` lines, term items, glossary `(context: <id>)`, decision lines, provenance); "Ctxo domain conventions v1" gains the `Code:` line, term items, decision lines and the glossary form (additive, no level of the adoption ladder needs code changes).
  - **The domain graph:** node IDs, the link families with every `source` value, `graph.json`, what never reads it (K8), when it is rebuilt (`ctxo index` and the post-commit hook, not `ctxo watch`), staleness (F1, F2).
  - **Linking rules to tests and code:** the annotation table (xUnit `Trait` with `domain.tests.ruleTraitKeys`, NUnit `Category`, MSTest `TestCategory`, JUnit `Tag`), the text scan with variants and titles, card lines, `rule:` comments above declarations, tracker safeguards; C# teams should prefer file paths in `Code:` lines, because method IDs differ between analysis tiers (F3 to F5).
  - **Decisions and provenance:** relative links, external strings never fetched (ADR-004), tracker keys (F6). **Terms:** the matching rules (F7).
  - **Fields on core tools** (the seven fields with one synthetic example each), **the two tools**, **the domain search scope**, and the tool count: "14 core tools; 16 with `@ctxo/domain` (PR 4 adds 2 more)".
  - **verify-domain:** the check 6 findings for card references and production `rule:` comments.
- [ ] **Step 2: Other docs.**
  - ADR-018 addendum "PR 3 additions to the internal API": `ResponseEnricher` may return a Promise (awaited by the async tools), `reserveTaskContextTokens`, `rankedContextScopes`, host services `createDocumentSearch` and `splitIdentifier`.
  - `site/docs/mcp-tools/get-domain-context.md` and `get-rule.md` (parameters, response fields, graceful misses, examples from the synthetic sample); `overview.md` states "14 core tools, plus 2 with @ctxo/domain"; `tool-selection-guide.md` gains "Need the business rules or decisions behind code? Use get_domain_context, then get_rule"; the five tool pages describe their fields (present only with `@ctxo/domain` and a registry; the lists are capped at 50, `decisions` at five, with `<name>Total` fields when cut), `get-ranked-context.md` the `scope` parameter; the sidebar gains a `Domain (@ctxo/domain)` group with both tools; `site/docs/concepts/domain-knowledge.md` summarises the graph; `site/docs/cli/domain.md` the check 6 additions.
  - `llms.txt` and `llms-full.txt`: the tool reference becomes "14 core tools, plus 2 with @ctxo/domain", with both tools, their parameters, the `scope` parameter and the fields; a "New in" entry for the release.
  - `README.md`: the tool list gains the two domain tools. `CLAUDE.md`: the status line and tool table state 14 core tools plus `get_domain_context` and `get_rule` with `@ctxo/domain`, and the Tool Selection Guide gains the domain question. `packages/domain/README.md`: tools, fields and scope.
  - `ctxo-domain-fold/SKILL.md`, "Before changing a context's code": call `get_domain_context` with the symbol you will change and `get_rule` for the rules it lists (F16).
  - `docs/roadmap.md`: PR 3 items shipped; a Deferred row "Multi-repo domain links (a frontend repo linking backend cards)", trigger "first consumer with cards in another repository".
  - `CHANGELOG.md` `[Unreleased]`: Added: the domain graph and `graph.json`, the link families, the seven fields, `get_domain_context`, `get_rule`, the `scope` parameter, document search in the core engine, the internal-API additions. Changed: `verify-domain` check 6 checks `Code:` lines and symbol IDs in card lines, `rule:` comments above a declaration link to it, async tools await async enrichers.
- [ ] **Step 3: Changeset** `.changeset/domain-graph.md` with `"@ctxo/cli": minor` and `"@ctxo/domain": minor` (the `fixed` group). Note, two sentences naming #156: `@ctxo/domain` builds a domain graph from cards (rules, terms, decisions) linked to tests, code and provenance, adds `get_domain_context`, `get_rule` and a domain scope for `get_ranked_context`, and adds rule and card fields to `get_blast_radius`, `get_context_for_task`, `get_why_context` and `get_pr_impact`; `@ctxo/cli` adds document search to its BM25 engine and three module seams (async enrichers, a token reservation for `get_context_for_task`, ranked-context scopes).
- [ ] **Step 4: Help and text checks.**
  - No command or flag changed (F16): `node packages/cli/dist/index.js --help` in a temp project with the junction prints the same command lists as before this PR; `verify-domain --help` is unchanged.
  - The MCP copy matches Tasks 3 and 13 (the registration test from Task 15 lists the `scope` description).
  - `git grep -nP "\x{2014}"` over the touched docs shows no new line.
- [ ] **Step 5: Full verification.**
  - `pnpm changeset status --verbose`. Expected: `@ctxo/cli` and `@ctxo/domain` at the same next version.
  - `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm --filter @ctxo/cli test:e2e && pnpm --filter @ctxo/domain test:e2e`. Expected: all green, the tarball test included (raise the limit with measurements if crossed).
  - `pnpm --filter @ctxo/domain pack --dry-run`. Expected: `dist/`, `skills/`, `schema/`, `README.md` only.
- [ ] **Step 6: Commit.**
  ```bash
  git add docs/features/domain-knowledge.md docs/architecture/ADR/adr-018-domain-knowledge-layer.md docs/roadmap.md CHANGELOG.md llms.txt llms-full.txt README.md CLAUDE.md packages/domain/README.md packages/domain/skills/ctxo-domain-fold/SKILL.md .changeset/domain-graph.md
  git add site/docs/mcp-tools/overview.md site/docs/mcp-tools/tool-selection-guide.md site/docs/mcp-tools/get-ranked-context.md site/docs/mcp-tools/get-blast-radius.md site/docs/mcp-tools/get-context-for-task.md site/docs/mcp-tools/get-why-context.md site/docs/mcp-tools/get-pr-impact.md site/docs/mcp-tools/get-domain-context.md site/docs/mcp-tools/get-rule.md site/docs/concepts/domain-knowledge.md site/docs/cli/domain.md site/docs/.vitepress/config.ts
  git commit -S -m "docs: domain graph, get_domain_context, get_rule, the domain search scope and the changeset (#156)"
  ```

---

### Task 17: Scale and speed smoke on the private fixture (nothing committed)

- [ ] **Step 1:** In the private fixture clone (path from the owner's brief; never the original checkout), with the `node_modules/@ctxo/domain` junction and the mechanically derived private registry from PR 2B Task 12, run `node <worktree>/packages/cli/dist/index.js index`. Expected: no crash; the `Domain:` log line with 0 rules; pass time at most 2 s.
- [ ] **Step 2:** To measure the scans with rules present, a script in the session scratchpad writes into the clone only: one headings-only card per candidate context with one rule `### C<id>-1 Rule <id>`, a `Code:` line naming the candidate's first file and an `Untested:` line, plus a glossary built from the candidates' top terms; the private registry points at the cards. Run `ctxo index` again. Expected: pass time at most 2 s (spec 13.4).
- [ ] **Step 3:** Through the dev build's MCP server: `get_blast_radius` on five high-PageRank symbols, `get_domain_context` for three files, `get_rule` for three IDs, `get_ranked_context` with scope `domain` for three queries, `get_pr_impact` since the default branch. Expected: no `error` response; each call under 500 ms.
- [ ] **Step 4:** `ctxo verify-domain --json`. Expected: exit 0 or 1, never 2.
- [ ] **Step 5:** Record aggregate numbers only (rules, links by kind, unresolved references, pass time, call latencies) in the scratchpad PR draft. Delete the scratch cards and glossary from the clone. Nothing from the fixture goes into the repository.

---

## Spec coverage (self-review)

| Spec | Tasks |
|---|---|
| 11.1 card format (consumer contract) | 4, 5, 16 |
| 11.2 domain graph, node IDs, links with sources (K8, K6, K19) | 5, 6, 7, 8, 9 |
| 11.3 `rulesAffected`, `cardsToUpdate`, card excerpt, `decisions[]` | 2, 11 |
| 11.3 `contextsTouched`, `cardsChanged`, `rulesWithoutTests` | 2, 12 |
| 11.4 `get_domain_context`, `get_rule`, tool count | 13, 16 |
| 11.4 `scope: "domain"` through the core search engine | 1, 3, 14 |
| 11.5 acceptance (rule and card in blast radius, Trait-linked tests with sources, no registry, determinism) | 11, 13, 15 |
| 12 seams for PR 4 | 10, 13 |
| 13.1 determinism, 13.2 degradation, 13.3 masking, envelope and `TRUNCATABLE_FIELDS`, 13.4 budget, 13.5 artifact | 5, 9, 10, 3, 13, 15, 17 |
| 15 docs, CLI help, release | 16 |
