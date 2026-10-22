# Domain Knowledge Layer

> Phase 1 of [#156](https://github.com/alperhankendi/Ctxo/issues/156): data coupling, plugin protocol v2 and `@ctxo/lang-sql`. Later phases (named contexts, rules, facts detectors) extend this document.

## The problem this solves

Two services can look independent in the dependency graph while both write the same table. No import edge connects them, so an agent that changes one of them never learns that the other reads the rows it is about to reshape. The strongest coupling between bounded contexts in a shared-database codebase is often the data they touch, and until now Ctxo could not see it:

- The protocol had no data vocabulary: no table, view or stored procedure as a symbol, and no edge that reads or writes one.
- Symbols carried no structured metadata. `[Fact]`, `[Trait("Category", "Loans")]` or `[HttpGet("/loans")]` say what a method is for, but the index dropped them, so test files were recognised by file name alone.
- There was no channel for small code facts (literal comparisons, retry timeouts) that later phases need, and no way for the host to ask for them only when needed.

Phase 1 closes these gaps. The design record is [ADR-017](../architecture/ADR/adr-017-plugin-protocol-v2-and-data-coupling.md).

## Data coupling

"Data coupling" is the concept: code that reads, writes or executes the same database objects is coupled, whatever its imports say. Ctxo models it with three symbol kinds and three edge kinds:

| Kind | Meaning |
|---|---|
| `table`, `view` (symbols) | Data resources. Core analyses use `DATA_RESOURCE_KINDS` (`table`, `view`), never the literal `table`. |
| `procedure` (symbol) | A stored procedure. SQL functions map to the existing `function` kind. |
| `reads`, `writes` (edges) | From a method, procedure, view or function to a table or view. |
| `executes` (edge) | From a method or procedure to a stored procedure. |

Data edges point at a canonical 2-part name such as `dbo.loans::table` or `dbo.usp_closeloan::procedure`: lowercase (ASCII `A`-`Z` only), delimiters stripped, default schema `dbo`. The graph resolves a 2-part table or view reference to any `table` or `view` node with that name (the calling side cannot know which one it is), and a procedure reference to a `procedure` node. When several files define the same object, the first file in sorted path order wins, so resolution is deterministic. A reference that no indexed `.sql` file defines stays unresolved in the graph and appears as an external resource in the contexts view.

What the data edges change elsewhere:

- **Blast radius.** `reads`, `writes` and `executes` are `confirmed`: a schema change breaks readers and writers directly. Because the safe-edit gate counts `confirmed + likely` dependents, it now also guards heavily used tables and procedures.
- **Communities.** Data edges stay out of symbol-level communities, god nodes, cross-cluster counts and boundary violations. Data coupling is reported by the contexts view instead.
- **Dead code.** Symbols in `.sql` files are never reported by `find_dead_code`: their consumers may live outside the index.
- **PageRank.** `get_symbol_importance` runs on the whole graph, data edges included, so a table that many methods read ranks high.

## Plugin protocol v2

`@ctxo/plugin-api` carries the v2 surface. Everything is additive: a v1 plugin keeps working unchanged.

### Kinds

```ts
export const SYMBOL_KINDS = ['function', 'class', 'interface', 'method', 'variable', 'type',
                             'table', 'view', 'procedure'] as const;
export const EDGE_KINDS = ['imports', 'calls', 'extends', 'implements', 'uses',
                           'reads', 'writes', 'executes'] as const;
export const DATA_RESOURCE_KINDS = ['table', 'view'] as const;
```

The CLI imports these lists from `@ctxo/plugin-api`; it has no copy of its own. The MCP tool enums (`search_symbols.kind`, `get_symbol_importance.kind`, `find_importers.edgeKinds`) follow.

### Annotations

`SymbolNode` gains an optional `annotations` array:

```ts
export interface SymbolAnnotation {
  readonly name: string;                               // as written, no namespace, no "Attribute" suffix
  readonly args?: readonly string[];                   // constant positional arguments
  readonly named?: Readonly<Record<string, string>>;   // constant named arguments; named.type is reserved
}
```

- Always on. Annotations need no host request; they are capped and additive.
- Host-language attributes, annotations and decorators follow the C# caps: 20 per symbol, 10 positional and 10 named entries each, 200 characters per value (longer values are truncated). `named.type` is reserved for the fully qualified type name when the extractor knows it.
- `@ctxo/lang-sql` emits a `columns` annotation on each table with every column (sorted, lowercase). It is not subject to the host-language caps.
- Core validates shape only. A symbol whose annotations are malformed is kept without them.
- Annotations live in the JSON index only. SQLite is unchanged.

### Facts on request

```ts
export const FACT_KINDS = ['literal-comparison', 'normalization', 'retry-timeout', 'endpoint'] as const;
export interface CodeFact {
  readonly kind: FactKind;
  readonly symbolId: SymbolId;   // enclosing symbol
  readonly line: number;         // 0-based, like SymbolNode.startLine
  readonly text: string;         // single line, trimmed, at most 200 characters
  readonly detail?: Readonly<Record<string, string>>;
}
// ILanguageAdapter gains: extractFacts?(filePath: string, source: string): Promise<CodeFact[]>
```

Facts are produced only when the host asks for them: `index.facts: true` in `.ctxo/config.yaml` (no CLI flag). `ctxo index` and `ctxo watch` then call `extractFacts` on plugins that implement it and write the non-empty results into the file's index JSON under `facts`. This phase ships the types, the schema and the plumbing; no official plugin implements `extractFacts` yet, so the setting has no visible effect today. The detectors arrive in a later phase.

### Capabilities

```ts
export interface PluginCapabilities {
  readonly facts?: boolean;         // index.facts: true
  readonly sqlCallSites?: boolean;  // a discovered plugin handles .sql
}
// PluginContext gains: readonly capabilities?: PluginCapabilities
```

The CLI computes capabilities from the discovered plugins before any `createAdapter` call and hands them to every plugin. A plugin ignores the ones it does not use. `sqlCallSites` is set only when a plugin that lists `.sql` is installed, so a C# repository without `@ctxo/lang-sql` gets no edges to resources that cannot exist.

### Versioning

- `SUPPORTED_API_VERSIONS = ['1', '2']`. The CLI loads plugins that declare either. `'1'` stays accepted for at least 12 months after `'2'` ships (ADR-012). The old `SUPPORTED_API_VERSION` export stays at `'1'` and is deprecated.
- Versions gate loading only: the CLI handles output identically for `'1'` and `'2'`. A plugin declares the **lowest** version it works on. The existing official plugins stay on `'1'`; only `@ctxo/lang-sql` declares `'2'`.
- An older CLI skips `@ctxo/lang-sql` with a warning (`unsupported apiVersion 2`), and when it reads an index written by a newer one it drops the symbols and edges of the new kinds with a warning.
- The official plugins accept `@ctxo/plugin-api` `^0.7.3 || ^0.8.0 || ^0.9.0` as a peer; `@ctxo/lang-sql` accepts `^0.8.0 || ^0.9.0`.

### The one dependency exception

Language plugins import only from `@ctxo/plugin-api`. The exception: a plugin may depend on a Ctxo-owned utility package with zero runtime dependencies. Today that is only `@ctxo/sql-extract`, the T-SQL tokenizer and recognizers. It is a library, not a plugin, and it is never discovered.

## `@ctxo/lang-sql`

```bash
ctxo install sql        # or: ctxo install tsql
```

A syntax-tier plugin for `.sql` files (T-SQL), built on `@ctxo/sql-extract`. No database connection and no .NET: SQL-only repositories need nothing beyond Node.js. `ctxo init`, `ctxo doctor` (language coverage) and `ctxo index --install-missing` suggest it when the repository has `.sql` files.

### What it indexes

| Source | Becomes |
|---|---|
| `CREATE [OR ALTER] TABLE` | `table` symbol with a `columns` annotation |
| `CREATE [OR ALTER] VIEW`, `ALTER VIEW` | `view` symbol |
| `CREATE [OR ALTER] PROC[EDURE]`, `ALTER PROC[EDURE]` | `procedure` symbol |
| `CREATE [OR ALTER] FUNCTION`, `ALTER FUNCTION` | `function` symbol |
| `FROM`, `JOIN`, `APPLY`, `MERGE ... USING` tables in a body | `reads` edge |
| `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE TABLE`, `SELECT ... INTO`, `OUTPUT ... INTO` targets in a body | `writes` edge |
| `EXEC` / `EXECUTE` of a procedure in a body | `executes` edge |

Symbol IDs carry the canonical name: `db/lending.sql::dbo.loans::table`. The symbol `name` keeps the declared spelling without delimiters and without an added schema.

### The rules in short

- **Names.** One to four dot-separated parts; `[...]` and `"..."` delimiters are removed. One part gets schema `dbo`. Three- and four-part names, temp tables (`#t`), table variables (`@t`), CTE names, aliases and the `sys` and `information_schema` schemas are skipped. Only ASCII `A`-`Z` is folded, so `[dbo].[Ödünç Kaydı]` matches byte for byte on every side.
- **Bodies.** Accesses come from the body of a view, procedure or function. A body ends at the end of its `GO` batch, or at the next view, procedure or function definition when `GO` is missing. `CREATE TABLE` or `ALTER TABLE` inside a body is body text: it defines nothing and adds no columns.
- **Columns.** Column-list elements of `CREATE TABLE` (constraints and indexes excluded), plus `ALTER TABLE ... ADD` outside a body for a table defined in the same file.
- **Merging.** Two definitions of one object in a file merge into the first.
- **Text that is not code.** Comments, string literals and `GO` inside them never produce accesses. A leading byte order mark is ignored, and UTF-16 files saved by SSMS are decoded.
- **Not edges.** A call to a SQL function, dynamic SQL (`EXEC (@sql)`, `EXEC @proc`) and `EXECUTE AS`. A recursive procedure has no self edge. SQL objects carry no complexity metrics.

### v1 limits

- **T-SQL only**, with `dbo` as the default schema. Neither is configurable yet.
- **Top-level DML is skipped.** An `INSERT` or `SELECT` outside any definition (a migration or seed script) produces no edges. Co-change still connects those scripts to the code that changes with them.
- **`ALTER TABLE ... ADD` columns count only in the defining file.** Columns added from another file are not attached to the table.
- **CTE scope.** A CTE name is skipped from its `WITH` to the next top-level `;` or the end of the batch. A table that reuses a CTE name later in the same batch without a `;` in between is therefore skipped by `@ctxo/sql-extract`, while ScriptDom (the C# side) reads it.
- Objects defined outside indexed `.sql` files exist only as external resources.

## SQL at C# call sites

With `@ctxo/lang-sql` installed (`capabilities.sqlCallSites`) and the C# plugin in its Roslyn tier (.NET SDK 8+), the Roslyn helper parses **constant** SQL at known call sites with `Microsoft.SqlServer.TransactSql.ScriptDom` and adds `reads`, `writes` and `executes` edges from the calling method or constructor to the same 2-part targets that `@ctxo/lang-sql` defines. A C# method and the stored procedure that touch `dbo.loans` meet in the graph.

| API | Where the SQL comes from | Procedure when |
|---|---|---|
| ADO.NET `SqlCommand` (`Microsoft.Data.SqlClient` and `System.Data.SqlClient`) | constructor argument `cmdText` | the command's `CommandType` is `StoredProcedure` in the same method |
| `CommandText` on `SqlCommand`, `DbCommand`, `IDbCommand` and their subtypes | simple assignment | the command's `CommandType` is `StoredProcedure` in the same method |
| Dapper `SqlMapper` extension methods whose name starts with `Query` or `Execute` | argument `sql` | the call passes `commandType: CommandType.StoredProcedure` |
| `SqlBulkCopy.DestinationTableName` | simple assignment | never; the table is written |
| EF Core `FromSqlRaw` | argument `sql` | never |
| EF Core `ExecuteSqlRaw`, `ExecuteSqlRawAsync`, `SqlQueryRaw` | argument `sql` | never |

- **Constants only.** The text counts when the compiler knows it: string literals, `const` fields, constant concatenation, verbatim and raw strings. SQL built at runtime, interpolation with holes, parameters and `static readonly` fields are non-constant and produce no edges. Nothing is guessed.
- **Make SQL visible.** Declare it as a `const string`, not `static readonly string`:

  ```csharp
  private const string CloseLoanSql =
      "UPDATE dbo.Loans SET ClosedAt = SYSUTCDATETIME() WHERE Id = @id";   // visible: writes dbo.loans

  private static readonly string ActiveLoansSql =
      "SELECT Id FROM dbo.Loans WHERE ClosedAt IS NULL";                    // invisible: not a constant
  ```

- **EF placeholders.** EF Core composite-format placeholders (`{0}`, `{1}`) are rewritten to parameters (`@p0`) before ScriptDom parses the text.
- **Dapper lists.** `WHERE Id IN @ids` is rewritten to `IN (@ids)` before parsing.
- **CommandType** is recognised only on a local (`command.CommandType = CommandType.StoredProcedure`) and in an object initializer of the same method. `CommandText +=` (and `??=`) builds text at runtime and counts as non-constant.
- **Parse failures.** A constant that ScriptDom rejects adds no edges and never stops the batch.
- **Scope.** Call sites inside method and constructor bodies, the same scope as the other C# edges.
- **Counts.** `DEBUG=ctxo:roslyn ctxo index` logs `Roslyn SQL call sites: N constant, M non-constant, K unparsable`.
- **Needs.** The .NET SDK 8+ (Roslyn tier) and `@ctxo/lang-sql`. The tree-sitter fallback gives no SQL edges.

## C# attribute annotations

`@ctxo/lang-csharp` reports the attributes written on each symbol as annotations, in both tiers:

- `name` is the attribute name as written, without namespace and without the `Attribute` suffix (`Fact`, `Trait`, `HttpGet`).
- Values in the Roslyn tier: numbers in invariant culture, `true` and `false`, enum constants as `Type.Member`, `typeof(T)` as the type's display string, array arguments flattened, nulls skipped.
- In the Roslyn tier, `named.type` carries the attribute class's fully qualified name when it resolves.

Tier differences:

- Tree-sitter keeps literal arguments only (strings, numbers, booleans). Enum constants, `typeof(T)`, array arguments and other expressions are dropped there.
- In the Roslyn semantic path, an argument written with a parameter name (`name: "x"`) arrives in `args`, while the tree-sitter tier puts it in `named`. Consumers should not depend on which of the two holds such an argument.
- Roslyn formats real-number exponents its own way.

The first `ctxo index` after upgrading rewrites the committed index JSON of C# files once, because annotations are always on.

## Test files recognised by annotations

The contexts view leaves test files out. A file is a test file when a test glob matches it (the shared defaults plus `index.tests`) or when any symbol in it carries a test-framework annotation. The names match exactly:

`Fact`, `Theory`, `SkippableFact`, `SkippableTheory`, `Test`, `TestCase`, `TestCaseSource`, `TestFixture`, `TestMethod`, `DataTestMethod`, `TestClass`

- An annotated file is a test file whatever its path.
- Once any C# file in the index carries annotations (the evidence that the annotating plugin ran), a file matched only by the name globs `**/*Test.cs` or `**/*Tests.cs` and without a test annotation becomes a production node. This removes the false positives of name-only matching, such as a production `LoanPolicyTests.cs` helper.
- Folder globs (`**/tests/**`, `**/*.Tests/**`, `**/*.Test/**` and the rest of the defaults) still decide on their own.
- A repository whose C# files have no annotations in the index keeps the plain glob behaviour.

Limitations, both fixed with an `index.tests` glob:

- Test classes that use only other attributes, for example FsCheck `[Property]`.
- An unannotated `*Tests.cs` file in a bare capital `Tests/` or `Test/` folder: `**/tests/**` is case-sensitive.

```yaml
index:
  tests:
    - "**/Tests/**"
    - "src/Lending.Properties/**"
```

## Data coupling in the contexts view

`ctxo index` adds data coupling to `.ctxo/index/contexts-view.json` (see "Candidate contexts" in [architectural intelligence](architectural-intelligence.md) for the view itself):

| Field | Meaning |
|---|---|
| `dataResources[]` | Every table or view that a candidate file (members and assigned hubs) reads or writes, by name: `name`, `kind` (absent when external), `external`, `accesses` (per candidate, `modes` of `reads` and `writes`), `writers`, `owner` |
| `dataResources[].external` | No indexed `.sql` file defines it |
| `dataResources[].owner` | The only candidate that writes it; several writers leave it absent with more than one entry in `writers` |
| `candidates[].sharedTables[]` | The resources of this candidate that at least one other candidate also reads or writes, by name, with every candidate's access modes |

How access is counted:

- A `reads` or `writes` edge from a symbol in a candidate file records that candidate and mode.
- An `executes` edge to an indexed procedure adds that procedure's reads and writes, following further `executes` edges transitively. An unresolved procedure adds nothing.
- Reading a view does not expand to its tables.
- Unclustered files are ignored; hubs count for their assigned candidate.

**Clustering weight.** `contextsView.weights.data` (default `0`) adds a third component to a file-pair weight: the data edges between two files (an accessor and the `.sql` file that defines the object), log-normalised like the dependency component. At the default, data access never pulls candidates together. Shared tables are a boundary finding to show, not a reason to merge candidates. Data edges never count as hub dependents and never appear in `crossEdges`.

**Terms and collisions.** Table and view names and table columns join the top-term harvest of the candidate whose `.sql` file they are in. A table takes part in collisions with its columns as members; names and members compare with ASCII case and `_` ignored, so `LoanItems` meets `loan_items`. Views appear in terms but not in collisions.

**Surfaces.**

- `ctxo index` prints `, <S> shared tables` at the end of its contexts line when any table is shared.
- `ctxo contexts` adds the shared table count to its header and to each candidate line that has any, then one `shared` line per shared resource with its accesses and `owner #<id>`, `several writers` or `read only`. `ctxo contexts --json` prints the full lists.
- `get_architectural_overlay({ mode: "contexts" })`: the summary carries counts only, `sharedTableCount` on each candidate that has shared tables, plus `dataResourcesTotal`, `sharedResourcesTotal` and `externalResourcesTotal`. With `candidate: <id>`, the detail adds `sharedTables` (the first 15 by name, each with up to 10 accesses, the asking candidate's own access always kept, plus `accessCount`) with `sharedTableCount`, and the candidate's own `dataResources` (the first 15 by name, each with its `modes`, `owner`, `writerCount` and `external`) with `dataResourcesTotal`.
- **Byte budget.** When the detail is still larger than the response limit (`CTXO_RESPONSE_LIMIT`, default 8192 bytes), trailing entries are dropped by name order from the longer of the two lists (`dataResources` on a tie) until it fits. The counts keep the totals. Neither list is a truncatable field of the envelope.

**Design note: artifact size.** For a table shared by k candidates, the artifact lists all k accesses under each of those candidates, so its size grows with k² for widely shared tables. The MCP responses are capped; the artifact keeps the full lists.

## Configuration

```yaml
index:
  facts: false             # true asks plugins for code facts (index JSON only)
  tests: []                # extra test-file globs
contextsView:
  weights: { dependency: 1.0, coChange: 1.0, data: 0 }
```

| Key | Default | Effect |
|---|---|---|
| `index.facts` | `false` | Sets `capabilities.facts`; plugins that implement `extractFacts` write `facts` into the index JSON |
| `contextsView.weights.data` | `0` | Weight of data edges in the contexts-view file graph |
| `index.tests` | `[]` | Extra test-file globs; the fix for the annotation limitations above |

## Graceful degradation

| Missing | Behaviour |
|---|---|
| .NET SDK 8+ | No Roslyn annotations and no SQL call-site edges; the tree-sitter tier still emits attribute annotations, with literal arguments only. `ctxo doctor` (`csharp_tier`) passes at the syntax tier with a hint |
| The Roslyn helper cannot restore or build (for example a private or offline NuGet feed without ScriptDom) | The C# plugin falls back to tree-sitter: symbols and literal-only annotations are kept; Roslyn-tier details (resolved `named.type`, non-literal argument values) and SQL call-site edges are lost. `ctxo index` reports `C#: N files (syntax tier - the Roslyn helper failed, run "ctxo doctor")` and `ctxo doctor` warns (`csharp_tier`) |
| `@ctxo/lang-sql` not installed | No SQL call-site edges in any language; no `table`, `view` or `procedure` symbols |
| No annotations in the index | Test files are recognised by globs alone, as before |
| An older CLI | Skips `@ctxo/lang-sql` with a warning and drops the new kinds from a newer index with a warning |

## Upgrade notes

- **One-time C# index change.** The first re-index rewrites the committed JSON of C# files (annotations).
- **UTF-16 sources.** `ctxo index`, `--check` and `ctxo watch` now decode UTF-16 LE and BE files that start with a byte order mark. Their content hash changes once, so the first `ctxo index --check` after upgrading reports them stale until the next `ctxo index`. UTF-8 decoding is unchanged.
- **ScriptDom restore.** The Roslyn helper now restores `Microsoft.SqlServer.TransactSql.ScriptDom` from NuGet for every C# user, with or without `@ctxo/lang-sql`. If your feed cannot serve it, the plugin falls back to tree-sitter (see above); make the package reachable from your NuGet sources to keep the Roslyn tier.
- **.NET roll forward.** The helper targets `net8.0` with `RollForward` `Major`: the .NET host keeps using an installed 8.x runtime and rolls forward to a newer major runtime when no 8.x is installed. The built helper has been run with `dotnet exec --fx-version` on .NET 8, 9 and 10, and an integration test checks the `rollForward` setting and runs the helper on the newest installed runtime.
- **Lone `.csproj`.** A C# repository with one `.csproj` and no solution file now indexes in the Roslyn tier.

## The conformance corpus

`packages/sql-extract/corpus/` keeps the TypeScript and C# SQL parsers in agreement. Each case is a `<case>.sql` file (UTF-8, LF, pinned by `.gitattributes`) with a `<case>.expected.json`:

```json
{
  "description": "Tables after FROM and JOIN are read; the aliases l and m are not tables.",
  "mode": "statement",
  "accesses": { "reads": ["dbo.loans", "dbo.members"], "writes": [], "executes": [] }
}
```

- `mode`: `"statement"` for SQL as code sends it (`extractSqlAccesses`, and ScriptDom on the whole text), or `"file"` for a script of definitions (`extractSqlDefinitions` with the union of body accesses, `@ctxo/lang-sql` through its adapter, and ScriptDom on the whole script).
- `sides` (optional): defaults to `["sql-extract", "scriptdom"]` for statement cases and `["sql-extract", "lang-sql", "scriptdom"]` for file cases. Only a case that is not valid T-SQL may leave out `scriptdom`.
- `definitions` (file mode only): sorted by name, then kind; `columns` only for tables.
- `accesses`: every key present, each list sorted.

The `@ctxo/sql-extract` and `@ctxo/lang-sql` tests run every case on their side. A lang-csharp integration test (it needs the .NET SDK 8+) runs the same cases through `ctxo-roslyn --sql-extract`, for LF and CRLF text.

**Adding a case.** Write `<case>.sql` with synthetic names (library lending: `dbo.loans`, `dbo.members`, `usp_CloseLoan`), write `<case>.expected.json` with the accesses you expect, then run `pnpm --filter @ctxo/sql-extract test` and `pnpm --filter @ctxo/lang-sql test`. With the .NET SDK installed, also run the lang-csharp tests so ScriptDom agrees. When the two parsers disagree on valid T-SQL, fix the parser, not the expectation.

## See also

- [ADR-017](../architecture/ADR/adr-017-plugin-protocol-v2-and-data-coupling.md): the decisions behind this phase
- [Architectural intelligence](architectural-intelligence.md): communities, co-change and the contexts view
- [SQL language page](../../site/docs/languages/sql.md) and [C# language page](../../site/docs/languages/csharp.md)
- [Writing a plugin](../../site/docs/languages/writing-a-plugin.md): the v2 surface for plugin authors
- [roadmap.md](../roadmap.md): deferred items (NoSQL, messaging, dialects, ORMs)
