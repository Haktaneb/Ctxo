# PR 4, Part 2: Text-Scan Fallback, `find_shadow_specs`, `get_context_map` and the Suggested Rung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support the agentic Deletion Test loop in `@ctxo/domain`: a text-scan fallback for plugins without fact detectors, shadow-spec candidates with line-independent fingerprints and resolutions (rule links, `Untested:` lines, `shadow-specs.yaml`), per-context metrics with a cumulative suggested rung, the MCP tools `find_shadow_specs` and `get_context_map`, their CLI faces, a `verify-domain` check for stale resolutions, and the docs and changeset for the whole PR (Phase 4 of #156, spec 12.1 to 12.4; K12, K13a, K13b).

**Architecture:**
- The domain index pass (PR 2B's seam, extended by PR 3) adds two artifacts under `.ctxo/index/domain/`: `shadow-candidates.json` (every candidate of every context, with automatic resolutions) and `maturity.json` (per-context test counts, main-path and contract reachability from characterization and contract tests, cross-context co-change). Expensive work (the text scan, reachability) runs at index time only.
- At query time a `LoopState` reads both artifacts beside PR 3's `DomainState` and the PR 2B artifacts, and reads each context's `shadow-specs.yaml` on every call, so a resolution an agent just wrote takes effect without re-indexing. Pure `core/` views build the tool bodies; the CLI wraps masking, `_meta`, truncation and recording.
- `verify-domain` computes candidates from the index and the repo (E5, never artifacts) to report stale or broken resolutions. `ctxo domain map` and `ctxo domain shadow-specs` print the same bodies for people and CI.

**Tech Stack:** TypeScript (ESM, Node >= 20), yaml, vitest, @modelcontextprotocol/sdk (test client only), pnpm workspace, changesets.

**Spec:** `docs/superpowers/specs/2026-10-20-domain-knowledge-layer-design.md`, sections 12.1 to 12.4, with 3, 4, 10.5, 10.7, 10.9, 11.2, 13, 14, 15 and 18 (K12, K13a, K13b; the PR 4 calls: the cumulative ladder with per-criterion status and `pinnedCoverage` 0.8). Part 1: `docs/superpowers/plans/2026-10-21-pr4-1-fact-detectors.md`.

## Global Constraints

- **Base:** the same branch as Part 1 (`feat/agentic-loop-156`), after Part 1's Task 10. Consumed by name:
  - Part 1: the Fact contract; `FactDetectorOptions`, `TrivialLiteral`, `CtxoModuleRegistration.indexCapabilities.factOptions`, `CodeFact` exported from `@ctxo/cli/internal`; `facts: []` for fact-capable adapters; `packages/lang-csharp/src/facts/{fact-types,fact-rules,finish-facts}.ts` and `packages/plugin-api/conformance/fact-vectors.json`.
  - PR 2B: `CtxoHost`, `CtxoHostServices` (`loadConfig`, `makeGlobMatcher`, `createTestFileCheck`, `createGit`, `readIndex`, `buildGraph`), `IndexPassContext`, `ModuleToolDefinition`, `ModuleCommand`, `TestFileCheck`, `createModuleHost`, `handleModuleTool`; `DomainConfig`, `resolveDomainConfig`, `ConfigProblem`, `DomainRegistry`, `DomainContext`, `Rung`, `RUNGS`, `readRegistry`, `registryHash`, `createOwnership`, `Ownership`, `GlobMatcherFactory`; `DomainArtifactStore`, `BoundariesArtifact`, `ContextsArtifact`, `ContextHistoryEntry`, `MovedFile`, `contextDrift`, `ContextDrift`; `runVerifyChecks`, `VerifyInput`, `VERIFY_CHECKS`, `verifyDomainCommand`; `domainCommand`; `discoverConventions`, `DiscoveryProposal`, `formatDiscovery`, `proposalAddsSomething`, `mergeDiscoveryProposal`, `mergeDomainDefaults`; `scanTestText`, `readTestFiles`; `register`; the library-lending sample and `packages/domain/e2e/__tests__/sample-workspace.ts`.
  - PR 3: `DomainGraph`, `buildDomainGraph`, `indexGraph`, `GraphIndex`, `RuleNode`, `TermNode`, `ContextNode`, `rulesForSymbols`, `rulesWithoutTests`, `canonicalRuleId`, `DomainState`, `DomainSnapshot`, `createDomainState`, `STALE_CARDS_HINT`, `domainTools`, `readRepoTexts`, `SOURCE_SCAN_MAX_BYTES`, `DATA_RESOURCE_KIND_NAMES`, `e2e/__tests__/mcp-client.ts` (`connectServer`).
  - PR 0: `CoChangeEntry`, `CoChangeReader`.
- **Spec values, verbatim:**
  - Candidates (12.2): facts of the first three kinds in the context's files; endpoints without a rule link; procedures and data resources owned by the context without a rule link; rules without tests. Each with file, line, symbol, fingerprint, source and resolution. Every candidate records its source, `native` or `text` (12.1).
  - Fingerprint: `kind | symbol | normalized text`, independent of line numbers; a changed literal changes the fingerprint, so the candidate reopens.
  - Resolution (K13b): automatic when a rule links to the candidate's symbol; otherwise from `docs/domain/<ctx>/shadow-specs.yaml` entries `{ fingerprint, resolution: { rule: LEND-03 } | { notARule: "<reason>" } }`. `verify-domain` reports entries whose fingerprint no longer matches any candidate (warning).
  - Tools: `find_shadow_specs({ context, kinds?, includeResolved? })` and `get_context_map()`.
  - Context map (12.3): card present, rule count, share of rules with tests; characterization and contract test counts; cross-context edges in and out; co-change pairs with files of other contexts above the threshold; drift events, boundary violations, open shadow-spec candidates; the owner's `rung`, a `suggestedRung` and the status of each criterion.
  - Ladder (cumulative, every criterion reported separately): fear when none holds; pinned when at least `domain.rungs.pinnedCoverage` (default 0.8) of the main paths (the context's `endpoint` facts plus the contract symbols other contexts may use) are reachable in the graph from a characterization test; named when pinned, a card exists and its Language section has terms present in the glossary; bounded when named, every contract symbol is reachable from a contract test and there are no boundary violations; boring when bounded, every rule has a test link and every shadow-spec candidate is resolved.
  - K13a defaults: `domain.tests.ruleTraitKeys: [Rule]`; `characterization: { annotations: ["Trait:Kind=Characterization", "Tag:characterization"], paths: ["**/Characterization/**"], names: ["[characterization]"] }`; `contract: { annotations: ["Trait:Kind=Contract", "Tag:contract"], paths: ["**/Contract/**", "**/Contracts.Tests/**"], names: ["[contract]"] }`; `domain.rungs.pinnedCoverage: 0.8`.
  - Tool count: 14 core tools, plus 2 from `@ctxo/domain` in PR 3 and 2 more in PR 4 when it is installed (18).
  - Degradation (13.2): a plugin without facts gets the text-scan fallback marked `source: text`; a language without an official plugin gets a file-level text scan for facts.
- **Rules carried over:** hexagonal layers in `@ctxo/cli` and `@ctxo/domain` (`core/` never imports `adapters/`, `ports/` or `mcp/`; no barrels beyond the package entries); `@ctxo/domain` imports `@ctxo/cli` and `@ctxo/cli/internal` with `import type` only (lint-enforced), every runtime service comes from `host.services`; language plugins import only `@ctxo/plugin-api` plus the `@ctxo/sql-extract` exception. Never `console.log`: human output to `console.error`, JSON to `process.stdout.write`, logs through `createLogger`. MCP handlers never throw; every payload, candidate text included, passes through `wrapResponse` and `masking.mask` (`handleModuleTool`); the primary arrays of the new tools join `TRUNCATABLE_FIELDS`, while additive arrays on existing tools are capped at their source (default 50, with a `<name>Total` count when capped) and are not added, so truncation keeps working on each existing tool's primary array.
- **Facts on request (spec 8.3, K12):** plugins produce facts only with `capabilities.facts`, which `@ctxo/domain` asks for through its registration (or `index.facts: true`); without either, no plugin runs a detector and the index is unchanged.
- **Determinism (spec 13.1):** the domain's codepoint comparator, never `localeCompare`; no wall clock in results; artifacts rewritten only on change; the same input twice gives byte-identical `shadow-candidates.json` and `maturity.json` and identical tool payloads.
- **No authoring (spec 2):** Ctxo never writes `shadow-specs.yaml`, cards or rules; agents and people do.
- **Tests:** vitest in `__tests__/`, kebab-case names; temp dirs from `mkdtempSync(join(tmpdir(), 'ctxo-...'))`; temp repos start with `git init -b main` and every git operation that creates commits in them (commit, merge, rebase, cherry-pick, amend, revert, tag) passes `-c commit.gpgsign=false -c user.name=Test -c user.email=test@test.com`, plus `-c tag.gpgsign=false` for tags; domain tests use the built cli (`pnpm --filter @ctxo/cli build` after cli changes); never run `ctxo init` or `ctxo doctor --fix` against the worktree.
- **Git:** stage the Files block paths only (never `-A` or `.`), never `.ctxo/` or `.claude/settings.local.json`; `git commit -S`, and a signing failure means stop and report BLOCKED; the post-commit hook may take minutes; no `Co-Authored-By` or AI attribution; no push, PR, publish or issue comment without the owner's approval. Before editing an existing symbol, call `get_blast_radius` and `get_why_context` on it. The session's ctxo MCP server indexes the main checkout (older code), so `found: false` from either tool for a symbol added on these branches is expected: call the tools as the project rule asks, then proceed.
- **Budgets (spec 13.4):** the domain index pass at most 2 s on the fixture; tool calls under 500 ms there.
- **Tarball:** the CLI limit is 1350 KB; when crossed, raise it to the measured size rounded up to the next 50 KB with both numbers in the PR description.
- **Text:** English only, no em dashes. **Privacy:** nothing from any private repository in code, tests, docs, commits or PR text; samples are synthetic; fixture numbers are aggregates only.

## Review Focus

1. **Resolution entries written by agents:** a fingerprint copied with different spacing around `|`, doubled spaces, a trailing newline from a YAML block scalar, or a rule written `lend03`. Expected: matching after whitespace normalization of each part and ID canonicalization, so the entry resolves its candidate. Tests: Task 3 `normalizeFingerprint tolerates spacing around separators and inside parts`; Task 4 `entries match candidates whatever the spacing`, `rule resolutions accept ID variants`.
2. **Damaged `shadow-specs.yaml`:** CRLF and a BOM, a mapping instead of a list, a YAML syntax error, unknown keys, both `rule` and `notARule`, duplicate fingerprints. Expected: errors and warnings with 1-based lines, valid entries still applied, never a crash of the tool or the gate. Tests: Task 4 `CRLF and a BOM parse like LF`, `... are errors with 1-based lines`, `valid entries apply although others are broken`.
3. **Text that only looks like code in fallback languages:** `//` inside strings (URLs), Python docstrings and `#` comments, Kotlin nested block comments, a comparison inside a string literal, generics (`List<int>`). Expected: no phantom facts, no lost lines. Tests: Task 2 lexer and `generics are not comparisons`.
4. **Contexts where a criterion has nothing to measure:** no endpoints and no contracts, no rules, no glossary, rung fear without a card. Expected: explicit evidence (`coverage: null`, `share: null`, counts), a deterministic `met`, never `NaN`. Tests: Task 7 `pinned uses coverage ... and falls back to a characterization test without main paths`, `a context without a card fails named and keeps its counts`, `a context without rules has share null`.
5. **Edits after the last `ctxo index`:** a card change (rule links and Untested lines may be stale), a registry change, a `shadow-specs.yaml` edit. Expected: stale cards add `stale: true` and the hint; a registry change gives the "run ctxo index" hint; a resolution edit takes effect on the next call. Tests: Task 8 `marks stale cards`, `reports the PR 3 hints and a missing-artifact hint`, `reads shadow-specs.yaml on every call`.

## Designer calls (spec gaps decided here; the owner may override)

- **H1 Artifacts:** `shadow-candidates.json` (`"ctxoArtifact": "domain-shadow-candidates"`) and `maturity.json` (`"domain-maturity"`), both `version: 1` with `registryHash` and `cardsHash`, no timestamps. File resolutions are applied at query time.
- **H2 Text fallback scope:** indexed non-test files with exactly one owner whose FileIndex has no `facts` key (Part 1's G10), plus tracked, unindexed, non-test files with one owner whose extension is in `domain.facts.textScanExtensions` (default `.dart .ex .exs .groovy .kt .kts .php .py .rb .rs .scala .swift`). Whole files up to 1 MiB; facts attach to the innermost symbol or the module symbol (file level for unindexed files). Heuristics are single-line.
- **H3 Candidate shape:** kinds `literal-comparison`, `normalization`, `retry-timeout`, `endpoint`, `data-resource` (tables and views), `procedure`, `rule-without-tests`; sources `native` and `text` for facts, `index` for data objects, `card` for rules; `line` is 1-based; a rule candidate sits at its card heading.
- **H4 Fingerprint parts:** the symbol part is the last two `.` segments of `<file basename>.<symbol name without a trailing (...)>` (`LoanPolicy.CanBorrow` in C#, TypeScript and Java, `loan-policy.canBorrow` for a TypeScript function, `dbo.loans` for a table); data objects use text `<kind> <canonical name>`; rules use the rule ID and title. Entries are compared after normalizing each part.
- **H5 Resolution order:** rule links (code links only: card `Code:` lines and `rule:` comments, through `rulesForSymbols`, file-level links included), then the card's `Untested:` line for rules without tests, then `shadow-specs.yaml`. An entry matching an automatically resolved candidate is not stale.
- **H6 Resolution file:** `<registry folder>/<context>/shadow-specs.yaml` (the spec path under the default registry). YAML syntax and schema problems are errors; stale entries, unknown rule IDs (not applied), duplicates and files for unknown contexts are warnings (check 12).
- **H7 Test conventions:** matchers `Name`, `Name:value`, `Name:key=value` (names exact; keys and values ASCII case-insensitive; `Trait:Kind=Characterization` reads xUnit's positional `args` or a `named` key); test cases are function and method symbols of test files that contain no other function or method (leaf `it` blocks, not `describe`); a class-level annotation marks its methods; name markers match the symbol name or a test title the K6 scan captures on a line the symbol spans.
- **H8 Reachability:** characterization and contract tests anywhere in the repository count; forward edges `calls`, `uses`, `imports`, `extends`, `implements` (never data edges); a test without edges of its own starts from its class (JDT edges are type-level); a target counts as reached when it is visited, when its containing type is visited (TypeScript and Java edges often stop at the type), or, for a module symbol, when any symbol of its file is visited. The `via` is reported.
- **H9 Main paths:** unique symbols of the context's `endpoint` facts plus its contract symbols (leaf symbols of its files that another context's `contracts.<this>` globs list). With no main paths, pinned holds when the context has at least one characterization test (`coverage: null`).
- **H10 named:** a card file exists, the Language section has at least one term, and every Language term has a glossary entry (for this context or repository-wide).
- **H11 bounded:** boundary violations of any severity, in or out. **H12 boring:** `Untested:` rules count as without tests.
- **H13 Co-change threshold:** frequency at least 0.5 (PR 0's `coChangedFiles` floor), non-test files of two different contexts; top 10 kept.
- **H14 Config:** `domain.facts` (`trivialLiterals`, typed; `normalizationMethods`; `textScanExtensions`), the K13a sections and `domain.rungs.pinnedCoverage` in [0, 1], validated per key. `init --domain` writes the K13a and rungs defaults, not the fact lists. The registration passes `trivialLiterals` and `normalizationMethods` as `indexCapabilities.factOptions`; changes take effect at the next `ctxo index`.
- **H15 CLI faces:** `ctxo domain map` and `ctxo domain shadow-specs <context>`, the full-output target of the truncation hints and a CI view.
- **H16 Payload keys:** `shadowSpecs` and `contextMap` (PR 1A and PR 3 already give `candidates` and `contexts` hints for other tools).
- **H17 Discovery:** `ctxo domain discover` proposes `paths` for Characterization and Contract folders the configured globs miss (K19's discover, propose, confirm).
- **H18 Registration:** both tools register whenever `@ctxo/domain` loads and answer `found: false` with a hint without a registry or artifacts (PR 3's F14).

---

### Task 1: Domain config for facts, test conventions and rungs; the fact request; init defaults; discovery

**Files:**
- Modify: `packages/domain/src/core/domain-config.ts` (`DomainConfig`, `DEFAULT_DOMAIN_CONFIG`, `resolveDomainConfig`, new `toFactDetectorOptions`), `packages/domain/src/index.ts` (`indexCapabilities`), `packages/domain/src/adapters/config-writer.ts` (`mergeDomainDefaults` block, `mergeDiscoveryProposal`), `packages/domain/src/core/discovery.ts` (`DiscoveryProposal`, `discoverConventions`, `formatDiscovery`, `proposalAddsSomething`). Before editing: `get_blast_radius` and `get_why_context` on `resolveDomainConfig`, `register`, `mergeDomainDefaults`, `mergeDiscoveryProposal` and `discoverConventions`.
- Create: `packages/domain/src/core/test-conventions.ts`
- Test: `packages/domain/src/core/__tests__/domain-config.test.ts`, `test-conventions.test.ts`, `discovery.test.ts`; `packages/domain/src/adapters/__tests__/config-writer.test.ts`; `packages/domain/src/__tests__/register.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // core/domain-config.ts
  export interface TestConvention { readonly annotations: readonly string[]; readonly paths: readonly string[]; readonly names: readonly string[] }
  // DomainConfig gains or extends:
  //   tests: { ruleTraitKeys; characterization: TestConvention; contract: TestConvention }
  //   rungs: { pinnedCoverage: number }
  //   facts: { trivialLiterals: readonly TrivialLiteral[]; normalizationMethods: readonly string[]; textScanExtensions: readonly string[] }
  export const DEFAULT_TEXT_SCAN_EXTENSIONS: readonly string[];   // H2 list, codepoint order
  export function toFactDetectorOptions(config: DomainConfig): FactDetectorOptions;
  // core/test-conventions.ts
  export interface AnnotationMatcher { readonly name: string; readonly key?: string; readonly value?: string }
  export function parseAnnotationMatcher(spec: string): AnnotationMatcher | undefined;   // Name | Name:value | Name:key=value
  // core/discovery.ts: DiscoveryProposal gains readonly characterizationPaths: readonly string[]; readonly contractPaths: readonly string[]
  // index.ts: indexCapabilities: { facts: true, factOptions: toFactDetectorOptions(<config resolved at register time>) }
  ```
- Defaults: the K13a values and `pinnedCoverage` verbatim (Global Constraints); `facts.trivialLiterals` `[0, 1, -1, null, true, false, '']` and `facts.normalizationMethods` the spec list (Part 1's `DEFAULT_FACT_OPTIONS`).
- Validation, each problem with its path: matchers must parse; `paths` and `names` non-empty strings; `pinnedCoverage` a number in [0, 1]; `trivialLiterals` numbers, strings, booleans or `null`; `normalizationMethods` Part 1's pattern regex; `textScanExtensions` `^\.[A-Za-z0-9]+$`, lower-cased. An invalid key falls back to its default (D6).
- `mergeDomainDefaults` appends, under `tests:`, the `characterization` and `contract` blocks and adds `rungs: { pinnedCoverage: 0.8 }` (spec 12.3 layout); no `facts:` block (H14).
- Discovery (H17): each folder of `evidence.characterizationFolders` or `contractFolders` that no configured glob of the matching section matches (probe path `<folder>/x`) is proposed as `<folder>/**`; `mergeDiscoveryProposal` unions them into the two `paths` lists; `formatDiscovery` prints them under the test folders line with `<- not covered by domain.tests.<section>.paths`.

- [ ] **Step 1: Write the failing tests.**
  - `domain-config.test.ts`: `defaults include the K13a conventions, pinnedCoverage 0.8 and the spec fact lists` (deep-equal to the spec values); `typed trivial literals are kept` (`[0, null, 'N/A', true]`); `invalid values fall back per key with their paths` (`trivialLiterals: [{}]`, `pinnedCoverage: 1.5`, `characterization.annotations: ['Trait:']`, `textScanExtensions: ['py']` give four problems at `domain.facts.trivialLiterals`, `domain.rungs.pinnedCoverage`, `domain.tests.characterization.annotations`, `domain.facts.textScanExtensions`, and the other keys keep their values); `extensions are lower-cased` (`['.PY']` gives `['.py']`).
  - `test-conventions.test.ts`: `parseAnnotationMatcher reads the three forms` (`Tag`, `Tag:characterization`, `Trait:Kind=Characterization`); `rejects malformed matchers` (`''`, `':x'`, `'Trait:'`, `'Trait:=x'`, `'Trait:a=b=c'`).
  - `register.test.ts`: `the registration requests facts with the configured lists` (a temp project whose `.ctxo/config.yaml` holds `domain.facts.trivialLiterals: [0, 100]`: `indexCapabilities` deep-equals `{ facts: true, factOptions: { trivialLiterals: [0, 100], normalizationMethods: <defaults> } }`).
  - `config-writer.test.ts`: `mergeDomainDefaults writes the K13a and rungs defaults and no fact lists`; `adds the new keys to an existing domain section without changing values`; `mergeDiscoveryProposal unions characterization and contract paths`.
  - `discovery.test.ts`: `proposes a Contracts folder the default contract paths miss` (`tests/Contracts/ChargeTests.cs` gives `contractPaths: ['tests/Contracts/**']`); `covered folders propose nothing` (`tests/Billing.Tests/Contract/X.cs`).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli build && pnpm --filter @ctxo/domain test:unit`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS, PR 2B's config, init and discovery tests included.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(domain): fact lists, K13a test conventions and rung settings with the fact request (#156)"`.

---

### Task 2: The text-scan fallback

**Files:**
- Create: `packages/domain/src/core/facts/fact-types.ts`, `fact-rules.ts`, `finish-facts.ts` (copies of Part 1's lang-csharp modules; types from `@ctxo/cli/internal` with `import type`), `packages/domain/src/core/text-lexer.ts`, `packages/domain/src/core/text-facts.ts`, `packages/domain/src/adapters/text-fact-sources.ts`
- Test: `packages/domain/src/core/facts/__tests__/fact-rules.test.ts`, `finish-facts.test.ts` (copies, vectors path adjusted), `packages/domain/src/core/__tests__/text-lexer.test.ts`, `text-facts.test.ts`, `packages/domain/src/adapters/__tests__/text-fact-sources.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // core/text-lexer.ts
  export type CommentStyle = 'c' | 'c-nested' | 'hash' | 'php' | 'sql';
  export interface TextToken { readonly kind: 'word' | 'number' | 'string' | 'op' | 'punct'; readonly text: string; readonly line: number; readonly start: number; readonly end: number }   // 0-based line, UTF-16 offsets
  export function commentStyleFor(file: string): CommentStyle;   // c-nested: .kt .kts .rs .scala .swift; hash: .ex .exs .pl .py .r .rb .sh; php: .php; sql: .sql; else c
  export function lexSource(text: string, style: CommentStyle): TextToken[];   // comments dropped, strings kept whole, never throws
  // core/text-facts.ts
  export function scanTextFacts(file: string, text: string, symbols: readonly SymbolNode[], options: FactOptions): CodeFact[];   // evidence from tokens, then finishFacts
  // adapters/text-fact-sources.ts
  export interface TextScanTarget { readonly file: string; readonly symbols: readonly SymbolNode[] }   // symbols [] for unindexed files
  export function textScanTargets(input: { readonly indices: readonly FileIndex[]; readonly tracked: readonly string[]; readonly ownership: Ownership;
    readonly isTestFile: TestFileCheck; readonly extensions: readonly string[] }): TextScanTarget[];   // H2, codepoint order
  export function readTextFacts(projectRoot: string, targets: readonly TextScanTarget[], options: FactOptions): Map<string, CodeFact[]>;   // readRepoTexts; files without facts are absent
  ```
- Lexer: `c` has `//` and `/* */` comments, strings `"..."`, `'...'` and `` `...` `` with backslash escapes, and `"""..."""`; `c-nested` nests block comments; `hash` has `#` comments and `'...'`, `"..."`, `'''...'''`, `"""..."""` strings; `php` has `//`, `#` (not `#[`) and `/* */`; `sql` (for `.sql` files, which lang-sql indexes without facts, so they reach this fallback) has `--` line comments and `/* */` block comments, and `'...'` strings in which a doubled quote is the escape (no backslash escapes). Words are Unicode letters, digits, `_` and `$`; numbers follow FC-7's literal forms; multi-character operators `===`, `!==`, `==`, `!=`, `<=`, `>=`, `=>`, `->`, `::`, `&&`, `||`, `:=`, `**`.
- Evidence rules (single line):
  - **Comparison:** an operator of FC-3 counts when a condition word (`if`, `elif`, `elsif`, `while`, `until`, `unless`, `when`, `guard`) occurs earlier on the line or `?` later on it; its operands are the adjacent runs of words, numbers, strings, `.`, `::`, `->` and balanced brackets, stopping at `,`, `&&`, `||`, `and`, `or`, `not`, `!`, `:` and condition words; exactly one operand is a single literal token (number, optionally signed; string; `null`, `nil`, `None`, `true`, `false`, `True`, `False`). A line starting with `case` or `when` followed by one literal token gives `case` evidence with text `case <literal>`.
  - **Call:** a word matching a normalization pattern directly followed by `(`; the qualifier is the word before a preceding `.`, `::` or `->`; text from the receiver run to the matching `)` on the line.
  - **Binding:** a fragment name followed by `=`, `:` or `:=` and a numeric constant up to `;`, `,`, `)`, `}` or the line end.
  - **Duration:** `TimeSpan.From<Unit>(n)`, `Duration.of<Unit>(n)`, `n * time.<Unit>`, `time.<Unit> * n`, `setTimeout(..., n)`.
  - **Route:** `[Http<Verb>("x")]`, `@<Verb>Mapping("x")`, `@<word>.(get|post|put|delete|patch|route)("x")` (`route` takes its verbs from a `methods=[...]` list on the line, else `ANY`), `<word>.(get|post|put|delete|patch|head|options|all)("/x")`, `Map(Get|Post|Put|Delete|Patch)("x")`, `HandleFunc("x")`.
- Targets (H2): indexed, non-test, singly owned files whose index has no `facts` key; tracked, unindexed, non-test, singly owned files with a listed extension.

- [ ] **Step 1: Write the failing tests.**
  - Copied rule tests: every vectors category passes in the domain copy.
  - `text-lexer.test.ts` (Review Focus 3): `comments are dropped and strings stay whole` (`// if (x > 5)`, `/* timeout = 30 */` and `"if (x > 5)"` give no `if` word); `a URL inside a string is not a comment` (`"http://x" + y` keeps `y`); `nested block comments in Kotlin` (`/* a /* b */ c */ if` in `.kt` keeps `if`); `Python docstrings and # comments give no words` (`"""timeout = 30"""`, `# retries = 3`); `SQL comments are dropped in .sql files` (`commentStyleFor('db/x.sql')` is `sql`; `-- if x > 5` and `/* timeout = 30 */` give no `if` or `timeout` word; `SELECT 'a -- b'` keeps the string whole and a trailing `-- c` is dropped); `a doubled quote escapes inside a SQL string` (`'it''s'` is one string token, and in `'C:\'` the backslash does not escape the closing quote); `unterminated strings and comments never throw`; `lines are 0-based across CRLF`.
  - `text-facts.test.ts`: `a Python file gives its facts` (`TIMEOUT_SECONDS = 30` gives `TIMEOUT_SECONDS = 30`; `if days > 14:` gives `days > 14`; `return 'late' if days > 14 else 'ok'` gives `days > 14`; `x = "if a > 5"` gives nothing; `@app.route("/fees", methods=["POST"])` gives `POST /fees`; with `normalizationMethods: ['lower']`, `s.lower()` gives method `lower`); `a C-style file of an unknown language gives its facts` (`.lend`: `if days > 14 then charge 2.5` gives `days > 14`; `retries = 3` gives `retries = 3`); `generics are not comparisons` (`List<int> xs = new List<int>();` gives nothing); `facts attach to the innermost symbol, others to the module symbol`; `the same text twice gives deep-equal facts`.
  - `text-fact-sources.test.ts`: `targets are owned non-test files without native facts plus unindexed files with a listed extension` (a FileIndex with `facts: []` is no target; one without the key is; `src/Billing/fees.py` owned by billing is a target with `symbols: []`; `scripts/x.py` unowned and `src/Billing/notes.md` are not); `readTextFacts skips oversized and binary files`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/facts src/core/__tests__/text-lexer.test.ts src/core/__tests__/text-facts.test.ts src/adapters/__tests__/text-fact-sources.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/domain lint` (no runtime import of `@ctxo/cli`).
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(domain): text-scan fact fallback for plugins without detectors and unindexed languages (#156)"`.

---

### Task 3: Fingerprints and shadow-spec candidates

**Files:**
- Create: `packages/domain/src/core/fingerprint.ts`, `packages/domain/src/core/shadow-candidates.ts`
- Test: `packages/domain/src/core/__tests__/fingerprint.test.ts`, `shadow-candidates.test.ts`

**Interfaces:**
- Consumes: `normalizeFactText` (Task 2's copy); `GraphIndex`, `rulesForSymbols`, `rulesWithoutTests`, `DATA_RESOURCE_KIND_NAMES` (PR 3); `Ownership` (PR 2B).
- Produces:
  ```ts
  // fingerprint.ts
  export function fingerprintSymbolPart(symbolId: string): string;                         // H4
  export function fingerprint(kind: string, symbolPart: string, text: string): string;     // `${kind} | ${symbolPart} | ${normalizeFactText(text)}`
  export function normalizeFingerprint(raw: string): string | undefined;                   // split at the first two '|', each part trimmed and whitespace-collapsed
  // shadow-candidates.ts
  export const CANDIDATE_KINDS = ['literal-comparison', 'normalization', 'retry-timeout', 'endpoint', 'data-resource', 'procedure', 'rule-without-tests'] as const;
  export type CandidateKind = (typeof CANDIDATE_KINDS)[number];
  export type CandidateSource = 'native' | 'text' | 'index' | 'card';
  export type CandidateResolution =
    | { readonly by: 'rule-link'; readonly rules: readonly string[] }
    | { readonly by: 'untested'; readonly reason: string }
    | { readonly by: 'shadow-specs'; readonly rule: string }
    | { readonly by: 'shadow-specs'; readonly notARule: string };
  export interface ShadowCandidate {
    readonly fingerprint: string; readonly kind: CandidateKind; readonly context: string;
    readonly file: string; readonly line: number;                       // 1-based
    readonly symbolId?: string; readonly ruleId?: string;
    readonly text: string; readonly detail?: Readonly<Record<string, string>>;
    readonly source: CandidateSource; readonly resolution?: CandidateResolution;
  }
  export interface CandidateInput { readonly registry: DomainRegistry; readonly ownership: Ownership; readonly isTestFile: TestFileCheck;
    readonly indices: readonly FileIndex[]; readonly textFacts: ReadonlyMap<string, readonly CodeFact[]>; readonly graph: GraphIndex }
  export function buildShadowCandidates(input: CandidateInput): ShadowCandidate[];   // every context, automatic resolutions applied
  export function compareCandidates(a: ShadowCandidate, b: ShadowCandidate): number;  // context, file, line, CANDIDATE_KINDS order, fingerprint
  export function candidatesOf(all: readonly ShadowCandidate[], context: string, kinds?: readonly CandidateKind[]): ShadowCandidate[];
  ```
- Rules:
  - **Facts:** a non-test file with exactly one owner contributes its index `facts` (source `native`) when the key exists, else `textFacts` (source `text`); unindexed files in `textFacts` count for their owner. Each fact gives `{ kind, file, line: line + 1, symbolId, text, detail }` with `fingerprint(kind, fingerprintSymbolPart(symbolId), text)`.
  - **Data objects:** symbols of kinds in `DATA_RESOURCE_KIND_NAMES` give `data-resource`, `procedure` symbols give `procedure`, both with text `<kind> <middle segment of symbolId>`, line `startLine + 1`, source `index`.
  - **Rules:** `rulesWithoutTests(graph, [context])` gives `rule-without-tests` at the rule's card and line with `ruleId`, text `<ID> <title>`, fingerprint `fingerprint('rule-without-tests', <ID>, <title>)`, source `card`, and `{ by: 'untested', reason }` when the rule has an `Untested:` line.
  - **Rule links (H5):** for a candidate with a `symbolId`, the `via` entries of `rulesForSymbols(graph, [symbolId])` whose `link` is `code` give `{ by: 'rule-link', rules }` (unique, codepoint order).

- [ ] **Step 1: Write the failing tests.**
  - `fingerprint.test.ts`:
    - `the symbol part drops namespaces and the C# parameter suffix` (`it.each`: `src/Lending/LoanPolicy.cs::LibraryLending.Lending.LoanPolicy.CanBorrow::method` and `...CanBorrow(1)::method` give `LoanPolicy.CanBorrow`; `src/lending/loan-policy.ts::LoanPolicy.canBorrow::method` gives `LoanPolicy.canBorrow`; `src/lending/loan-policy.ts::canBorrow::function` gives `loan-policy.canBorrow`; `src/main/java/lending/LoanPolicy.java::canBorrow::method` gives `LoanPolicy.canBorrow`; `loans/policy.go::CanBorrow::function` gives `policy.CanBorrow`; `db/migrations/lending/001_create_loans.sql::dbo.loans::table` gives `dbo.loans`; `src/app.ts::app::variable` gives `app.app`);
    - `fingerprint reproduces the spec example` (`fingerprint('literal-comparison', 'LoanPolicy.CanBorrow', 'loans.Count >= 5')` is `literal-comparison | LoanPolicy.CanBorrow | loans.Count >= 5`);
    - `normalizeFingerprint tolerates spacing around separators and inside parts` (Review Focus 1: `literal-comparison|LoanPolicy.CanBorrow|loans.Count  >=  5\n` gives the spec string; `a | b | x | y` keeps `x | y` as text);
    - `normalizeFingerprint rejects fewer than three parts or an empty part`.
  - `shadow-candidates.test.ts` (a hand-built registry with `lending` and `billing`, FileIndex fixtures and a graph from `buildDomainGraph`):
    - `facts of a context's non-test files become candidates with native or text source`;
    - `facts of test files and of unowned or multiply owned files are left out`;
    - `tables, views and procedures owned by the context become candidates with source index`;
    - `rules without tests become candidates and an Untested line resolves them`;
    - `a Code: link to the symbol or to its file resolves by rule-link; a test link does not`;
    - `a changed literal changes the fingerprint` (spec 12.2: `openLoans >= 5` and `openLoans >= 6`);
    - `shuffled input gives deep-equal candidates`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/fingerprint.test.ts src/core/__tests__/shadow-candidates.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(domain): line-independent fingerprints and shadow-spec candidates with rule-link resolution (#156)"`.

---

### Task 4: `shadow-specs.yaml`: parser, resolutions, stale entries and the schema

**Files:**
- Create: `packages/domain/src/core/shadow-specs-file.ts`, `packages/domain/src/adapters/shadow-specs-files.ts`, `packages/domain/schema/shadow-specs.schema.json`
- Test: `packages/domain/src/core/__tests__/shadow-specs-file.test.ts`, `packages/domain/src/adapters/__tests__/shadow-specs-files.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // core/shadow-specs-file.ts
  export const SHADOW_SPECS_FILE = 'shadow-specs.yaml';
  export type Resolution = { readonly rule: string } | { readonly notARule: string };
  export interface ResolutionEntry { readonly fingerprint: string; readonly resolution: Resolution; readonly line: number }   // normalized fingerprint, 1-based item line
  export interface ShadowSpecsProblem { readonly line: number; readonly severity: 'error' | 'warning'; readonly message: string }
  export interface ParsedShadowSpecs { readonly entries: readonly ResolutionEntry[]; readonly problems: readonly ShadowSpecsProblem[] }
  export function parseShadowSpecs(text: string): ParsedShadowSpecs;
  export function shadowSpecsPath(registryPath: string, context: string): string;   // posix: <dirname(registryPath)>/<context>/shadow-specs.yaml
  export interface AppliedResolutions { readonly candidates: readonly ShadowCandidate[]; readonly stale: readonly ResolutionEntry[]; readonly unknownRules: readonly ResolutionEntry[] }
  export function applyResolutions(candidates: readonly ShadowCandidate[], entries: readonly ResolutionEntry[],
    canonicalRule: (raw: string) => string | undefined): AppliedResolutions;
  // adapters/shadow-specs-files.ts
  export interface LoadedShadowSpecs { readonly context: string; readonly path: string; readonly parsed?: ParsedShadowSpecs }   // parsed absent: no file
  export function readShadowSpecs(projectRoot: string, registryPath: string, contexts: readonly string[]): LoadedShadowSpecs[];   // registry order
  export function findOrphanShadowSpecs(projectRoot: string, registryPath: string, contexts: readonly string[]): string[];   // files under folders that are no context id
  ```
- Parse rules (yaml `parseDocument` with a `LineCounter`; BOM stripped):
  - empty text or `[]`: no entries; a non-sequence root: one error `the file must be a YAML list of { fingerprint, resolution } entries`; a syntax error: one error at its line;
  - an item must be a map with exactly `fingerprint` (a string `normalizeFingerprint` accepts; else `fingerprint must read "<kind> | <symbol> | <text>"`) and `resolution` (a map with exactly one of `rule` or `notARule`, a non-empty string); anything else is an error and the item is skipped;
  - a repeated normalized fingerprint is a warning `duplicate fingerprint; the entry at line <n> wins` and is skipped.
- `applyResolutions`: a candidate without a `resolution` and an entry with its fingerprint gets `{ by: 'shadow-specs', rule: canonicalRule(rule) }` or `{ by: 'shadow-specs', notARule }`; an unknown rule goes to `unknownRules` and resolves nothing; an entry matching no candidate (automatically resolved ones included) is stale; candidate order is unchanged.
- `shadow-specs.schema.json`: JSON Schema draft 2020-12, an array of objects with `fingerprint` (string) and `resolution` (`oneOf` an object with `rule` or one with `notARule`, each `additionalProperties: false`).

- [ ] **Step 1: Write the failing tests.**
  - `parses the spec example` (the 12.2 block verbatim gives two entries with lines 1 and 3).
  - Review Focus 2: `CRLF and a BOM parse like LF`; `a mapping root, a syntax error, unknown keys, a bad fingerprint and a resolution with both keys are errors with 1-based lines` (`it.each`); `a duplicate fingerprint is a warning and the first entry wins`; `valid entries apply although others are broken`.
  - Review Focus 1: `entries match candidates whatever the spacing`; `rule resolutions accept ID variants` (`lend03` with `canonicalRuleId` gives `LEND-03`).
  - `an unknown rule leaves the candidate open and is reported`; `entries matching no candidate are stale`; `an automatic resolution wins and its entry is not stale`.
  - `the JSON Schema agrees with the parser` (required keys, `oneOf`, `additionalProperties: false`).
  - Adapters: `readShadowSpecs reads <registry folder>/<context>/shadow-specs.yaml and reports missing files as absent`; `findOrphanShadowSpecs lists files for unknown contexts`; `shadowSpecsPath follows the registry folder` (`config/domain/contexts.yaml` gives `config/domain/lending/shadow-specs.yaml`).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/shadow-specs-file.test.ts src/adapters/__tests__/shadow-specs-files.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(domain): shadow-specs.yaml resolutions with stale and unknown-rule detection and a JSON Schema (#156)"`.

---

### Task 5: Test conventions, reachability and maturity facts

**Files:**
- Modify: `packages/domain/src/core/test-conventions.ts` (classification), `packages/domain/src/core/rule-id-scan.ts` (new `scanTestTitles`). Before editing: the two MCP tools on `scanTestText`.
- Create: `packages/domain/src/core/reachability.ts`, `packages/domain/src/core/maturity.ts`
- Test: `packages/domain/src/core/__tests__/test-conventions.test.ts`, `rule-id-scan.test.ts`, `reachability.test.ts`, `maturity.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // rule-id-scan.ts
  export interface TestTitle { readonly file: string; readonly line: number; readonly title: string }   // 0-based line
  export function scanTestTitles(file: string, text: string): TestTitle[];   // PR 2B's test-declaration regex, every match
  // test-conventions.ts
  export interface TestClassification { readonly testCases: readonly string[]; readonly characterization: ReadonlySet<string>; readonly contract: ReadonlySet<string> }
  export function classifyTests(input: { readonly indices: readonly FileIndex[]; readonly isTestFile: TestFileCheck; readonly titles: readonly TestTitle[];
    readonly characterization: TestConvention; readonly contract: TestConvention; readonly makeMatcher: GlobMatcherFactory }): TestClassification;
  // reachability.ts
  export const REACH_EDGE_KINDS: ReadonlySet<string>;   // calls, uses, imports, extends, implements
  export interface ReachGraph { readonly successors: ReadonlyMap<string, readonly string[]>; readonly containerOf: ReadonlyMap<string, string>;
    readonly symbolsByFile: ReadonlyMap<string, readonly string[]> }
  export function buildReachGraph(graph: SymbolGraph, indices: readonly FileIndex[]): ReachGraph;
  export function reachableFrom(reach: ReachGraph, tests: Iterable<string>): ReadonlySet<string>;
  export type ReachedVia = 'symbol' | 'type' | 'file';
  export function reachedVia(reach: ReachGraph, visited: ReadonlySet<string>, symbolId: string): ReachedVia | undefined;
  // maturity.ts
  export const CROSS_CONTEXT_COCHANGE_MIN = 0.5; export const UNREACHED_CAP = 20; export const COCHANGE_TOP = 10;
  export interface CrossContextCoChange { readonly file: string; readonly otherFile: string; readonly otherContext: string; readonly frequency: number; readonly sharedCommits: number }
  export interface ReachSummary { readonly total: number; readonly reached: number; readonly unreached: readonly string[] }
  export interface ContextMaturityFacts {
    readonly context: string; readonly tests: { readonly characterization: number; readonly contract: number };
    readonly mainPaths: ReachSummary; readonly contractSymbols: ReachSummary;
    readonly coChange: { readonly pairs: number; readonly top: readonly CrossContextCoChange[] };
  }
  export interface MaturityInput { readonly registry: DomainRegistry; readonly ownership: Ownership; readonly isTestFile: TestFileCheck;
    readonly indices: readonly FileIndex[]; readonly facts: ReadonlyMap<string, readonly CodeFact[]>;   // effective facts per file (native, else text)
    readonly reach: ReachGraph; readonly tests: TestClassification; readonly makeMatcher: GlobMatcherFactory; readonly coChange?: readonly CoChangeEntry[] }
  export function buildMaturityFacts(input: MaturityInput): ContextMaturityFacts[];   // registry order
  ```
- Rules (H7 to H9, H13):
  - **Test cases:** `function` and `method` symbols of test files that contain no other `function` or `method` symbol of the file (line spans).
  - **Classification:** a case is characterization when its file matches a `paths` glob; when it, or a symbol of its file whose span contains it, has an annotation a matcher accepts (`Name` exact; `Name:value` any `args` element or `named` value; `Name:key=value` `args[0]` and `args[1]`, or `named[key]`; keys and values ASCII case-insensitive); or when a `names` marker occurs (ASCII case-insensitive) in its `name` or in a `TestTitle` on a line it spans. Contract: the same with the contract convention.
  - **Reach graph:** edges of `REACH_EDGE_KINDS` from `graph.allEdges()`; a target that `graph.getNode` resolves uses the node's `symbolId`; `containerOf` is the innermost other symbol of the file whose span contains the symbol. `reachableFrom` starts at each test, plus its container when the test has no successors.
  - **`reachedVia`:** `symbol` when visited; `type` when its container is visited; `file` when the symbol is no indexed node and any symbol of its file is visited.
  - **Main paths and contract symbols:** main paths are the unique `symbolId`s of `endpoint` facts in the context's non-test files plus its contract symbols. Contract symbols are the leaf symbols (containing no other symbol) of the context's non-test files that some other context's `contracts.<this>` globs match. `mainPaths` counts reach from characterization tests, `contractSymbols` from contract tests; `unreached` is sorted and capped at `UNREACHED_CAP`.
  - **Co-change:** entries with `frequency >= CROSS_CONTEXT_COCHANGE_MIN` whose two files are non-test and singly owned by different contexts; per context the pair count and the top `COCHANGE_TOP` by frequency desc, `sharedCommits` desc, `file`, `otherFile`.

- [ ] **Step 1: Write the failing tests.**
  - `rule-id-scan.test.ts`: `scanTestTitles captures every declared title with its line` (titles with and without rule IDs).
  - `test-conventions.test.ts`:
    - `the four default signals mark characterization tests` (`it.each`: `{ name: 'Trait', args: ['Kind', 'Characterization'] }`, `{ name: 'Tag', args: ['characterization'] }`, a file under `tests/Lending.Tests/Characterization/`, a title `[characterization] borrow flow`);
    - `a class-level annotation marks its methods`; `describe blocks are containers and only leaf blocks count`; `values and keys compare without case` (`Trait("kind", "CHARACTERIZATION")`); `contract conventions work the same way`.
  - `reachability.test.ts`: `a test reaches what it calls transitively`; `a test without edges starts from its class`; `reaching a class counts its methods via type`; `a module symbol counts as reached via file`; `data edges are not followed`.
  - `maturity.test.ts`:
    - `main paths are endpoint symbols and contract symbols other contexts may use`; `contract symbols are the leaves of contract files`;
    - `cross-context co-change counts pairs at 0.5 or more and keeps the top ten` (a pair at 0.49 is left out; 12 pairs give `pairs: 12` and ten in `top`);
    - `unreached lists are sorted and capped at 20`; `shuffled input gives deep-equal output`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/test-conventions.test.ts src/core/__tests__/rule-id-scan.test.ts src/core/__tests__/reachability.test.ts src/core/__tests__/maturity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS, PR 2B's scan tests included.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(domain): characterization and contract test conventions, reachability and per-context maturity facts (#156)"`.

---

### Task 6: The index pass writes `shadow-candidates.json` and `maturity.json`

**Files:**
- Modify: `packages/domain/src/index-pass/domain-index-pass.ts`, `packages/domain/src/adapters/artifact-store.ts` (`writeIfChanged`, `readShadowCandidates`, `readMaturity`, `removeAll`). Before editing: the two MCP tools on `domainIndexPass` and `DomainArtifactStore`.
- Modify (cli): `packages/cli/src/ports/i-ctxo-module.ts` (`CtxoHostServices.readCoChangeEntries`), `packages/cli/src/cli/module-host.ts`, `packages/cli/src/adapters/storage/co-change-reader.ts` (new `readEntries()`). Before editing: the two MCP tools on `createModuleHost` and `CoChangeReader`.
- Test: `packages/domain/src/index-pass/__tests__/domain-index-pass.test.ts`, `packages/domain/src/adapters/__tests__/artifact-store.test.ts`, `packages/cli/src/cli/__tests__/module-host.test.ts`, `packages/cli/src/adapters/storage/__tests__/co-change-reader.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 5; `buildDomainGraph`, `indexGraph`, `readTestFiles` (PR 3, PR 2B); `CoChangeReader` (PR 0).
- Produces:
  ```ts
  // cli CoChangeReader (PR 0) gains
  readEntries(): readonly CoChangeEntry[] | undefined;   // the validated matrix's `entries` as stored, one per file pair; same CoChangeMatrixSchema validation and mtime cache as readCoChangeMap
  // cli CtxoHostServices gains
  readCoChangeEntries(ctxoRoot: string): readonly CoChangeEntry[] | undefined;   // CoChangeReader.readEntries(); undefined when missing or invalid
  // artifact-store.ts
  export interface ShadowCandidatesArtifact { readonly ctxoArtifact: 'domain-shadow-candidates'; readonly version: 1; readonly registryHash: string; readonly cardsHash: string;
    readonly candidates: readonly ShadowCandidate[] }
  export interface MaturityArtifact { readonly ctxoArtifact: 'domain-maturity'; readonly version: 1; readonly registryHash: string; readonly cardsHash: string;
    readonly contexts: readonly ContextMaturityFacts[] }
  // writeIfChanged also takes 'shadow-candidates.json' | 'maturity.json'; readShadowCandidates(): ShadowCandidatesArtifact | undefined;
  // readMaturity(): MaturityArtifact | undefined (undefined unless marker, version 1 and every array present); removeAll() also removes both
  ```
- Pass additions, for a valid registry only, after PR 3's `graph.json`:
  1. `textScanTargets` (tracked files from `listTrackedFiles`, else the indexed paths) and `readTextFacts` with the config's fact lists.
  2. `buildShadowCandidates` over `indexGraph(graph)`.
  3. `scanTestTitles` over the test file texts the pass already reads; `classifyTests`; `buildReachGraph(ctx.graph(), ctx.indices)`; the effective facts map; `buildMaturityFacts` with `host.services.readCoChangeEntries(ctx.ctxoRoot)`.
  4. `writeIfChanged` both artifacts; the log line gains `, <c> shadow-spec candidates (<r> resolved by links or Untested)`.

- [ ] **Step 1: Write the failing tests.**
  - `domain-index-pass.test.ts` (PR 3's temp-project fixture plus a `src/Lending/RenewalPolicy.cs` index with a native `renewals > 2` fact, a FileIndex without a `facts` key whose source holds `if (days > 14)`, a characterization test method, and a `co-changes.json` with one cross-context pair at 0.6):
    - `writes shadow-candidates.json and maturity.json, byte-identical on a second run` (spec 13.1);
    - `the text fallback runs only for files without native facts` (one `text` candidate; a FileIndex with `facts: []` gives none);
    - `maturity counts the characterization test and the cross-context pair`;
    - `removes both artifacts when the registry is gone`; `writes nothing when the registry has problems`;
    - `the JSON index reader skips both artifacts` (`readIndex` returns as many indices as before).
  - `artifact-store.test.ts`: `readShadowCandidates and readMaturity read what writeIfChanged wrote and reject other shapes`.
  - `module-host.test.ts`: `readCoChangeEntries returns the entries of co-changes.json once per pair and undefined for a missing or invalid file` (a matrix with one pair gives exactly one entry; flattening `readCoChangeMap()` would give it twice, once under each file).
  - `co-change-reader.test.ts`: `readEntries returns the validated entries as stored and re-reads after the mtime changes`; `readEntries returns undefined for a missing or invalid file`.
  - `domain-index-pass.test.ts`: `maturity counts a cross-context pair once` (the one pair at 0.6 gives `pairs: 1` for each of its two contexts, not 2).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/cli/__tests__/module-host.test.ts src/adapters/storage/__tests__/co-change-reader.test.ts` and, after `pnpm --filter @ctxo/cli build`, `pnpm --filter @ctxo/domain exec vitest run src/index-pass src/adapters/__tests__/artifact-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/domain test:unit`.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(domain): shadow-candidates.json and maturity.json in the domain index pass (#156)"`.

---

### Task 7: The suggested rung and the context map and shadow-spec views

**Files:**
- Create: `packages/domain/src/core/context-map.ts`, `packages/domain/src/core/shadow-specs-view.ts`
- Test: `packages/domain/src/core/__tests__/context-map.test.ts`, `shadow-specs-view.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // context-map.ts
  export interface PinnedStatus { readonly met: boolean; readonly mainPaths: number; readonly reached: number; readonly coverage: number | null; readonly threshold: number;
    readonly characterizationTests: number; readonly unreached: readonly string[] }
  export interface NamedStatus { readonly met: boolean; readonly card: boolean; readonly terms: number; readonly inGlossary: number; readonly missing: readonly string[] }   // missing capped at 10
  export interface BoundedStatus { readonly met: boolean; readonly contractSymbols: number; readonly reached: number; readonly unreached: readonly string[]; readonly boundaryViolations: number }
  export interface BoringStatus { readonly met: boolean; readonly rules: number; readonly rulesWithoutTests: number; readonly openCandidates: number }
  export interface ContextMapEntry {
    readonly id: string; readonly name: string; readonly rung: Rung; readonly suggestedRung: Rung;
    readonly card: { readonly path?: string; readonly present: boolean };
    readonly rules: { readonly count: number; readonly withTests: number; readonly share: number | null };
    readonly tests: { readonly characterization: number; readonly contract: number };
    readonly crossContextEdges: { readonly in: number; readonly out: number };
    readonly coChange: { readonly pairs: number; readonly top: readonly CrossContextCoChange[] };
    readonly drift: { readonly crossShare: ContextDrift['crossShare']; readonly movedFiles: number; readonly distinctCommits: number; readonly confidence: ContextDrift['confidence'] } | null;
    readonly boundaryViolations: { readonly total: number; readonly errors: number; readonly warnings: number };
    readonly shadowSpecs: { readonly open: number; readonly resolved: number };
    readonly criteria: { readonly pinned: PinnedStatus; readonly named: NamedStatus; readonly bounded: BoundedStatus; readonly boring: BoringStatus };
  }
  export function suggestRung(met: { readonly pinned: boolean; readonly named: boolean; readonly bounded: boolean; readonly boring: boolean }): Rung;
  export interface ContextMapInput { readonly snapshot: DomainSnapshot; readonly boundaries?: BoundariesArtifact; readonly history: readonly ContextHistoryEntry[];
    readonly movedFiles: readonly MovedFile[]; readonly maturity: MaturityArtifact; readonly candidates: readonly ShadowCandidate[];   // file resolutions applied
    readonly cardExists: (repoPath: string) => boolean }
  export interface ContextMapView { readonly contextMap: readonly ContextMapEntry[];
    readonly summary: { readonly contexts: number; readonly agree: number; readonly suggestedAbove: number; readonly suggestedBelow: number };
    readonly settings: { readonly pinnedCoverage: number } }
  export function buildContextMap(input: ContextMapInput): ContextMapView;   // registry order
  // shadow-specs-view.ts
  export function shadowSpecsView(input: { readonly context: ContextNode; readonly candidates: readonly ShadowCandidate[]; readonly kinds?: readonly CandidateKind[];
    readonly includeResolved: boolean; readonly resolutionFile: string; readonly stale: readonly ResolutionEntry[]; readonly unknownRules: readonly ResolutionEntry[];
    readonly problems: readonly ShadowSpecsProblem[] }): Record<string, unknown>;
  ```
- Rules:
  - **pinned:** `coverage` is `reached / mainPaths` rounded to 3 decimals, `null` without main paths; `met` is `coverage >= threshold` with main paths, else `characterizationTests >= 1` (H9).
  - **named (H10):** `card` when the registry names a card and `cardExists`; `terms` counts the context's term nodes with a `card` definition; `inGlossary` counts those with a `glossary` definition or a repository-wide node of the same key; `met` needs `card`, `terms >= 1` and `inGlossary === terms`.
  - **bounded:** `met` when every contract symbol is reached and `boundaryViolations` (violations whose `from.context` or `to.context` is the context, any severity) is 0.
  - **boring:** `met` when `rulesWithoutTests` (from `rulesWithoutTests`, Untested included) and `openCandidates` are both 0.
  - **Ladder:** `suggestRung` is cumulative over `RUNGS`; each criterion's `met` is computed on its own (spec: reported separately).
  - **Metrics:** `rules.share` is `withTests / count` (3 decimals), `null` without rules; cross edges sum `byKind` of `boundaries.crossEdges` with `to` (in) or `from` (out) equal to the context; `drift` from `contextDrift(id, history, movedFiles, registryHash)`, `null` when undefined; `shadowSpecs` counts the context's candidates.
  - **Shadow-spec view:** `{ context: { id, name, rung }, counts: { open, resolved, byKind }, shadowSpecs, resolutionFile, staleResolutions: [{ fingerprint, line }], unknownRules: [{ fingerprint, rule, line }], resolutionProblems: [{ line, severity, message }] }`; `counts` cover the kinds filter; `shadowSpecs` holds open candidates, plus resolved ones with `includeResolved`, in `compareCandidates` order.

- [ ] **Step 1: Write the failing tests.**
  - `context-map.test.ts`:
    - `suggestRung follows the cumulative ladder` (`it.each`: nothing gives `fear`; pinned gives `pinned`; pinned and named give `named`; named alone gives `fear`; all four give `boring`; pinned, named and boring without bounded give `named`);
    - `pinned uses coverage against pinnedCoverage and falls back to a characterization test without main paths` (Review Focus 4: 4 of 5 at 0.8 met, 3 of 5 not; no main paths and no test not met with `coverage: null`; no main paths and one test met);
    - `named needs a card and every Language term in the glossary`; `a context without a card fails named and keeps its counts` (Review Focus 4);
    - `bounded needs every contract symbol reached and no violation in or out`;
    - `boring needs every rule tested and no open candidate; Untested rules block it`;
    - `every criterion is reported even when a lower one fails`; `a context without rules has share null` (Review Focus 4); `the summary counts agreement`; `the same input gives deep-equal views`.
  - `shadow-specs-view.test.ts`: `open candidates only unless includeResolved`; `counts cover the kinds filter`; `lists sit at the top level so the envelope can truncate shadowSpecs, staleResolutions, unknownRules and resolutionProblems` (all four are arrays of the new tool and are truncatable fields, Task 8).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/core/__tests__/context-map.test.ts src/core/__tests__/shadow-specs-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(domain): suggested rung with per-criterion status, the context map and shadow-spec views (#156)"`.

---

### Task 8: MCP tools `find_shadow_specs` and `get_context_map`

**Files:**
- Create: `packages/domain/src/mcp/loop-state.ts`, `packages/domain/src/mcp/loop-tools.ts`
- Modify: `packages/domain/src/mcp/domain-tools.ts` (`domainTools` appends `loopTools`), `packages/domain/src/index.ts`; `packages/cli/src/core/response-envelope.ts` (`TRUNCATABLE_FIELDS`). Before editing: the two MCP tools on `domainTools`, `register` and `wrapResponse`.
- Test: `packages/domain/src/mcp/__tests__/loop-state.test.ts`, `loop-tools.test.ts`, `packages/cli/src/core/__tests__/response-envelope.test.ts`

**Interfaces:**
- Consumes: Tasks 3 to 7; `DomainState`, `STALE_CARDS_HINT`, `canonicalRuleId` (PR 3); `DomainArtifactStore` (PR 2B); `ModuleToolDefinition` (PR 2B).
- Produces:
  ```ts
  // loop-state.ts
  export interface LoopSnapshot { readonly domain: DomainSnapshot; readonly candidates: readonly ShadowCandidate[]; readonly maturity: MaturityArtifact;
    readonly boundaries?: BoundariesArtifact; readonly history: readonly ContextHistoryEntry[]; readonly movedFiles: readonly MovedFile[];
    readonly shadowSpecs: readonly LoadedShadowSpecs[]; readonly stale: boolean }
  export type LoopStateResult = { readonly ok: true; readonly snapshot: LoopSnapshot } | { readonly ok: false; readonly hint: string };
  export interface LoopState { load(): LoopStateResult }
  export function createLoopState(host: CtxoHost, state: DomainState): LoopState;   // artifacts mtime-cached; shadow-specs.yaml read on every load
  // loop-tools.ts
  export const FIND_SHADOW_SPECS = 'find_shadow_specs'; export const GET_CONTEXT_MAP = 'get_context_map';
  export function loopTools(host: CtxoHost, state: DomainState): ModuleToolDefinition[];
  ```
- States: a not-ok `DomainState` gives its hint; missing artifacts or another `registryHash` give `No shadow-spec data yet; run "ctxo index".`; a `cardsHash` other than the graph's sets `stale: true` (responses add `stale: true` and `hint: STALE_CARDS_HINT`). Every not-ok answer is `{ found: false, hint }`.
- `find_shadow_specs`: an unknown context gives `{ found: false, hint: 'No context <id> in the registry; get_context_map lists the contexts.' }`; otherwise `applyResolutions(candidatesOf(...), entries, raw => canonicalRuleId(index, raw))` and `shadowSpecsView` with `resolutionFile = shadowSpecsPath(registryPath, id)`.
- `get_context_map`: `buildContextMap` with every context's candidates after file resolutions.
- Copy (exact):
  - `find_shadow_specs` description: `Find shadow-spec candidates in a named context: business-looking logic that no card rule pins yet. Candidates are literal comparisons in conditions, string normalization, retry and timeout values and public endpoints in the context's code, the SQL tables, views and procedures it owns, and its rules without tests. Each has its file, line, symbol, a line-independent fingerprint, its source (native analysis, text scan, the index or the card) and its resolution: linked to a rule, marked Untested in the card, or resolved in the context's shadow-specs.yaml (the response names the file) with { rule: <ID> } or { notARule: "<reason>" }. Use this for the Deletion Test: for each open candidate, find or write the rule that pins it, or record why it is not a rule. Resolved candidates are hidden unless includeResolved is true. Large results are truncated with _meta.hint.`
  - Parameters: `context` `Context ID from the registry, e.g. lending` (required string); `kinds` `Candidate kinds to return (default: all): literal-comparison, normalization, retry-timeout, endpoint, data-resource, procedure, rule-without-tests` (optional array of the enum); `includeResolved` `Also return resolved candidates with their resolution (default false)` (optional boolean).
  - `get_context_map` description: `Get the map of named contexts: for each context its card, rule count and share of rules with tests, characterization and contract test counts, cross-context edges in and out, co-change with other contexts, drift, boundary violations and open shadow-spec candidates, plus the owner's rung from the registry, a suggested rung and the status of each criterion (pinned, named, bounded, boring). Use this to see how mature each context is and what blocks its next rung. The suggestion never changes the registry. Needs a domain registry (docs/domain/contexts.yaml).` No parameters.
- `TRUNCATABLE_FIELDS` gains the top-level arrays of the two new tools (both tools are new, so no existing tool's array is touched, and no `<name>Total` capping applies here):
  - `shadowSpecs`: `Use find_shadow_specs with kinds to narrow the list, or run "ctxo domain shadow-specs <context> --json" for every candidate.`
  - `contextMap`: `Run "ctxo domain map --json" for the full context map.`
  - `staleResolutions`: `Run "ctxo verify-domain --json" for every stale resolution in shadow-specs.yaml.`
  - `unknownRules`: `Run "ctxo verify-domain --json" for every resolution that names an unknown rule.`
  - `resolutionProblems`: `Run "ctxo verify-domain --json" for every problem in shadow-specs.yaml.`

- [ ] **Step 1: Write the failing tests.**
  - `loop-state.test.ts` (temp projects with artifacts from the Task 6 pass, a host from `createModuleHost`): `reports the PR 3 hints and a missing-artifact hint` (Review Focus 5); `marks stale cards after a card edit`; `reads shadow-specs.yaml on every call` (Review Focus 5: an entry written after the index resolves its candidate on the next `load()`).
  - `loop-tools.test.ts`:
    - `find_shadow_specs returns open candidates with file, line, symbol, fingerprint and source` (spec 12.4 at unit level);
    - `includeResolved adds resolved candidates with their resolution`; `kinds filters candidates and counts`;
    - `an unknown context gives a graceful hint`; `no registry gives found false, never an error`;
    - `get_context_map returns metrics, criteria and a suggested rung per context` (spec 12.4 at unit level);
    - `the same call twice gives identical payloads` (13.1); `input schemas are built with the host's zod` (a recording stub of `z`).
  - `response-envelope.test.ts`: `the new tools' arrays are truncatable with their hints` (`it.each` over `shadowSpecs`, `contextMap`, `staleResolutions`, `unknownRules` and `resolutionProblems`; `CTXO_RESPONSE_LIMIT=1024`, 100 items of 40 characters).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/core/__tests__/response-envelope.test.ts`, then `pnpm --filter @ctxo/cli build && pnpm --filter @ctxo/domain exec vitest run src/mcp`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS, PR 3's tool tests included. Then `pnpm --filter @ctxo/domain build && pnpm --filter @ctxo/domain lint`.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(domain): find_shadow_specs and get_context_map tools (#156)"`.

---

### Task 9: `ctxo domain map`, `ctxo domain shadow-specs` and verify-domain check 12

**Files:**
- Modify: `packages/domain/src/commands/domain-command.ts` (subcommands `map` and `shadow-specs`, help lines), `packages/domain/src/core/verify-checks.ts` (`VERIFY_CHECKS`, `VerifyInput`, check `12`), `packages/domain/src/commands/verify-domain-command.ts` (inputs for check 12). Before editing: the two MCP tools on `domainCommand`, `runVerifyChecks` and `verifyDomainCommand`.
- Test: `packages/domain/src/commands/__tests__/domain-command.test.ts`, `packages/domain/src/core/__tests__/verify-checks.test.ts`, `packages/domain/src/commands/__tests__/verify-domain-command.test.ts`

**Interfaces:**
- Produces: `VERIFY_CHECKS` gains `'12'` (title `Shadow-spec resolutions`); `VerifyInput` gains
  ```ts
  readonly shadowSpecs: readonly { readonly context: string; readonly path: string; readonly parsed?: ParsedShadowSpecs;
    readonly stale: readonly ResolutionEntry[]; readonly unknownRules: readonly ResolutionEntry[] }[];
  readonly orphanShadowSpecs: readonly string[];
  ```
- Check 12 (H6): each parse problem at its severity (`<path>:<line> <message>`); each stale entry a warning `stale resolution "<fingerprint>" matches no candidate of <id>`; each unknown rule a warning `resolution names unknown rule <rule>`; each orphan file a warning `<path> belongs to no context`. Skipped with the other checks when the registry has problems. `verify-domain` computes candidates from the index and the repo (E5): `buildDomainGraph` and `indexGraph` with the inputs it already builds for check 6, `textScanTargets` and `readTextFacts`, `buildShadowCandidates`, `readShadowSpecs`, `applyResolutions` per context, `findOrphanShadowSpecs`.
- Commands (H15), both on `createLoopState` in host mode `cli`:
  - `ctxo domain map [--json]`: no registry gives PR 2B's hint and exit 0; registry problems exit 2; missing artifacts print `[ctxo] No context map yet; run "ctxo index".` and exit 2. `--json` writes the `get_context_map` body (`JSON.stringify(view, null, 2)`) to stdout. Otherwise stderr gets `[ctxo] Context map: <n> contexts (<a> agree with the suggested rung)`, then per context `  <id>  rung <rung>  suggested <suggested>  rules <count> (<withTests> tested)  open candidates <open>  pinned <✓|✗> named <✓|✗> bounded <✓|✗> boring <✓|✗>`. Exit 0.
  - `ctxo domain shadow-specs <context> [--kinds <k,...>] [--all] [--json]`: a missing context argument prints the usage and exits 1; an unknown context prints `[ctxo] No context "<id>" in the registry.` and exits 1; an unknown kind prints `[ctxo] Unknown kind "<k>"; use one of: <kinds>` and exits 1. `--json` writes the `find_shadow_specs` body; `--all` means `includeResolved`. Otherwise stderr gets `[ctxo] <id>: <open> open, <resolved> resolved shadow-spec candidates (<resolution file>)`, then per candidate `  <open|resolved>  <kind>  <file>:<line>  <text>`, the fingerprint indented on the next line, and resolutions as `[linked: <IDs>]`, `[untested: <reason>]`, `[rule <ID>]`, `[not a rule: <reason>]`; stale entries follow as `  stale  <fingerprint> (line <n>)`. Exit 0.
  - Help lines (exact): `  ctxo domain map          Context map: metrics, rungs and suggested rungs per context (--json)` and `  ctxo domain shadow-specs <context>   Shadow-spec candidates of a context (--kinds, --all, --json)`.

- [ ] **Step 1: Write the failing tests.**
  - `domain-command.test.ts` (temp projects indexed through the built CLI): `domain map --json prints the context map and exits 0`; `domain map without artifacts exits 2 with the hint`; `domain shadow-specs lending --json prints open candidates and --all adds resolved ones`; `--kinds filters and an unknown kind exits 1`; `an unknown context exits 1`; `help lists map and shadow-specs`.
  - `verify-checks.test.ts`: `check 12 passes without shadow-specs files` (day one: no finding); `stale entries, unknown rules and orphan files warn`; `a broken file is an error`; `registry problems skip check 12`.
  - `verify-domain-command.test.ts`: `verify-domain computes candidates from the index and warns about a stale resolution` (exit 0; the JSON output's check 12 has one warning naming the fingerprint); `a syntax error in shadow-specs.yaml exits 1`; `uses the current shadow-specs.yaml, not artifacts`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/domain exec vitest run src/commands src/core/__tests__/verify-checks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS, PR 2B's and PR 3's verify tests included.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(domain): ctxo domain map, ctxo domain shadow-specs and the verify-domain check for stale resolutions (#156)"`.

---

### Task 10: Library-lending sample extension and the PR 4 acceptance tests

**Files:**
- Modify (both variants under `packages/domain/test-fixtures/library-lending/{csharp,typescript}/`): Lending sources, the Billing card's Language section, tests; create `docs/domain/lending/shadow-specs.yaml`
- Create: `packages/domain/test-fixtures/library-lending/plugins/ctxo-lang-lendingscript/package.json` and `index.js`; `packages/domain/e2e/__tests__/acceptance-loop.test.ts`
- Modify: `packages/domain/e2e/__tests__/sample-workspace.ts` (an option that junctions a fixture plugin into `node_modules`), `packages/domain/e2e/__tests__/acceptance.test.ts` (the no-registry test)

**Interfaces:**
- Consumes: `sample-workspace.ts` (PR 2B), `connectServer` (PR 3), the built server and CLI.
- Sample additions (synthetic; C# names, TypeScript analogs in brackets):
  - `src/Lending/RenewalPolicy.cs` with `CanRenew(int renewals)` holding `if (renewals > 2) return false;` [`src/lending/renewal-policy.ts`].
  - `src/Lending/MemberDirectory.cs` with `Key(string email) => email.Trim().ToLowerInvariant();` [`email.trim().toLowerCase()`].
  - `src/Lending/Api/LoansController.cs` (`[Route("api/[controller]")]`, `[HttpGet("{id}")] Get`, then `// rule: LEND-03` above `[HttpPost] Borrow`; ASP.NET stubs in `tests/Stubs/AspNetCore.cs`) [`src/lending/api/loans.controller.ts` with Nest `@Controller('loans')`, `@Get(':id') find`, `// rule: LEND-03` above `@Post() borrow`].
  - `tests/Lending.Tests/Characterization/LoanFlowCharacterizationTests.cs` with `[Fact] [Trait("Kind", "Characterization")] BorrowAndRead()` calling `Borrow` and `Get` [`src/lending/__tests__/loan-flow.test.ts` with `it('[characterization] borrow and read', ...)` constructing the controller].
  - Billing: the card's Language section lists `Account` only (the PR 3 glossary has `Account (context: billing)`); `tests/Billing.Tests/Characterization/ChargeCharacterizationTests.cs` and `tests/Billing.Tests/Contract/ChargeServiceContractTests.cs` (`Trait("Kind", "Characterization")`, `Trait("Kind", "Contract")`) calling the charge-service interface [`describe('[characterization] charges', ...)` and `describe('[contract] charge service', ...)` in `src/billing/__tests__/`]; `src/Billing/fees.py` [`src/billing/fees.py`] with `TIMEOUT_SECONDS = 30` and `if days > 14:`.
  - `docs/domain/lending/shadow-specs.yaml`: `{ rule: LEND-05 }` for the renewal comparison and `{ notARule: "input cleanup, not a business rule" }` for the `Trim` (`trim`) call, with each variant's fingerprints.
  - `ctxo-lang-lendingscript`: `apiVersion: '1'`, id `lendingscript`, extensions `['.lend']`, tier `syntax`, an adapter that turns `function <name> {` ... `}` blocks into `function` symbols and has no `extractFacts`.
- Expected rungs (registry rungs from PR 2B in brackets): lending `pinned` [pinned] (pinned met with both endpoints reached, named not met: `Hold`, `Member account` and `Account` lack glossary entries); billing `bounded` [bounded] (boring not met: three rules without tests and the open `fees.py` candidates); catalog `fear` [fear]. Before writing assertions, Step 1 checks that the sample still has PR 3's Lending terms and glossary and PR 2B's `lending.contracts.billing`; these rungs depend on them.

- [ ] **Step 1: Write the acceptance tests** (`acceptance-loop.test.ts`; one indexed workspace per variant in `beforeAll`; tests that change files use their own copy; symbol IDs come from `search_symbols`, never hard-coded C# IDs):
  - `find_shadow_specs lending returns open candidates with locations and sources` (both; 12.4): the `ToLowerInvariant` (`toLowerCase`) candidate and the `Get` (`find`) endpoint are open with `source: 'native'`, a 1-based line, a `symbolId` and a fingerprint; the `dbo.loans` table is open with `source: 'index'`.
  - `includeResolved marks resolved candidates` (both; 12.4): the renewal comparison has `{ by: 'shadow-specs', rule: 'LEND-05' }`, the `Trim` call `{ by: 'shadow-specs', notARule }`, `Borrow` (`borrow`) `{ by: 'rule-link', rules: ['LEND-03'] }`, `LEND-04` `{ by: 'untested' }`.
  - `get_context_map returns per-context metrics, criteria and suggested rungs` (both; 12.4): the rungs above, each criterion's evidence (lending `pinned.reached === 2`, billing `bounded.met`, catalog `pinned.coverage === null`), and lending `crossContextEdges.out >= 1`.
  - `the text fallback works for a v1 plugin` (12.4; a TypeScript copy whose `package.json` lists `ctxo-lang-lendingscript` together with the official plugins the test needs, `@ctxo/lang-typescript` for the sample code and `@ctxo/lang-sql` for the `.sql` migrations, because discovery loads only the plugins the project's `package.json` names (the official ones resolve through the CLI's own dependencies, as in PR 1B's CLI tests); the lendingscript plugin junctioned, and `src/lending/fees.lend` holding `function lateFee {`, `  if days > 14 then charge 2.5`, `  retries = 3`, `}`): candidates `days > 14` and `retries = 3` with `source: 'text'` and the `lateFee` symbol.
  - `an unindexed Python file in a context gets file-level text facts` (C#; 13.2): `TIMEOUT_SECONDS = 30` and `days > 14` with `source: 'text'` and `symbolId` `src/Billing/fees.py::fees::variable`.
  - `verify-domain warns about a stale resolution and still passes` (a copy appending a stale entry: exit 0, check 12 `warn` naming the fingerprint); `a resolution written after the index takes effect on the next call` (Review Focus 5).
  - `ctxo domain map --json and ctxo domain shadow-specs lending --json print the tool bodies` (deep-equal to the MCP bodies without `_meta`).
  - `tools/list holds 18 tools` (C#).
  - `candidate text passes the masking pipeline` (a copy with `if (apiKey == "AKIAIOSFODNN7EXAMPLE")` in a Lending file: the candidate text is masked).
  - `the same input twice gives byte-identical shadow-candidates.json and maturity.json and identical tool payloads` (both; 13.1).
  - Extend PR 2B's and PR 3's no-registry test: `find_shadow_specs` and `get_context_map` answer `found: false`, never `error`, and core responses gain no new key.
- [ ] **Step 2: Run them.** `pnpm -r build && pnpm --filter @ctxo/domain test:e2e`. Expected: the new tests FAIL until the sample exists.
- [ ] **Step 3: Write the sample files.** C# runs on the tree-sitter tier without dotnet and on Roslyn with it; facts and fingerprints agree (Part 1).
- [ ] **Step 4: Run them.** Expected: PASS, the PR 2B and PR 3 acceptance tests included (`verify-domain` on the sample still has warnings only). If one fails, fix the code under test, not the expectation.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture folders; `git commit -S -m "test(domain): library-lending Deletion Test loop sample with the PR 4 acceptance tests (#156)"`.

---

### Task 11: Docs, ADR addenda, help, changeset and full verification

**Files:**
- Modify: `docs/features/domain-knowledge.md`, `docs/architecture/ADR/adr-017-plugin-protocol-v2-and-data-coupling.md` (addendum), `docs/architecture/ADR/adr-018-domain-knowledge-layer.md` (addendum), `docs/roadmap.md`, `CHANGELOG.md`, `llms.txt`, `llms-full.txt`, `README.md`, `CLAUDE.md`, `packages/domain/README.md`, `packages/domain/skills/ctxo-domain-fold/SKILL.md`, `packages/lang-java/README.md`, `packages/lang-go/README.md`
- Modify (site): `site/docs/mcp-tools/overview.md`, `tool-selection-guide.md`; `site/docs/cli/domain.md`; `site/docs/reference/config-schema.md`; `site/docs/concepts/domain-knowledge.md`; `site/docs/languages/typescript.md`, `csharp.md`, `java.md`, `go.md`, `writing-a-plugin.md`; `site/docs/.vitepress/config.ts`
- Create: `site/docs/mcp-tools/find-shadow-specs.md`, `site/docs/mcp-tools/get-context-map.md`, `.changeset/agentic-loop.md`

- [ ] **Step 1: Feature doc** (`docs/features/domain-knowledge.md`), new sections:
  - **Facts:** the four kinds with the spec 12.1 table, Part 1's Fact contract in reader form (conditions, literal forms, the trivial list, normalization patterns, name fragments, durations and units, endpoint rules per framework, attribution, the 500 cap), native and tree-sitter tiers per language, the text fallback and its limits (single-line heuristics), `domain.facts` and `index.facts`, and the tier note (facts agree across tiers; C#'s `(n)` suffix is ignored by fingerprints).
  - **The Deletion Test loop:** candidates and sources, fingerprints with the spec example, the resolution order, the `shadow-specs.yaml` format with `packages/domain/schema/shadow-specs.schema.json` embedded, `find_shadow_specs`, `ctxo domain shadow-specs`, check 12.
  - **Context map and rungs:** the metrics, the ladder with every criterion, the K13a conventions and how discovery proposes their paths, reachability rules and their limits (HTTP-level tests do not create graph edges), `get_context_map`, `ctxo domain map`.
  - **Artifacts:** rows for `shadow-candidates.json` and `maturity.json`; **degradation:** the spec 13.2 rows for facts; **tool count:** "14 core tools; 18 with `@ctxo/domain`"; "Ctxo domain conventions v1" level 4 gains the resolution schema (no level needs code changes).
- [ ] **Step 2: Other docs.**
  - ADR-017 addendum "Fact detectors (PR 4)": evidence protocol, `--facts=`, `PluginContext.config.facts`, `facts: []`, rules on the TypeScript side, the conformance vectors. ADR-018 addendum: `indexCapabilities.factOptions`, the host service `readCoChangeEntries`, the two artifacts, the two tools.
  - Site: the two tool pages (parameters, response fields, graceful misses, synthetic examples); `overview.md` and the sidebar's Domain group list four domain tools; `tool-selection-guide.md` gains "Running the Deletion Test? Use find_shadow_specs, then get_rule" and "How mature is each context? Use get_context_map"; `cli/domain.md` the two subcommands and check 12; `config-schema.md` the `domain.facts`, `domain.tests.characterization`, `domain.tests.contract` and `domain.rungs` keys with defaults; the language pages the facts per language; `writing-a-plugin.md` `extractFacts`, `capabilities.facts`, `config.facts` and `facts: []`; `concepts/domain-knowledge.md` the loop summary.
  - `llms.txt` and `llms-full.txt`: both tools with parameters, the CLI subcommands, the config keys, the fact kinds, a "New in" entry; `README.md` the tool list; `CLAUDE.md` the status line and tool table (four `@ctxo/domain` tools), the Quick Reference (`ctxo domain map`, `ctxo domain shadow-specs <context>`) and a Tool Selection Guide entry; the domain, Java and Go READMEs; `ctxo-domain-fold/SKILL.md` one line: "To find business logic no rule pins yet, call find_shadow_specs for the context."
  - `docs/roadmap.md`: PR 4 shipped; Deferred rows with triggers: route prefixes from Express mounts, gin groups and `MapGroup` (evidence of missed endpoints); endpoint frameworks beyond the list (chi, echo, Koa, Hono, Flask in a native plugin) (user demand); HTTP-level reachability from characterization tests (owners reporting under-detected pinned); configurable retry and timeout name fragments (fixture or user noise reports); multi-line text-scan heuristics (fallback precision reports).
  - `CHANGELOG.md` `[Unreleased]`. Added: fact detectors in four languages and both tiers, the text fallback, `find_shadow_specs`, `get_context_map`, `ctxo domain map`, `ctxo domain shadow-specs`, `shadow-specs.yaml`, verify-domain check 12, the `domain.facts`, K13a and `domain.rungs` keys. Changed: with a fact request, files of fact-capable plugins carry `facts` (possibly empty) in their index JSON; `ctxo watch` requests facts like `ctxo index`; `ctxo domain discover` proposes Characterization and Contract paths.
- [ ] **Step 3: Changeset** `.changeset/agentic-loop.md`: `"@ctxo/cli": minor`, `"@ctxo/domain": minor` (the `fixed` group), `"@ctxo/lang-typescript": minor`, `"@ctxo/lang-csharp": minor`, `"@ctxo/lang-java": minor`, `"@ctxo/lang-java-analyzer": minor`, `"@ctxo/lang-go": minor`, with a three-sentence note naming #156 Phase 4. `@ctxo/plugin-api` gets none: only its unpublished `conformance/` data changed. Run `pnpm changeset status --verbose`. Expected: those bumps, no `major`, `@ctxo/cli` and `@ctxo/domain` on the same next version, and `@ctxo/lang-java` and `@ctxo/lang-java-analyzer` on the same next version (otherwise stop and ask the owner).
- [ ] **Step 4: Help and text checks.** In a temp project with the domain junction, `node packages/cli/dist/index.js --help` lists `ctxo domain map` and `ctxo domain shadow-specs`; `ctxo domain --help` prints both usages; `git diff -U0 HEAD -- docs CHANGELOG.md llms.txt llms-full.txt CLAUDE.md README.md site .changeset packages/*/README.md packages/domain/skills | LC_ALL=C.UTF-8 grep -nP '^\+.*\x{2014}'` prints nothing.
- [ ] **Step 5: Full verification.** `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r typecheck && pnpm -r lint && CTXO_JDT_ANALYZER_JAR="$PWD/packages/lang-java-analyzer/jar/ctxo-jdt-analyzer-17.jar" pnpm -r test && pnpm --filter @ctxo/cli test:e2e && pnpm --filter @ctxo/domain test:e2e && mvn -q -f packages/lang-java-analyzer/java/pom.xml -Pjava17 test && (cd packages/lang-go/tools/ctxo-go-analyzer && go vet ./... && go test ./...)`. Expected: all green, the tarball test included (raise the limit with measurements if crossed). `pnpm --filter @ctxo/domain pack --dry-run` lists `dist/`, `skills/`, `schema/` (with `shadow-specs.schema.json`) and `README.md` only.
- [ ] **Step 6: Commit.** Stage the Files block paths; `git commit -S -m "docs: fact detectors, the Deletion Test loop, the context map, CLI help and the changeset (#156)"`.

---

### Task 12: Scale, speed and precision smoke on the private fixture (nothing committed)

- [ ] **Step 1:** In the private fixture clone (path in the owner's brief; never the original checkout), with the `node_modules/@ctxo/domain` junction and PR 2B's mechanically derived private registry (rung fear, no cards; clone only), run `node <worktree>/packages/cli/dist/index.js index` twice. Expected: no crash; the `Domain:` log line with the candidate count; pass time at most 2 s (spec 13.4); byte-identical `shadow-candidates.json` and `maturity.json` across both runs.
- [ ] **Step 2:** Through the dev build's MCP server: `get_context_map`, and `find_shadow_specs` for the three largest contexts with and without `includeResolved`. Expected: no `error` response; each call under 500 ms.
- [ ] **Step 3:** `ctxo verify-domain --json` and `ctxo domain map --json`. Expected: exit 0 or 1 (never 2) for verify, 0 for the map.
- [ ] **Step 4:** Record aggregate numbers only in the scratchpad PR draft: candidates by kind and source, native against text share, suggested rungs by rung, pass time, call latencies, and Part 1 Task 4's precision shares. Nothing from the fixture enters the repository.

---

## Spec coverage (self-review, both parts)

| Spec | Part and task |
|---|---|
| 12.1 detectors, lists, trivial literals, native and tree-sitter tiers, C# first | Part 1 Tasks 2 to 10 |
| 12.1 text fallback in `@ctxo/domain` (comments and strings stripped, symbol spans, `source: text`) | Part 2 Task 2; 13.2 unindexed languages: Task 2, Task 10 |
| 12.2 candidates with file, line, symbol, fingerprint, source, resolution | Task 3, Task 7 |
| 12.2 fingerprint, rule-link auto-resolution, `shadow-specs.yaml`, stale warning | Tasks 3, 4, 9 |
| 12.2 `find_shadow_specs({ context, kinds?, includeResolved? })` | Task 8 |
| 12.3 per-context metrics, rung, `suggestedRung`, criteria, cumulative ladder | Tasks 5, 6, 7, 8 |
| 12.3 K13a conventions with defaults, `pinnedCoverage` 0.8 | Task 1, Task 5 |
| 12.4 acceptance: candidates with locations and sources, resolved marked; map; native facts in four languages; text fallback for a v1 plugin | Task 10; Part 1 Task 10 |
| 13.1 determinism; 13.3 masking, envelope, `TRUNCATABLE_FIELDS`; 13.4 budgets; 13.5 artifacts | Tasks 6, 8, 10, 12; Part 1 Task 2 |
| 14 fixture: C# first, scale and speed, aggregates only | Part 1 Task 4 Step 6; Task 12 |
| 15 docs, CLI help, llms files, site, CHANGELOG, roadmap, ADR addenda, changesets | Task 11 |
