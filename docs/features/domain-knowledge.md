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

Data edges point at a canonical 2-part name such as `dbo.loans::table` or `dbo.usp_closeloan::procedure`: lowercase (ASCII `A`-`Z` only), delimiters stripped, default schema `dbo`. The graph resolves a 2-part table or view reference to any `table` or `view` node with that name (the calling side cannot know which one it is), and a procedure reference to a `procedure` node. A reference that no indexed `.sql` file defines stays unresolved in the graph and appears as an external resource in the contexts view.

### Several definitions of one object

Repositories with migration history define the same object more than once: `CREATE OR ALTER PROCEDURE` again in a later migration, a copy of the schema in a docs folder, a test schema script. Every data edge points at one of them, the winner, chosen in this order:

1. a definition outside test files, by the default test globs (`index.tests` is not consulted: the graph has no config);
2. then one not under a folder named `docs`, `doc` or `documentation` (ASCII case ignored; folder names only, not the file name);
3. then the codepoint-smallest symbol ID, which is the first file in sorted path order.

The choice does not depend on the order in which files were read. Among production copies the codepoint-smallest path wins, which is not necessarily the newest migration (`V10__` sorts before `V7__`). Docs or test copies can also be left out of the index with `index.ignore`.

All copies of an object share one identity for impact questions:

- **Reverse lookups agree.** The full ID of any copy, or the 2-part ID (`dbo.loans::table`, `dbo.usp_closeloan::procedure`), gives the same answer in `get_blast_radius`, `find_importers` (direct and transitive), `get_pr_impact`, `get_context_for_task`, the safe-edit gate and `ctxo blast-radius`: the winner's dependents, because every data edge points at the winner. A `CREATE OR ALTER PROCEDURE` in a new migration therefore reports the callers of the procedure, not zero.
- **Forward edges stay per copy.** `get_logic_slice` on a copy's full ID walks that copy's own body, so a procedure body in a later migration keeps its own reads and writes. A 2-part ID walks the winner's body.
- **History.** `get_why_context` with a 2-part ID reports the history of the winner's file.

### What the data edges change elsewhere

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
- Host-language attributes, annotations and decorators follow the C# caps: 20 per symbol, 10 positional entries and 10 named entries plus the reserved `type` each, 200 characters per value (longer values are truncated). `named.type` is reserved for the fully qualified type name when the extractor knows it, so a source argument that is itself named `type` is not kept.
- `@ctxo/lang-sql` emits a `columns` annotation on each table with every column (sorted, lowercase). It is not subject to the host-language caps.
- Core validates shape only. A symbol whose annotations are malformed is kept without them.
- Annotations live in the JSON index only. SQLite is unchanged.
- MCP output: `get_logic_slice` returns them on its nodes at `L4` only; `L1` to `L3` and `get_context_for_task` leave them out, so they do not crowd out dependencies. When the graph comes from the SQLite fallback instead of the JSON index, nodes carry no annotations at any level.

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
- The official plugins accept `@ctxo/plugin-api` `^0.7.3 || ^0.8.0 || ^0.9.0` as a peer; `@ctxo/lang-sql` accepts `^0.9.0`, the first release with protocol v2.

### The one dependency exception

Language plugins import only from `@ctxo/plugin-api`. The exception: a plugin may depend on a Ctxo-owned utility package with zero runtime dependencies. Today that is only `@ctxo/sql-extract`, the T-SQL tokenizer and recognizers, used by `@ctxo/lang-sql` and, for SQL at call sites, by `@ctxo/lang-typescript`, `@ctxo/lang-java` and `@ctxo/lang-go`. It is a library, not a plugin, and it is never discovered.

## `@ctxo/lang-sql`

```bash
ctxo install sql        # or: ctxo install tsql
```

