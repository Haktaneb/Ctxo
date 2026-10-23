# PR 4, Part 1: Fact Detectors in the Four Official Language Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native fact detectors for `literal-comparison`, `normalization`, `retry-timeout` and `endpoint` in the primary and tree-sitter tiers of the TypeScript, C#, Java and Go plugins, produced only when the host requests facts, with configurable lists delivered by the host and one shared rule set (Phase 4 of #156, spec 12.1; K12). Part 2 (`docs/superpowers/plans/2026-10-21-pr4-2-agentic-loop-tools.md`) adds the text-scan fallback, `find_shadow_specs` and `get_context_map` on the same branch; both parts become one PR.

**Architecture:**
- One normative Fact contract (below). Each plugin's TypeScript side owns the rules in `src/facts/` (`fact-types.ts`, `fact-options.ts`, `fact-rules.ts`, `finish-facts.ts`, copied unchanged between plugins, plus a language-specific `annotation-endpoints.ts`). Shared conformance vectors in `packages/plugin-api/conformance/fact-vectors.json` keep the copies, the analyzers and Part 2's text scan in agreement.
- Native tiers find evidence: ts-morph in process; the Roslyn helper (IOperation), the JDT analyzer and ctxo-go-analyzer report `factEvidence` records in their own JSON behind `--facts=<base64>`. Tree-sitter tiers find the same evidence with simple CST queries. `finishFacts` turns evidence into `CodeFact`s the same way for both tiers, so tiers agree by construction on everything except what the parser can see.
- The CLI hands `@ctxo/domain`'s lists (`indexCapabilities.factOptions`) to plugins as `PluginContext.config.facts`, writes `facts: []` for a fact-capable adapter that found nothing (Part 2 then knows which files need the text fallback), and requests facts in `ctxo watch` exactly as in `ctxo index`.

**Tech Stack:** TypeScript (ESM, Node >= 20), ts-morph 28, tree-sitter 0.22 with tree-sitter-c-sharp 0.23.1, tree-sitter-java 0.23.5 and tree-sitter-go 0.23.4, vitest; C# (.NET 8 target, Roslyn 4.12 IOperation); Java 11/17 (Eclipse JDT Core, Gson, JUnit 5, Maven); Go (`go/ast`, `go/types`, golang.org/x/tools/go/packages); pnpm workspace with changesets.

**Spec:** `docs/superpowers/specs/2026-10-20-domain-knowledge-layer-design.md`, section 12.1, with 3, 4, 5, 8.2 and 8.3 (facts protocol), 8A (annotations, test symbols, analyzers), 13, 15 and 18 (K12; the PR 4 calls: the fact detector lists and the trivial-literal list). Interfaces consumed from `docs/superpowers/plans/2026-10-21-pr1b-plugin-v2-and-sql.md`, `2026-10-21-pr1c-language-parity.md`, `2026-10-21-pr2b-1-domain-package.md`, `2026-10-21-pr2b-2-domain-checks-and-surfaces.md` and `2026-10-21-pr3-domain-graph.md`.

## Global Constraints

- **Base:** branch `feat/agentic-loop-156` in its own worktree, stacked on the tip of `feat/domain-graph-156` once PR 3 (and before it PRs 0, 1A, 1B, 1C, 2A, 2B) is complete. Consumed by name (Task 0 confirms each):
  - PR 1B: `FACT_KINDS`, `FactKind`, `CodeFact` (0-based `line`, single-line trimmed `text`), `ILanguageAdapter.extractFacts?(filePath, source)`, `PluginCapabilities { facts?, sqlCallSites? }`, `PluginContext.capabilities`, `hostCapabilities`, `LoadPluginsOptions.facts`, `factsRequested`, `extractFileFacts`, Phase 1c of `IndexCommand.run`, `buildWatchFileIndex`, `CodeFactSchema`, `index.facts`; C# `toSymbolNode`, `toGraphEdges`, `RoslynRunOptions`, `RoslynKeepAlive`, `CSharpCompositeAdapter({ sqlCallSites })`, the `csharp-v2-sample` fixture; `HAS_DOTNET`.
  - PR 1C: TypeScript `TsMorphAdapterOptions`, `ModuleResolver`, `receiverModule`, `packageOfSpecifier`, `symbolScopes`, `findTestBlocks`, `classAnnotations`, `methodAnnotations`, `readLendingSample`, `writeLendingSample`, the `lending-sample` fixture; Java `toSymbolNode`, `RunOpts`, `JdtKeepAlive`, `JdtAnalyzerAdapter({ sqlCallSites })`, `JavaCompositeAdapter({ sqlCallSites })`, `Analyzer(rootDir, classpath, sqlCallSites)`, `testAnalyzerJar`, `CAN_RUN_JDT`, `LENDING_FIXTURE`; Go `GoAnalyzerRunOptions`, `buildGoAnalyzerArgs`, `runBatchAnalyze`, `GoAnalyzerAdapter({ sqlCallSites })`, `GoCompositeAdapter({ sqlCallSites })`, `options`, `run(root, opts, stdout)`, `symbols.FuncDeclSymbolID`, the `lending-module` fixture with its `stubs/`; `detectGoToolchain`.
  - PR 2B: `CtxoModuleRegistration.indexCapabilities`, `LoadedModule`, `loadCtxoModules`, `createModuleHost`, `IndexCommand.run({ modules })`; PR 3 leaves `FileIndex.facts` untouched.
