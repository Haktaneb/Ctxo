# PR 1C: Language Parity for TypeScript, Java and Go Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the TypeScript, Java and Go plugins what PR 1B gave C#: SQL edges at known call sites (constants only, full tier only, behind `capabilities.sqlCallSites`), typed annotations (TypeScript decorators, Java annotations, Go struct tags) and test symbols with edges, so rule-to-test links and reachability from tests work in all four official languages (Phase 1 of #156, K18).

**Architecture:**
- lang-typescript works in process: decorators and test blocks come from the ts-morph AST; SQL call sites are found through a data table of library members, a receiver-provenance walk (the in-memory project has no library types) and a constant evaluator, then parsed with `@ctxo/sql-extract`.
- The JDT analyzer and ctxo-go-analyzer emit annotations (Go: raw struct tags) and, with `--sql-call-sites`, `{ symbolId, line, text, kind }` records in their own JSON. The TypeScript side of each plugin turns the records into `reads`, `writes` and `executes` edges with `@ctxo/sql-extract`. The Go analyzer loads test packages and partitions package variants so every file is analysed once.
- The shared corpus in `packages/sql-extract/corpus` gains host-language cases that each plugin runs, so all four languages and lang-sql resolve to the same canonical nodes. An e2e test proves that no SQL edge appears without `@ctxo/lang-sql` and that, with it, every language reaches the same table node.

**Tech Stack:** TypeScript (ESM, Node >= 20), ts-morph 28, tree-sitter 0.22 with tree-sitter-java 0.23.5 and tree-sitter-go 0.23.4, vitest; Java 11/17 (Eclipse JDT Core 3.33 and 3.39, Gson, JUnit 5, Maven); Go (golang.org/x/tools/go/packages, `go/types`; the analyzer module says `go 1.25.0`); `@ctxo/sql-extract` and `@ctxo/plugin-api` v2 from PR 1B; pnpm workspace with changesets.

**Spec:** `docs/superpowers/specs/2026-10-20-domain-knowledge-layer-design.md`, section 8A (8A.1 to 8A.5), building on section 8 (PR 1B), with sections 3, 4, 5, 13, 15 and 18 (K18 and the PR 1C calls). Interfaces consumed from PR 1B: `docs/superpowers/plans/2026-10-21-pr1b-plugin-v2-and-sql.md`.

## Global Constraints

- **Base:** worktree and branch `feat/language-parity-156`, stacked on the finished PR 1B branch `feat/plugin-v2-sql-156` (itself on PR 1A and PR 0). Consumed by name: from PR 1B, `SymbolAnnotation`, `SymbolNode.annotations`, `PluginCapabilities`, `PluginContext.capabilities`, the v2 `EDGE_KINDS`, `hostCapabilities` (sets `sqlCallSites` only when a discovered plugin lists `.sql`), `@ctxo/sql-extract` (`extractSqlAccesses(text, kind?)`, `SqlAccess`, `SqlTextKind`), the corpus and its format in `packages/sql-extract/corpus`, `@ctxo/lang-sql`, the data-resource resolution in `SymbolGraph`, confirmed data tiers in `BlastRadiusCalculator`; from PR 1A, `DEFAULT_TEST_GLOBS` and `createProject` in `packages/cli/src/cli/__tests__/helpers/temp-project.ts`; existing `loadGraph` (`packages/cli/src/cli/graph-loader.ts`).
- **Scope (spec 8A.1):** raw SQL text at known call sites and stored-procedure calls, compile-time constants only, full tier only, emitted only with `capabilities.sqlCallSites`. ORM and query builders stay out in every language: EF LINQ, JPQL and Spring Data derived queries, knex chains, Prisma model calls, TypeORM repositories, gorm model calls.
- **Canonical names (spec 8A.1):** the same 2-part form as C#, produced only by `@ctxo/sql-extract`; edges go to `<schema.name>::table` for `reads` and `writes` and to `<schema.name>::procedure` for `executes`.
- **Annotation caps (spec 8.4, "same caps as C#"):** 20 annotations per symbol, 10 args each, 200 chars per arg; like PR 1B designer call 11, at most 10 `named` entries; `args` and `named` omitted when empty.
- **Dependencies:** language plugins import only from `@ctxo/plugin-api`, the documented exception `@ctxo/sql-extract` (ADR-017), their own parsers (`ts-morph`, `tree-sitter`, `tree-sitter-java`, `tree-sitter-go`) and Node built-ins; never from `@ctxo/cli`.
- **Protocol:** the three plugins keep `apiVersion: '1'` and PR 1B's peer range `^0.7.3 || ^0.8.0 || ^0.9.0` (designer call 1); `@ctxo/lang-sql` peers `^0.8.0 || ^0.9.0`. The plan does not depend on the owner's separately staged 0.8.0 release: both ranges hold whether plugin-api is at its next minor `0.8.0` or `0.9.0`.
- **Output channels:** never `console.log`. Plugins log through their own stderr logger (`createLogger`, gated by `DEBUG`); the existing `console.error` diagnostics in `ts-morph-adapter.ts` stay. Analyzers keep JSONL on stdout and diagnostics on stderr.
- **Determinism (spec 13.1):** the TypeScript side sorts every list it emits with codepoint order (`a < b ? -1 : a > b ? 1 : 0`, never `localeCompare`); analyzer output order never decides edge order; no wall clock or randomness; the same input twice gives deep-equal symbols and edges.
- **Tests:** vitest co-located in `__tests__/`; JUnit 5 in `packages/lang-java-analyzer/java/src/test`; Go tests next to the Go sources. Gates: Java full tier `describe.skipIf(!CAN_RUN_JDT)` (Task 5 helper: JRE >= 11 and a built analyzer JAR), Go `describe.skipIf(!detectGoToolchain().available)`. Go fixture modules are copied to a temp dir before analysis (the analyzer runs with `GOFLAGS=-mod=mod`, which may rewrite `go.mod`). Fixtures use stub types with the real package and type names (Java stub sources, Go stub modules wired through `replace`), never downloaded dependencies. Every git operation that creates commits in a temp repo (commit, merge, rebase, cherry-pick, amend, revert, tag) passes `-c commit.gpgsign=false -c user.name=Test -c user.email=test@test.com`, plus `-c tag.gpgsign=false` for tags.
- **Build order:** rebuild `@ctxo/plugin-api` and `@ctxo/sql-extract` before plugin tests and `@ctxo/lang-sql` before CLI tests (they resolve through `dist/`); after Java changes rebuild both JARs with `pnpm --filter @ctxo/lang-java-analyzer build`; the Go binary rebuilds itself (its cache key hashes the analyzer sources).
- **Toolchains (checked 2026-10-21):** Node 24, .NET SDK 10, git 2.50, Go 1.24.4 (inside the analyzer module `GOTOOLCHAIN=auto` selects the cached go1.25.0), Temurin JDK 21, Maven 3.9.16. Every gated test runs locally. CI runs no plugin tests today; Task 13 adds a job with JDK 21 and Go.
- **Git:** stage exactly the task's paths (`git add <path>...`, never `-A` or `.`), never `.ctxo/` or `.claude/settings.local.json`. Branch commits are GPG-signed through the user's config: never pass `--no-gpg-sign` or `-c commit.gpgsign=false` there; on a signing failure stop and report BLOCKED. The post-commit hook may take minutes; wait for the commit to return.
- **Safe edits:** before editing an existing symbol, call the ctxo MCP tools `get_blast_radius` and `get_why_context` on it; each task names the symbols. The Java sources are not in this repo's ctxo index (the root manifest lists no `@ctxo/lang-java`), so `found: false` is expected there; note it in the task report. More generally, the session's ctxo MCP server indexes the main checkout (older code), so `found: false` from either tool for a symbol added on these branches is expected: call the tools as the project rule asks, then proceed.
- **Text:** English only, no em dashes, no `Co-Authored-By` or AI attribution lines. No push, PR, publish or issue without the owner's approval.
- **Privacy and validation:** every sample uses the synthetic library-lending domain (loans, members, holds); nothing from any private repository. The private fixture is C#, so this PR is validated on the synthetic samples only (spec 8A.5).

## Review Focus

1. **One TypeScript file re-extracted without the rest of the project:** the post-commit hook (`ctxo index --commit HEAD`), `--files` and watch preload only the touched files, so a DB handle or SQL constant imported from an untouched file would not resolve and the committed JSON would flip between full and incremental runs. Expected: identical SQL edges either way. Test owned by Task 4.
2. **Test titles that break or collide symbol IDs:** two `it('works')` in one block, a title built in a loop (`it(c.name, ...)`), `::` in a title, empty, multi-line or 300-character titles, `.each` tables. Expected: unique, valid three-part IDs with deterministic suffixes. Test owned by Task 3.
3. **SQL-looking calls on objects that are not databases:** `bus.execute('CloseLoan')`, `regex.exec(...)`, a search client's `query(...)`, and mysql2 `execute` (a statement) beside mssql `execute` (a procedure) in one file. Expected: no edge unless the receiver traces to the listed library, and that library's kind. Test owned by Task 4.
4. **Go modules whose tests change the package set:** internal and external test packages, a directory with only `_test.go` files, test mains. Expected: each `_test.go` function appears once with its edges, while production records, `dead` and `hasMain` stay exactly as without tests. Tests owned by Task 10.
5. **Java projects without dependency JARs on the classpath** (no `.classpath`, no `.idea` libraries, no matching `~/.m2` artifacts): Spring, JPA, MyBatis and JUnit types do not resolve. Expected: annotations still come from the syntax, and call sites still match through the receiver's declared type and the imports. Tests owned by Tasks 5 and 7.

## Designer calls (spec gaps decided here; the owner may override)