A syntax-tier plugin for `.sql` files (T-SQL), built on `@ctxo/sql-extract`. No database connection and no .NET: SQL-only repositories need nothing beyond Node.js. `ctxo init`, `ctxo doctor` (language coverage) and `ctxo index --install-missing` suggest it when the repository has at least 5 `.sql` files and they are at least 2% of its files (as `git ls-files` lists them). SQL has no manifest file, so a handful of scripts in a large code base does not trigger the suggestion; install the plugin yourself if you want them indexed.

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
- **Size limit: 5 MiB.** A `.sql` file larger than 5 MiB is skipped: it gets no symbols, edges or facts, and `ctxo index` prints one warning for it (`skipped <file>: <n> MiB is over the 5 MiB SQL size limit`). Such files are usually data dumps or seed scripts, whose top-level DML gives no edges anyway, and parsing them could exhaust memory. Keep definitions in their own scripts, or leave a dump out with `index.ignore` to silence the warning.
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
| Dapper `CommandDefinition` constructor (for the `SqlMapper` overloads that take one) | argument `commandText` | the constructor's `commandType` argument, named or positional, is `CommandType.StoredProcedure` |
| `SqlBulkCopy.DestinationTableName` | simple assignment | never; the table is written |
| EF Core `FromSqlRaw` | argument `sql` | never |
| EF Core `ExecuteSqlRaw`, `ExecuteSqlRawAsync`, `SqlQueryRaw` | argument `sql` | never |

- **Constants only.** The text counts when the compiler knows it: string literals, `const` fields, constant concatenation, verbatim and raw strings. SQL built at runtime, interpolation with non-constant holes, parameters and `static readonly` fields are non-constant and produce no edges. Nothing is guessed.
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
- **Scope.** Call sites inside method and constructor bodies, the same scope as the other C# edges. For a `CommandDefinition`, the edge belongs to the method that constructs it.
- **Counts.** `DEBUG=ctxo:roslyn ctxo index` logs `Roslyn SQL call sites: N constant, M non-constant, K unparsable`.
- **Needs.** The .NET SDK 8+ (Roslyn tier) and `@ctxo/lang-sql`. The tree-sitter fallback gives no SQL edges.

## C# attribute annotations

`@ctxo/lang-csharp` reports the attributes written on each symbol as annotations, in both tiers:

- `name` is the attribute name as written, without namespace and without the `Attribute` suffix (`Fact`, `Trait`, `HttpGet`).
- Values in the Roslyn tier: strings and characters as their value, numbers in invariant culture, `true` and `false`, enum constants as `Type.Member`, `typeof(T)` as the type's display string, array arguments flattened, nulls skipped.
- In the Roslyn tier, `named.type` carries the attribute class's fully qualified name when it resolves. A source argument named `type` is dropped in both tiers, so it never takes that key.

Tier differences:

- Tree-sitter keeps literal arguments only (strings, numbers, booleans). Enum constants, `typeof(T)`, array arguments and other expressions are dropped there.
- In the Roslyn semantic path, an argument written with a parameter name (`name: "x"`) arrives in `args`, while the tree-sitter tier puts it in `named`. Consumers should not depend on which of the two holds such an argument.
- Roslyn formats real-number exponents its own way.

The first `ctxo index` after upgrading rewrites the committed index JSON of C# files once, because annotations are always on. Run that first index as a full `ctxo index`, not an incremental one: see the upgrade note under [test files](#test-files-recognised-by-annotations).

## Test files recognised by annotations

The contexts view leaves test files out. A file is a test file when a test glob matches it (the shared defaults plus `index.tests`) or when any symbol in it carries a test-framework annotation. The names match exactly:

`Fact`, `Theory`, `SkippableFact`, `SkippableTheory`, `Test`, `TestCase`, `TestCaseSource`, `TestFixture`, `TestMethod`, `DataTestMethod`, `TestClass`

- An annotated file is a test file whatever its path.
- Once any C# file in the index carries annotations (the evidence that the annotating plugin ran), a file matched only by the name globs `**/*Test.cs` or `**/*Tests.cs` and without a test annotation becomes a production node. This removes the false positives of name-only matching, such as a production `LoanPolicyTests.cs` helper.
- Folder globs (`**/tests/**`, `**/*.Tests/**`, `**/*.Test/**` and the rest of the defaults) still decide on their own.
- A repository whose C# files have no annotations in the index keeps the plain glob behaviour.