- **Protocol (spec 8.2, verbatim):** `FACT_KINDS = ['literal-comparison', 'normalization', 'retry-timeout', 'endpoint']`; `CodeFact { kind, symbolId /* enclosing symbol */, line, text /* single line, trimmed, capped at 200 chars */, detail? }`; `extractFacts?(filePath, source): Promise<CodeFact[]>`; `capabilities.facts` means the host wants `extractFacts`. Facts live in the JSON index only (SQLite unchanged).
- **Detection table (spec 12.1, verbatim):**
  - `literal-comparison`: a comparison in a condition (`if`, `while`, ternary, `switch case`, `when`) with a literal operand other than 0, 1, -1, null, true, false, empty string (configurable); `detail` `operator`, `literal`.
  - `normalization`: string normalization on a value: `ToLower*`, `ToUpper*`, `Trim*`, `Normalize`, `toLowerCase`, `toUpperCase`, `trim`, `strings.ToLower`, `strings.TrimSpace`, `equalsIgnoreCase` (configurable list); `detail` `method`.
  - `retry-timeout`: a numeric constant bound to a name containing retry, retries, attempt, timeout, delay, backoff, ttl, expir; or a duration constructor (`TimeSpan.From*`, `Duration.of*`, `time.Second * n`, `setTimeout(..., n)`); `detail` `name`, `value`.
  - `endpoint`: a public route: C# `[HttpGet]`/`[Route]`/`MapGet`, TS Express/Fastify/Nest, Go `http.HandleFunc`/gin, Java `@GetMapping` and friends; `detail` `verb`, `route`.
  - All four languages produce facts natively in their primary tier (TypeScript ts-morph, C# Roslyn IOperation, Go the analyzer, Java JDT) and their tree-sitter tiers through simple queries. C# is validated first on the fixture.
- **Opt-in:** a plugin produces facts only when `ctx.capabilities?.facts === true`; analyzers collect evidence only with `--facts=`. Without the request, index JSON is byte-identical to PR 3's.
- **Dependencies:** language plugins import only `@ctxo/plugin-api`, the documented exception `@ctxo/sql-extract` (ADR-017), their own parsers and Node built-ins, never `@ctxo/cli`; the copied `src/facts/` modules keep that rule. Inside `@ctxo/cli` the hexagonal rules hold (`core/` never imports `adapters/` or `ports/`, `ports/` never imports `adapters/`, only the composition roots wire adapters, no barrel exports, every adapter implements a port). `@ctxo/domain` imports only types from `@ctxo/cli/internal`.
- **Versions:** the four plugins keep `apiVersion: '1'` and PR 1C's peer range; `extractFacts` is optional, so older cores ignore it.
- **Output channels:** never `console.log`. Plugins log through their own `createLogger` (DEBUG-gated, stderr); analyzers keep JSONL on stdout and diagnostics on stderr. Adapters warn and continue: a detector failure returns no facts for that file, never a failed index. Every MCP response passes through `wrapResponse` and `masking.mask` (Part 2's tools).
- **Determinism (spec 13.1):** codepoint ordering (`a < b ? -1 : a > b ? 1 : 0`, `StringComparer.Ordinal`, `sort.Strings`, `String.compareTo`), never `localeCompare`; no wall clock or randomness; the same input twice gives deep-equal facts.
- **Tests:** vitest in `__tests__/`; JUnit 5 in `packages/lang-java-analyzer/java/src/test`; Go tests next to the Go sources. Gates: `describe.skipIf(!HAS_DOTNET)`, `describe.skipIf(!CAN_RUN_JDT)`, `describe.skipIf(!detectGoToolchain().available)`. Go fixture modules are copied to a temp dir before analysis. Fixtures use stub types with the real namespace, package and type names, never downloaded dependencies. Every git operation that creates commits in a temp repo (commit, merge, rebase, cherry-pick, amend, revert, tag) passes `-c commit.gpgsign=false -c user.name=Test -c user.email=test@test.com`, plus `-c tag.gpgsign=false` for tags.
- **Toolchains (local):** Node 24, .NET 10 SDK with runtimes 8, 9 and 10, Go 1.24 and 1.25 (`GOTOOLCHAIN=auto` inside the analyzer module), JDK 21, Maven 3.9. Every gated test runs on this machine.
- **Build order:** rebuild `@ctxo/plugin-api` and `@ctxo/sql-extract` before plugin tests, both JARs (`pnpm --filter @ctxo/lang-java-analyzer build`) after Java changes, and `@ctxo/cli` before domain or e2e tests; the Go binary rebuilds itself (its cache key hashes the analyzer sources).
- **Git:** stage exactly the task's paths (`git add <path>...`, never `-A` or `.`), never `.ctxo/` or `.claude/settings.local.json`. Branch commits are GPG-signed (`git commit -S`); on a signing failure stop and report BLOCKED. The post-commit hook may take minutes; wait for the commit to return. No `Co-Authored-By` or AI attribution lines. No push, PR, publish or issue comment without the owner's approval.
- **Safe edits:** before editing an existing symbol, call the ctxo MCP tools `get_blast_radius` and `get_why_context` on it (each task names the symbols). Java and Go analyzer sources are outside this repo's ctxo index, so `found: false` is expected there; note it in the task report. More generally, the session's ctxo MCP server indexes the main checkout (older code), so `found: false` from either tool for a symbol added on these branches is expected: call the tools as the project rule asks, then proceed.
- **Text:** English only, no em dashes, no `Co-Authored-By`.
- **Privacy:** every sample is the synthetic library-lending domain (loans, members, holds); nothing from any private repository in code, tests, docs, commits or PR text. Fixture work happens only in the private fixture clone (path in the owner's brief); scripts and raw output stay in the session scratchpad; only aggregate numbers leave it.
- **Tarball:** the CLI limit is 1350 KB (`packages/cli/tests/e2e/release-packaging.test.ts`); when crossed, raise it to the measured size rounded up to the next 50 KB with both numbers in the PR description.

## Review Focus

1. **Generated or very large files** (designer files, EF migrations and model snapshots, lookup tables with thousands of `case` labels, minified bundles): facts must not balloon the committed index. Expected: at most 500 facts per file, the first 500 in fact order, identical on every run. Test: Task 4 `a generated file with 2,000 case labels gives 500 facts`.
2. **The same repository indexed on machines with different tiers** (a developer with .NET, Go or a JRE, CI without): fingerprints in Part 2 depend on fact text and the enclosing symbol. Expected: both tiers give the same `kind`, `line`, `text`, `detail` and, after removing C#'s `(n)` parameter suffix, the same `symbolId` for the fixtures' members, private members and fields included. Tests: Tasks 4, 7 and 9 `both tiers give the same facts`.
3. **Facts lost by the incremental paths:** the post-commit hook (`ctxo index --commit HEAD`), `--files` and `ctxo watch` rewrite one file's JSON; a run that forgets the request or the options silently drops native facts and Part 2 falls back to the noisier text scan. Expected: incremental runs keep untouched files' facts and refresh the touched file's; watch requests facts with the module's options. Tests: Task 1 `ctxo index --commit HEAD keeps facts of untouched files`, `watch requests facts like index`.
4. **Literals that look trivial and are not, or the reverse:** `"0"` (string) against `0`, `0.0`, `0x0`, `1L`, `1m`, `-1`, `""` against `''`, `@""` and Go raw strings, YAML-typed lists (`null`, `true`, `""` arrive as non-strings). Expected: typed comparison, so `"0"` is reported and `0.0` is not. Tests: Task 2 vectors `isTrivialLiteral`, `readFactOptions keeps typed trivial literals and falls back per field`.
5. **CRLF sources, tabs, non-ASCII text and long expressions:** line numbers must not shift and text must not split a surrogate pair. Expected: CRLF and LF copies give identical facts; text is whitespace-collapsed and cut at 200 code points. Tests: Task 2 vectors `normalizeFactText`, Task 4 `CRLF line endings give the same facts`.

## Designer calls (spec gaps decided here; the owner may override)

- **G1 Evidence, then one finisher.** Analyzers and CST walkers report syntactic evidence (`comparison`, `call`, `binding`, `duration`, `route`); `finishFacts` on each plugin's TypeScript side applies the trivial-literal list, evaluates numbers, builds text and `detail`, attributes, sorts and caps. Analyzers apply only the normalization patterns and the retry/timeout name rule, to keep their output small (PR 1C's precedent: analyzers report, the TypeScript side decides).
- **G2 Options channel without a protocol change.** `@ctxo/domain` declares `indexCapabilities.factOptions` (Part 2 Task 1); the CLI passes them as `PluginContext.config.facts` (a host-reserved key of the existing `Record<string, unknown>`); analyzers get `--facts=<base64 of UTF-8 JSON { "normalizationMethods": [...] }>`, one argument because the Roslyn helper treats its first non-flag argument as the solution. Absent or invalid options fall back per field to the spec lists.
- **G3 Typed trivial literals:** numbers, strings, booleans and `null`, so the string `"0"` is not the number `0`; Go `nil` counts as `null`.
- **G4 Condition shapes:** comparisons are found through `&&`, `||`, `!`, parentheses and C# pattern combinators only, never inside calls or lambdas; exactly one operand must be a literal; a case label or arm compares the switch subject (`<subject> case <label>`, operator `case`); relational patterns keep their operator.
- **G5 Normalization by name:** the callee's simple name is matched; `Name*` is a prefix pattern; `q.Name` matches only calls written `q.Name(...)`; `detail.method` is the simple name. No receiver-type check, so tiers agree.
- **G6 Retry and timeout:** the name rule works on identifier-token boundaries (`settlementDays` never matches `ttl`); a numeric constant is a number literal or `+ - * /` arithmetic of number literals (named constants are not followed, so tiers agree); every duration constructor with a constant amount is a fact; `text` is `<name> = <value>`, with a unit for durations (`Timeout = 30s`, the spec 12.2 example).
- **G7 Endpoints:** attribute, annotation and decorator routes (C#, Java, Nest) are built on the TypeScript side from symbol annotations, which both tiers already emit; call routes (minimal APIs, Express, Fastify, `net/http`, gin) come from evidence. Express and Fastify receivers must trace to `express` or `fastify` through PR 1C's provenance walk. Mount prefixes, route groups and `MapGroup` are not followed. Verbs are upper case; `ANY` when none is declared.
- **G8 Attribution:** a fact belongs to its innermost enclosing declaration. Full tiers use their own symbol ID. A syntax tier uses its own ID when it indexes the declaration, else the ID its full tier would give (fields, properties, private and non-exported members); code outside every declaration belongs to the module symbol `<file>::<basename without extension>::variable` (the TypeScript adapter's existing import-edge source).
- **G9 Text and limits:** whitespace runs collapse to one space, trimmed, at most 200 Unicode code points; facts sorted by line, `FACT_KINDS` order, text, then `detail` JSON; duplicates dropped; at most 500 per file.
- **G10 `facts: []`:** a fact-capable adapter that finds nothing writes an empty list (PR 1B wrote no key), so Part 2 runs the text fallback only for files whose plugin has no detectors. Repos without a fact request are unchanged.
- **G11 Watch parity:** `ctxo watch` loads modules, like `ctxo index`, to compute the fact request.
- **G12 Test files** get facts too; Part 2 excludes them from candidates.
- **G13 Vectors** live in `packages/plugin-api/conformance/fact-vectors.json`: test data next to the protocol owner, outside its published `files`, read along the dependency direction by every plugin's tests.

## Fact contract (normative for Tasks 2 to 10, and for Part 2's text scan)

- **FC-1 Shape.** `CodeFact` per spec 8.2. `detail`: `literal-comparison` `{ operator, literal }`; `normalization` `{ method }`; `retry-timeout` `{ name, value }`; `endpoint` `{ verb, route }`. `line` is the 0-based line where the evidence node starts.
- **FC-2 Text.** `normalizeFactText`: every whitespace run (line breaks included) becomes one space, trimmed, cut at 200 code points (no ellipsis, never inside a surrogate pair).
- **FC-3 literal-comparison.** Conditions are the tests of `if`, `while`, `do ... while`, the `for` condition, the ternary condition, C# `when` guards (case labels, switch arms, catch filters), Go tagless `switch` case expressions, and switch case labels and arms. Inside a condition, comparisons (`==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`, C# relational, constant and `not` patterns) are found through `&&`, `||`, `!`, parentheses and C# `and`/`or` patterns. Exactly one operand is a literal: a number (optionally signed), string (any quote form, verbatim, raw, text block), char, `true`, `false`, `null` or `nil`. `operator`: as written; `case` for case labels and arms with a constant; a relational pattern's operator; `==` for an `is` constant pattern, `!=` for `is not`. `literal`: the literal's source text. `text`: the comparison's source; `<subject> case <label>` for case labels and arms; the `is` expression for patterns. Dropped when trivial (FC-6).
- **FC-4 normalization.** A call whose callee simple name matches a pattern of `normalizationMethods`: `Name` exact, `Name*` prefix, `q.Name[*]` only when the call is written `q.Name(...)` (`q` is the receiver's source, for example Go's `strings`). `method`: the simple name. `text`: the call's source.
- **FC-5 retry-timeout.** Name rule (`hasRetryTimeoutFragment`): split the name into lower-cased tokens (camelCase, PascalCase, `_`, `-`, digit runs); a fragment of `retry`, `retries`, `attempt`, `timeout`, `delay`, `backoff`, `ttl`, `expir` matches when the concatenated tokens, read from the start of some token, begin with it (`TimeOut` and `tokenTTL` match, `settlementDays` and `relay` do not). Bindings: declarations with an initializer (variables, constants, fields, properties), assignments to a name or member (the last segment is the name), object-literal and initializer members, named arguments, annotation members, Go composite-literal keys. The value must be a numeric constant (FC-7) or a duration constructor. Duration constructors (amount must be constant): C# `TimeSpan.From{Milliseconds,Seconds,Minutes,Hours,Days,Microseconds}(n)`; Java `Duration.of{Millis,Seconds,Minutes,Hours,Days,Nanos}(n)` and `Duration.of(n, ChronoUnit.{MILLIS,SECONDS,MINUTES,HOURS,DAYS,NANOS,MICROS})`; Go `n * time.X`, `time.X * n`, `time.Duration(n) * time.X` and a bare `time.X` (n = 1) for X in Nanosecond, Microsecond, Millisecond, Second, Minute, Hour; TypeScript and JavaScript `setTimeout(fn, n)`. Units: `ns`, `us`, `ms`, `s`, `min`, `h`, `d`. A duration bound to a name is one fact under that name, whatever the name; an unbound one is named by the constructor's last two `.` segments (`TimeSpan.FromSeconds`, `Duration.ofMinutes`, `time.Second`); `setTimeout` is always `setTimeout`. `value`: the canonical number, plus the unit for durations. `text`: `<name> = <value>`.
- **FC-6 Trivial literals.** `isTrivialLiteral(literal, kind, list)`: numbers compare by canonical value with the list's numbers; strings and chars by decoded content (delimiters removed, `\"`, `\'`, `\\`, `\n`, `\t`, `\r` and doubled quotes decoded) with the list's strings; `null`/`nil`/`None` with `null`; booleans (case-insensitive) with booleans. Default list `[0, 1, -1, null, true, false, '']`.
- **FC-7 Canonical number.** `canonicalNumber(expression)`: remove `_` and type suffixes (`L l U u UL ul m M d D f F n`), read decimal, exponent, `0x`, `0b` and `0o` forms, evaluate `+ - * /` with parentheses and unary minus in IEEE doubles; an integer result prints without a decimal point, otherwise rounded to 6 decimals with trailing zeros removed; `-0` prints `0`; anything else (names, division by zero, strings) is not a constant (`undefined`).
- **FC-8 endpoint.** `text`: `<VERB> <route>`. `joinRoute(...parts)`: drop empty parts, trim each part's leading and trailing `/`, join with `/`, collapse repeated `/`, prefix `/`; the empty route is `/`. Language rules: C# a method template starting with `/` or `~/` ignores the class `[Route]`, `[controller]` is the class name without a `Controller` suffix, `[action]` the method name; Spring, JAX-RS and Nest always concatenate class and method paths.
- **FC-9 Attribution.** G8. `moduleSymbolId(file)` is `<file>::<basename without its last extension>::variable`. Annotation endpoints use the annotated method's symbol.
- **FC-10 Order and cap.** G9.

**Language mapping (the evidence each tier looks for):**

| Language | Case labels and arms | Calls | Bindings | Routes |
|---|---|---|---|---|
| C# | switch statement labels, `case` patterns, switch expression arms | invocations | fields, properties, locals, assignments, object initializers, named arguments, anonymous object members | annotations `HttpGet`, `HttpPost`, `HttpPut`, `HttpDelete`, `HttpPatch`, `HttpHead`, `HttpOptions` (template = `args[0]` or `named.Template`), `Route` (class prefix; on a method without an `Http*` annotation: `ANY`); invocations `MapGet`, `MapPost`, `MapPut`, `MapDelete`, `MapPatch` with a string literal first argument |
| TypeScript | `switch` case clauses | `x.m(...)` | `const`/`let`/`var`, class properties, object-literal properties, assignments | Nest decorators `Get`, `Post`, `Put`, `Delete`, `Patch`, `Head`, `Options`, `All` (`ANY`) in a class decorated `Controller` (prefix `args[0]` or `named.path`); Express and Fastify receivers: `get`, `post`, `put`, `delete`, `patch`, `head`, `options`, `all` (`ANY`) with a string first argument, Fastify `route({ method, url })` (a method array gives one fact per method) |
| Java | switch statement and expression case labels | method invocations | fields, locals, assignments, annotation members | annotations `GetMapping`, `PostMapping`, `PutMapping`, `DeleteMapping`, `PatchMapping`, `RequestMapping` (verbs from `named.method`, `RequestMethod.GET` gives `GET`, comma-separated values give one fact each, none gives `ANY`); paths from each `args` value, else `named.path`, else `named.value`; class `RequestMapping` is the prefix; JAX-RS `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS` with `Path` on the method and the class |
| Go | expression switch case values; tagless switch cases are conditions | `pkg.F(...)`, `x.M(...)` | `const`/`var` specs, `=` and `:=`, composite-literal keys | `net/http` `HandleFunc` and `Handle` (package functions and `*ServeMux` methods; a pattern `"GET /x"` gives `GET /x`, else `ANY`); gin `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`, `Any` (`ANY`), `Handle(method, path)` on `*gin.Engine` and `*gin.RouterGroup` |

**Evidence records** (each plugin's internal protocol; analyzers emit them as `factEvidence` in their per-file record, omitted when empty or without `--facts=`):

```ts
export type LiteralKind = 'number' | 'string' | 'char' | 'boolean' | 'null';
export type DurationUnit = 'ns' | 'us' | 'ms' | 's' | 'min' | 'h' | 'd';
export type FactEvidence =
  | { readonly kind: 'comparison'; readonly symbolId?: string; readonly line: number; readonly text: string; readonly operator: string; readonly literal: string; readonly literalKind: LiteralKind }
  | { readonly kind: 'call'; readonly symbolId?: string; readonly line: number; readonly text: string; readonly method: string; readonly qualifier?: string }
  | { readonly kind: 'binding'; readonly symbolId?: string; readonly line: number; readonly name: string; readonly value: string }   // value: source text
  | { readonly kind: 'duration'; readonly symbolId?: string; readonly line: number; readonly name?: string; readonly constructor: string; readonly unit: DurationUnit; readonly amount: string }
  | { readonly kind: 'route'; readonly symbolId?: string; readonly line: number; readonly verb: string; readonly route: string };
```

`symbolId` is set by collectors that know the enclosing declaration (analyzers, ts-morph); the finisher attributes the rest by line (FC-9).

---

### Task 0: Branch setup (no commit)

- [ ] **Step 1:** Create the worktree with superpowers:using-git-worktrees: branch `feat/agentic-loop-156` from the tip of `feat/domain-graph-156` once every PR 3 task is committed. Copy both PR 4 plans into the gitignored `docs/superpowers/plans/` if missing (Task 1 commits them).
- [ ] **Step 2:** `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test`. Expected: green (gated suites run here). Note the counts for the PR description.
- [ ] **Step 3: Confirm the consumed pieces.** Each command must print matches, otherwise stop and report BLOCKED:
  - `git grep -n -e "FACT_KINDS" -e "extractFacts" -- packages/plugin-api/src`; `git grep -n -e "export async function extractFileFacts" -e "export function factsRequested" -e "export function hostCapabilities" -- packages/cli/src`
  - `git grep -n -e "indexCapabilities" -- packages/cli/src/ports/i-ctxo-module.ts`; `git grep -n "export function receiverModule" -- packages/lang-typescript/src`
  - `git grep -n -e "sqlCallSites" -- packages/lang-csharp/src/roslyn/roslyn-process.ts packages/lang-java/src/analyzer/jdt-process.ts packages/lang-go/src/analyzer/analyzer-process.ts`; `git grep -n "FuncDeclSymbolID" -- packages/lang-go/tools/ctxo-go-analyzer`
- [ ] **Step 4: Record in the scratchpad:** how `IndexCommand.run` and `WatchCommand.run` call `loadPlugins` today (PR 1B Phase 1c and the watch facts path), the Java analyzer's enclosing-method tracking from PR 1C (field name in `Analyzer.EmitVisitor`), and the C# tree-sitter node names `rootNode.toString()` prints for a `switch` statement, a switch expression, an `is` pattern and a `when` clause (tree-sitter-c-sharp 0.23.1).

---

### Task 1: CLI: the fact options channel, `facts: []`, and watch parity

**Files:**
- Modify: `packages/cli/src/ports/i-ctxo-module.ts` (`TrivialLiteral`, `FactDetectorOptions`, `CtxoModuleRegistration.indexCapabilities`), `packages/cli/src/internal.ts` (type exports, plus `CodeFact`)
- Modify: `packages/cli/src/cli/plugin-loader.ts` (`LoadPluginsOptions.factOptions`, `buildContext`), `packages/cli/src/cli/index-facts.ts` (`extractFileFacts`, new `pluginFactRequest`), `packages/cli/src/cli/index-command.ts` (Phase 1c), `packages/cli/src/cli/watch-command.ts` (`WatchCommand.run`). Before editing: `get_blast_radius` and `get_why_context` on `loadPlugins`, `extractFileFacts`, `IndexCommand.run` and `WatchCommand.run`.
- Add: both PR 4 plan files (gitignored folder, `git add -f`)
- Test: `packages/cli/src/cli/__tests__/index-facts.test.ts`, `plugin-loader.capabilities.test.ts`, `index-command.plugin-v2.test.ts`, `watch-command.test.ts`

**Interfaces:**
- Consumes: `factsRequested`, `extractFileFacts`, `LoadPluginsOptions` (PR 1B); `LoadedModule`, `loadCtxoModules`, `createModuleHost` (PR 2B).
- Produces:
  ```ts
  // ports/i-ctxo-module.ts
  export type TrivialLiteral = number | string | boolean | null;
  export interface FactDetectorOptions { readonly trivialLiterals: readonly TrivialLiteral[]; readonly normalizationMethods: readonly string[] }
  // CtxoModuleRegistration.indexCapabilities: { readonly facts?: boolean; readonly factOptions?: FactDetectorOptions }
  // cli/index-facts.ts
  export interface PluginFactRequest { readonly facts: boolean; readonly factOptions?: FactDetectorOptions }
  export function pluginFactRequest(config: CtxoConfig, modules: readonly LoadedModule[]): PluginFactRequest;
  //   facts: factsRequested(config) or any module's indexCapabilities.facts; factOptions: the first module (load order) declaring them, only when facts
  export async function extractFileFacts(adapter: ILanguageAdapter, relativePath: string, source: string): Promise<CodeFact[] | undefined>;
  //   [] when extractFacts exists and finds nothing; undefined without the method or on a throw (message unchanged)
  // cli/plugin-loader.ts: LoadPluginsOptions gains `readonly factOptions?: FactDetectorOptions`;
  //   buildContext sets config to { facts: factOptions } when facts and factOptions are both given, else {}
  ```
- Phase 1c sets `fileIndex.facts` whenever `extractFileFacts` returns an array. `WatchCommand.run` loads modules with `loadCtxoModules(createModuleHost({ projectRoot, mode: 'cli' }))` before plugins and passes `pluginFactRequest(config, modules)` to `loadPlugins`; its re-index paths write facts like Phase 1c.

- [ ] **Step 1: Write the failing tests.**
  - `index-facts.test.ts`: replace PR 1B's `returns undefined for an adapter without extractFacts or with no facts` with `returns undefined for an adapter without extractFacts` and `returns [] for an adapter whose extractFacts finds nothing`; `pluginFactRequest combines index.facts with module requests` (`it.each`: no config, no modules gives `{ facts: false }`; `index.facts: true` gives `{ facts: true }` without `factOptions`; a module with `{ facts: true, factOptions: O }` gives `{ facts: true, factOptions: O }`; two such modules give the first one's `O`; a module with `factOptions` but no `facts`, and no config, gives `{ facts: false }`).
  - `plugin-loader.capabilities.test.ts`: `loadPlugins hands config.facts to every plugin only with a fact request and options` (two fake plugins record `ctx.config`: `{ facts: true, factOptions: O }` gives `{ facts: O }` for both; `{ facts: false, factOptions: O }` and `{ facts: true }` give `{}`).
  - `index-command.plugin-v2.test.ts`: `a fact-capable adapter that finds nothing writes facts: []` (fake plugin whose `extractFacts` resolves `[]`, `index.facts: true`: the file's JSON has `"facts":[]`); `an adapter without extractFacts writes no facts key`; `ctxo index --commit HEAD keeps facts of untouched files` (Review Focus 3: `createProject` with `src/a.fake` and `src/b.fake`, both with one fact, a full run, a commit changing `src/b.fake`, then `run({ commit: 'HEAD' })`: `a.fake`'s JSON still deep-equals its facts and `b.fake`'s holds the new fact).
  - `watch-command.test.ts`: `watch requests facts like index` (Review Focus 3: `vi.mock` of `../../adapters/modules/module-loader.js` returns one module declaring `{ facts: true, factOptions: O }` and `vi.mock` of `../plugin-loader.js` captures the options of `loadPlugins` and resolves `[]`; `WatchCommand.run` on an empty project resolves and `loadPlugins` saw `facts: true` and `factOptions: O`).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/cli exec vitest run src/cli/__tests__/index-facts.test.ts src/cli/__tests__/plugin-loader.capabilities.test.ts src/cli/__tests__/index-command.plugin-v2.test.ts src/cli/__tests__/watch-command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, `pluginFactRequest`, the loader context, Phase 1c and the watch path.
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/cli test:unit && pnpm --filter @ctxo/cli build && pnpm -r typecheck`. Expected: green.
- [ ] **Step 5: Commit.**
  ```bash
  git add -f docs/superpowers/plans/2026-10-21-pr4-1-fact-detectors.md docs/superpowers/plans/2026-10-21-pr4-2-agentic-loop-tools.md
  git add packages/cli/src/ports/i-ctxo-module.ts packages/cli/src/internal.ts packages/cli/src/cli/plugin-loader.ts packages/cli/src/cli/index-facts.ts packages/cli/src/cli/index-command.ts packages/cli/src/cli/watch-command.ts packages/cli/src/cli/__tests__/index-facts.test.ts packages/cli/src/cli/__tests__/plugin-loader.capabilities.test.ts packages/cli/src/cli/__tests__/index-command.plugin-v2.test.ts packages/cli/src/cli/__tests__/watch-command.test.ts
  git commit -S -m "feat(cli): fact options for plugins, facts: [] for fact-capable adapters, and watch fact parity (#156)"
  ```

---

### Task 2: Conformance vectors and the shared fact rules (in lang-csharp)

**Files:**
- Create: `packages/plugin-api/conformance/fact-vectors.json`
- Create: `packages/lang-csharp/src/facts/fact-types.ts`, `fact-options.ts`, `fact-rules.ts`, `finish-facts.ts`, `annotation-endpoints.ts`
- Test: `packages/lang-csharp/src/facts/__tests__/fact-rules.test.ts`, `fact-options.test.ts`, `finish-facts.test.ts`, `annotation-endpoints.test.ts`

**Interfaces:**
- Produces (the first four modules are copied verbatim into lang-typescript, lang-java, lang-go and `@ctxo/domain` later; only import paths change):
  ```ts
  // fact-types.ts: LiteralKind, DurationUnit, FactEvidence (the Fact contract block), and
  export type TrivialLiteral = number | string | boolean | null;
  export interface FactOptions { readonly trivialLiterals: readonly TrivialLiteral[]; readonly normalizationMethods: readonly string[] }
  // fact-options.ts
  export const DEFAULT_FACT_OPTIONS: FactOptions;   // trivialLiterals [0, 1, -1, null, true, false, '']; normalizationMethods the spec list in spec order
  export function readFactOptions(config: Readonly<Record<string, unknown>> | undefined): FactOptions;   // config.facts; per-field fallback
  export function encodeFactOptions(options: FactOptions): string;   // standard base64 of UTF-8 JSON {"normalizationMethods":[...]}
  // fact-rules.ts
  export const RETRY_TIMEOUT_FRAGMENTS: readonly string[];   // retry, retries, attempt, timeout, delay, backoff, ttl, expir
  export const MAX_FACT_TEXT = 200; export const MAX_FACTS_PER_FILE = 500;
  export function normalizeFactText(text: string): string;                               // FC-2
  export function canonicalNumber(expression: string): string | undefined;               // FC-7
  export function isTrivialLiteral(literal: string, kind: LiteralKind, trivial: readonly TrivialLiteral[]): boolean;   // FC-6
  export function matchesNormalizationPattern(method: string, qualifier: string | undefined, patterns: readonly string[]): boolean;   // FC-4
  export function hasRetryTimeoutFragment(name: string): boolean;                        // FC-5
  export function joinRoute(...parts: readonly (string | undefined)[]): string;          // FC-8
  // finish-facts.ts
  export function moduleSymbolId(file: string): string;                                  // FC-9
  export function finishFacts(file: string, evidence: readonly FactEvidence[], symbols: readonly SymbolNode[], options: FactOptions): CodeFact[];
  // annotation-endpoints.ts (C#)
  export function annotationRouteEvidence(symbols: readonly SymbolNode[]): FactEvidence[];   // 'route' evidence with the method's symbolId and startLine
  ```
- `readFactOptions`: `trivialLiterals` must be an array of numbers, strings, booleans or `null`; `normalizationMethods` an array of strings matching `^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_$][A-Za-z0-9_$]*\*?$`; anything else falls back to the default for that field.
- `finishFacts` per evidence kind: `comparison` is dropped when `isTrivialLiteral`, else `{ operator, literal }`; `call` is kept when its pattern still matches; `binding` needs `hasRetryTimeoutFragment(name)` and a `canonicalNumber(value)`; `duration` needs `canonicalNumber(amount)`; `route` gets `verb.toUpperCase()` and `joinRoute(route)`. Then FC-2 text, FC-9 attribution for evidence without `symbolId` (innermost symbol whose `startLine..endLine` holds the line; ties: the later `startLine`, then the smaller span, then index order), FC-10 order, duplicates and cap.
- C# annotation routes: the FC-8 C# rules and the C# row of the language mapping; the class prefix is the `Route` annotation of the innermost class symbol whose span holds the method.

**Vectors** (`fact-vectors.json`, one array per category, each entry `{ "input": ..., "expected": ... }`; every plugin copy and Part 2 test all of them):

| Category | Inputs and expected values |
|---|---|
| `canonicalNumber` | `5` 5; `30_000` 30000; `5000L` 5000; `1.50` 1.5; `2.5m` 2.5; `0x10` 16; `0b101` 5; `10n` 10; `1e3` 1000; `30 * 1000` 30000; `(5 + 1) * 60` 360; `-1` -1; `1 / 3` 0.333333; `-0` 0; not constant (`null`): `x * 2`, `1 / 0`, `"5"`, `` (empty) |
| `isTrivialLiteral` (defaults) | true: `0`, `0.0`, `0x0`, `-1`, `1L`, `1m` (number); `""`, `''`, `@""` and an empty template literal (string); `null`, `nil` (null); `true`, `False` (boolean). false: `5`, `2` (number); `"0"`, `"gold"` (string); `'a'` (char) |
| `isTrivialLiteral` (custom list `[100, "N/A"]`) | true: `100`, `"N/A"`; false: `0`, `"100"` |
| `hasRetryTimeoutFragment` | true: `MaxRetries`, `MAX_RETRIES`, `retryCount`, `attempts`, `TimeOut`, `requestTimeoutMs`, `tokenTTL`, `ExpiryDays`, `backoffFactor`, `delayMs`, `HOLD_TIMEOUT`; false: `settlementDays`, `relay`, `delta`, `count` |
| `matchesNormalizationPattern` (defaults) | true: `ToLowerInvariant`, `ToUpper`, `TrimEnd`, `Normalize`, `toLowerCase`, `trim`, `equalsIgnoreCase`, (`TrimSpace`, `strings`), (`ToLower`, `bytes`); false: `trimStart`, `NormalizeEmail`, `lower`, `toString` |
| `matchesNormalizationPattern` (custom `["strings.ToLower"]`) | true: (`ToLower`, `strings`); false: (`ToLower`, `bytes`), (`ToLower`, none) |
| `normalizeFactText` | `"a  >=\n\t5"` gives `"a >= 5"`; 250 times `é` gives 200 times `é`; 199 times `a` then two `😀` gives 199 times `a` and one `😀` |
| `joinRoute` | (`api/Loans`, `{id}`) `/api/Loans/{id}`; (`/loans/`, ``) `/loans`; (``, ``) `/`; (`api//loans`) `/api/loans`; (`loans`, `/`) `/loans` |

Long inputs are written as `{ "repeat": "é", "count": 250 }` objects that the tests expand.

- [ ] **Step 1: Write the failing tests.**
  - `fact-rules.test.ts`: `it.each` over every vectors category, loading the file from `../../../../plugin-api/conformance/fact-vectors.json` relative to the test (a missing file fails the test).
  - `fact-options.test.ts`: `readFactOptions returns the spec defaults without config.facts`; `readFactOptions keeps typed trivial literals and falls back per field` (`{ facts: { trivialLiterals: [0, 100, 'N/A', null], normalizationMethods: 'x' } }` gives those four literals and the default methods; Review Focus 4); `encodeFactOptions round-trips the normalization list` (decoding gives `{ normalizationMethods: [...] }` only).
  - `finish-facts.test.ts`:
    - `a trivial comparison is dropped and the string "0" is kept`;
    - `a binding needs a fragment name and a numeric constant` (`{ name: 'REQUEST_TIMEOUT', value: '30 * 1000' }` gives text `REQUEST_TIMEOUT = 30000`; `settlementDays = 3` and `{ name: 'timeout', value: 'x * 2' }` give nothing);
    - `durations carry their unit and their binding name` (`{ name: 'Timeout', constructor: 'System.TimeSpan.FromSeconds', unit: 's', amount: '30' }` gives `Timeout = 30s` with `detail { name: 'Timeout', value: '30s' }`; without `name` it gives `TimeSpan.FromSeconds = 30s`; `setTimeout` with a name stays `setTimeout`);
    - `routes are upper-cased and joined` (`{ verb: 'get', route: 'loans/' }` gives `GET /loans`);
    - `evidence without a symbolId goes to the innermost symbol or the module symbol` (`moduleSymbolId('src/Program.cs')` is `src/Program.cs::Program::variable`);
    - `facts are sorted, de-duplicated and capped at 500` (600 comparisons on distinct lines give the 500 with the smallest lines);
    - `shuffled evidence gives deep-equal facts`.
  - `annotation-endpoints.test.ts`: `attribute routes combine the controller route with the action template` (class `LoansController` with `{ name: 'Route', args: ['api/[controller]'] }`; methods with `HttpGet('{id}')`, `HttpPost`, `HttpGet('/health')` and `Route('legacy/[action]')` alone give `GET /api/Loans/{id}`, `POST /api/Loans`, `GET /health`, `ANY /api/Loans/legacy/Archive` for method `Archive`); `named Template is read when args is empty`; `methods without route annotations and non-route annotations give nothing`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/plugin-api build && pnpm --filter @ctxo/lang-csharp exec vitest run src/facts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the modules and the vectors file; `fact-rules.ts` imports nothing beyond its sibling `fact-types.ts`.
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/lang-csharp typecheck`.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(lang-csharp): fact rules, options, finisher and attribute routes with shared conformance vectors (#156)"`.

---

### Task 3: C# facts in the Roslyn tier (IOperation)

**Files:**
- Create: `packages/lang-csharp/tools/ctxo-roslyn/Facts.cs`
- Modify: `packages/lang-csharp/tools/ctxo-roslyn/Program.cs` (`--facts=` parsing next to `--keep-alive`; `AnalyzeDocument` fills `FileResult.FactEvidence`)
- Modify: `packages/lang-csharp/src/roslyn/roslyn-process.ts` (`RoslynRunOptions.facts`, `RoslynFileResult.factEvidence`, both spawn paths), `src/roslyn/roslyn-adapter.ts` (constructor options, `extractFacts`, `rewriteAllPaths` rewrites evidence ids), `src/composite-adapter.ts` (options, `extractFacts`), `src/index.ts` (`createAdapter`). Before editing: the two MCP tools on `RoslynAdapter`, `CSharpCompositeAdapter`, `runBatchIndex`, `RoslynKeepAlive`, `rewriteAllPaths` and `packages/lang-csharp/src/index.ts::plugin::variable` (the Roslyn C# sources answer `found: false`).
- Extend fixture `packages/lang-csharp/src/__tests__/fixtures/csharp-v2-sample/CsharpV2Sample/`: `Stubs/AspNetCore.cs` (`Microsoft.AspNetCore.Mvc` `ApiControllerAttribute`, `RouteAttribute(string)`, `HttpGetAttribute()`/`(string)`, `HttpPostAttribute()`, `ControllerBase`; `Microsoft.AspNetCore.Builder.WebApplication` with `MapGet(string, System.Delegate)` and `MapPost(string, System.Delegate)`), `Facts/LoanPolicy.cs`, `Facts/LoansController.cs`, `Facts/Endpoints.cs`
- Test: new `src/__tests__/roslyn-facts.integration.test.ts`, `src/__tests__/roslyn-process.test.ts`, `src/__tests__/plugin.test.ts`

**Interfaces:**
- Consumes: Task 2's modules; `toSymbolNode` (PR 1B).
- C#:
  ```csharp
  sealed record FactOptions(IReadOnlyList<string> NormalizationMethods) { public static FactOptions? Decode(string? base64); }   // null on bad input (stderr line)
  record CtxoFactEvidence { string Kind; string? SymbolId; int Line; string Text; string? Operator; string? Literal; string? LiteralKind; string? Method;
    string? Qualifier; string? Name; string? Value; string? Constructor; string? Unit; string? Amount; string? Verb; string? Route; }   // JSON camelCase, nulls omitted
  static class Facts { public static List<CtxoFactEvidence> Collect(SyntaxNode root, SemanticModel model, string filePath, FactOptions options); }
  // FileResult gains List<CtxoFactEvidence>? FactEvidence (null when empty or without --facts=)
  ```
- `Facts.Collect` walks each member (method, constructor, accessor, local function, field and property declarator, event) in source order. `SymbolId` is the `ExtractSymbols` id of that member (`GetQualifiedName` and `MapSymbolKind`). It reads `model.GetOperation` of each body, expression body and initializer:
  - conditions from `IConditionalOperation`, `IWhileLoopOperation`, `IForLoopOperation`, pattern and switch-arm guards, catch filters;
  - comparisons from `IBinaryOperation` (`Equals`, `NotEquals`, `LessThan`, `LessThanOrEqual`, `GreaterThan`, `GreaterThanOrEqual`; descend through `ConditionalAnd`, `ConditionalOr` and `IUnaryOperation` `Not`) and `IIsPatternOperation` with `IRelationalPatternOperation`, `IConstantPatternOperation`, `INegatedPatternOperation` and `IBinaryPatternOperation`;
  - case labels from `ISingleValueCaseClauseOperation`, `IPatternCaseClauseOperation` and `ISwitchExpressionArmOperation`, the subject being the switch `Value`;
  - calls from `IInvocationOperation` (`TargetMethod.Name`; qualifier = the receiver's syntax for a member access); bindings from declarators, `ISimpleAssignmentOperation`, object initializer members, named `IArgumentOperation`s and anonymous object members;
  - durations from `IInvocationOperation` on `System.TimeSpan.From*` (or the syntax `TimeSpan.From*` when unresolved); routes from invocations named `MapGet`, `MapPost`, `MapPut`, `MapDelete`, `MapPatch` with a literal first argument.
  
  An operand is a literal only when its syntax (conversions unwrapped) is a `LiteralExpressionSyntax` or a signed one, so both tiers agree. `Text` is `node.ToString()` of the syntax.
- TypeScript:
  ```ts
  // roslyn-process.ts: RoslynRunOptions { sqlCallSites?; facts?: FactOptions; timeoutMs? } appends `--facts=${encodeFactOptions(facts)}`; RoslynFileResult.factEvidence?: FactEvidence[]
  export class RoslynAdapter { constructor(options?: { readonly sqlCallSites?: boolean; readonly facts?: FactOptions }); extractFacts(filePath: string, source: string): Promise<CodeFact[]> }
  export class CSharpCompositeAdapter { constructor(options?: { readonly sqlCallSites?: boolean; readonly facts?: FactOptions }); extractFacts(filePath: string, source: string): Promise<CodeFact[]> }
  // createAdapter(ctx): facts = ctx.capabilities?.facts === true ? readFactOptions(ctx.config) : undefined
  ```
  `RoslynAdapter.extractFacts` returns `[]` without `facts`; otherwise `finishFacts(file, [...cached.factEvidence ?? [], ...annotationRouteEvidence(symbols)], symbols, facts)` with `symbols` the cached symbols through `toSymbolNode`. The keep-alive process gets the same flag; `reindexFile` refreshes the cache, so a later `extractFacts` returns the new facts. The composite forwards to its delegate and returns `[]` without one.
- Fixture `Facts/` (namespace `Lending.Facts`):
  - `LoanPolicy.cs`: `public const int MaxRetries = 3;`, `public static readonly System.TimeSpan HoldTimeout = System.TimeSpan.FromMinutes(90);`, `private const int SettlementDays = 3;`;
    - `CanBorrow(int openLoans, string? member)` with `if (member == null) return false;` and `if (openLoans >= 5 && member != "") return false;`;
    - `Fee(string tier)` with `switch (tier) { case "gold": return 0m; case "": return 1m; default: return 2.5m; }`;
    - `Key(string email) => email.Trim().ToLowerInvariant();` and `Label(int days) => days is > 14 ? "late" : "ok";`;
    - a private `Remind() => System.Threading.Tasks.Task.Delay(System.TimeSpan.FromSeconds(30));` and a private `Note() => "if (x > 5) timeout = 30";`.
  - `LoansController.cs`: `[ApiController] [Route("api/[controller]")] public class LoansController : ControllerBase` with `[HttpGet("{id}")] Get(int id)`, `[HttpPost] Borrow(int id)`, `[HttpGet("/health")] Health()`.
  - `Endpoints.cs`: `public static class Endpoints { public static void Map(WebApplication app) { app.MapGet("/holds/{id}", (int id) => id); app.MapPost("/holds", () => 0); } }`.
- Expected facts (names relative to `CsharpV2Sample/Facts/`; the full-tier member name, then kind, text and `detail`):

  | Member | Kind | Text | Detail |
  |---|---|---|---|
  | `LoanPolicy.cs` `Lending.Facts.LoanPolicy.MaxRetries` (variable) | retry-timeout | `MaxRetries = 3` | name `MaxRetries`, value `3` |
  | `...LoanPolicy.HoldTimeout` (variable) | retry-timeout | `HoldTimeout = 90min` | name `HoldTimeout`, value `90min` |
  | `...LoanPolicy.CanBorrow` | literal-comparison | `openLoans >= 5` | operator `>=`, literal `5` |
  | `...LoanPolicy.Fee` | literal-comparison | `tier case "gold"` | operator `case`, literal `"gold"` |
  | `...LoanPolicy.Key` | normalization | `email.Trim()` | method `Trim` |
  | `...LoanPolicy.Key` | normalization | `email.Trim().ToLowerInvariant()` | method `ToLowerInvariant` |
  | `...LoanPolicy.Label` | literal-comparison | `days is > 14` | operator `>`, literal `14` |
  | `...LoanPolicy.Remind` | retry-timeout | `TimeSpan.FromSeconds = 30s` | name `TimeSpan.FromSeconds`, value `30s` |
  | `LoansController.cs` `Lending.Facts.LoansController.Get` | endpoint | `GET /api/Loans/{id}` | verb `GET`, route `/api/Loans/{id}` |
  | `...LoansController.Borrow` | endpoint | `POST /api/Loans` | verb `POST`, route `/api/Loans` |
  | `...LoansController.Health` | endpoint | `GET /health` | verb `GET`, route `/health` |
  | `Endpoints.cs` `Lending.Facts.Endpoints.Map` | endpoint | `GET /holds/{id}` | verb `GET`, route `/holds/{id}` |
  | `...Endpoints.Map` | endpoint | `POST /holds` | verb `POST`, route `/holds` |

- [ ] **Step 1: Write the failing tests.**
  - `roslyn-facts.integration.test.ts` (gated; `beforeAll` initializes `new RoslynAdapter({ facts: DEFAULT_FACT_OPTIONS })` on the fixture and runs `batchIndex()`, 120 s):
    - `it.each` over the table: `<member>: <text>` (a fact of that kind whose `symbolId` ends with `::<member>::<kind>`, with that text and `detail`; its `line` is the 0-based index of the first fixture line holding the row's evidence: the comparison, the `case` label, the call, the declarator, the duration call, or the route attribute or call);
    - `trivial literals, a non-fragment constant and code in strings give no facts` (no fact text contains `member == null`, `member != ""`, `case ""`, `SettlementDays` or `x > 5`);
    - `a custom normalization list replaces the defaults` (`normalizationMethods: ['Trim']`: the `Trim` fact only);
    - `a custom trivial list drops 5` (`trivialLiterals: [5]`: no `openLoans >= 5`);
    - `without the facts option the batch has no evidence and extractFacts returns []`;
    - `the keep-alive reindex returns the batch's facts` (after `startKeepAlive()` and `reindexFile('CsharpV2Sample/Facts/LoanPolicy.cs')`).
  - `roslyn-process.test.ts`: `runBatchIndex appends --facts= with base64 options only when facts are given`; `the keep-alive process gets the same argument`.
  - `plugin.test.ts`: `createAdapter enables facts only with capabilities.facts and reads config.facts` (no capability: `extractFacts` resolves `[]`; capability with `config.facts.normalizationMethods: ['Trim']`: the composite holds those options).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/lang-csharp test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `Facts.cs`, the flag and the TypeScript plumbing.
- [ ] **Step 4: Run them.** Expected: PASS with the integration test running here; the PR 1B integration tests still pass on the rebuilt helper. Then `pnpm --filter @ctxo/lang-csharp build && pnpm --filter @ctxo/lang-csharp typecheck`.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture additions; `git commit -S -m "feat(lang-csharp): Roslyn fact evidence behind --facts and extractFacts in the full tier (#156)"`.

---

### Task 4: C# facts in the tree-sitter tier; tier agreement; first validation on the private fixture

**Files:**
- Create: `packages/lang-csharp/src/facts/tree-sitter-evidence.ts`
- Modify: `packages/lang-csharp/src/csharp-adapter.ts` (constructor options, `extractFacts`), `src/composite-adapter.ts` (passes `facts` to the tree-sitter adapter). Before editing: the two MCP tools on `CSharpAdapter` and `CSharpCompositeAdapter`.
- Test: `src/facts/__tests__/tree-sitter-evidence.test.ts`, new `src/__tests__/facts-tier-agreement.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function collectTreeSitterEvidence(root: SyntaxNode, file: string, symbols: readonly SymbolNode[], options: FactOptions): FactEvidence[];
  export class CSharpAdapter { constructor(options?: { readonly facts?: FactOptions }); extractFacts(filePath: string, source: string): Promise<CodeFact[]> }
  // extractFacts: [] without facts; else finishFacts(file, [...collectTreeSitterEvidence(...), ...annotationRouteEvidence(symbols)], symbols, facts)
  ```
- Nodes (confirm names against tree-sitter-c-sharp 0.23.1 with `rootNode.toString()`, as recorded in Task 0): conditions of `if_statement`, `while_statement`, `do_statement`, `for_statement`, `conditional_expression`, `when_clause`, `catch_filter_clause`; `binary_expression` (operator), `prefix_unary_expression`, `parenthesized_expression`, `is_pattern_expression`, `relational_pattern`, `constant_pattern`, `negated_pattern`, `and_pattern`, `or_pattern`; `switch_statement` sections and `switch_expression_arm`; `invocation_expression` with `member_access_expression`; `variable_declarator`, `property_declaration`, `assignment_expression`, `argument` with `name_colon`, `anonymous_object_member_declarator`; literals `integer_literal`, `real_literal`, `string_literal`, `verbatim_string_literal`, `raw_string_literal`, `character_literal`, `boolean_literal`, `null_literal`.
- `symbolId` (G8): a public method or constructor gets the tier's own id (`<Ns.Type.Method>(<n>)`); fields, properties and private members get the full-tier shape (`<Ns.Type.Member>`, `variable` or `method`), tracked through namespace and type declarations like `visitSymbols`.

- [ ] **Step 1: Write the failing tests.**
  - `tree-sitter-evidence.test.ts` (the Task 3 fixture files read from disk through `new CSharpAdapter({ facts: DEFAULT_FACT_OPTIONS }).extractFacts`):
    - `the syntax tier reports the Task 3 table` (same rows; public members carry the `(n)` suffix, for example `Lending.Facts.LoanPolicy.CanBorrow(2)`);
    - `fields and private members use the full-tier ID shape` (`...::Lending.Facts.LoanPolicy.MaxRetries::variable`, `...::Lending.Facts.LoanPolicy.Remind::method`);
    - `CRLF line endings give the same facts` (Review Focus 5);
    - `a generated file with 2,000 case labels gives 500 facts` (Review Focus 1: a synthetic `switch` with `case 1000:` to `case 2999:` gives exactly 500 facts, the 500 smallest lines, deep-equal on a second call);
    - `without the facts option extractFacts returns []`.
  - `facts-tier-agreement.integration.test.ts` (gated): `both tiers give the same facts` (Review Focus 2: for every `Facts/*.cs`, facts of both tiers mapped to `{ kind, line, text, detail, symbolId: symbolId.replace(/\(\d+\)(?=::)/, '') }`, sorted, are deep-equal).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/lang-csharp exec vitest run src/facts src/__tests__/facts-tier-agreement.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the collector and the adapter method.
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/lang-csharp test && pnpm --filter @ctxo/lang-csharp build`.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(lang-csharp): tree-sitter fact evidence that agrees with the Roslyn tier (#156)"`.
- [ ] **Step 6: Validate C# on the private fixture first (spec 12.1; nothing committed).** In the private fixture clone (path in the owner's brief; never the original checkout), with a scratch `.ctxo/config.yaml` holding `index: { facts: true }` (clone only), run `node <worktree>/packages/cli/dist/index.js index` twice. Record aggregates only in the scratchpad PR draft: facts by kind, files with facts, facts per file (median, 99th percentile, maximum, files at the 500 cap), index time against PR 3's run, and byte-identical facts across both runs. Review 30 random facts per kind in the scratchpad and record only the share that is plausible business logic. Expected: no crash, cap hits explained, determinism holds. Report precision below 50 % for any kind to the owner before Task 5.

---

### Task 5: TypeScript facts (ts-morph)

**Files:**
- Create: `packages/lang-typescript/src/facts/fact-types.ts`, `fact-options.ts`, `fact-rules.ts`, `finish-facts.ts` (copies of Task 2, imports from `@ctxo/plugin-api`), `annotation-endpoints.ts` (Nest), `ts-evidence.ts`
- Create tests: `src/facts/__tests__/fact-rules.test.ts`, `fact-options.test.ts`, `finish-facts.test.ts` (copies), `annotation-endpoints.test.ts`, `ts-evidence.test.ts`
- Modify: `packages/lang-typescript/src/ts-morph-adapter.ts` (`TsMorphAdapterOptions.facts`, `extractFacts`), `src/sql/provenance.ts` (`receiverModule` module set), `src/index.ts`. Before editing: the two MCP tools on `TsMorphAdapter`, `packages/lang-typescript/src/sql/provenance.ts::receiverModule::function` and `packages/lang-typescript/src/index.ts::plugin::variable`.
- Create fixtures: `src/__tests__/fixtures/lending-sample/src/facts/loan-rules.ts.fixture`, `http.ts.fixture`, `fastify-routes.ts.fixture`
- Test: `src/__tests__/lending-sample.test.ts`, `src/__tests__/plugin.test.ts`

**Interfaces:**
- Consumes: Task 2's modules; `ModuleResolver`, `receiverModule`, `classAnnotations`, `methodAnnotations` (PR 1C).
- Produces:
  ```ts
  // sql/provenance.ts
  export function receiverModule(expr: Node, resolver: ModuleResolver, modules?: ReadonlySet<string>): string | undefined;   // default: the SQL table modules
  // facts/ts-evidence.ts
  export const ROUTE_MODULES: ReadonlySet<string>;   // 'express', 'fastify'
  export function collectTsEvidence(sourceFile: SourceFile, filePath: string, resolver: ModuleResolver, options: FactOptions): FactEvidence[];
  // facts/annotation-endpoints.ts (Nest)
  export function annotationRouteEvidence(symbols: readonly SymbolNode[]): FactEvidence[];
  // ts-morph-adapter.ts
  export interface TsMorphAdapterOptions { readonly sqlCallSites?: boolean; readonly projectRoot?: string; readonly facts?: FactOptions }
  extractFacts(filePath: string, source: string): Promise<CodeFact[]>;   // [] without facts; a ModuleResolver released in finally
  ```
- Evidence from ts-morph nodes: conditions of `IfStatement`, `WhileStatement`, `DoStatement`, `ForStatement.getCondition()`, `ConditionalExpression.getCondition()`; `SwitchStatement` case clauses; `BinaryExpression` comparisons; literals `NumericLiteral`, `BigIntLiteral`, `StringLiteral`, `NoSubstitutionTemplateLiteral`, `TrueKeyword`, `FalseKeyword`, `NullKeyword` and a signed numeric; `CallExpression` with a `PropertyAccessExpression` callee; `VariableDeclaration`, `PropertyDeclaration`, `PropertyAssignment` (identifier or string name), `BinaryExpression` `=`; `setTimeout`, `window.setTimeout` and `globalThis.setTimeout` with a second argument; route calls whose receiver `receiverModule(receiver, resolver, ROUTE_MODULES)` traces.
- `symbolId` (G8): the innermost of the adapter's symbols (exported functions, classes and methods, exported variables, test blocks) holding the node, or, for a non-exported named function, class or method, the id the adapter would give it if exported (`<file>::label::function`); else unset (the finisher uses the module symbol).
- Fixtures (in `lending-sample/src/facts/`):
  - `loan-rules.ts`: `export const MAX_RETRIES = 3;`, `export const settlementDays = 3;`;
    - `canBorrow(openLoans: number, member: string | null)` with `if (member === null) return false; if (openLoans >= 5 && member !== '') return false;`;
    - `fee(tier: string)` with `switch (tier) { case 'gold': return 0; case '': return 1; default: return 2.5; }`;
    - `key(email: string) { return email.trim().toLowerCase(); }`, `remind(send: () => void) { setTimeout(send, 30_000); }`, `export const client = { timeout: 5000 };`;
    - a non-exported `function label(days: number) { return days > 14 ? 'late' : 'ok'; }` and `export const note = 'if (x > 5) timeout = 30';`.
  - `http.ts`: `import express from 'express'; import axios from 'axios'; export const router = express.Router(); router.get('/holds/:id', (_req, res) => res.end()); const cache = new Map<string, string>(); cache.get('/holds'); export async function load() { return axios.get('/api/loans'); }`.
  - `fastify-routes.ts`: `import type { FastifyInstance } from 'fastify'; export async function routes(app: FastifyInstance) { app.get('/members/:id', async () => ({})); app.route({ method: ['POST', 'PUT'], url: '/members', handler: async () => ({}) }); }`.
- Expected facts: `loan-rules.ts`: `MAX_RETRIES` `MAX_RETRIES = 3`; `canBorrow` `openLoans >= 5` (`>=`, `5`); `fee` `tier case 'gold'` (`case`, `'gold'`); `key` `email.trim()` (`trim`) and `email.trim().toLowerCase()` (`toLowerCase`); `remind` `setTimeout = 30000ms`; `client` `timeout = 5000`; `label` (id `src/facts/loan-rules.ts::label::function`) `days > 14`. `http.ts`: module symbol `src/facts/http.ts::http::variable` `GET /holds/:id`. `fastify-routes.ts`: `routes` `GET /members/:id`, `POST /members`, `PUT /members`. PR 1C's `src/loan.controller.ts`: `LoanController.find` `GET /loans/:id`.

- [ ] **Step 1: Write the failing tests.**
  - Copied rule tests (the vectors path adjusted); `annotation-endpoints.test.ts`: `Nest routes combine the Controller prefix with method decorators` (`Controller('loans')` with `Get(':id')`, `Post()` and `All('x')` give `GET /loans/:id`, `POST /loans`, `ANY /loans/x`); `method decorators outside a Controller class give nothing`.
  - `ts-evidence.test.ts`: `the fixtures give the expected facts` (`it.each` over the rows above, whole sample preloaded through `readLendingSample`); `receiver tracing keeps Map.get and axios.get out`; `top-level registrations attach to the module symbol`; `a non-exported function gets its own symbol id`; `facts in test files carry test-block ids` (a `describe('limits', () => { it('five', () => { if (n >= 5) {} }) })` in `src/__tests__/x.test.ts` gives `src/__tests__/x.test.ts::limits > five::function`); `trivial literals and strings give nothing`; `extracting the same file twice gives deep-equal facts`.
  - `lending-sample.test.ts`: `a run with only loan-rules.ts preloaded gives the same facts`; `plugin.test.ts`: `createAdapter enables facts only with capabilities.facts and reads config.facts`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/plugin-api build && pnpm --filter @ctxo/lang-typescript test`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules, the module-set parameter (SQL callers unchanged) and the adapter method.
- [ ] **Step 4: Run them.** Expected: PASS, PR 1C's SQL tests included. Then `pnpm --filter @ctxo/lang-typescript build && pnpm --filter @ctxo/lang-typescript typecheck`.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixtures; `git commit -S -m "feat(lang-typescript): fact detectors with Express, Fastify and Nest endpoints (#156)"`.

---

### Task 6: Java facts in the JDT tier

**Files:**
- Create: `packages/lang-java-analyzer/java/src/main/java/io/ctxo/jdt/FactEvidence.java`, `.../src/test/java/io/ctxo/jdt/FactEvidenceTest.java`
- Modify: `.../io/ctxo/jdt/Dtos.java` (`Evidence`, `FactOptions`, `FileResult.factEvidence`), `Analyzer.java` (four-argument constructor; the visitor calls the collector), `Main.java` (`--facts=` in batch and keep-alive), `ContractIT.java`
- Extend fixture `packages/lang-java-analyzer/java/src/test/resources/lending/`: `src/main/java/lending/facts/LoanRules.java`, `LoanController.java`, `HoldResource.java`; stubs `src/stubs/java/org/springframework/web/bind/annotation/{RestController,RequestMapping,GetMapping,PostMapping}.java` and `src/stubs/java/jakarta/ws/rs/{Path,GET}.java`
- Create: `packages/lang-java/src/facts/` copies of Task 2's four modules and tests, `annotation-endpoints.ts` (Spring, JAX-RS) with `__tests__/annotation-endpoints.test.ts`
- Modify: `packages/lang-java/src/analyzer/jdt-process.ts` (`RunOpts.facts`, `JdtFileResult.factEvidence`, `JdtKeepAlive` options), `src/analyzer/jdt-adapter.ts` (options, `extractFacts`), `src/composite-adapter.ts` (options, `extractFacts`), `src/index.ts`. Before editing: the two MCP tools on `JdtAnalyzerAdapter`, `JavaCompositeAdapter`, `runBatchIndex`, `JdtKeepAlive` and `packages/lang-java/src/index.ts::plugin::variable` (and on `Analyzer`, expected `found: false`).
- Test: `src/analyzer/__tests__/jdt-process.unit.test.ts`, `src/__tests__/lending-sample.full-tier.integration.test.ts`, `src/__tests__/plugin.test.ts`

**Interfaces:**
- Java:
  ```java
  public static final class Evidence { public String kind, symbolId, text, operator, literal, literalKind, method, qualifier, name, value, constructor, unit, amount, verb, route; public int line; }   // Dtos; Gson omits nulls
  public static final class FactOptions { public List<String> normalizationMethods; static FactOptions decode(String base64); }   // Dtos; null on bad input
  // FileResult gains: public List<Evidence> factEvidence;   // null when empty or without --facts=
  public Analyzer(String rootDir, String[] classpath, boolean sqlCallSites, Dtos.FactOptions facts);   // the three-argument form passes null
  final class FactEvidence {
    static void collect(CompilationUnit cu, String file, Dtos.FactOptions options, List<Dtos.Evidence> out);
    static boolean hasRetryTimeoutFragment(String name);
    static boolean matchesPattern(String method, String qualifier, List<String> patterns);
  }
  ```
- Collector (an `ASTVisitor`): conditions of `IfStatement`, `WhileStatement`, `DoStatement`, `ForStatement`, `ConditionalExpression`; `InfixExpression` comparisons through `CONDITIONAL_AND`, `CONDITIONAL_OR`, `PrefixExpression` `NOT` and `ParenthesizedExpression`; `SwitchStatement` and `SwitchExpression` `SwitchCase.expressions()` with the switch expression as subject; literals `NumberLiteral` (signed by a `PrefixExpression` `MINUS`), `StringLiteral`, `TextBlock`, `CharacterLiteral`, `BooleanLiteral`, `NullLiteral`; `MethodInvocation` (`getName()`, qualifier = `getExpression()` source); `VariableDeclarationFragment` (fields and locals), `Assignment`, `MemberValuePair`; `Duration.of*` and `Duration.of(n, ChronoUnit.X)`. `symbolId`: the enclosing method (`<file>::<name>::method`), field (`<file>::<name>::variable`) or type, as `EmitVisitor` names them; `line` is `cu.getLineNumber(pos) - 1`; `text` is `node.toString()` of the source range (`cu`'s source slice).
- TypeScript: `RunOpts.facts?: FactOptions` appends `--facts=<encodeFactOptions>`; `JdtKeepAlive(javaBin, jarPath, projectRoot, { sqlCallSites?, facts?, idleMs? })`; `JdtAnalyzerAdapter({ sqlCallSites?, facts? })` and `JavaCompositeAdapter({ sqlCallSites?, facts? })` gain `extractFacts` as in Task 3, with `annotationRouteEvidence` (Spring and JAX-RS rows of the language mapping).
- Fixtures (`package lending.facts;`):
  - `LoanRules`: `public static final int MAX_RETRIES = 3;`, `static final java.time.Duration HOLD_TIMEOUT = java.time.Duration.ofMinutes(90);`, `private static final int SETTLEMENT_DAYS = 3;`;
    - `canBorrow(int openLoans, String member)` with `if (member == null) return false; if (openLoans >= 5 && !member.isEmpty()) return false;`;
    - `fee(String tier)` with `switch (tier) { case "gold": return 0; case "": return 1; default: return 2.5; }`;
    - `key(String email) { return email.trim().toLowerCase(); }`, `same(String a, String b) { return a.equalsIgnoreCase(b); }`, `label(int days) { return days > 14 ? "late" : "ok"; }`, a private `note()` returning `"if (x > 5) timeout = 30"`.
  - `LoanController`: `@RestController @RequestMapping("/api/loans")` with `@GetMapping("/{id}") get(long id)` and `@PostMapping borrow()`.
  - `HoldResource`: `@Path("/holds")` with `@GET @Path("{id}") get(long id)`.
- Expected facts (`src/main/java/lending/facts/`): `LoanRules.java` `MAX_RETRIES` (variable) `MAX_RETRIES = 3`; `HOLD_TIMEOUT` `HOLD_TIMEOUT = 90min`; `canBorrow` `openLoans >= 5`; `fee` `tier case "gold"`; `key` `email.trim()` (`trim`) and `email.trim().toLowerCase()` (`toLowerCase`); `same` `a.equalsIgnoreCase(b)` (`equalsIgnoreCase`); `label` `days > 14`. `LoanController.java` `get` `GET /api/loans/{id}`, `borrow` `POST /api/loans`. `HoldResource.java` `get` `GET /holds/{id}`.

- [ ] **Step 1: Write the failing tests.**
  - JUnit `FactEvidenceTest` (analyzer with `FactOptions` of the default patterns over the fixture's files): `comparisonsInConditionsAndCaseLabelsAreReported`; `normalizationCallsMatchTheConfiguredPatterns`; `bindingsOnlyForFragmentNames` (the `hasRetryTimeoutFragment` vectors read from `packages/plugin-api/conformance/fact-vectors.json`, located by walking up from `user.dir`); `matchesPatternFollowsTheVectors`; `durationsReportUnitAndAmount` (`ofMinutes(90)` gives unit `min`, amount `90`); `codeInStringsGivesNothing`; `withoutTheOptionThereIsNoEvidence`. `ContractIT.factEvidenceSerializesWithKindLineText`.
  - lang-java: copied rule tests; `annotation-endpoints.test.ts`: `Spring mappings combine the class RequestMapping with method mappings`, `RequestMapping verbs come from named.method and default to ANY`, `JAX-RS verbs pair with Path on the class and the method`; `jdt-process.unit.test.ts`: `buildAnalyzerArgs appends --facts= only with facts`, `the keep-alive gets the same argument`; `lending-sample.full-tier.integration.test.ts`: `the facts fixture gives the expected facts in the JDT tier`; `plugin.test.ts`: `createAdapter enables facts only with capabilities.facts`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/lang-java-analyzer test && pnpm --filter @ctxo/lang-java test`. Expected: FAIL.
- [ ] **Step 3: Implement** the collector, the flag and the TypeScript plumbing.
- [ ] **Step 4: Run them.** `pnpm --filter @ctxo/lang-java-analyzer test && mvn -q -f packages/lang-java-analyzer/java/pom.xml -Pjava17 test && pnpm --filter @ctxo/lang-java-analyzer build && CTXO_JDT_ANALYZER_JAR="$PWD/packages/lang-java-analyzer/jar/ctxo-jdt-analyzer-17.jar" pnpm --filter @ctxo/lang-java test`. Expected: PASS on both JDT profiles, gated tests running here.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture folders; `git commit -S -m "feat(lang-java): JDT fact evidence behind --facts with Spring and JAX-RS endpoints (#156)"`.

---

### Task 7: Java facts in the tree-sitter tier; tier agreement

**Files:**
- Create: `packages/lang-java/src/facts/tree-sitter-evidence.ts`
- Modify: `packages/lang-java/src/java-adapter.ts` (options, `extractFacts`), `src/composite-adapter.ts` (passes `facts`). Before editing: the two MCP tools on `JavaAdapter` and `JavaCompositeAdapter`.
- Test: `src/facts/__tests__/tree-sitter-evidence.test.ts`, new `src/__tests__/facts-tier-agreement.integration.test.ts`

**Interfaces:**
- Produces: `collectTreeSitterEvidence(root, file, symbols, options): FactEvidence[]` and `JavaAdapter({ facts? }).extractFacts` as in Task 4.
- Nodes (confirm against tree-sitter-java 0.23.5): conditions of `if_statement`, `while_statement`, `do_statement`, `for_statement`, `ternary_expression`; `binary_expression`, `unary_expression`, `parenthesized_expression`; `switch_expression` and `switch_block` with `switch_label`; `method_invocation` (`name`, `object`); `variable_declarator`, `assignment_expression`, `element_value_pair`; literals `decimal_integer_literal`, `hex_integer_literal`, `binary_integer_literal`, `decimal_floating_point_literal`, `string_literal`, `text_block`, `character_literal`, `true`, `false`, `null_literal`. Ids match the JDT tier's shapes already (`<name>::method`, `<name>::variable`).

- [ ] **Step 1: Write the failing tests.** `tree-sitter-evidence.test.ts`: `the syntax tier reports the Task 6 table`; `CRLF line endings give the same facts`. `facts-tier-agreement.integration.test.ts` (gated on `CAN_RUN_JDT`): `both tiers give the same facts` (Review Focus 2; facts mapped to `{ kind, line, text, detail, symbolId }`, sorted, deep-equal per fixture file).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/lang-java exec vitest run src/facts src/__tests__/facts-tier-agreement.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/lang-java test && pnpm --filter @ctxo/lang-java build && pnpm --filter @ctxo/lang-java typecheck`.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(lang-java): tree-sitter fact evidence that agrees with the JDT tier (#156)"`.

---

### Task 8: Go facts in ctxo-go-analyzer

**Files:**
- Create (Go): `packages/lang-go/tools/ctxo-go-analyzer/internal/facts/facts.go`, `internal/facts/facts_test.go`
- Modify (Go): `internal/emit/emit.go` (`FactEvidence`, `FileRecord.FactEvidence`), `main.go` (`--facts=` into `options`; both passes collect). Before editing: the two MCP tools on `packages/lang-go/tools/ctxo-go-analyzer/main.go::run::function` (expected `found: false`).
- Extend fixture `packages/lang-go/test-fixtures/lending-module/`: `go.mod` (`require` and `replace github.com/gin-gonic/gin => ./stubs/gin`), `stubs/gin/go.mod` and `stubs/gin/gin.go` (`type Engine struct{ RouterGroup }`, `type RouterGroup struct{}`, `type HandlerFunc func()`, `type IRoutes interface{}`, methods `GET`, `POST`, `Any`, `Handle` on `*RouterGroup`), `loans/facts.go`
- Create: `packages/lang-go/src/facts/` copies of Task 2's four modules and tests
- Modify: `packages/lang-go/src/analyzer/analyzer-process.ts` (`GoAnalyzerRunOptions.facts`, `buildGoAnalyzerArgs`, `AnalyzerFileResult.factEvidence`), `src/analyzer/analyzer-adapter.ts` (options, `absorbBatch` rewrites evidence ids with the module prefix, `extractFacts`), `src/composite-adapter.ts` (options, `extractFacts`), `src/index.ts`. Before editing: the two MCP tools on `GoAnalyzerAdapter`, `GoCompositeAdapter`, `packages/lang-go/src/analyzer/analyzer-process.ts::buildGoAnalyzerArgs::function` and `packages/lang-go/src/index.ts::plugin::variable`.
- Test: `src/__tests__/analyzer-process.test.ts`, `src/__tests__/lending-module.integration.test.ts`, `src/__tests__/plugin.test.ts`

**Interfaces:**
- Go:
  ```go
  type FactEvidence struct {   // emit; omitempty on every optional field
      Kind string `json:"kind"`; SymbolID string `json:"symbolId,omitempty"`; Line int `json:"line"`; Text string `json:"text"`
      Operator, Literal, LiteralKind, Method, Qualifier, Name, Value, Constructor, Unit, Amount, Verb, Route string   // json camelCase, omitempty
  }
  // FileRecord gains FactEvidence []FactEvidence `json:"factEvidence,omitempty"`
  type Options struct{ NormalizationMethods []string }                       // facts; decoded from --facts=<base64>
  func Decode(base64Value string) (*Options, error)
  func Collect(pkg *packages.Package, file *ast.File, relFile string, opts Options) []emit.FactEvidence   // sorted by line, then kind, then text
  func HasRetryTimeoutFragment(name string) bool
  func MatchesPattern(method, qualifier string, patterns []string) bool
  ```
- Collector: `ast.Inspect` over each `*ast.FuncDecl` (closures belong to it; `symbolId` from `symbols.FuncDeclSymbolID`) and package-level value specs (`symbols.SymbolID(rel, name, "variable")`):
  - conditions of `*ast.IfStmt`, the `*ast.ForStmt` condition and tagless `*ast.SwitchStmt` case expressions; `*ast.BinaryExpr` comparisons through `LAND`, `LOR`, `*ast.UnaryExpr` `NOT` and `*ast.ParenExpr`;
  - tagged switches give `case` evidence for literal case values; literals `*ast.BasicLit` (INT, FLOAT, CHAR, STRING) and `nil`, `true`, `false` resolved to universe objects through `TypesInfo.Uses`;
  - calls `*ast.CallExpr` with a `*ast.SelectorExpr` callee (qualifier = the `X` source); bindings `*ast.ValueSpec`, `*ast.AssignStmt` and `*ast.KeyValueExpr` with an identifier key;
  - durations: a `*ast.BinaryExpr` `MUL` with a `time` constant (`TypesInfo.Uses` gives a `*types.Const` of package `time`) and a numeric side, `time.Duration(n) * time.X`, or a bare `time.X` as a bound value;
  - routes: callees resolved to `net/http.HandleFunc`, `net/http.Handle`, `(*net/http.ServeMux).HandleFunc` and `Handle`, and methods of `github.com/gin-gonic/gin.RouterGroup` (`GET` ... `Any`, `Handle`), with a constant string path.
  
  `line` is `fset.Position(pos).Line - 1` (the analyzer's symbol lines are not changed).
- TypeScript: `GoAnalyzerRunOptions { sqlCallSites?; facts?: FactOptions; timeoutMs? }`; `buildGoAnalyzerArgs` appends `--facts=<encodeFactOptions>`; `GoAnalyzerAdapter({ sqlCallSites?, facts? })` and `GoCompositeAdapter({ sqlCallSites?, facts? })` gain `extractFacts` (`finishFacts` over the cached evidence and symbols; Go has no annotation routes).
- Fixture `loans/facts.go`:
  - declarations `const maxRetries = 3`, `const settlementDays = 3`, `var holdTimeout = 90 * time.Minute`;
  - `CanBorrow(openLoans int, member *string) bool` with `if member == nil { return false }` and `if openLoans >= 5 && *member != "" { return false }`;
  - `Fee(tier string) float64` with `switch tier { case "gold": return 0; case "": return 1 }`; `Key(email string) string { return strings.ToLower(strings.TrimSpace(email)) }`;
  - `Routes(mux *http.ServeMux, r *gin.Engine)` with `mux.HandleFunc("GET /holds/{id}", nil)`, `http.HandleFunc("/health", nil)`, `r.GET("/loans/:id", nil)`; `Note() string { return "if x > 5 { timeout = 30 }" }`.
- Expected facts (`loans/facts.go`): `maxRetries` (variable) `maxRetries = 3`; `holdTimeout` (variable) `holdTimeout = 90min`; `CanBorrow` `openLoans >= 5`; `Fee` `tier case "gold"`; `Key` `strings.TrimSpace(email)` (`TrimSpace`) and `strings.ToLower(strings.TrimSpace(email))` (`ToLower`); `Routes` `GET /holds/{id}`, `ANY /health`, `GET /loans/:id`.

- [ ] **Step 1: Write the failing tests.**
  - `facts_test.go` (temp modules with the gin stub wired through `replace`): `TestCollectReportsTheFixtureEvidence` (table-driven over the expected rows' evidence); `TestFragmentsAndPatternsFollowTheVectors` (reads `packages/plugin-api/conformance/fact-vectors.json` by walking up from the test's working directory); `TestNilIsANullLiteralAndStringsGiveNothing` (the analyzer reports `member == nil` with `literalKind: "null"`, which the finisher drops later, and nothing for `Note`); `TestClosuresBelongToTheEnclosingFunction`; `TestDecodeRejectsBadInput`.
  - `main_test.go`: `TestRunReportsFactEvidenceOnlyWithTheFlag`.
  - TypeScript: copied rule tests; `analyzer-process.test.ts`: `buildGoAnalyzerArgs appends --facts= only with facts`; `lending-module.integration.test.ts`: `the facts fixture gives the expected facts in the full tier`, `evidence ids carry the module prefix when go.mod sits in a subdirectory`; `plugin.test.ts`: `createAdapter enables facts only with capabilities.facts`.
- [ ] **Step 2: Run them.** `(cd packages/lang-go/tools/ctxo-go-analyzer && go test ./...)` and `pnpm --filter @ctxo/lang-go test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS; then `go vet ./...` in the analyzer and `pnpm --filter @ctxo/lang-go build && pnpm --filter @ctxo/lang-go typecheck`.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture additions; `git commit -S -m "feat(lang-go): analyzer fact evidence behind --facts with net/http and gin endpoints (#156)"`.

---

### Task 9: Go facts in the tree-sitter tier; tier agreement

**Files:**
- Create: `packages/lang-go/src/facts/tree-sitter-evidence.ts`
- Modify: `packages/lang-go/src/go-adapter.ts` (options, `extractFacts`), `src/composite-adapter.ts` (the syntax tier serves facts when the analyzer is not active). Before editing: the two MCP tools on `GoAdapter` and `GoCompositeAdapter`.
- Test: `src/facts/__tests__/tree-sitter-evidence.test.ts`, new `src/__tests__/facts-tier-agreement.integration.test.ts`

**Interfaces:**
- Produces: `collectTreeSitterEvidence(root, file, symbols, options): FactEvidence[]` and `GoAdapter({ facts? }).extractFacts`, as in Task 4.
- Nodes (confirm against tree-sitter-go 0.23.4): `if_statement` (`condition`), `for_statement` (`for_clause` condition or a bare condition), `expression_switch_statement` (`value`) with `expression_case` (`value`), `binary_expression`, `unary_expression`, `parenthesized_expression`; `call_expression` (`function`: `selector_expression` with `operand` and `field`); `const_spec`, `var_spec`, `short_var_declaration`, `assignment_statement`, `keyed_element`; literals `int_literal`, `float_literal`, `interpreted_string_literal`, `raw_string_literal`, `rune_literal`, `true`, `false`, `nil`. Routes and durations by name (`http.HandleFunc`, `<x>.HandleFunc`, `<x>.Handle`, `<x>.GET`..., `time.<Unit>` with the import alias of `time`). Package-level `const` and `var` get `<file>::<name>::variable` (G8).

- [ ] **Step 1: Write the failing tests.** `tree-sitter-evidence.test.ts`: `the syntax tier reports the Task 8 table`; `package-level constants use the analyzer's variable ids`; `CRLF line endings give the same facts`. `facts-tier-agreement.integration.test.ts` (gated on Go): `both tiers give the same facts` (Review Focus 2).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/lang-go exec vitest run src/facts src/__tests__/facts-tier-agreement.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/lang-go test && pnpm --filter @ctxo/lang-go build`.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -S -m "feat(lang-go): tree-sitter fact evidence that agrees with the analyzer (#156)"`.

---

### Task 10: Cross-language acceptance for native facts

**Files:**
- Create: `packages/cli/tests/e2e/facts-four-languages.test.ts`

**Interfaces:**
- Consumes: every task above; `IndexCommand` as PR 1C's `language-parity-sql.test.ts` drives it; `createProject`; `JsonIndexReader`.
- Project (written into a `createProject()` repo, then committed): `src/policy.ts` (`export function canBorrow(n: number): boolean { if (n >= 5) return false; return true; }`), `src/empty.ts` (`export const label = 'x';`), `Parity.csproj` (net8.0) and a classic-format `Parity.sln` listing it (a template string with the solution header and one `Project(...)` entry for `Parity.csproj`, so the Roslyn tier opens a solution) with `src/LoanPolicy.cs` (`namespace Parity; public class LoanPolicy { public bool CanBorrow(int n) { if (n >= 5) return false; return true; } }`), `src/main/java/parity/LoanPolicy.java` (the same method), `go.mod` (`module parity`, `go 1.22`) with `loans/policy.go` (`func CanBorrow(n int) bool { if n >= 5 { return false }; return true }`), and a `package.json` whose devDependencies list the four official plugins (`*`). Gates as in PR 1C's e2e (`HAS_GO`, `CAN_RUN_JDT` with `CTXO_JDT_ANALYZER_JAR` stubbed); C# runs in whichever tier the machine allows.

- [ ] **Step 1: Write the acceptance tests.** The test writes every project file, `Parity.sln` included, before the commit.
  - `without a fact request no file has a facts key` (no config).
  - `with index.facts every language reports the n >= 5 comparison` (spec 12.4: for `src/policy.ts`, `src/LoanPolicy.cs`, `src/main/java/parity/LoanPolicy.java` and `loans/policy.go`, the FileIndex `facts` holds `{ kind: 'literal-comparison', text: 'n >= 5', detail: { operator: '>=', literal: '5' } }`; Java and Go `it.skipIf` their gates only for the full tier, the syntax tier runs everywhere).
  - `a file of a fact-capable plugin without facts carries facts: []` (`src/empty.ts`).
  - `indexing the same commit twice gives deep-equal facts for every file` (spec 13.1).
- [ ] **Step 2: Run them.** `pnpm -r build && pnpm --filter @ctxo/cli exec vitest run --config vitest.config.e2e.ts tests/e2e/facts-four-languages.test.ts`. Expected: PASS on this machine with every gate open (an acceptance test over Tasks 1 to 9; a failure names the task to fix).
- [ ] **Step 3: Full check of Part 1.** `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm --filter @ctxo/cli test:e2e`, `mvn -q -f packages/lang-java-analyzer/java/pom.xml -Pjava17 test`, `(cd packages/lang-go/tools/ctxo-go-analyzer && go vet ./... && go test ./...)`. Expected: green, the tarball test included. `pnpm --filter @ctxo/lang-csharp pack --dry-run` lists `tools/ctxo-roslyn/Facts.cs`; `pnpm --filter @ctxo/lang-go pack --dry-run` lists `tools/ctxo-go-analyzer/internal/facts/facts.go` and no `test-fixtures/` path.
- [ ] **Step 4: Commit.** `git add packages/cli/tests/e2e/facts-four-languages.test.ts && git commit -S -m "test(e2e): native facts in TypeScript, C#, Java and Go behind the fact request (#156)"`.

---

## Spec coverage (self-review, Part 1)

| Spec | Tasks |
|---|---|
| 12.1 four fact kinds, detection rules, `detail` keys, configurable lists and trivial literals | Fact contract, 2 (rules, vectors), 3 to 9 |
| 12.1 native primary tiers (ts-morph, Roslyn IOperation, the Go analyzer, JDT) | 5, 3, 8, 6 |
| 12.1 tree-sitter tiers through simple queries | 4, 7, 9 |
| 12.1 C# validated first on the fixture | 4 Step 6 (before Tasks 5 to 9) |
| 8.3 facts produced only on request; JSON only | 1, 3 to 10 |
| 12.4 native facts exist for all four official languages | 10 |
| 13.1 determinism; 13.4 cost recorded on the fixture | 2, 4, 5, 10; 4 Step 6 |
| Text-scan fallback, `source`, candidates, tools, docs, changesets | Part 2 |