1. **Versions:** lang-typescript, lang-java and lang-go keep `apiVersion: '1'` (PR 1B's lowest-version rule: a v1 core drops annotations and never sets `sqlCallSites`) and PR 1B's peer range. lang-java-analyzer gets the same bump as lang-java, so jar-resolve's base-version check stays quiet.
2. **Metadata on members that are not symbols** (TypeScript class properties, Go struct fields) attaches to the enclosing class symbol, with the member name in the reserved key `named.member` (it wins over a same-named key and does not count toward the 10 entries). No new property or field symbols, so dead-code reports and communities do not grow. Java fields are symbols, so their annotations stay on them.
3. **TypeScript decorators:** `name` is the rightmost identifier of the decorator expression; `args` are its string-literal and no-substitution-template arguments; `named` holds string-valued properties of object-literal arguments (first occurrence wins); accessor and parameter decorators are ignored; a class lists its own decorators before its property decorators.
4. **Java annotations:** the `value` member (shorthand or explicit) goes to `args`, other members to `named`; declared values only (no defaults); strings as is, numbers `String.valueOf`, `true`/`false`, enum constants `Type.MEMBER`, class literals as the qualified name (as written when unresolved), arrays flattened in `args` and joined with `,` in `named`; nested annotations and nulls skipped; no `named.type` (Java members named `type` are common).
5. **TypeScript test files** are recognised by the TS/JS part of `DEFAULT_TEST_GLOBS` (`**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`), reimplemented in the plugin because it cannot import the CLI; `index.tests` extras do not reach plugins (`PluginContext.config` is always `{}`, spec 19).
6. **TypeScript test blocks:** the recognised callees, title rules and ` #n` suffixes of Task 3; a block's `calls` and `uses` edges come from its own callback minus nested blocks, so each `it` owns its edges and a `describe` keeps its hooks; import edges keep today's source.
7. **TypeScript call sites without library types:** a receiver counts only when a provenance walk ties it to the row's module; relative modules missing from the in-memory project are read from disk for the duration of one `extractEdges` call (Review Focus 1); constants also cover `+` and templates whose substitutions are constants (parity with C# and Java concatenation); pg `{ text }` and mysql2 `{ sql }` config objects count; edges come from exported functions, methods of exported classes, exported variables and test blocks (the TypeScript counterpart of C#'s method and constructor bodies).
8. **Java call sites:** the owner is matched on the receiver's static type, the binding's declaring class or any supertype, else on the declared type through the imports; the SQL is the first argument (every argument of an all-String `batchUpdate`); a JDBC escape `{call name(...)}` is a procedure name wherever it appears; edges come from the enclosing method or constructor (like C#), while JDT's `calls` and `uses` edges stay type-level.
9. **Go tests:** load with `Tests: true`, then partition into production packages (exactly today's set) and test variants. The production passes run unchanged; a test pass analyses only `_test.go` files, first variant by ID, with `implements` and `extends` computed inside that variant's own universe; reachability runs on production packages only and `dead` never lists test symbols.
10. **Go call sites:** the callee's method object (pointer stripped) names the receiver type, falling back to the selection's receiver; the SQL is the argument bound to the first `string` parameter; sqlx package functions count; `*sql.Stmt` methods carry no SQL text (it is read at `Prepare`); pgx v4 and v5 paths both count.
11. **Go struct tags:** the analyzer emits raw `{ field, tag }` pairs and one TypeScript parser builds the annotations for both tiers, so the tiers agree by construction; the tree-sitter tier reads tags too.
12. **Analyzer protocol:** both analyzers take `--sql-call-sites` (like C#); their final summary lines gain `sql: { constant, nonConstant }`; record lines are 0-based.
13. **Corpus:** host-language sources are `<case>.<ts|java|go>.fixture` with an `expected.json` holding the union of accesses; they default to `sides: []`, so only the matching plugin runs them; Java and Go cases run with the plugin's stubs.
14. **`sqlEdgesFromCallSites`** is a short module duplicated in each plugin: plugins share no code beyond plugin-api and sql-extract, and sql-extract stays the two-function library of spec 8.5.
15. **Java sample** lives in `packages/lang-java-analyzer/java/src/test/resources/lending`, shared by JUnit and lang-java tests like the existing `fixture/`; a test helper resolves the built JAR (`-17` or `-11`) because the default path in today's integration tests no longer exists.
16. **CI:** a `plugin-tests` job runs the lang-typescript, lang-java and lang-go vitest suites, JUnit in both Maven profiles and `go test`, with JDK 21 and Go.
17. **Changesets:** minor for `@ctxo/lang-typescript`, `@ctxo/lang-java`, `@ctxo/lang-java-analyzer` and `@ctxo/lang-go`; patch for `@ctxo/cli` (help text); none for `@ctxo/sql-extract` (only its tests and the unpublished corpus change).

## Shared contracts (normative)

### Annotation shape

`SymbolAnnotation { name, args?, named? }` from plugin-api, in source order, capped per Global Constraints, values cut at 200 characters. Reserved `named` keys: `type` (C#, PR 1B) and `member` (designer call 2). A symbol with no annotations has no `annotations` key.

### SQL call-site record and edges

```json
{ "symbolId": "src/main/java/lending/data/LoanRepository.java::findActive::method", "line": 41, "text": "SELECT ...", "kind": "statement" }
```

`line` is 0-based; `kind` is `statement` or `procedureName`. Java records sit in `FileResult.sqlCallSites`, Go records in `FileRecord.sqlCallSites`; both are omitted when empty and absent without `--sql-call-sites`. Each plugin's `sqlEdgesFromCallSites(sites)` calls `extractSqlAccesses(site.text, site.kind)` and emits `{ from: site.symbolId, to: '<name>::table', kind: 'reads' | 'writes' }` or `{ from, to: '<name>::procedure', kind: 'executes' }`, unique by `from|kind|to`, sorted by `from`, then `kind`, then `to`.

### Known-API tables

Spec 8A.2, verbatim:

| Language | Where | APIs |
|---|---|---|
| TypeScript/JS | ts-morph, in process | pg `query`; mysql2 `query`/`execute`; mssql `request.query`, `request.execute(proc)` (procedure); `knex.raw`; Prisma `$queryRaw`/`$executeRaw` and their `Unsafe` forms; TypeORM `query`; Sequelize `query`; better-sqlite3 `prepare`/`exec`. Constants: string literals, templates without substitutions, `const` bindings ts-morph can resolve, tagged templates with interpolations replaced by placeholders |
| Java | JDT analyzer reports, the TS side parses | JDBC `prepareStatement`, `prepareCall` (`{call proc}` is a procedure), `Statement.execute*`; Spring `JdbcTemplate` / `NamedParameterJdbcTemplate`; `EntityManager.createNativeQuery`; `@Query(value = ..., nativeQuery = true)`; MyBatis `@Select`/`@Insert`/`@Update`/`@Delete`. Constants through JDT constant evaluation (literals, `static final`, concatenation, text blocks) |
| Go | ctxo-go-analyzer reports, the TS side parses | `database/sql` `Query`/`QueryRow`/`Exec`/`Prepare` (and `Context` forms) on DB, Tx, Conn, Stmt; sqlx `Select`/`Get`/`Queryx`/`NamedExec`/`MustExec`; pgx `Query`/`QueryRow`/`Exec`; gorm `Raw`/`Exec`. Constants through `go/types` constant values |

The data each plugin encodes:

| Plugin | Module or owner | Members | SQL text | Kind |
|---|---|---|---|---|
| TS | `pg` | `query` | first argument, or its `text` property | statement |
| TS | `mysql2` | `query`, `execute` | first argument, or its `sql` property | statement |
| TS | `mssql` | `query` | first argument, or the tagged template | statement |
| TS | `mssql` | `execute` | first argument | procedureName |
| TS | `knex` | `raw` | first argument | statement |
| TS | `@prisma/client` | `$queryRaw`, `$executeRaw` | the tagged template, or a tagged-template first argument | statement |
| TS | `@prisma/client` | `$queryRawUnsafe`, `$executeRawUnsafe` | first argument | statement |
| TS | `typeorm`, `sequelize` | `query` | first argument | statement |
| TS | `better-sqlite3` | `prepare`, `exec` | first argument | statement |
| Java | `java.sql.Connection` | `prepareStatement`, `prepareCall` | first argument | statement, or procedureName for a call escape |
| Java | `java.sql.Statement` | names starting with `execute` | first argument | same |
| Java | `org.springframework.jdbc.core.JdbcTemplate`, `JdbcOperations`; `org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate`, `NamedParameterJdbcOperations` | `query`, `queryForObject`, `queryForList`, `queryForMap`, `queryForRowSet`, `queryForStream`, `update`, `batchUpdate`, `execute` | first argument; every argument of an all-String `batchUpdate` | same |
| Java | `javax.persistence.EntityManager`, `jakarta.persistence.EntityManager` | `createNativeQuery` | first argument | same |
| Java | annotation `org.springframework.data.jpa.repository.Query` on a method | `value` when `nativeQuery = true` | annotation value | same |
| Java | annotations `org.apache.ibatis.annotations.Select`, `Insert`, `Update`, `Delete` on a method | `value` | array elements joined with one space | same |
| Go | `database/sql` types `DB`, `Tx`, `Conn`, `Stmt` | `Query`, `QueryRow`, `Exec`, `Prepare` and their `Context` forms | first `string` parameter | statement |
| Go | `github.com/jmoiron/sqlx` types `DB`, `Tx`, `Conn` and package functions | `Select`, `Get`, `Queryx`, `NamedExec`, `MustExec` | first `string` parameter | statement |
| Go | `github.com/jackc/pgx/v5` and `/v4` (`Conn`, `Tx`), their `pgxpool` (`Pool`, `Conn`, `Tx`) | `Query`, `QueryRow`, `Exec` | first `string` parameter | statement |
| Go | `gorm.io/gorm` type `DB` | `Raw`, `Exec` | first `string` parameter | statement |

### Corpus host-language cases

`packages/sql-extract/corpus/<case>.<ext>.fixture` (`ext` is `ts`, `java` or `go`) with `<case>.expected.json`:

```json
{ "description": "one sentence", "mode": "typescript", "accesses": { "reads": ["dbo.loans"], "writes": [], "executes": ["dbo.usp_closeloan"] } }
```

`mode` is `typescript`, `java` or `go` and matches the extension; `accesses` is the union of the data edges of every call site in the case, by kind, canonical names sorted, every key present. `sides` defaults to `[]` for these modes (leave it out of the file): no sql-extract, lang-sql or ScriptDom test runs a host case, because those tests select cases by `mode` and `sides` (PR 1B's corpus format) and a host case has no `.sql` file. A TypeScript case is the module `src/<case>.ts`; a Java case declares `package corpus;` and `public class <PascalCase of the case name>`; a Go case is `package corpus` in its own directory `<case>/`. Only the matching plugin runs a host case; sql-extract's corpus test checks pairing and modes.

---

### Task 0: Branch setup (no commit)

- [ ] **Step 1:** Create the worktree with superpowers:using-git-worktrees: branch `feat/language-parity-156` from the head of `feat/plugin-v2-sql-156` once every PR 1B task is committed. Copy this plan in if it is missing (Task 1 commits it).
- [ ] **Step 2:** `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test`. Expected: green. `pnpm -r build` also builds `packages/lang-java-analyzer/jar/ctxo-jdt-analyzer-11.jar` and `-17.jar`.
- [ ] **Step 3:** Record in the scratchpad: `go version`, `(cd packages/lang-go/tools/ctxo-go-analyzer && go version)`, `java -version`, `mvn -version`, the peer ranges for `@ctxo/plugin-api` of the four existing plugins (expected `^0.7.3 || ^0.8.0 || ^0.9.0`, as PR 1B Task 16 sets them whether or not the owner's staged release has landed) and of `@ctxo/lang-sql` (expected `^0.8.0 || ^0.9.0`), and `apiVersion: '1'` in the TypeScript, Java and Go plugin entries.
- [ ] **Step 4: Baseline of the gated suites.** `CTXO_JDT_ANALYZER_JAR="$PWD/packages/lang-java-analyzer/jar/ctxo-jdt-analyzer-17.jar" pnpm --filter @ctxo/lang-java test`; `pnpm --filter @ctxo/lang-java-analyzer test`; `mvn -q -f packages/lang-java-analyzer/java/pom.xml -Pjava17 test`; `(cd packages/lang-go/tools/ctxo-go-analyzer && go test ./...)`; `pnpm --filter @ctxo/cli exec vitest run --config vitest.config.e2e.ts tests/e2e/go-full-tier.test.ts`. Expected: green. Without the variable the existing Java full-tier tests skip; if one fails with it, record it and tell the owner before Task 5.

---

### Task 1: ADR-017 addendum (first commit of the PR)

**Files:**
- Modify: `docs/architecture/ADR/adr-017-plugin-protocol-v2-and-data-coupling.md` (new section `## Addendum: language parity (PR 1C, <release>)`, where `<release>` is the version `pnpm changeset status` reports (expected 0.13 if the staged release lands first); the Status field notes the addendum)
- Add: `docs/superpowers/plans/2026-10-21-pr1c-language-parity.md` (gitignored folder, `git add -f`)

- [ ] **Step 1: Write the addendum.** It records:
  - scope (spec 8A.1, the ORM exclusions), canonical names through `@ctxo/sql-extract`, and the TypeScript, Java and Go plugins joining the sql-extract dependency exception;
  - the known-API tables as data in each plugin, and how each language matches a call site: receiver provenance in lang-typescript with lazy reads of relative modules; receiver type or supertypes with an import fallback, plus annotation types, in the JDT analyzer; the callee's method object in ctxo-go-analyzer;
  - the analyzer protocol: `--sql-call-sites`, the call-site record, the `sql` stats, parsing on the TypeScript side;
  - annotations per language with the C# caps, the reserved `named.member`, and no `named.type` for Java;
  - test symbols: Go `Tests: true` with the production and test partition; TypeScript test blocks (title paths, `{ name: 'test' }`, own-body edges, ` #n` suffixes); Java test sources verified;
  - versioning (the three plugins stay `apiVersion: '1'` with PR 1B's peer range) and the corpus host-language modes;
  - consequences: a one-time change of committed index JSON for TypeScript, Java and Go; tests count as blast-radius dependents, so the safe-edit gate may fire more often on well-tested symbols, as it does for C#; find_dead_code no longer reports Go functions whose only callers are tests (as in the other languages); Go full-tier runs type-check test packages; symbol-level communities shift once after the upgrade;
  - alternatives rejected: library types through `node_modules` in ts-morph (slow, install-dependent), SQL parsing inside each analyzer (four parsers instead of one), new symbols for TypeScript properties and Go fields, moving JDT `calls`/`uses` edges from types to methods in this PR, an edge helper inside `@ctxo/sql-extract`.
- [ ] **Step 2: Check the text.** `LC_ALL=C.UTF-8 grep -nP '\x{2014}' docs/architecture/ADR/adr-017-plugin-protocol-v2-and-data-coupling.md` prints nothing.
- [ ] **Step 3: Commit.**
  ```bash
  git add docs/architecture/ADR/adr-017-plugin-protocol-v2-and-data-coupling.md
  git add -f docs/superpowers/plans/2026-10-21-pr1c-language-parity.md
  git commit -m "docs(adr): ADR-017 addendum for TypeScript, Java and Go parity (#156)"
  ```

---

### Task 2: TypeScript decorators as annotations

**Files:**
- Create: `packages/lang-typescript/src/decorators.ts`
- Modify: `packages/lang-typescript/src/ts-morph-adapter.ts` (`extractClasses`). Before editing: `get_blast_radius` and `get_why_context` on `packages/lang-typescript/src/ts-morph-adapter.ts::TsMorphAdapter::class`.
- Create: `packages/lang-typescript/src/__tests__/fixtures/lending-sample/src/loan.entity.ts.fixture`, `src/loan.controller.ts.fixture`; `packages/lang-typescript/src/__tests__/helpers/lending-sample.ts`
- Test: new `packages/lang-typescript/src/__tests__/decorators.test.ts`, new `packages/lang-typescript/src/__tests__/lending-sample.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // decorators.ts
  export const ANNOTATION_CAPS = { perSymbol: 20, args: 10, named: 10, chars: 200 } as const;
  export function classAnnotations(cls: ClassDeclaration): SymbolAnnotation[] | undefined;    // own decorators, then property decorators with named.member
  export function methodAnnotations(method: MethodDeclaration): SymbolAnnotation[] | undefined;
  // __tests__/helpers/lending-sample.ts
  export function readLendingSample(): Map<string, string>;   // 'src/x.ts' -> content ('.fixture' stripped), sorted by path
  export function writeLendingSample(dir: string): void;      // the same files written under dir
  ```
- Rules: designer call 3 and the annotation shape.
- Sample: `src/loan.entity.ts` is `@Entity('loans') export class Loan { @PrimaryGeneratedColumn() id!: number; @Column({ name: 'member_id', type: 'int', nullable: false }) memberId!: number; note = ''; }` (imports from `typeorm`); `src/loan.controller.ts` is `@Controller('loans') export class LoanController { constructor(private readonly loans: LoanRepository) {} @Get(':id') @HttpCode(200) find(@Param('id') id: string) { return this.loans.byMember(Number(id)); } }` (imports from `@nestjs/common` and `./loan.repository`).

- [ ] **Step 1: Write the failing tests.**
  - `decorators.test.ts`:
    - `class and method decorators become annotations with their string arguments`: the controller gives class `[{ name: 'Controller', args: ['loans'] }]` and `LoanController.find` `[{ name: 'Get', args: [':id'] }, { name: 'HttpCode' }]` (`200` is not a string; the parameter decorator is ignored).
    - `property decorators attach to the class with named.member`: the entity gives `Loan` `[{ name: 'Entity', args: ['loans'] }, { name: 'PrimaryGeneratedColumn', named: { member: 'id' } }, { name: 'Column', named: { member: 'memberId', name: 'member_id', type: 'int' } }]`, and there is no symbol named `Loan.memberId` or `Loan.note`.
    - `a qualified decorator keeps its rightmost name and a bare one has no args`: `@nest.Injectable() @Sealed export class S {}` gives `[{ name: 'Injectable' }, { name: 'Sealed' }]`.
    - `object keys may be identifiers or strings, the first wins and member is reserved`: `@Opt({ a: 'x' }, { a: 'y', 'b-c': 'z', member: 'm' })` on property `p` gives `named: { member: 'p', a: 'x', 'b-c': 'z' }`.
    - `caps limit annotations, arguments, named entries and value length`: 25 class decorators `@D0` to `@D24` give `D0` to `D19`; 12 string arguments give the first 10; an object with 12 string properties gives `member` plus 10; a 250-character literal gives 200 characters.
    - `accessor and parameter decorators and non-exported classes produce nothing`; `symbols without decorators carry no annotations key`.
  - `lending-sample.test.ts`: `the entity and the controller carry their decorators` (both sample files through `extractSymbols`; the values above).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/plugin-api build && pnpm --filter @ctxo/lang-typescript exec vitest run src/__tests__/decorators.test.ts src/__tests__/lending-sample.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `decorators.ts` on ts-morph's `getDecorators()` and `getArguments()`; `extractClasses` adds `annotations` to class and method symbols only when present.
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/lang-typescript test && pnpm --filter @ctxo/lang-typescript typecheck`. Expected: green, existing tests unchanged.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture folder; `git commit -m "feat(lang-typescript): decorators as symbol annotations (#156)"`.

---

### Task 3: TypeScript test blocks as synthetic function symbols

**Files:**
- Create: `packages/lang-typescript/src/test-blocks.ts`
- Modify: `packages/lang-typescript/src/ts-morph-adapter.ts` (`extractSymbols`, `extractEdges`; `emitUsesEdges` gains an `exclude` list). Before editing: the two MCP tools on `TsMorphAdapter`.
- Create: `lending-sample/src/loan-policy.ts.fixture`, `lending-sample/src/__tests__/loan-policy.test.ts.fixture`
- Test: new `packages/lang-typescript/src/__tests__/test-blocks.test.ts`, `lending-sample.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // test-blocks.ts
  export function isTestFilePath(path: string): boolean;   // designer call 5: a path segment __tests__, test or tests, or a basename containing .test. or .spec.; either separator
  export interface TestBlock {
    readonly symbolId: string;          // '<file>::<title path>::function'
    readonly name: string;              // the title path
    readonly call: CallExpression;      // the symbol's span
    readonly body: Node;                // the callback
    readonly nested: readonly Node[];   // callbacks of every block inside this one
  }
  export function findTestBlocks(sourceFile: SourceFile, filePath: string): TestBlock[];   // source order; [] unless isTestFilePath(filePath)
  export function testBlockSymbol(block: TestBlock): SymbolNode;   // kind 'function', annotations [{ name: 'test' }]
  ```
- Callees (data): groups `describe`, `suite`, `context`, `fdescribe`, `xdescribe`; tests `it`, `test`, `specify`, `fit`, `xit`, `xtest`; chained members `only`, `skip`, `todo`, `concurrent`, `sequential`, `shuffle`, `fails`; called members `each`, `for`, `skipIf`, `runIf` (their argument list comes before the title call). The title is the first argument; the callback is the first arrow or function expression after it; a call without a callback is not a block.
- Titles: a string literal or no-substitution template gives its value; a template with substitutions gives its source text between the backticks; any other expression gives its source text. Whitespace runs become one space, then trim; two or more `:` in a row become one `:`; an empty title becomes `(untitled)`; each title is cut at 200 characters. The path joins enclosing titles with ` > `; a path seen again in the file gets ` #2`, ` #3` in source order, and children use their parent's final name.
- Edges: each block emits `calls` and `uses` edges from `body`, skipping nodes inside `nested`, with the resolution exported functions use (`resolveLocalCallTarget`, the import map, one `uses` edge per name).

- [ ] **Step 1: Write the failing tests** (`test-blocks.test.ts`):
  - `isTestFilePath follows the TypeScript defaults of the shared classifier`: `it.each` true for `src/__tests__/a.ts`, `src/a.test.ts`, `web/a.spec.js`, `test/a.ts`, `tests/e2e/a.ts`, `src\\şube kaydı\\__tests__\\a.ts`, `src/şube kaydı/b.test.tsx`; false for `src/latest.ts`, `src/contest/a.ts`, `src/testing.ts`, `src/a.tests.ts`, `src/attest.spec-helper.ts`.
  - `describe, it and test blocks become function symbols named by their title path`: in `src/__tests__/loan-policy.test.ts`,
    ```ts
    describe('LoanPolicy', () => {
      it('LEND-03 a member holds at most five loans', () => {});
      describe('renewal', () => { test('extends by seven days', () => {}); });
    });
    ```
    gives `LoanPolicy`, `LoanPolicy > LEND-03 a member holds at most five loans`, `LoanPolicy > renewal`, `LoanPolicy > renewal > extends by seven days`, ids `src/__tests__/loan-policy.test.ts::<name>::function`, `annotations` deep-equal to `[{ name: 'test' }]`, and lines spanning each call.
  - `modifiers, tables and options objects are recognised`: `it.only('a', fn)`, `describe.skip.each([1])('b %i', fn)`, `it.skipIf(flag)('c', fn)`, `test('d', { timeout: 5 }, fn)` and `it.todo('e')` give exactly `a`, `b %i`, `c`, `d`.
  - `titles become unique valid ids` (Review Focus 2): `it('works', fn)` twice in one block gives `works` and `works #2`; `for (const c of cases) it(c.name, fn)` gives one symbol `c.name`; `it('Foo::bar', fn)` gives `Foo:bar`; `it('', fn)` gives `(untitled)`; a two-line title collapses to one line; `` it(`handles ${kind}`, fn) `` gives `` handles ${kind} ``; a 300-character title is cut to 200; every id splits into exactly three `::` parts.
  - `blocks outside test files are ignored` (the same source at `src/loan-policy.ts` gives no test symbols).
  - `each block owns the edges of its own body`: a test file importing `{ canBorrow, MAX_LOANS }` from `'../loan-policy'` and `{ reset }` from `'./helpers'` with
    ```ts
    describe('LoanPolicy', () => {
      beforeEach(() => reset());
      it('allows four', () => { expect(canBorrow(4)).toBe(true); });
      it('uses the limit', () => { expect(MAX_LOANS).toBe(5); });
    });
    ```
    gives `LoanPolicy > allows four` calls `src/loan-policy.ts::canBorrow::function`, `LoanPolicy > uses the limit` uses `src/loan-policy.ts::MAX_LOANS::variable`, `LoanPolicy` calls `src/__tests__/helpers.ts::reset::function` with no edge to `canBorrow`, and no edge targets `expect`, `it` or `beforeEach`.
  - `import edges of a test file keep their source` (`src/__tests__/loan-policy.test.ts::loan-policy.test::variable`, as today).
  - `the same test file twice gives deep-equal symbols and edges`.
  - `lending-sample.test.ts`: `the policy test yields test-block symbols with calls into the sample`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/lang-typescript exec vitest run src/__tests__/test-blocks.test.ts src/__tests__/lending-sample.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `extractSymbols` appends `findTestBlocks(...).map(testBlockSymbol)` after the existing symbols; `extractEdges` adds the block edges after the existing passes.
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/lang-typescript test && pnpm --filter @ctxo/lang-typescript typecheck`. Expected: green.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -m "feat(lang-typescript): test blocks as synthetic function symbols with edges (#156)"`.

---

### Task 4: TypeScript SQL at known call sites; corpus host-language cases

**Files:**
- Create: `packages/lang-typescript/src/sql/known-sql-apis.ts`, `sql/module-resolver.ts`, `sql/provenance.ts`, `sql/constant-text.ts`, `sql/sql-call-sites.ts`, `sql/sql-edges.ts`; `packages/lang-typescript/src/logger.ts` (a copy of `packages/lang-go/src/logger.ts`)
- Modify: `packages/lang-typescript/src/ts-morph-adapter.ts` (constructor, `extractEdges`), `src/index.ts` (`createAdapter`), `package.json` (`dependencies` gain `"@ctxo/sql-extract": "workspace:^"`), `tsup.config.ts` (`external` gains `@ctxo/sql-extract`), `pnpm-lock.yaml`. Before editing: the two MCP tools on `TsMorphAdapter` and on `packages/lang-typescript/src/index.ts::plugin::variable`.
- Modify: `packages/sql-extract/src/__tests__/corpus.test.ts` (host-language pairing and modes)
- Create: `packages/sql-extract/corpus/ts-node-drivers.ts.fixture`, `ts-orm-raw-sql.ts.fixture`, `ts-constants.ts.fixture`, each with `<case>.expected.json`
- Create: `lending-sample/src/db.ts.fixture`, `src/queries.ts.fixture`, `src/loan.repository.ts.fixture`
- Test: new `packages/lang-typescript/src/__tests__/sql-call-sites.test.ts`, `corpus.test.ts`, `plugin.test.ts`, `package.test.ts`; `lending-sample.test.ts`

**Interfaces:**
- Consumes: `extractSqlAccesses`, `SqlTextKind` (PR 1B); `findTestBlocks`, `TestBlock` (Task 3).
- Produces:
  ```ts
  // sql/sql-edges.ts (the shared contract)
  export interface SqlCallSite { readonly symbolId: string; readonly line: number; readonly text: string; readonly kind: SqlTextKind }
  export function sqlEdgesFromCallSites(sites: readonly SqlCallSite[]): GraphEdge[];
  // sql/known-sql-apis.ts
  export interface KnownSqlApi { readonly module: string; readonly members: readonly string[]; readonly sql: 'firstArgument' | 'taggedTemplate'; readonly objectKey?: 'text' | 'sql'; readonly kind: SqlTextKind }
  export const KNOWN_SQL_APIS: readonly KnownSqlApi[];             // the TS rows of the shared table
  export function packageOfSpecifier(specifier: string): string;   // '@scope/name/sub' -> '@scope/name'; 'mysql2/promise' -> 'mysql2'
  // sql/module-resolver.ts
  export class ModuleResolver {
    constructor(project: Project, projectRoot?: string);
    sourceFileFor(from: SourceFile, specifier: string): SourceFile | undefined;   // the project file, else a disk read under projectRoot
    release(): void;                                                         // removes only the files it added
  }
  // sql/provenance.ts and sql/constant-text.ts
  export function receiverModule(expr: Node, resolver: ModuleResolver): string | undefined;
  export function constantText(expr: Node, resolver: ModuleResolver): string | undefined;
  export function taggedTemplateText(template: TaggedTemplateExpression): string;   // ${...} becomes @p0, @p1, ...
  // sql/sql-call-sites.ts
  export interface SqlStats { constant: number; nonConstant: number }
  export interface SymbolScope { readonly symbolId: string; readonly node: Node; readonly exclude: readonly Node[] }
  export function symbolScopes(sourceFile: SourceFile, filePath: string, blocks: readonly TestBlock[]): SymbolScope[];
  export function collectSqlCallSites(sourceFile: SourceFile, scopes: readonly SymbolScope[], resolver: ModuleResolver, stats: SqlStats): SqlCallSite[];
  // ts-morph-adapter.ts
  export interface TsMorphAdapterOptions { readonly sqlCallSites?: boolean; readonly projectRoot?: string }
  // constructor(options?: TsMorphAdapterOptions); readonly sqlCallSites: boolean; getSqlStats(): SqlStats (cumulative)
  ```
- Scopes: exported functions, methods of exported classes, exported variable declarations and test blocks (callback minus nested callbacks); a call belongs to the smallest scope that contains it; calls outside every scope are skipped.
- A call site is a call whose callee is `<receiver>.<member>` or `<receiver>?.<member>`, or a tagged template whose tag is one, where `receiverModule(receiver)` is the module of a row listing the member. Text: `firstArgument` rows take `constantText` of the first argument, or for `objectKey` rows the constant `text`/`sql` property of an object-literal first argument; `taggedTemplate` rows take `taggedTemplateText` of the tagged form or of a tagged-template first argument. A constant text counts as `constant`, any other text as `nonConstant`. Edges only when `sqlCallSites` is true.
- The resolver serves relative specifiers with the `resolveRelativeImport` rules plus the candidates `.tsx`, `.js`, `.jsx`, `/index.ts`, `/index.js`; `extractEdges` calls `release()` in its `finally`, so preloaded files stay and files read from disk never outlive the call (Review Focus 1).
  ```text
  receiverModule(expr): at most 8 steps, never revisiting a declaration
    unwrap parentheses, await, as / satisfies / <T> assertions and !
    identifier -> its declaration:
      import from M (named, default, namespace, import x = require('M')) -> packageOfSpecifier(M) when it is a table module;
        a relative M continues at the same-named export of the resolved file, following export { x } from re-exports
      variable or property -> its type annotation, else its initializer; binding element -> the destructured initializer
      parameter (also a constructor parameter property) -> its type annotation
      class -> its extends expression; function with a return type annotation -> that type
    this.x -> member x of the enclosing class (property or constructor parameter property)
    a.b, a?.b -> receiverModule(a);  f(...) -> require('M') gives M, else receiverModule(f);  new X(...) -> receiverModule(X)
    type reference -> its leftmost identifier, resolved as above;  import('M').T -> M
    anything else -> undefined
  constantText(expr): at most 8 steps
    string literal, no-substitution template -> its value
    template with substitutions -> every substitution constant, joined with the literal parts
    a + b -> both sides constant
    parentheses, as / satisfies / <T> assertions and ! -> the inner expression
    identifier of a const declaration with an initializer (same file, or a relative import through the resolver) -> constantText(initializer)
    anything else -> undefined
  ```
- `createAdapter(ctx)` returns `new TsMorphAdapter({ sqlCallSites: ctx.capabilities?.sqlCallSites === true, projectRoot: ctx.projectRoot })`. A file with call sites logs `sql <file>: constant <n>, nonConstant <m>` at debug level through `createLogger('ctxo:lang-typescript')`.
- Sample: `src/db.ts` is `import { Pool } from 'pg'; export const pool = new Pool();`; `src/queries.ts` exports `ACTIVE_LOANS_SQL = 'SELECT l.Id FROM dbo.Loans l JOIN [dbo].[Members] m ON m.Id = l.MemberId WHERE l.ClosedAt IS NULL'`; `src/loan.repository.ts` exports `LoanRepository`:

  | Method | Call | Expected data edges |
  |---|---|---|
  | `active` | `pool.query(ACTIVE_LOANS_SQL)` (both imported) | reads `dbo.loans`, `dbo.members` |
  | `archive` | `` pool.query(`INSERT INTO dbo.LoanArchive (Id) SELECT Id FROM dbo.Loans WHERE ClosedAt IS NOT NULL`) `` | reads `dbo.loans`, writes `dbo.loanarchive` |
  | `close` | `const request = new sql.Request()` (`sql` from `mssql`), then `request.execute('usp_CloseLoan')` | executes `dbo.usp_closeloan` |
  | `byMember` | `` pool.query(`SELECT * FROM dbo.Loans WHERE MemberId = ${memberId}`) `` | none (non-constant) |

- Corpus cases (the SQL of each case touches exactly the listed resources):

  | Case | Covers | reads | writes | executes |
  |---|---|---|---|---|
  | `ts-node-drivers` | pg `query` with a string and with `{ text }`; mysql2 `query` and `execute`, one with `{ sql }`; mssql `query` as a call and tagged, `execute`; better-sqlite3 `prepare`, `exec` | dbo.holds, dbo.loans, dbo.members | dbo.loanarchive, dbo.loans | dbo.usp_closeloan, dbo.usp_notifymember |
  | `ts-orm-raw-sql` | `knex.raw`; Prisma `$queryRaw` tagged and with a tagged argument, `$executeRaw`, `$queryRawUnsafe`, `$executeRawUnsafe`; TypeORM `query`; Sequelize `query`; plus a knex chain, `prisma.loan.findMany()`, `repository.find()` and `Loan.findAll()`, which give nothing | dbo.holds, dbo.loans, dbo.members | dbo.holds, dbo.loanstaging | |
  | `ts-constants` | a const binding, `+`, a template with constant substitutions; a `let`, a parameter and a non-constant template (nothing); `bus.execute('CloseLoan')`, `search.query(...)` on `@elastic/elasticsearch`, `/x/.exec(...)` (nothing) | dbo.loans | | |

- [ ] **Step 1: Write the failing tests.**
  - `sql-call-sites.test.ts` (adapters `{ sqlCallSites: true }`, sources through `loadProjectSources`):
    - `every row of the API table yields an edge at a matching call site`: `it.each` over each row and member; a generated `src/run.ts` imports the row's module, builds the receiver (`new Pool()`, `mysql.createPool()`, `new sql.Request()`, `knex(config)`, `new PrismaClient()`, `new DataSource(options)`, `new Sequelize(url)`, `new Database(file)`) and calls the member with `SELECT * FROM dbo.Loans` (`usp_CloseLoan` for the procedure row, the tagged form for tagged rows) inside `export async function run()`; expected `[{ from: 'src/run.ts::run::function', to: 'dbo.loans::table', kind: 'reads' }]`, or `dbo.usp_closeloan::procedure` with `executes`.
    - `config objects carry the SQL in text for pg and in sql for mysql2`.
    - `tagged templates replace interpolations with placeholders`: `` prisma.$queryRaw`SELECT * FROM dbo.Holds WHERE MemberId = ${id}` `` reads `dbo.holds`; `` request.query`SELECT * FROM ${table}` `` gives nothing.
    - `constants cover literals, templates, concatenation, const bindings and constant substitutions`: five such call sites read `dbo.loans`; a `let`, a parameter, a function result and a template with a non-constant substitution give nothing; `getSqlStats()` equals `{ constant: 5, nonConstant: 4 }`.
    - `the receiver must trace to the listed library` (Review Focus 3): `bus.execute('CloseLoan')` with `bus` from `./bus`, `/x/.exec('SELECT 1 FROM dbo.Loans')` and `client.query('SELECT * FROM dbo.Loans')` with `client` from `@elastic/elasticsearch` give nothing; in one file mysql2 `conn.execute('UPDATE dbo.Loans SET Flag = 1')` writes `dbo.loans` and mssql `request.execute('usp_CloseLoan')` executes `dbo.usp_closeloan`.
    - `provenance follows annotations, parameter properties, this members, require, destructuring, awaited factories and subclasses`: `it.each` over `constructor(private readonly pool: Pool)` with `this.pool.query(...)`, `const { Pool } = require('pg')`, `const pool = await sql.connect(config)` with `pool.request().input('id', 1).query(...)`, `class PrismaService extends PrismaClient {}` with `new PrismaService().$queryRawUnsafe(...)`, and a parameter typed `import('pg').PoolClient`; each reads `dbo.loans`.
    - `ORM and query-builder calls produce nothing` (a knex chain, `prisma.loan.findMany()`, TypeORM `find`, Sequelize `findAll`).
    - `edges come from the innermost scope`: calls in an exported function, a method of an exported class, an exported arrow-function variable and a nested test block give edges from those ids; a call in a non-exported function gives none.
    - `without the capability there are no data edges` (`new TsMorphAdapter()` on the same sources); `edges are unique and sorted by source, kind and target`.
  - `lending-sample.test.ts`:
    - `repository methods read, write and execute as in the sample table` (whole sample preloaded).
    - `a run with only the repository preloaded gives the same SQL edges` (Review Focus 1): after `writeLendingSample(tmp)`, an adapter `{ sqlCallSites: true, projectRoot: tmp }` with only `src/loan.repository.ts` preloaded gives the same data edges as the full preload, and the project then holds only that file; without `projectRoot`, `active` has no data edge.
  - `corpus.test.ts`: `it.each` over corpus cases with `mode: 'typescript'`: `<case>: call-site accesses match the corpus` (the case as `src/<case>.ts` in a fresh adapter; data edges grouped by kind, target's first segment, equal to `accesses`); `the typescript cases name every module of the API table`.
  - `packages/sql-extract/src/__tests__/corpus.test.ts`: `every corpus source (.sql or .<ts|java|go>.fixture) has an expected.json and the reverse`; `host-language cases use the mode of their extension`; `host-language cases default to sides []` (a case with the host mode and no `sides` key resolves to an empty list, and none of the sql-extract, lang-sql or ScriptDom loops picks it up); the statement and file `it.each` loops filter on their modes and on `sides`. In `packages/lang-csharp/src/__tests__/sql-corpus.integration.test.ts` (PR 1B Task 12) the ScriptDom file list keeps only the statement and file cases, so adding the host cases breaks neither it nor lang-sql's corpus test (Step 4 runs both).
  - `plugin.test.ts`: `createAdapter enables SQL call sites only when capabilities.sqlCallSites is true` (no capabilities, `{ sqlCallSites: false }`, `{ sqlCallSites: true }` give `false`, `false`, `true`); `the plugin keeps apiVersion 1`.
  - `package.test.ts`: `depends on @ctxo/sql-extract and keeps the plugin-api peer range` (`workspace:^`; the range recorded in Task 0); `source imports stay within the allowed set` (every import in non-test `src/**/*.ts` is relative, `node:*`, `@ctxo/plugin-api`, `@ctxo/sql-extract` or `ts-morph`).
- [ ] **Step 2: Run them.** `pnpm install && pnpm --filter @ctxo/plugin-api --filter @ctxo/sql-extract build && pnpm --filter @ctxo/lang-typescript test && pnpm --filter @ctxo/sql-extract test`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules, the adapter wiring and the plugin change; write the corpus files and the sample.
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/lang-typescript build && pnpm --filter @ctxo/lang-typescript typecheck && pnpm --filter @ctxo/cli test:unit`, `pnpm --filter @ctxo/lang-sql build && pnpm --filter @ctxo/lang-sql test` and `pnpm --filter @ctxo/lang-csharp exec vitest run src/__tests__/sql-corpus.integration.test.ts` (it skips without .NET 8). Expected: green.
- [ ] **Step 5: Commit.** Stage the Files block paths and the corpus files; `git commit -m "feat(lang-typescript): SQL edges at known call sites behind sqlCallSites (#156)"`.

---

### Task 5: Java annotations in the JDT analyzer; test sources verified

**Files:**
- Create: `packages/lang-java-analyzer/java/src/main/java/io/ctxo/jdt/Annotations.java`
- Modify: `.../io/ctxo/jdt/Dtos.java` (`Ann`, `Sym.annotations`), `Analyzer.java` (`EmitVisitor`: types, methods, fields), `Main.java` (`discoverJavaFiles` becomes package-private static)
- Create fixture `packages/lang-java-analyzer/java/src/test/resources/lending/`: `src/main/java/lending/domain/{Loan,Limits,Retry,Note,Notes}.java`, `src/test/java/lending/LoanPolicyTest.java`, stubs in `src/stubs/java/` for `org.junit.jupiter.api.{Test,Tag,DisplayName}` and `jakarta.persistence.{Entity,Table,Column}`
- Create: `.../src/test/java/io/ctxo/jdt/AnnotationsTest.java`; Modify: `ContractIT.java`
- Create: `packages/lang-java/src/analyzer/jdt-mapping.ts`, `packages/lang-java/src/__tests__/helpers/analyzer-jar.ts`
- Modify: `packages/lang-java/src/analyzer/jdt-process.ts` (`JdtAnnotation`, `JdtSymbol.annotations?`), `jdt-adapter.ts` (`extractSymbols` uses `toSymbolNode`), `src/composite-adapter.ts` (`reindexFile` uses `toSymbolNode`). Before editing: the two MCP tools on `JdtAnalyzerAdapter` and `JavaCompositeAdapter`; also on `Analyzer` (expected `found: false`).
- Test: new `packages/lang-java/src/analyzer/__tests__/jdt-mapping.test.ts`, new `packages/lang-java/src/__tests__/lending-sample.full-tier.integration.test.ts`

**Interfaces:**
- Java:
  ```java
  public static final class Ann { public String name; public List<String> args; public Map<String, String> named; }   // Dtos; null when empty; LinkedHashMap keeps source order
  // Dtos.Sym gains: public List<Ann> annotations;   // null when empty (Gson omits nulls)
  static List<Dtos.Ann> of(List<?> modifiers);       // Annotations: a BodyDeclaration's modifiers(); null when none
  static List<String> discoverJavaFiles(String root); // Main, package-private for the test
  ```
- Rules: designer call 4 and the annotation shape. A resolved `IAnnotationBinding` gives `getDeclaredMemberValuePairs()` in source order; otherwise the syntax (`SingleMemberAnnotation`, `NormalAnnotation.values()`) with `Expression.resolveConstantExpressionValue()`, falling back to the literal nodes (string, text block, number token, boolean, character, type literal, enum constant as written). Every fragment of a field declaration gets that declaration's annotations.
- TypeScript:
  ```ts
  export interface JdtAnnotation { name: string; args?: string[]; named?: Record<string, string> }   // jdt-process.ts; JdtSymbol.annotations?: JdtAnnotation[]
  export function toSymbolNode(s: JdtSymbol): SymbolNode;   // jdt-mapping.ts: offsets when present, annotations when non-empty
  // __tests__/helpers/analyzer-jar.ts
  export function testAnalyzerJar(): string | undefined;   // CTXO_JDT_ANALYZER_JAR when the file exists, else jar/ctxo-jdt-analyzer-17.jar (JRE >= 17) or -11.jar of packages/lang-java-analyzer
  export const CAN_RUN_JDT: boolean;                       // detectJavaRuntime().available && testAnalyzerJar() !== undefined
  export const LENDING_FIXTURE: string;                    // absolute path of packages/lang-java-analyzer/java/src/test/resources/lending
  ```
- Fixture rows (paths under `src/main/java/lending/domain/` unless shown):

  | Symbol | Source | Expected `annotations` |
  |---|---|---|
  | `src/test/java/lending/LoanPolicyTest.java::memberHoldsAtMostFiveLoans::method` | `@Test @Tag("LEND-03") @DisplayName("a member holds at most five loans")` | `[{ name: 'Test' }, { name: 'Tag', args: ['LEND-03'] }, { name: 'DisplayName', args: ['a member holds at most five loans'] }]` |
  | `Loan.java::Loan::class` | `@Entity @Table(name = "Loans")` | `[{ name: 'Entity' }, { name: 'Table', named: { name: 'Loans' } }]` |
  | `Loan.java::memberId::variable` | `@Column(name = "member_id", nullable = false)` | `[{ name: 'Column', named: { name: 'member_id', nullable: 'false' } }]` |
  | `Loan.java::renew::method` | `@Retry(value = "renewal", times = Limits.MAX_RETRIES, unit = TimeUnit.SECONDS, on = IllegalStateException.class)` | `[{ name: 'Retry', args: ['renewal'], named: { times: '3', unit: 'TimeUnit.SECONDS', on: 'java.lang.IllegalStateException' } }]` |
  | `Loan.java::legacy::method` | `@SuppressWarnings({"unchecked", "rawtypes"}) @Notes({@Note("a")})` | `[{ name: 'SuppressWarnings', args: ['unchecked', 'rawtypes'] }, { name: 'Notes' }]` |
  | `Loan.java::audited::method` | `@Unknown(value = "x", level = 2)`, no `Unknown` type anywhere | `[{ name: 'Unknown', args: ['x'], named: { level: '2' } }]` |

- [ ] **Step 1: Write the failing tests.**
  - JUnit `AnnotationsTest` (files from `Main.discoverJavaFiles(fixture)`): one test per row: `testMethodsCarryTheirJUnitAnnotations`, `typesCarryAnnotations`, `fieldsCarryAnnotations`, `constantsEnumsAndClassLiteralsAreFormatted`, `arraysFlattenAndNestedAnnotationsAreSkipped`, `unresolvedAnnotationTypesFallBackToSyntax` (Review Focus 5); `capsLimitAnnotationsArgsNamedAndLength` (a `@TempDir` class with 25 annotations, one annotation with 12 array values, one with 12 members and a 250-character constant: 20, 10, 10 and 200); `discoversTestSourcesAndSkipsBuildFolders` (`@TempDir` with `src/test/java/a/ATest.java` and `target/B.java`: only the first is listed).
  - `ContractIT.annotationsSerializeAsNameArgsNamedAndAreOmittedWhenEmpty` (the `Loan` symbol's JSON holds `"annotations":[{"name":"Entity"},`; the `Limits` symbol has no `annotations` key).
  - `jdt-mapping.test.ts`: `toSymbolNode copies annotations and offsets and omits absent ones`; `the keep-alive reindexFile keeps annotations` (`vi.mock('../jdt-adapter.js')` so the composite's `initialize` activates a fake analyzer whose `reindexFileRaw` returns a symbol with annotations).
  - `lending-sample.full-tier.integration.test.ts` (`describe.skipIf(!CAN_RUN_JDT)`; composite initialized on `LENDING_FIXTURE` with `CTXO_JDT_ANALYZER_JAR` stubbed to `testAnalyzerJar()`; 130 s): `test methods under src/test/java are method symbols with their JUnit annotations`; `the entity class and its field carry their annotations`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/lang-java-analyzer test && pnpm --filter @ctxo/lang-java test`. Expected: FAIL.
- [ ] **Step 3: Implement** the Java and TypeScript changes.
- [ ] **Step 4: Run them.** `pnpm --filter @ctxo/lang-java-analyzer test && mvn -q -f packages/lang-java-analyzer/java/pom.xml -Pjava17 test && pnpm --filter @ctxo/lang-java-analyzer build && pnpm --filter @ctxo/lang-java test && pnpm --filter @ctxo/lang-java typecheck`. Expected: PASS on both JDT versions, with the integration test running here.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture folder; `git commit -m "feat(lang-java): JDT annotations and verified test sources in the full tier (#156)"`.

---

### Task 6: Java annotations in the tree-sitter tier

**Files:**
- Create: `packages/lang-java/src/tree-sitter-annotations.ts`
- Modify: `packages/lang-java/src/java-adapter.ts` (`walkTypeDecls`, `extractMembers`). Before editing: the two MCP tools on `JavaAdapter`.
- Test: `packages/lang-java/src/__tests__/java-adapter.test.ts`, new `packages/lang-java/src/__tests__/lending-sample.syntax-tier.test.ts`

**Interfaces:**
- `export function annotationsFromModifiers(declaration: SyntaxNode): SymbolAnnotation[] | undefined;` reads the `marker_annotation` and `annotation` children of the declaration's `modifiers` in order. `name` is the last identifier of the annotation name. A lone element value goes to `args`; an `element_value_pair` goes to `args` for `value` and to `named` otherwise. Values: a `string_literal` is unquoted with `\b \t \n \f \r \s \" \' \\` decoded (other escapes kept as written); an `element_value_array_initializer` of strings is flattened into `args` or joined with `,` in `named`; text blocks and non-string values are skipped. Same caps as the full tier. Confirm the node type names against tree-sitter-java 0.23.5 with `tree.rootNode.toString()` while writing the first test.

- [ ] **Step 1: Write the failing tests.**
  - `java-adapter.test.ts`:
    - `reads marker and string annotations on classes, fields, constructors and methods`: `@Entity @Table(name = "Loans") public class Loan { @Column(name = "member_id", nullable = false) private long memberId; @Deprecated public Loan() {} @GetMapping("/loans/{id}") public Loan find() { return null; } }` gives class `[{ name: 'Entity' }, { name: 'Table', named: { name: 'Loans' } }]`, field `memberId` `[{ name: 'Column', named: { name: 'member_id' } }]`, constructor `Loan` `[{ name: 'Deprecated' }]`, method `find` `[{ name: 'GetMapping', args: ['/loans/{id}'] }]`.
    - `qualified names keep the simple name and string arrays flatten`: `@org.junit.jupiter.api.Tag("LEND-03")` gives `Tag`; `@SuppressWarnings({"unchecked", "rawtypes"})` gives both args.
    - `escapes are decoded; text blocks and non-string values are skipped`; `caps apply as in the full tier`.
  - `lending-sample.syntax-tier.test.ts`: `test methods under src/test/java are method symbols with their JUnit annotations in the syntax tier` (the fixture's `LoanPolicyTest.java` through `JavaAdapter.extractSymbols` gives the same list as the Task 5 row).
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/lang-java exec vitest run src/__tests__/java-adapter.test.ts src/__tests__/lending-sample.syntax-tier.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Then `pnpm --filter @ctxo/lang-java test && pnpm --filter @ctxo/lang-java typecheck`. Expected: green.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -m "feat(lang-java): annotations in the tree-sitter tier (#156)"`.

---

### Task 7: SQL call sites in the JDT analyzer

**Files:**
- Create: `.../io/ctxo/jdt/KnownSqlApis.java`, `SqlCallSites.java`
- Modify: `Dtos.java` (`SqlSite`, `SqlStats`, `FileResult.sqlCallSites`), `Analyzer.java` (three-argument constructor, enclosing-method tracking, `sqlStats()`), `Main.java` (`--sql-call-sites`, `sql` in the `done` line)
- Extend fixture `resources/lending`: `src/main/java/lending/data/{LoanRepository,LoanJpaRepository,LoanMapper}.java`; stubs for `org.springframework.jdbc.core.{JdbcTemplate,RowMapper}`, `org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate`, `org.springframework.data.jpa.repository.Query`, `jakarta.persistence.{EntityManager,Query}`, `org.apache.ibatis.annotations.{Select,Insert,Update,Delete}`. Create `resources/sql-missing-classpath/src/main/java/lending/LegacyDao.java` (imports `org.springframework.jdbc.core.JdbcTemplate`; no stub)
- Create: `.../src/test/java/io/ctxo/jdt/SqlCallSitesTest.java`; Modify: `ContractIT.java`

**Interfaces:**
- Java:
  ```java
  public static final class SqlSite { public String symbolId; public int line; public String text; public String kind; }   // Dtos; kind "statement" | "procedureName"
  public static final class SqlStats { public int constant; public int nonConstant; }                                  // Dtos
  // FileResult gains: public List<SqlSite> sqlCallSites;   // null when none or without the flag; sorted by line, then text
  public Analyzer(String rootDir, String[] classpath, boolean sqlCallSites);   // the two-argument constructor passes false
  public Dtos.SqlStats sqlStats();
  final class SqlCallSites {
    static void fromInvocation(MethodInvocation node, String symbolId, CompilationUnit cu, Dtos.SqlStats stats, List<Dtos.SqlSite> out);
    static void fromAnnotations(MethodDeclaration node, String symbolId, CompilationUnit cu, Dtos.SqlStats stats, List<Dtos.SqlSite> out);
  }
  ```
- `KnownSqlApis` holds the Java rows of the shared table as data. Matching: designer call 8. Without a binding, the receiver's declared type comes from the field, local variable or parameter declaration in the same compilation unit, resolved through the single-type imports or the same package; annotation types resolve through the binding, else through the imports (Review Focus 5). A matched member whose resolved first parameter is not `java.lang.String` is not a call site and is not counted. Only method and constructor bodies count; lambdas belong to their enclosing method. A constant text matching `^\s*\{\s*(?:\?\s*=\s*)?call\s+([^\s(}]+)\s*(?:\(.*\))?\s*\}\s*$` (case-insensitive, dot matches newlines) gives a `procedureName` record with the captured name.
- Main: `--sql-call-sites` works in batch and keep-alive modes; with it, the `done` line gains `"sql":{"constant":n,"nonConstant":m}`.
- Fixture rows (`LoanRepository` holds `static final String ACTIVE_SQL = "SELECT l.Id FROM dbo.Loans l " + "JOIN [dbo].[Members] m ON m.Id = l.MemberId";`):

  | Method | Call | Expected record |
  |---|---|---|
  | `findActive` | `jdbc.query(ACTIVE_SQL, mapper)` | statement: the joined constant |
  | `close` | `connection.prepareCall("{call dbo.usp_CloseLoan(?)}")` | procedureName: `dbo.usp_CloseLoan` |
  | `archive` | `statement.executeUpdate("INSERT INTO dbo.LoanArchive (Id) " + "SELECT Id FROM dbo.Loans WHERE ClosedAt IS NOT NULL")` | statement |
  | `holdsFor` | `named.queryForList(` a text block `SELECT * FROM dbo.Holds WHERE MemberId = :id`, `params)` | statement |
  | `purge` | `entityManager.createNativeQuery("DELETE FROM dbo.Holds WHERE ExpiresAt < CURRENT_TIMESTAMP")` | statement |
  | `flagAll` | `jdbc.batchUpdate("UPDATE dbo.Loans SET Flag = 1", "UPDATE dbo.Members SET Flag = 1")` | two statements |
  | `later` | `return () -> jdbc.update("UPDATE dbo.Holds SET Flag = 1");` | statement from `later` |
  | `dynamic(String table)` | `jdbc.query("SELECT * FROM " + table, mapper)` | none, counted non-constant |
  | `prepared(PreparedStatement ps)` | `ps.executeQuery()` | none, not counted |
  | `LoanJpaRepository.findOverdue` | `@Query(value = "SELECT * FROM dbo.Loans WHERE DueAt < CURRENT_TIMESTAMP", nativeQuery = true)` | statement |
  | `LoanJpaRepository.findByMember` | `@Query("SELECT l FROM Loan l WHERE l.memberId = ?1")` (JPQL) | none, not counted |
  | `LoanMapper.active` | `@Select({"SELECT * FROM dbo.Loans", "WHERE ClosedAt IS NULL"})` | statement `SELECT * FROM dbo.Loans WHERE ClosedAt IS NULL` |
  | `LoanMapper.add`, `renew`, `remove` | `@Insert`, `@Update`, `@Delete` on `dbo.Loans` (`#{id}` placeholders only in `VALUES` and `WHERE`) | one statement each |

  Stats: `{ constant: 13, nonConstant: 1 }`.

- [ ] **Step 1: Write the failing tests** (JUnit `SqlCallSitesTest`, analyzer built with `sqlCallSites = true` over the fixture's files):
  - `jdbcSpringAndJpaCallSitesReportConstantSql` (the `LoanRepository` rows, matched by `symbolId`, `kind` and `text`); `nativeQueryAndMyBatisAnnotationsReportSql` (the `LoanJpaRepository` and `LoanMapper` rows); `lambdaCallSitesBelongToTheEnclosingMethod`.
  - `statsCountThirteenConstantAndOneNonConstantText`; `withoutTheFlagThereAreNoSitesAndNoStats`.
  - `missingClasspathTypesMatchThroughDeclaredTypesAndImports` (Review Focus 5): `LegacyDao.load` with a field `private final JdbcTemplate jdbc;` and no stub gives one statement record.
  - `ContractIT.sqlCallSitesSerializeWithSymbolIdLineTextKind`.
- [ ] **Step 2: Run them.** `pnpm --filter @ctxo/lang-java-analyzer test`. Expected: FAIL.
- [ ] **Step 3: Implement** the table, the collector, the flag and the stats.
- [ ] **Step 4: Run them.** `pnpm --filter @ctxo/lang-java-analyzer test && mvn -q -f packages/lang-java-analyzer/java/pom.xml -Pjava17 test && pnpm --filter @ctxo/lang-java-analyzer build`. Expected: PASS on both profiles; both JARs rebuilt.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture folders; `git commit -m "feat(lang-java-analyzer): report SQL call sites behind --sql-call-sites (#156)"`.

---

### Task 8: lang-java turns call sites into edges

**Files:**
- Create: `packages/lang-java/src/sql-edges.ts`
- Modify: `src/analyzer/jdt-process.ts` (`RunOpts.sqlCallSites`, `buildAnalyzerArgs`, `JdtKeepAlive` options, `JdtFileResult.sqlCallSites?`, `JdtBatchResult.sql?`, the `done` line), `src/analyzer/jdt-mapping.ts` (`toGraphEdges`), `src/analyzer/jdt-adapter.ts` (constructor options, `extractEdges`, `startKeepAlive`, `getSqlStats`), `src/composite-adapter.ts` (constructor options, `sqlCallSites`, `reindexFile` edges), `src/index.ts`, `package.json` (`"@ctxo/sql-extract": "workspace:^"`), `tsup.config.ts` (external), `pnpm-lock.yaml`. Before editing: the two MCP tools on `JdtAnalyzerAdapter`, `JavaCompositeAdapter`, `runBatchIndex`, `JdtKeepAlive` and `packages/lang-java/src/index.ts::plugin::variable`.
- Create: `packages/sql-extract/corpus/java-jdbc.java.fixture`, `java-spring-jpa-mybatis.java.fixture`, `java-constants.java.fixture` with expected files
- Test: `src/analyzer/__tests__/jdt-process.unit.test.ts`, `jdt-keepalive.unit.test.ts`, `jdt-mapping.test.ts`; new `src/__tests__/sql-edges.test.ts`, `plugin.test.ts`, `package.test.ts`, `corpus.integration.test.ts`; `lending-sample.full-tier.integration.test.ts`

**Interfaces:**
- Consumes: the record and edge contract; `toSymbolNode`, `testAnalyzerJar`, `CAN_RUN_JDT`, `LENDING_FIXTURE` (Task 5); the Task 7 JSON.
- Produces:
  ```ts
  // sql-edges.ts: SqlCallSite and sqlEdgesFromCallSites (the shared contract)
  // jdt-process.ts
  export interface RunOpts { classpathOverride?: string[]; allowBuildTools?: boolean; timeoutMs?: number; sqlCallSites?: boolean }   // buildAnalyzerArgs appends --sql-call-sites
  export interface JdtSqlStats { constant: number; nonConstant: number }   // JdtBatchResult.sql?; JdtFileResult.sqlCallSites?: SqlCallSite[]
  export class JdtKeepAlive { constructor(javaBin: string, jarPath: string, projectRoot: string, options?: { readonly sqlCallSites?: boolean; readonly idleMs?: number }) }
  // jdt-mapping.ts
  export function toGraphEdges(file: JdtFileResult, options: { readonly sqlCallSites: boolean }): GraphEdge[];   // today's filter, then SQL edges when enabled
  // adapters and plugin
  export class JdtAnalyzerAdapter { constructor(options?: { readonly sqlCallSites?: boolean }); getSqlStats(): JdtSqlStats | undefined }
  export class JavaCompositeAdapter { constructor(options?: { readonly sqlCallSites?: boolean }); readonly sqlCallSites: boolean }
  // createAdapter(ctx) returns new JavaCompositeAdapter({ sqlCallSites: ctx.capabilities?.sqlCallSites === true })
  ```
- Expected edges for the fixture (symbols under `src/main/java/lending/data/`): `LoanRepository.java::findActive::method` reads `dbo.loans`, `dbo.members`; `::close::method` executes `dbo.usp_closeloan`; `::archive::method` reads `dbo.loans` and writes `dbo.loanarchive`; `::holdsFor::method` reads `dbo.holds`; `::purge::method` writes `dbo.holds`; `::flagAll::method` writes `dbo.loans`, `dbo.members`; `::later::method` writes `dbo.holds`; `LoanJpaRepository.java::findOverdue::method` reads `dbo.loans`; `LoanMapper.java::active::method` reads `dbo.loans`; `add`, `renew` and `remove` each write `dbo.loans`; no other method has a data edge.
- Corpus cases:

  | Case | Covers | reads | writes | executes |
  |---|---|---|---|---|
  | `java-jdbc` | `prepareStatement`; `prepareCall` with `{call ...}` and `{? = call ...}`; `Statement.executeQuery`, `execute`, `executeUpdate`; `PreparedStatement.executeQuery()` (nothing) | dbo.loans, dbo.members | dbo.loanarchive | dbo.usp_closeloan, dbo.usp_notifymember |
  | `java-spring-jpa-mybatis` | `JdbcTemplate` `query`, `queryForObject`, `update`, `batchUpdate`; `NamedParameterJdbcTemplate.queryForList`; `createNativeQuery`; a native `@Query` and a JPQL `@Query` (nothing); the four MyBatis annotations | dbo.holds, dbo.loans | dbo.holds, dbo.loans, dbo.members | |
  | `java-constants` | `static final` in another class, concatenation, a text block, a local non-constant (nothing) | dbo.loans, dbo.members | | |

- [ ] **Step 1: Write the failing tests.**
  - `jdt-process.unit.test.ts`: `buildAnalyzerArgs appends --sql-call-sites only when enabled`; `runBatchIndex reads sqlCallSites records and the sql stats of the done line` (`node:child_process` mocked as in lang-go's `analyzer-process.test.ts`).
  - `jdt-keepalive.unit.test.ts`: `the keep-alive process gets --sql-call-sites only when enabled` (spawn mocked; the flag follows `--keep-alive`).
  - `sql-edges.test.ts`: `statement and procedure sites become data edges to canonical targets` (`UPDATE l SET l.Flag = 1 FROM dbo.Loans l` gives `reads` and `writes` to `dbo.loans::table`; procedure name `[dbo].[usp_CloseLoan]` gives `executes` to `dbo.usp_closeloan::procedure`); `duplicate sites give one edge and edges sort by source, kind and target`; `text without an access gives no edge`.
  - `jdt-mapping.test.ts`: `toGraphEdges keeps the analyzer edges and adds SQL edges only when enabled`.
  - `plugin.test.ts`: `createAdapter enables SQL call sites only when capabilities.sqlCallSites is true` (`false`, `false`, `true`); `the plugin keeps apiVersion 1`.
  - `package.test.ts`: `depends on @ctxo/sql-extract and keeps the plugin-api peer range`; `source imports stay within @ctxo/plugin-api, @ctxo/sql-extract, tree-sitter, tree-sitter-java, node built-ins and relative paths`.
  - `corpus.integration.test.ts` (gated): one temp project holding every `mode: 'java'` case at `src/main/java/corpus/<PascalCase>.java` plus a copy of the fixture's `src/stubs`; one composite `{ sqlCallSites: true }`; `<case>: call-site accesses match the corpus`.
  - `lending-sample.full-tier.integration.test.ts`: `repository, JPA and MyBatis methods have the expected data edges`; `getSqlStats reports 13 constant and 1 non-constant texts`; `without sqlCallSites there are no data edges and no stats`; `the keep-alive reindex of LoanRepository.java returns the batch's data edges and annotations`.
- [ ] **Step 2: Run them.** `pnpm install && pnpm --filter @ctxo/sql-extract build && pnpm --filter @ctxo/lang-java test`. Expected: FAIL.
- [ ] **Step 3: Implement** the plumbing, `toGraphEdges`, `sqlEdgesFromCallSites` and the plugin change; write the corpus files.
- [ ] **Step 4: Run them.** Expected: PASS, with the gated tests running here. Then `pnpm --filter @ctxo/lang-java build && pnpm --filter @ctxo/lang-java typecheck && pnpm --filter @ctxo/sql-extract test`. Expected: green.
- [ ] **Step 5: Commit.** Stage the Files block paths and the corpus files; `git commit -m "feat(lang-java): SQL edges from JDT call sites behind sqlCallSites (#156)"`.

---

### Task 9: Go struct tags as annotations in both tiers

**Files:**
- Modify (Go): `packages/lang-go/tools/ctxo-go-analyzer/internal/emit/emit.go` (`FieldTag`, `Symbol.Tags`), `internal/symbols/symbols.go`. Before editing: the two MCP tools on `packages/lang-go/tools/ctxo-go-analyzer/internal/symbols/symbols.go::Extract::function`.
- Test (Go): `internal/symbols/symbols_test.go`, `internal/emit/emit_test.go`
- Create: `packages/lang-go/src/struct-tags.ts`
- Modify: `src/analyzer/analyzer-process.ts` (`AnalyzerSymbol.tags?`), `src/analyzer/analyzer-adapter.ts` (`extractSymbols`), `src/go-adapter.ts` (`extractTypeSymbols`). Before editing: the two MCP tools on `GoAnalyzerAdapter` and `GoAdapter`.
- Create fixture: `packages/lang-go/test-fixtures/lending-module/go.mod` (`module lending`, `go 1.22`), `loans/loan.go`
- Test: new `src/__tests__/struct-tags.test.ts`, `go-adapter.test.ts`, new `src/__tests__/lending-module.integration.test.ts`

**Interfaces:**
- Go: `type FieldTag struct { Field string `json:"field"`; Tag string `json:"tag"` }`; `Symbol.Tags []FieldTag `json:"tags,omitempty"``, set on struct (`class`) symbols in field order: one entry per field name; an embedded field uses its type's last identifier; the literal is decoded with `strconv.Unquote` and skipped when that fails or yields an empty string.
- TypeScript:
  ```ts
  export interface FieldTag { readonly field: string; readonly tag: string }
  export function parseStructTag(tag: string): Array<[key: string, value: string]>;   // reflect.StructTag conventions; first key wins
  export function structTagAnnotations(tags: readonly FieldTag[]): SymbolAnnotation[] | undefined;
  // one { name: 'tag', named: { member: <field>, ...pairs } } per field with at least one pair; caps 20, 10 pairs, 200 chars; member reserved
  ```
  `parseStructTag` mirrors `reflect.StructTag.Lookup`: skip leading spaces; a key is a run of bytes above space other than `:`, `"` and DEL, followed by `:"`; the value runs to the next unescaped `"` and is decoded with `JSON.parse` of the quoted text; parsing stops at the first malformed pair or undecodable value.
- Tree-sitter tier: for each exported struct `type_spec`, every `field_declaration` of its `field_declaration_list` gives `(name, tag)` pairs: the names are its `field_identifier` children, else the embedded type's last identifier; the `tag` child is a `raw_string_literal` (backticks stripped) or an `interpreted_string_literal` (`JSON.parse`). Confirm the node names against tree-sitter-go 0.23.4 with `rootNode.toString()`.
- Fixture `loans/loan.go`:
  ```go
  type Base struct{ CreatedAt int64 }
  type Loan struct {
      LoanID           int    `json:"loan_id" gorm:"column:loan_id;primaryKey"`
      MemberID, CopyID int    `json:"member_id"`
      Base
      Note             string
      Due              string "json:\"due_at\""
  }
  ```
  Expected for `loans/loan.go::Loan::class` in both tiers: `[{ name: 'tag', named: { member: 'LoanID', json: 'loan_id', gorm: 'column:loan_id;primaryKey' } }, { name: 'tag', named: { member: 'MemberID', json: 'member_id' } }, { name: 'tag', named: { member: 'CopyID', json: 'member_id' } }, { name: 'tag', named: { member: 'Due', json: 'due_at' } }]`.

- [ ] **Step 1: Write the failing tests.**
  - `struct-tags.test.ts`: `parseStructTag follows reflect.StructTag conventions` (`json:"loan_id,omitempty" gorm:"column:loan_id"` gives both pairs; extra spaces are skipped; `x:"a\"b"` gives `a"b`; `json:loan_id` gives `[]`; `a:"1" bad b:"2"` gives only `a`; `a:"1" a:"2"` keeps `1`); `structTagAnnotations records each tagged field with named.member and skips untagged ones`; `a tag key named member does not replace the field name`; `caps apply` (25 tagged fields give 20; 12 keys give `member` plus 10; a 250-character value gives 200).
  - `go-adapter.test.ts`: `exported structs carry their field tags as annotations` (the fixture through `GoAdapter.extractSymbols`, the expected list); `structs without tags carry no annotations key`.
  - Go: `TestStructTagsAreEmittedRaw` (field order, both names of `MemberID, CopyID`, nothing for `Base` or `Note`, the interpreted-string tag decoded; non-struct types have no `Tags`); `TestSymbolTagsOmittedWhenEmpty`.
  - `lending-module.integration.test.ts` (`describe.skipIf(!detectGoToolchain().available)`; the module copied to a temp dir; composite initialized there; 180 s): `the analyzer gives Loan the same tag annotations as the tree-sitter tier`.
- [ ] **Step 2: Run them.** `(cd packages/lang-go/tools/ctxo-go-analyzer && go test ./internal/...)` and `pnpm --filter @ctxo/lang-go test`. Expected: FAIL.
- [ ] **Step 3: Implement** the Go emission, the parser and both tiers.
- [ ] **Step 4: Run them.** Expected: PASS. Then `(cd packages/lang-go/tools/ctxo-go-analyzer && go vet ./... && go test ./...)` and `pnpm --filter @ctxo/lang-go build && pnpm --filter @ctxo/lang-go typecheck`. Expected: green.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture folder; `git commit -m "feat(lang-go): struct field tags as annotations in both tiers (#156)"`.

---

### Task 10: Go test packages in the analyzer

**Files:**
- Modify (Go): `internal/load/load.go` (`Tests: true`, `Partition`), `internal/symbols/symbols.go` (`ExtractFile`), `internal/implements/implements.go`, `internal/extends/extends.go` (`include` filter), `main.go` (production pass on `Prod`, test pass, `collectDead`, `run` writes to an `io.Writer`). Before editing: the two MCP tools on `packages/lang-go/tools/ctxo-go-analyzer/main.go::run::function`, `internal/load/load.go::Packages::function`, `internal/implements/implements.go::Extract::function` and `internal/extends/extends.go::Extract::function`.
- Test (Go): `internal/load/load_test.go`, `internal/implements/implements_test.go`, `internal/extends/extends_test.go`, new `main_test.go`
- Extend fixture `lending-module`: `loans/policy.go` (`func CanBorrow(open int) bool`; `type Store interface { Open(memberID int) int }`), `loans/policy_test.go` (`package loans`: `TestCanBorrow` calls `CanBorrow`; `type fakeStore struct{}` with method `Open`), `loans/policy_external_test.go` (`package loans_test`: `TestPolicyFromOutside` calls `loans.CanBorrow`), `itest/smoke_test.go` (`package itest`: `TestSmoke`)
- Test (TS): `packages/lang-go/src/__tests__/lending-module.integration.test.ts`

**Interfaces:**
- Go:
  ```go
  type Partitioned struct { Prod, Tests []*packages.Package }   // load; each sorted by ID
  func Partition(pkgs []*packages.Package) Partitioned           // Prod: IDs without "[" that are not test mains (Name "main", ID ending ".test"); Tests: IDs with "["
  // Packages keeps its signature and loads with Tests: true through an unexported load(dir string, tests bool, patterns ...string)
  func ExtractFile(pkg *packages.Package, file *ast.File, rootDir string) (FileSymbols, bool)   // symbols; Extract is built on it
  func Extract(rootDir string, pkgs []*packages.Package, include func(relFile string) bool) map[string][]emit.Edge   // implements and extends; include filters the concrete or embedding type's file; nil keeps all
  func run(root string, stdout io.Writer) error
  ```
- `run`: `parts := load.Partition(load.PackagesWithFallback(root).Packages)`. The production pass is today's code over `parts.Prod` with `nil` filters. One `edges.NewExtractor(root, append(parts.Prod, parts.Tests...))` serves both passes. The test pass walks `parts.Tests` in ID order; each file of `pkg.Syntax` whose base name ends in `_test.go`, whose path is under root and that no earlier package emitted gets `ExtractFile` symbols and `ext.Extract` edges, plus `implements.Extract(root, []*packages.Package{pkg}, inThisPackagesTestFiles)` and the same for `extends`. A file's edges are de-duplicated by `from`, `to`, `kind`, `typeArgs`. `reach.Analyze` receives `parts.Prod` only; `collectDead` skips symbols whose file ends in `_test.go`.

- [ ] **Step 1: Write the failing tests.**
  - `load_test.go`: `TestPartitionProdMatchesALoadWithoutTests` (a temp module with an internal test, an external test and a test-only directory: the IDs of `Partition(load(dir, true)).Prod` equal those of `load(dir, false)`); `TestPartitionPutsVariantsInTestsAndDropsTestMains`.
  - `main_test.go` (`run` into a buffer over temp modules):
    - `TestRunEmitsEachTestFunctionOnceWithItsCalls` (Review Focus 4): the records of `loans/policy_test.go`, `loans/policy_external_test.go` and `itest/smoke_test.go` hold `TestCanBorrow`, `TestPolicyFromOutside` and `TestSmoke` exactly once each, and the first two have `calls` edges to `loans/policy.go::CanBorrow::function`.
    - `TestRunLeavesProductionRecordsUnchanged` (Review Focus 4): the module with and without its `_test.go` files gives deep-equal records for every non-test file, the same `dead` list and the same `hasMain`.
    - `TestRunLinksTestFakesToProductionInterfaces`: `loans/policy_test.go::fakeStore::class` implements `loans/policy.go::Store::interface`.
    - `TestRunNeverListsTestSymbolsAsDead`.
  - `implements_test.go`, `extends_test.go`: existing calls pass `nil`; new `TestIncludeFiltersConcreteTypeFiles` and `TestIncludeFiltersEmbeddingTypeFiles`.
  - `lending-module.integration.test.ts`: `test functions are function symbols with calls edges in the full tier`.
- [ ] **Step 2: Run them.** `(cd packages/lang-go/tools/ctxo-go-analyzer && go test ./...)`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Then `go vet ./...` in the analyzer, `pnpm --filter @ctxo/lang-go test` and `pnpm --filter @ctxo/cli exec vitest run --config vitest.config.e2e.ts tests/e2e/go-full-tier.test.ts`. Expected: green; the sample-module e2e results are unchanged.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture additions; `git commit -m "feat(lang-go): analyse test packages with variant de-duplication (#156)"`.

---

### Task 11: SQL call sites in ctxo-go-analyzer

**Files:**
- Create (Go): `internal/sqlsites/sqlsites.go`, `internal/sqlsites/sqlsites_test.go`
- Modify (Go): `internal/emit/emit.go` (`SqlCallSite`, `SqlStats`, `FileRecord.SqlCallSites`, `Summary.Sql`), `internal/symbols/symbols.go` (exported `FuncDeclSymbolID`, now used by `internal/edges`), `internal/edges/edges.go`, `main.go` (`--sql-call-sites`, `options`, both passes collect). Before editing: the two MCP tools on `run` and on `packages/lang-go/tools/ctxo-go-analyzer/internal/edges/edges.go::funcDeclSymbolID::function`.
- Extend fixture `lending-module`: `go.mod` gains `require` and `replace` lines `github.com/jmoiron/sqlx => ./stubs/sqlx`, `github.com/jackc/pgx/v5 => ./stubs/pgx`, `gorm.io/gorm => ./stubs/gorm`; stub modules under `stubs/` (each with its own `go.mod` and only the types and methods the table needs); `loans/repository.go`, `loans/repository_test.go`
- Test (Go): `main_test.go`

**Interfaces:**
- Go:
  ```go
  type SqlCallSite struct { SymbolID string `json:"symbolId"`; Line int `json:"line"`; Text string `json:"text"`; Kind string `json:"kind"` }   // emit; Line 0-based; Kind "statement"
  type SqlStats struct { Constant int `json:"constant"`; NonConstant int `json:"nonConstant"` }                                        // emit
  // FileRecord gains SqlCallSites []SqlCallSite `json:"sqlCallSites,omitempty"`; Summary gains Sql *SqlStats `json:"sql,omitempty"`
  func Collect(pkg *packages.Package, file *ast.File, relFile string, stats *emit.SqlStats) []emit.SqlCallSite   // sqlsites; sorted by line, then text
  type options struct{ sqlCallSites bool }   // main; set by --sql-call-sites
  func run(root string, opts options, stdout io.Writer) error
  ```
- `Collect` walks every `*ast.FuncDecl` body (closures belong to the declaration, named through `symbols.FuncDeclSymbolID`). A `*ast.CallExpr` whose callee resolves through `TypesInfo.Uses` to a `*types.Func` matching a Go row (designer call 10) yields the argument bound to the callee's first `string` parameter: a `TypesInfo.Types[arg].Value` of kind `constant.String` counts as constant and gives a record; anything else counts as non-constant. A matching callee without a `string` parameter is not counted.
- Fixture `loans/repository.go` (`const activeLoansSQL = "SELECT l.Id FROM dbo.Loans l " + "JOIN [dbo].[Members] m ON m.Id = l.MemberId"`):

  | Function | Call | Record |
  |---|---|---|
  | `ActiveLoans(ctx, db *sql.DB)` | `db.QueryContext(ctx, activeLoansSQL)` | statement |
  | `CloseLoan(ctx, tx *sql.Tx, id int)` | `tx.ExecContext(ctx, "EXEC dbo.usp_CloseLoan @id = ?", id)` | statement |
  | `HoldsFor(db *sqlx.DB, id int)` | `db.Select(&holds, "SELECT * FROM dbo.Holds WHERE MemberId = ?", id)` | statement |
  | `Archive(ctx, conn *pgx.Conn)` | `conn.Exec(ctx, "INSERT INTO dbo.LoanArchive (Id) SELECT Id FROM dbo.Loans WHERE ClosedAt IS NOT NULL")` | statement |
  | `Purge(g *gorm.DB)` | `g.Exec("DELETE FROM dbo.Holds WHERE ExpiresAt < CURRENT_TIMESTAMP")` | statement |
  | `ByTable(db *sql.DB, table string)` | `db.Query("SELECT * FROM " + table)` | none, non-constant |
  | `Prepared(stmt *sql.Stmt)` | `stmt.Exec(1)` | none, not counted |
  | `Models(g *gorm.DB)` | `g.Where("member_id = ?", 1).Find(&loans)` | none, not counted |
  | `TestActiveLoanCount` in `loans/repository_test.go` | `db.QueryRow("SELECT COUNT(*) FROM dbo.Loans")` | statement |

  Stats: `{ constant: 6, nonConstant: 1 }`.

- [ ] **Step 1: Write the failing tests.**
  - `sqlsites_test.go` (temp modules with stub modules wired through `replace`): `TestKnownApisYieldRecords` (table-driven over every Go row: method and package-function forms, `Context` variants, pgx v4 and v5 paths, the pgx v5 `Tx` interface, the `*sql.DB` methods promoted onto `sqlx.DB`); `TestConstantsAndNonConstants` (a `const`, a constant concatenation, a `var`, `fmt.Sprintf`, a parameter); `TestStmtMethodsAndOrmCallsAreIgnored`; `TestClosuresBelongToTheEnclosingFunction`.
  - `main_test.go`: `TestRunReportsSqlCallSitesOnlyWithTheFlag` (the lending module copied to a temp dir: the table's records and `summary.sql` equal to `{6, 1}` with the flag; no `sqlCallSites` and no `sql` without it).
- [ ] **Step 2: Run them.** `(cd packages/lang-go/tools/ctxo-go-analyzer && go test ./...)`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Then `go vet ./...`. Expected: clean.
- [ ] **Step 5: Commit.** Stage the Files block paths and the fixture additions; `git commit -m "feat(lang-go): report SQL call sites in ctxo-go-analyzer behind --sql-call-sites (#156)"`.

---

### Task 12: lang-go turns call sites into edges

**Files:**
- Create: `packages/lang-go/src/sql-edges.ts`
- Modify: `src/analyzer/analyzer-process.ts` (`GoAnalyzerRunOptions`, `buildGoAnalyzerArgs`, `runBatchAnalyze`, `AnalyzerFileResult.sqlCallSites?`, `AnalyzerBatchResult.sql?`), `src/analyzer/analyzer-adapter.ts` (constructor options; `absorbBatch` rewrites call-site ids with the module prefix; `extractEdges`; `getSqlStats`), `src/composite-adapter.ts` (options, `sqlCallSites`), `src/index.ts`, `package.json` (`"@ctxo/sql-extract": "workspace:^"`), `tsup.config.ts`, `pnpm-lock.yaml`. Before editing: the two MCP tools on `GoAnalyzerAdapter`, `GoCompositeAdapter`, `packages/lang-go/src/analyzer/analyzer-process.ts::runBatchAnalyze::function` and `packages/lang-go/src/index.ts::plugin::variable`.
- Create: `packages/sql-extract/corpus/go-database-sql.go.fixture`, `go-sqlx-pgx-gorm.go.fixture`, `go-constants.go.fixture` with expected files
- Test: `src/__tests__/analyzer-process.test.ts`; new `sql-edges.test.ts`, `plugin.test.ts`, `package.test.ts`, `corpus.integration.test.ts`; `lending-module.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GoAnalyzerRunOptions { readonly sqlCallSites?: boolean; readonly timeoutMs?: number }   // timeout default 120_000
  export function buildGoAnalyzerArgs(moduleRoot: string, options?: GoAnalyzerRunOptions): string[];   // ['--root', moduleRoot], plus '--sql-call-sites'
  export async function runBatchAnalyze(binaryPath: string, moduleRoot: string, options?: GoAnalyzerRunOptions): Promise<AnalyzerBatchResult>;
  // AnalyzerFileResult.sqlCallSites?: SqlCallSite[]; AnalyzerBatchResult.sql?: { constant: number; nonConstant: number }
  export class GoAnalyzerAdapter { constructor(options?: { readonly sqlCallSites?: boolean }); getSqlStats(): { constant: number; nonConstant: number } | undefined }
  export class GoCompositeAdapter { constructor(options?: { readonly sqlCallSites?: boolean }); readonly sqlCallSites: boolean }
  // createAdapter(ctx) returns new GoCompositeAdapter({ sqlCallSites: ctx.capabilities?.sqlCallSites === true })
  ```
- Expected edges: `loans/repository.go::ActiveLoans::function` reads `dbo.loans`, `dbo.members`; `::CloseLoan::function` executes `dbo.usp_closeloan`; `::HoldsFor::function` reads `dbo.holds`; `::Archive::function` reads `dbo.loans` and writes `dbo.loanarchive`; `::Purge::function` writes `dbo.holds`; `loans/repository_test.go::TestActiveLoanCount::function` reads `dbo.loans`; no other symbol has a data edge.
- Corpus cases (run with the fixture's `stubs/` next to a `go.mod` for module `corpus` holding the same `replace` lines):

  | Case | Covers | reads | writes | executes |
  |---|---|---|---|---|
  | `go-database-sql` | `DB.Query`, `DB.QueryRowContext`, `Tx.ExecContext`, `Conn.QueryContext`, `DB.Prepare`; `Stmt.Exec` (nothing) | dbo.holds, dbo.loans | dbo.loans | dbo.usp_closeloan |
  | `go-sqlx-pgx-gorm` | sqlx `Select`, `Get`, `Queryx`, `NamedExec`, `MustExec` and `sqlx.Get`; pgx `Conn.Query`, `pgxpool.Pool.Exec`, `Tx.QueryRow`; gorm `Raw`, `Exec`; a gorm model chain (nothing) | dbo.holds, dbo.loans, dbo.members | dbo.holds, dbo.loanarchive | |
  | `go-constants` | `const`, constant concatenation; `var` and `fmt.Sprintf` (nothing) | dbo.loans | | |

- [ ] **Step 1: Write the failing tests.**
  - `analyzer-process.test.ts`: `buildGoAnalyzerArgs adds --sql-call-sites only when enabled`; `runBatchAnalyze spawns with those args and reads sqlCallSites and the summary sql stats`.
  - `sql-edges.test.ts`: the three tests of Task 8 against this plugin's module.
  - `plugin.test.ts`: `createAdapter enables SQL call sites only when capabilities.sqlCallSites is true`; `the plugin keeps apiVersion 1`. `package.test.ts`: the dependency and peer range; imports within `@ctxo/plugin-api`, `@ctxo/sql-extract`, `tree-sitter`, `tree-sitter-go`, node built-ins and relative paths.
  - `corpus.integration.test.ts` (gated Go): one temp module with each `mode: 'go'` case in `<case>/case.go`; `<case>: call-site accesses match the corpus`.
  - `lending-module.integration.test.ts`: `repository functions and the test function have the expected data edges`; `call-site ids carry the module prefix when go.mod sits in a subdirectory` (the module copied to `<tmp>/services/lending`, the composite initialized at `<tmp>`: `services/lending/loans/repository.go::ActiveLoans::function` reads `dbo.loans::table`); `getSqlStats reports 6 constant and 1 non-constant texts`; `without sqlCallSites there are no data edges and no stats`.
- [ ] **Step 2: Run them.** `pnpm install && pnpm --filter @ctxo/sql-extract build && pnpm --filter @ctxo/lang-go test`. Expected: FAIL.
- [ ] **Step 3: Implement**; write the corpus files.
- [ ] **Step 4: Run them.** Expected: PASS, with the gated tests running here. Then `pnpm --filter @ctxo/lang-go build && pnpm --filter @ctxo/lang-go typecheck && pnpm --filter @ctxo/sql-extract test`. Expected: green.
- [ ] **Step 5: Commit.** Stage the Files block paths and the corpus files; `git commit -m "feat(lang-go): SQL edges from analyzer call sites behind sqlCallSites (#156)"`.

---

### Task 13: Cross-language acceptance, CLI help and CI

**Files:**
- Create: `packages/cli/tests/e2e/language-parity-sql.test.ts`
- Modify: `packages/cli/src/cli/cli-router.ts` (`printHelp`, the `ctxo install sql` line). Before editing: the two MCP tools on `packages/cli/src/cli/cli-router.ts::printHelp::function`.
- Modify: `.github/workflows/ci.yml` (new `plugin-tests` job)

**Interfaces:**
- Consumes: every plugin task; `IndexCommand` as PR 1B's `index-command.sql.test.ts` drives it; `createProject` (PR 1A helper); `JsonIndexReader`, `loadGraph`, `BlastRadiusCalculator`.
- Project (written into a `createProject()` repo, then committed): `src/loans.ts` (`import { Pool } from 'pg'; const pool = new Pool(); export async function activeLoans() { return pool.query('SELECT * FROM dbo.Loans'); }`); `src/main/java/lending/LoanDao.java` (`public void load(java.sql.Connection c) throws Exception { c.prepareStatement("SELECT * FROM dbo.Loans"); }`); `go.mod` (`module parity`, `go 1.22`) and `loans/repo.go` (`func Active(db *sql.DB) { db.Query("SELECT * FROM dbo.Loans") }`); `db/Loans.sql` (`CREATE TABLE dbo.Loans (Id INT NOT NULL)`); a `package.json` whose `devDependencies` list `@ctxo/lang-typescript`, `@ctxo/lang-java` and `@ctxo/lang-go` (`*`), plus `@ctxo/lang-sql` in the second project only (discovery resolves them through the CLI's own install).
- Gates computed in the file: `HAS_GO` (`go version` succeeds) and `CAN_RUN_JDT` (`java -version` succeeds and `packages/lang-java-analyzer/jar/ctxo-jdt-analyzer-17.jar` or `-11.jar` exists); `CTXO_JDT_ANALYZER_JAR` set with `vi.stubEnv` before indexing; hook timeouts 300 s.
- Help line: `ctxo install sql          SQL plugin: .sql definitions, data edges from C#, TypeScript, Java and Go call sites`.
- CI job `plugin-tests` (`ubuntu-latest`, 20 minutes): checkout, `pnpm/action-setup` and `actions/setup-node` (Node 22) pinned like the existing jobs; `actions/setup-java` (Temurin 21, `cache: maven`) and `actions/setup-go` (`go-version-file` and `cache-dependency-path` pointing at `packages/lang-go/tools/ctxo-go-analyzer/go.mod` and `go.sum`), each pinned to the commit SHA of its latest release tag (`gh api repos/actions/<name>/releases/latest --jq .tag_name`, then `gh api repos/actions/<name>/commits/<tag> --jq .sha`) with the tag as a trailing comment; `pnpm install --frozen-lockfile`; `pnpm -r build`; `pnpm --filter @ctxo/lang-typescript --filter @ctxo/lang-java --filter @ctxo/lang-go test` with `CTXO_JDT_ANALYZER_JAR: ${{ github.workspace }}/packages/lang-java-analyzer/jar/ctxo-jdt-analyzer-17.jar`; `pnpm --filter @ctxo/lang-java-analyzer test && mvn -q -f packages/lang-java-analyzer/java/pom.xml -Pjava17 test`; `go test ./...` with `working-directory: packages/lang-go/tools/ctxo-go-analyzer`.

- [ ] **Step 1: Write the acceptance tests.**
  - `without @ctxo/lang-sql no language emits reads, writes or executes edges` (every FileIndex from `JsonIndexReader.readAll()`; it holds in whichever tier each toolchain allows).
  - `with @ctxo/lang-sql the TypeScript call site reaches the lang-sql table node` (after `loadGraph`, `graph.getNode('dbo.loans::table')?.symbolId` is `db/Loans.sql::dbo.loans::table`, and `BlastRadiusCalculator` on that node lists `src/loans.ts::activeLoans::function` as `confirmed`).
  - `it.skipIf(!CAN_RUN_JDT)`: `the Java call site reaches the same node` (`src/main/java/lending/LoanDao.java::load::method` is `confirmed` in that blast radius).
  - `it.skipIf(!HAS_GO)`: `the Go call site reaches the same node` (`loans/repo.go::Active::function`).
  - `indexing the same commit twice gives deep-equal symbols, annotations and edges for every file` (spec 13.1; `lastModified` is not compared).
- [ ] **Step 2: Run them.** `pnpm -r build && pnpm --filter @ctxo/cli exec vitest run --config vitest.config.e2e.ts tests/e2e/language-parity-sql.test.ts`. Expected: PASS on this machine with all four tests running (an acceptance test over Tasks 2 to 12; a failure names the plugin task to fix).
- [ ] **Step 3: Update the help line and add the CI job.**
- [ ] **Step 4: Verify.** `pnpm --filter @ctxo/cli build && node packages/cli/dist/index.js --help` shows the new `ctxo install sql` line; `pnpm --filter @ctxo/cli exec node -e "require('yaml').parse(require('fs').readFileSync('../../.github/workflows/ci.yml', 'utf8'))"` exits 0; `pnpm --filter @ctxo/cli test:unit` is green.
- [ ] **Step 5: Commit.** Stage the Files block paths; `git commit -m "test(e2e): SQL call sites reach lang-sql nodes from every language; CI plugin tests (#156)"`.

---

### Task 14: Docs, changesets and full verification

**Files:**
- Modify: `docs/features/domain-knowledge.md`, `docs/plugins.md`, `docs/roadmap.md`, `CHANGELOG.md`, `llms.txt`, `llms-full.txt`, `CLAUDE.md`, `README.md`, `packages/lang-java/README.md`, `packages/lang-go/README.md`
- Modify: `site/docs/languages/typescript.md`, `java.md`, `go.md`, `overview.md`, `sql.md`, `writing-a-plugin.md`; `site/docs/reference/symbol-ids.md`, `edge-kinds.md`; `site/docs/concepts/blast-radius.md`; `site/docs/mcp-tools/find-dead-code.md`; `site/docs/cli/install.md`
- Create: `.changeset/language-parity.md`

- [ ] **Step 1: Check the release state.** The four plugin peer ranges and the three `apiVersion: '1'` entries still equal Task 0's record.
- [ ] **Step 2: Feature doc.** A "Language parity" section in `docs/features/domain-knowledge.md`: the per-language API data (shared table), the constant rules per language (TypeScript: literals, templates, `+`, `const` bindings, tagged-template placeholders; Java: JDT constants; Go: `go/types` constants), receiver provenance and its limits in TypeScript, full tier only for Java and Go, annotations per language with `named.member`, test symbols per language, the corpus host-language cases and how to add one, and the "no SQL edges without `@ctxo/lang-sql`" rule.
- [ ] **Step 3: Roadmap and plugins.** `docs/plugins.md`: what each official plugin now emits (annotations, test symbols, SQL call sites) and the capability it reads. `docs/roadmap.md`: a shipped bullet; deferred rows with triggers: library type information for TypeScript receivers (evidence of missed edges), JDT `calls`/`uses` edges from methods instead of types (owner request), `index.tests` globs reaching plugins (when `PluginContext.config` is wired), counting test dependents separately in the safe-edit gate (owner feedback after the upgrade), Go `t.Run` subtests as symbols (demand; titles reach the K6 scan), TypeScript property symbols (a consumer needing them).
- [ ] **Step 4: CHANGELOG `[Unreleased]`.**
  - Added: TypeScript decorators, Java annotations (JDT and tree-sitter) and Go struct tags as symbol annotations; TypeScript test blocks as `function` symbols with `{ name: 'test' }` and edges; Go `_test.go` files in the full tier; SQL edges at known call sites in TypeScript (pg, mysql2, mssql, `knex.raw`, Prisma raw, TypeORM, Sequelize, better-sqlite3), Java (JDBC, Spring `JdbcTemplate`, JPA native queries, native `@Query`, MyBatis) and Go (`database/sql`, sqlx, pgx, gorm raw) when `@ctxo/lang-sql` is installed.
  - Changed: the first re-index after upgrading changes committed index JSON for TypeScript, Java and Go files; test blocks and Go test functions count as blast-radius dependents, so the safe-edit gate may fire more often on well-tested symbols (as for C#); find_dead_code no longer reports Go functions whose only callers are tests; symbol-level communities shift once; Go full-tier runs type-check test packages.
  - Compatibility: the three plugins still declare protocol `'1'` and work with older CLIs, which ignore annotations and never request SQL edges.
- [ ] **Step 5: llms files, CLAUDE.md, READMEs.** `llms.txt` and `llms-full.txt`: the language capability matrix, the annotation formats, test-block naming, the API tables. `CLAUDE.md`: the lang-* lines of the package tree and "Plugin Architecture" (the TypeScript, Java and Go plugins use `@ctxo/sql-extract`). `README.md`: the Notes column of "Supported Languages" (annotations, test symbols, SQL call sites) and Go's tier as `syntax / full`. The lang-java and lang-go READMEs: the same features.
- [ ] **Step 6: Site docs.** Language pages: sections for annotations, test symbols (TypeScript blocks, Go `_test.go`, Java test sources) and SQL at call sites (table, constants, tier, limits); replace the TypeScript line saying decorators are surfaced as `uses` edges. `overview.md`: support-matrix columns for annotations, test symbols and SQL call sites. `sql.md`: host languages are C#, TypeScript, Java and Go. `writing-a-plugin.md`: reserved annotation keys `type` and `member`, reading `capabilities`, analyzer JSON as a plugin-internal protocol. `symbol-ids.md`: a test-block id example. `edge-kinds.md`: data edges from all four languages. `blast-radius.md`: tests as dependents. `find-dead-code.md`: Go test-only callers. `install.md`: what `ctxo install sql` enables.
- [ ] **Step 7: Changeset** `.changeset/language-parity.md`: `"@ctxo/lang-typescript": minor`, `"@ctxo/lang-java": minor`, `"@ctxo/lang-java-analyzer": minor`, `"@ctxo/lang-go": minor`, `"@ctxo/cli": patch`, with a three-sentence note naming #156 Phase 1 and K18. Run `pnpm changeset status --verbose`. Expected: exactly those bumps, no `major`, and lang-java and lang-java-analyzer on the same next version (jar-resolve warns when their base versions differ); if they would differ, for example because PR 1B was released on its own, stop and ask the owner before committing.
- [ ] **Step 8: No em dashes.** `git diff -U0 HEAD -- docs CHANGELOG.md llms.txt llms-full.txt CLAUDE.md README.md site .changeset packages/*/README.md | LC_ALL=C.UTF-8 grep -nP '^\+.*\x{2014}'`. Expected: no output.
- [ ] **Step 9: Full verification.** `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r typecheck && pnpm -r lint && CTXO_JDT_ANALYZER_JAR="$PWD/packages/lang-java-analyzer/jar/ctxo-jdt-analyzer-17.jar" pnpm -r test && pnpm --filter @ctxo/cli test:e2e && mvn -q -f packages/lang-java-analyzer/java/pom.xml -Pjava17 test && (cd packages/lang-go/tools/ctxo-go-analyzer && go vet ./... && go test ./...)`. Expected: all green, including the CLI tarball test. `pnpm --filter @ctxo/lang-go pack --dry-run` lists `tools/ctxo-go-analyzer/internal/sqlsites/sqlsites.go` and no `test-fixtures/` path; `pnpm --filter @ctxo/lang-typescript pack --dry-run` lists only `dist/` and `package.json`.
- [ ] **Step 10: Commit.** Stage the Files block paths; `git commit -m "docs: language parity docs, help and changeset (#156)"`.