Limitations, all fixed with an `index.tests` glob:

- Test classes that use only other attributes, for example FsCheck `[Property]`.
- Custom attributes derived from `Fact` or `Theory` (a project's own `[LoanFact]`, say). Names match exactly and attribute base types are not resolved, so a `*Tests.cs` file outside the test folders that uses only such attributes becomes a production node.
- An unannotated `*Tests.cs` file in a bare capital `Tests/` or `Test/` folder: `**/tests/**` is case-sensitive, so that folder is not a default test glob.

**Upgrade note: run a full `ctxo index` after upgrading `@ctxo/lang-csharp`.** An incremental run (`--files`, `--commit`, and so the post-commit hook) re-indexes only the changed files, so only those carry annotations at first. The contexts view already counts the index as annotated, and every `*Test.cs` or `*Tests.cs` file outside the test folders that has not been re-indexed yet becomes a production node until a full run.

```yaml
index:
  tests:
    - "**/Tests/**"
    - "src/Lending.Properties/**"
```

A JUnit `@Test` gives the Java annotation `Test`, one of the names above, so since the Java plugin reports annotations, a Java file with a `@Test` method counts as a test file wherever it sits (through the same annotation rule, `filesWithTestAnnotations`), not only under `src/test/`.

## Language parity: TypeScript, Java and Go

`@ctxo/lang-typescript`, `@ctxo/lang-java` (with `@ctxo/lang-java-analyzer`) and `@ctxo/lang-go` now do what `@ctxo/lang-csharp` does: they report annotations, index tests as symbols with edges, and, with `@ctxo/lang-sql` installed, add data edges for constant SQL at known call sites. A TypeScript repository, a Spring service and a Go module that touch `dbo.loans` meet the C# code and the `.sql` definitions at the same node. The design record is the [ADR-017 addendum](../architecture/ADR/adr-017-plugin-protocol-v2-and-data-coupling.md#addendum-language-parity-pr-1c).

### No SQL edges without `@ctxo/lang-sql`

SQL call sites are read only when the host sets `capabilities.sqlCallSites`, which it does only when a plugin for `.sql` files (today `@ctxo/lang-sql`) is installed. Without it, no language emits `reads`, `writes` or `executes` edges, so a repository never gets edges to tables that cannot exist in its graph. Annotations and test symbols need no capability: they are always on.

### SQL at call sites

Every language uses the same rules as C#: only compile-time constant SQL counts, ORM and query-builder calls are left out (knex chains, Prisma model calls, TypeORM repositories, JPQL and Spring Data derived queries, gorm model calls), and the text goes through `extractSqlAccesses` of `@ctxo/sql-extract`, so the targets are the canonical 2-part names (`dbo.loans::table`, `dbo.usp_closeloan::procedure`). Each plugin keeps its rows of the shared API table as data:

| Language | APIs | SQL text | Procedure name when |
|---|---|---|---|
| TypeScript / JavaScript | pg `query` (also a `{ text }` config object); mysql2 `query`, `execute` (also `{ sql }`); mssql `query` (call or tagged template), `execute`; `knex.raw`; Prisma `$queryRaw`, `$executeRaw` (tagged template) and `$queryRawUnsafe`, `$executeRawUnsafe`; TypeORM `query`; Sequelize `query`; better-sqlite3 `prepare`, `exec` | the first argument, or the tagged template | mssql `execute` (its argument is a procedure name) |
| Java | JDBC `Connection.prepareStatement`, `prepareCall` and `Statement.execute*`; Spring `JdbcTemplate`, `NamedParameterJdbcTemplate` and their `*Operations` interfaces (`query*`, `update`, `batchUpdate`, `execute`); `EntityManager.createNativeQuery` (`javax` and `jakarta`); Spring Data `@Query(value = ..., nativeQuery = true)`; MyBatis `@Select`, `@Insert`, `@Update`, `@Delete` | the first `String` argument (every argument of an all-`String` `batchUpdate`); the annotation's `value`, array elements joined with a space | the text is a JDBC escape, `{call name(...)}` or `{? = call name(...)}` |
| Go | `database/sql` `Query`, `QueryRow`, `Exec`, `Prepare` and their `Context` forms on `DB`, `Tx`, `Conn`, `Stmt`; sqlx `Select`, `Get`, `Queryx`, `NamedExec`, `MustExec` (methods and package functions); pgx v4 and v5 `Query`, `QueryRow`, `Exec`, including `pgxpool`; gorm `Raw`, `Exec` | the argument bound to the callee's first `string` parameter | never (an `EXEC` inside a statement still gives an `executes` edge) |

What counts as a constant:

- **TypeScript:** string literals, templates without substitutions, `+` and templates whose parts are all constant, and `const` bindings with such an initializer, in the same file or behind a relative import. A constant used twice in one expression stays constant. In a tagged template (mssql, Prisma), each interpolation becomes a placeholder `@p0`, `@p1` and so on, so `` prisma.$queryRaw`SELECT id FROM dbo.Loans WHERE member_id = ${memberId}` `` reads `dbo.loans`.
- **Java:** JDT constant evaluation: literals, `static final` constants, constant concatenation and text blocks.
- **Go:** a value that `go/types` gives a constant string: literals, `const` declarations and constant concatenation.

How the receiver is matched:

- **TypeScript: receiver provenance.** The in-memory ts-morph project has no library types (`node_modules` is not loaded), so a call `<receiver>.<member>` counts only when a walk ties the receiver to a module in the table: imports (named, default, namespace, `import x = require`), `require('pg')`, type annotations and initializers, destructuring, constructor parameter properties and `this` members (also through the enclosing class's `extends` clause), function return types, `import('pg').Pool`, `export *` barrels and dynamic `import()`. The walk takes at most 8 steps (each declaration hop or barrel module is one) and never revisits a declaration. Relative modules missing from the in-memory project are read from disk for that one file's extraction (`.ts`, `.tsx`, `.js` and `.jsx` only, never outside the project root), so the post-commit hook, `--files` and `ctxo watch` give the same SQL edges as a full `ctxo index`. Edges start at the innermost exported function, method of an exported class, exported variable or test block; calls elsewhere are skipped.
- **Java: receiver type, supertypes and imports.** The JDT analyzer matches the receiver's static type, the method binding's declaring class or any of their supertypes. When the dependency JARs are not on the classpath, it reads the declared type of the field, local variable or parameter in the same file and resolves it through the single-type imports or the package. With a method binding, a member whose first parameter is not `java.lang.String` is no call site; without one, the first argument decides when it is a `String` constant or `String`-typed. Edges start at the enclosing method or constructor; a lambda belongs to its method.
- **Go: the callee's method object.** ctxo-go-analyzer resolves the callee through `go/types`; its receiver type (pointer stripped) names the owner. The `*sql.DB` methods promoted onto `sqlx.DB` and the pgx v5 `Tx` interface match too. A matching callee without a `string` parameter (a `*sql.Stmt` method, whose text was read at `Prepare`) is not counted. A closure belongs to its enclosing function declaration.

**Full tier only for Java and Go.** The SQL text comes from the JDT analyzer (JRE 11+ and `@ctxo/lang-java-analyzer`) and from ctxo-go-analyzer (Go 1.22+); the tree-sitter tiers give no SQL edges. TypeScript has one tier, so its call sites are always read.

**Counts.** Non-constant SQL is counted, never guessed. The counts reach debug logging only (`DEBUG=ctxo:*`), never the index: TypeScript counts every matched call site whose text is not constant; the JDT analyzer counts a matched call whose first argument is not a constant (with a method binding when the first parameter is a `String`, without one when the argument is `String`-typed); ctxo-go-analyzer counts every matched call whose `string` argument is not a constant. Each analyzer's summary line carries them as `sql: { constant, nonConstant }`.

**Make SQL visible** by keeping it in a constant:

```ts
const CLOSE_LOAN = 'UPDATE dbo.Loans SET closed_at = now() WHERE id = $1';   // visible: writes dbo.loans
export async function closeLoan(pool: Pool, id: string) {
  await pool.query(CLOSE_LOAN, [id]);
}
```

### Annotations per language

All three follow the C# caps: 20 annotations per symbol, 10 positional arguments, 10 named entries and 200 characters per value; `args` and `named` are omitted when empty. `named.type` stays reserved in every language and none of these plugins sets it, so a decorator property, Java annotation member or struct-tag key named `type` is dropped (a TypeORM `@Column({ type: 'int' })` loses its `type`). `named.member` is reserved only where the plugin emits it, for metadata of a member that is not a symbol of its own:

| Language | Source | Annotation |
|---|---|---|
| TypeScript | decorators on classes and methods | `name` is the rightmost identifier (`@nest.Injectable()` gives `Injectable`); `args` are string-literal and plain-template arguments; `named` holds the string properties of object-literal arguments, the first occurrence winning. Accessor and parameter decorators are ignored |
| TypeScript | property decorators | on the class, after the class's own decorators, with `named.member`: `@Column({ name: 'member_id' }) memberId` gives `{ name: 'Column', named: { member: 'memberId', name: 'member_id' } }` |
| Java (JDT) | annotations on types, methods and fields | the simple name; the `value` member goes to `args`, other members to `named`; declared values only (no defaults): strings, numbers, `true`/`false`, enum constants as `Type.MEMBER`, class literals as the qualified name; arrays flattened in `args` and joined with `,` in `named`; nested annotations and nulls skipped |
| Java (tree-sitter) | the same | string literals and string arrays only |
| Go | struct field tags, in both tiers | one `tag` annotation per tagged field on its struct: `` LoanID string `json:"loan_id" gorm:"column:loan_id;primaryKey"` `` gives `{ name: 'tag', named: { member: 'LoanID', json: 'loan_id', gorm: 'column:loan_id;primaryKey' } }`; an embedded field is named by its type's last identifier; untagged fields give nothing |

Java fields are symbols of their own, so their annotations stay on them, and Java (like C#) keeps a source member named `member`. TypeScript class properties and Go struct fields do not become symbols.

### Test symbols per language

| Language | What becomes a symbol |
|---|---|
| TypeScript / JavaScript | In a test file (`**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`), every `describe`, `it` or `test` block (also `suite`, `context`, `specify`, the `f` and `x` variants and modifiers such as `.only`, `.skip`, `.each`, `.skipIf`) becomes a `function` symbol named by its title path and annotated `{ name: 'test' }`. A block's `calls` and `uses` edges come from its own callback minus nested blocks, so each `it` owns its edges and a `describe` keeps its hooks. A block without a callback (`it.todo`) is not a symbol |
| Go | The full tier loads test packages too: functions and methods in `_test.go` files become symbols with `calls` edges (a test fake can `implements` a production interface). Reachability still runs on production packages only, so the analyzer's dead list never holds a test symbol |
| Java | Test methods under `src/test/java` were method symbols already; they now carry their annotations, and a `@Test` marks the file as a test file |

TypeScript test titles: a non-literal title keeps its source text; whitespace runs become one space, runs of `:` become one and a trailing `:` is dropped; an empty title becomes `(untitled)`; titles are cut at 200 characters. A path seen again in the file (or equal to an exported function's name) gets ` #2`, ` #3` in source order, and children use their parent's final name:

```text
src/loans/loan-policy.test.ts::LoanPolicy > renewal > extends by seven days::function
src/loans/loan-policy.test.ts::LoanPolicy > renewal > extends by seven days #2::function
```

`index.tests` extras do not reach plugins, so TypeScript test blocks come only from the default globs above.

### What changes elsewhere

- **Blast radius and the gate.** Test blocks and Go test functions have edges into production code and count as its dependents, so the safe-edit gate may fire more often on well-tested symbols, as it does for C#.
- **Dead code.** `find_dead_code` recognises test files with the shared test-file classifier (the default test globs plus files a test-framework annotation marks) instead of its own path patterns, which missed `_test.go`, `src/test/java`, `*.test.js` and `*.test.tsx` files. Unless `includeTests` is set, test symbols are never reported dead, even without outgoing edges, and production code called only from tests is not dead. In particular, Go functions whose only callers are tests are no longer reported. Production code under a folder named `test/` or `src/test/`, and any file with a test-annotated symbol, is left out of the analysis as well.
- **Communities.** Test symbols and their edges join the graph, so symbol-level communities shift once after the upgrade. Data edges stay out of communities.
- **Java edges stay type-level.** JDT `calls` and `uses` edges still start at the enclosing type, so a Java test method's own dependencies show at its class; data edges start at the method or constructor.
- **Go full-tier cost.** Go full-tier runs load and type-check the test packages as well, so they take longer on modules with many tests.

### Limitations

- **TypeScript.** A receiver the provenance walk cannot tie to a listed module is missed, not guessed: a client passed through an untyped factory or a dependency-injection container, more than 8 steps away, a union-typed receiver (`Pool | null`), a getter or method that returns a pool, a namespace import of a relative module. Numeric constants in a template are not constant.
- **Java.** The tree-sitter tier keeps string values only (non-string values such as `nullable = false` appear only in the full tier), does not evaluate string constants or concatenation (escapes in literals are decoded). MyBatis `<script>` and `${}` texts pass through as written. Without a method binding (dependency JARs missing), subclass receivers (`LoanJdbc extends JdbcTemplate`) and `super.update(...)` are missed, and array literals in `batchUpdate` are not expanded. In the syntax fallback, numbers keep their raw token (`10L`, `0x10`) when JDT cannot evaluate them.
- **Go.** The tree-sitter tier decodes interpreted (double-quoted) tag literals with JSON rules, not Go unquote rules, so `\x41`, octal and `\a` escapes can differ from the full tier (raw-string tags, the usual form, agree); it reads exported structs only. Build-tagged test files (for example `//go:build integration`) are not loaded and fall back to the syntax tier. User-defined interfaces (sqlc's `DBTX`), method values and method expressions give no call sites, and the sqlx `...Context` forms are not in the table.

### Host-language corpus cases

`packages/sql-extract/corpus` holds cases written in each host language next to the SQL ones: `<case>.<ts|java|go>.fixture` with a `<case>.expected.json` whose `mode` (`typescript`, `java` or `go`) matches the extension and whose `accesses` hold the union of the case's data edges by kind. They default to `sides: []`, so the sql-extract, lang-sql and ScriptDom tests skip them; only the matching plugin runs them (Java and Go against the stub library types of the lending samples), and the sql-extract corpus test checks the pairing and modes.

**Adding one.** Write `<case>.ts.fixture` (or `.java.fixture`, `.go.fixture`) with synthetic library-lending names, write `<case>.expected.json` with `"mode": "typescript"` (or `java`, `go`) and the expected `reads`, `writes` and `executes`, each sorted, then run `pnpm --filter @ctxo/sql-extract test` and the plugin's suite: `pnpm --filter @ctxo/lang-typescript test`, `pnpm --filter @ctxo/lang-java test` with `CTXO_JDT_ANALYZER_JAR` pointing at a built analyzer JAR, or `pnpm --filter @ctxo/lang-go test` with Go on `PATH`. A Java or Go case that needs a library type the stubs do not have adds it to the stubs.

## Data coupling in the contexts view

`ctxo index` adds data coupling to `.ctxo/index/contexts-view.json` (see "Candidate contexts" in [architectural intelligence](architectural-intelligence.md) for the view itself):

| Field | Meaning |
|---|---|
| `dataResources[]` | Every table or view that a candidate file (members and assigned hubs) reads or writes, by name: `name`, `kind` (absent when external), `external`, `accesses` (per candidate, `modes` of `reads` and `writes`), `writers`, `owner` |
| `dataResources[].external` | No indexed `.sql` file defines it |
| `dataResources[].owner` | The only candidate that writes it; several writers leave it absent with more than one entry in `writers` |
| `candidates[].sharedTables[]` | The resources of this candidate that at least one other candidate also reads or writes, by name, with every candidate's access modes |

How access is counted:

- A `reads` or `writes` edge from a symbol in a candidate file records that candidate and mode. Edges from procedure bodies are the exception: they count through `executes`, below.
- **Procedure bodies count for the candidates that execute them.** An `executes` edge from a candidate's symbol to an indexed procedure adds that procedure's reads and writes to the candidate, following further `executes` edges transitively. An unresolved procedure adds nothing.
- **The production copies count.** When several files define the procedure ([several definitions](#several-definitions-of-one-object)), the executing candidate takes on the union of the bodies of every production copy, meaning every copy outside test files and outside `docs`, `doc` or `documentation` folders, not only the winner's. When no copy is production, it takes the winner's body alone. Docs and test copies of a procedure that has a production copy add nothing: their reads, writes and `executes` edges count for no candidate.
- **Executed means executed by name.** When any candidate executes `dbo.usp_closeloan`, directly or through another procedure, no copy of that procedure credits its own candidate, whichever copy won resolution.
- **A procedure nobody executes credits its own candidate.** When no candidate executes it, directly or through other procedures, the candidate whose file holds it takes on its reads and writes, as if it executed it. With several copies, that is the candidate of each production copy (or of the winner when no copy is production), and each takes on the bodies of all those copies. Procedures that only execute each other, with nothing outside the cycle executing them, each credit their own candidate.
- Reading a view does not expand to its tables.
- Unclustered files and test files are ignored; hubs count for their assigned candidate.

Without the `executes` rule, the candidate that holds a procedure script becomes a reader and writer of every table its procedures touch. On one production fixture that candidate accounted for 7 of the 12 tables with several writers. The rule reduces the artifact but may not remove it: test files and unclustered files are not candidates, so a procedure that only test or unclustered code executes still credits the candidate that holds its script, and so does each other production copy of it that sits in a candidate file. A docs or test copy credits its candidate only when no production copy exists and it is the winner.

**Clustering weight.** `contextsView.weights.data` (default `0`) adds a third component to a file-pair weight: the data edges between two files (an accessor and the `.sql` file that defines the object), log-normalised like the dependency component. At the default, data access never pulls candidates together. Shared tables are a boundary finding to show, not a reason to merge candidates. Data edges never count as hub dependents and never appear in `crossEdges`.

**Coverage on SQL-heavy repositories.** At the default `weights.data` of 0, a `.sql` file joins the file graph's clusters only through co-change: its data edges carry no weight and SQL has no import or call edges. Scripts that never change together with other files stay unclustered and lower `coverage`. On one production fixture, 48 such scripts took coverage from 0.99 to 0.91 while the candidates themselves stayed the same. If the number matters, leave those scripts out of the view with `contextsView.exclude`. Whether to change the default is open (see the [roadmap](../roadmap.md)).

**Terms and collisions.** Table and view names and table columns join the top-term harvest of the candidate whose `.sql` file they are in. A table takes part in collisions with its columns as members; names and members compare with ASCII case and `_` ignored, so `LoanItems` meets `loan_items`. Views appear in terms but not in collisions. A C# class and a SQL table with the same name (an entity `LoanItems` next to the table `dbo.loan_items`) can therefore appear as a collision when the class's members differ from the columns. That is often an entity mapped to its table rather than two meanings of one term, so treat such entries as possible noise (3 of the 8 collisions on one fixture were of this kind).

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
| JRE 11+ or `@ctxo/lang-java-analyzer` | The Java plugin runs its tree-sitter tier: annotations with string values only, no SQL call-site edges |
| Go 1.22+ (or no `go.mod` / `go.work`) | The Go plugin runs its tree-sitter tier: struct-tag annotations on exported structs and no SQL call-site edges |
| .NET SDK 8+ | No Roslyn annotations and no SQL call-site edges; the tree-sitter tier still emits attribute annotations, with literal arguments only. `ctxo doctor` (`csharp_tier`) passes at the syntax tier with a hint |
| The Roslyn helper cannot restore or build (for example a private or offline NuGet feed without ScriptDom) | The C# plugin falls back to tree-sitter: symbols and literal-only annotations are kept; Roslyn-tier details (resolved `named.type`, non-literal argument values) and SQL call-site edges are lost. `ctxo index` reports `C#: N files (syntax tier - the Roslyn helper failed, run "ctxo doctor")` and `ctxo doctor` warns (`csharp_tier`) |
| The Roslyn keep-alive of `ctxo watch` is gone (idle shutdown or crash) | The next re-index restarts it once. If the restart fails, the C# plugin falls back to tree-sitter, so watch never writes a C# file with zero symbols because the keep-alive stopped |
| `@ctxo/lang-sql` not installed | No SQL call-site edges in any language; no `table`, `view` or `procedure` symbols |
| No annotations in the index | Test files are recognised by globs alone, as before |
| An older CLI | Skips `@ctxo/lang-sql` with a warning and drops the new kinds from a newer index with a warning |

## Upgrade notes

- **One-time C# index change.** The first re-index rewrites the committed JSON of C# files (annotations). Make it a full `ctxo index` after upgrading `@ctxo/lang-csharp`: an incremental run gives annotations to the changed files only, and until a full run the contexts view treats unannotated name-only `*Test.cs` / `*Tests.cs` matches as production files.
- **Test folders named `Tests/`.** A bare capital `Tests/` or `Test/` folder is not a default test glob (`**/tests/**` is case-sensitive). If your test files live in one, add it to `index.tests`.
- **UTF-16 sources.** `ctxo index`, `--check` and `ctxo watch` now decode UTF-16 LE and BE files that start with a byte order mark. Their content hash changes once, so the first `ctxo index --check` after upgrading reports them stale until the next `ctxo index`. UTF-8 decoding is unchanged.
- **ScriptDom restore.** The Roslyn helper now restores `Microsoft.SqlServer.TransactSql.ScriptDom` from NuGet for every C# user, with or without `@ctxo/lang-sql`. If your feed cannot serve it, the plugin falls back to tree-sitter (see above); make the package reachable from your NuGet sources to keep the Roslyn tier.
- **.NET roll forward.** The helper targets `net8.0` with `RollForward` `Major`: the .NET host keeps using an installed 8.x runtime and rolls forward to a newer major runtime when no 8.x is installed. The built helper has been run with `dotnet exec --fx-version` on .NET 8, 9 and 10, and an integration test checks the `rollForward` setting and runs the helper on the newest installed runtime.
- **Lone `.csproj`.** A C# repository with one `.csproj` and no solution file now indexes in the Roslyn tier.
- **One-time TypeScript, Java and Go index change.** The first re-index after upgrading `@ctxo/lang-typescript`, `@ctxo/lang-java` or `@ctxo/lang-go` rewrites the committed JSON of their files: annotations and test symbols are always on, and SQL edges appear when `@ctxo/lang-sql` is installed. Make it a full `ctxo index`, so every file and every test symbol changes in one commit. Expect the safe-edit gate to fire somewhat more often on well-tested symbols, and symbol-level communities to shift once.

## The conformance corpus

`packages/sql-extract/corpus/` keeps the TypeScript and C# SQL parsers in agreement. It also holds host-language cases for TypeScript, Java and Go call sites (see [host-language corpus cases](#host-language-corpus-cases)). Each case is a `<case>.sql` file (UTF-8, LF, pinned by `.gitattributes`) with a `<case>.expected.json`:

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
- [SQL language page](../../site/docs/languages/sql.md) and the [C#](../../site/docs/languages/csharp.md), [TypeScript](../../site/docs/languages/typescript.md), [Java](../../site/docs/languages/java.md) and [Go](../../site/docs/languages/go.md) language pages
- [Writing a plugin](../../site/docs/languages/writing-a-plugin.md): the v2 surface for plugin authors
- [roadmap.md](../roadmap.md): deferred items (NoSQL, messaging, dialects, ORMs)
