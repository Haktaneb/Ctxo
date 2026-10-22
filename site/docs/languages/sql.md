---
title: "SQL"
description: "@ctxo/lang-sql: T-SQL definitions and the data they read, write and execute."
---

# SQL

Plugin: **`@ctxo/lang-sql`** ([npm](https://www.npmjs.com/package/@ctxo/lang-sql))
Parser: **`@ctxo/sql-extract`** (zero-dependency T-SQL tokenizer and recognizers)
Tier: **`syntax`**
Extensions: `.sql`
Protocol: **v2** (`apiVersion: '2'`)

## What this plugin does

Two services can look independent in the dependency graph while both write the
same table. This plugin makes that coupling visible. It reads `.sql` scripts
(T-SQL), turns the tables, views, procedures and functions they define into
symbols, and links each view, procedure and function to the tables and
procedures its body touches with `reads`, `writes` and `executes` edges.

No database connection, no build step and no .NET: the recognizers are plain
TypeScript in `@ctxo/sql-extract`, so a SQL-only repository needs only Node.js.

## Install

```bash
ctxo install sql        # alias: ctxo install tsql
```

Or add the package yourself:

::: code-group
```bash [pnpm]
pnpm add -D @ctxo/lang-sql
```
```bash [npm]
npm install --save-dev @ctxo/lang-sql
```
```bash [yarn]
yarn add -D @ctxo/lang-sql
```
:::

`ctxo init`, `ctxo doctor` (language coverage) and `ctxo index --install-missing`
suggest the plugin when the repository has `.sql` files. It is a protocol v2
plugin: an older CLI skips it with a warning, so upgrade `@ctxo/cli` together
with it.

## What it extracts

### Symbols

| Kind | Source |
| --- | --- |
| `table` | `CREATE [OR ALTER] TABLE`, with a `columns` annotation (every column, lowercase, sorted) |
| `view` | `CREATE [OR ALTER] VIEW`, `ALTER VIEW` |
| `procedure` | `CREATE [OR ALTER] PROC[EDURE]`, `ALTER PROC[EDURE]` |
| `function` | `CREATE [OR ALTER] FUNCTION`, `ALTER FUNCTION` |

The symbol ID carries the canonical two-part name, so a table defined in
`db/lending.sql` is `db/lending.sql::dbo.loans::table`. The symbol `name` keeps
the declared spelling, without delimiters and without an added schema.

### Edges

| Kind | From a view, procedure or function body |
| --- | --- |
| `reads` | tables after `FROM`, `JOIN`, `APPLY`, in a `FROM` comma list and after `MERGE ... USING` |
| `writes` | targets of `INSERT [INTO]`, `UPDATE`, `DELETE [FROM]`, `MERGE [INTO]`, `TRUNCATE TABLE`, `SELECT ... INTO` and `OUTPUT ... INTO` |
| `executes` | `EXEC` / `EXECUTE` of a procedure name |

Edge targets are 2-part references such as `dbo.loans::table` and
`dbo.usp_notifymember::procedure`. Ctxo resolves a table reference to the
defining `table` or `view`, whichever defines the name, and when several files
define the same object, the first file in sorted path order wins.

```sql
-- db/lending.sql
CREATE TABLE dbo.Loans (Id INT PRIMARY KEY, MemberId INT, ClosedAt DATETIME2 NULL);
GO
CREATE PROCEDURE dbo.usp_CloseLoan @id INT AS
BEGIN
  UPDATE dbo.Loans SET ClosedAt = SYSUTCDATETIME() WHERE Id = @id;   -- writes dbo.loans
  INSERT INTO dbo.LoanEvents (LoanId, Kind) VALUES (@id, 'closed');   -- writes dbo.loanevents
  EXEC dbo.usp_NotifyMember @id;                                      -- executes dbo.usp_notifymember
END
```

## Rules

- **Names.** One to four dot-separated parts. `[...]` (with `]]`) and `"..."`
  delimiters are removed. A one-part name gets schema `dbo`. Three- and
  four-part names, temp tables (`#loans`), table variables (`@loans`), CTE
  names, aliases and the `sys` and `information_schema` schemas are skipped.
- **Case.** Only ASCII `A` to `Z` is folded to lowercase. `Ö`, `ı`, `İ` and every
  other character are kept, so `[dbo].[Ödünç Kaydı]` matches byte for byte on
  every side.
- **Bodies.** A view, procedure or function body ends at the end of its `GO`
  batch, or at the next view, procedure or function definition when `GO` is
  missing. `CREATE TABLE` or `ALTER TABLE` inside a body is body text: it
  defines nothing and adds no columns, and its DML is an ordinary access of the
  body.
- **Columns.** The column-list elements of `CREATE TABLE` (not constraints,
  keys, checks or indexes), plus `ALTER TABLE ... ADD` outside a body for a table
  defined in the same file.
- **Merging.** Two definitions of one object in a file merge into the first.
- **Not code.** Comments (`--`, nested `/* */`), string literals and `GO` inside
  them never produce accesses. Table hints such as `WITH (NOLOCK)` are fine. A
  leading byte order mark is ignored, and UTF-16 scripts saved by SSMS (with a
  byte order mark) are decoded.
- **Not edges.** Calls to SQL functions, table-valued functions in `FROM`,
  dynamic SQL (`EXEC (@sql)`, `EXEC @proc`) and `EXECUTE AS`. A recursive
  procedure has no self edge. SQL objects carry no complexity metrics.

## C# interplay

When this plugin is installed, the CLI tells every plugin that `.sql` files
are indexed (`capabilities.sqlCallSites`). The [C# plugin](/languages/csharp#sql-at-call-sites)
then adds `reads`, `writes` and `executes` edges from C# methods to the same
`dbo.loans::table` targets, for constant SQL at known ADO.NET, Dapper,
`SqlBulkCopy` and EF Core call sites (Roslyn tier, .NET SDK 8+). A C# method and
the stored procedure that both touch `dbo.loans` then meet in the graph:

- [`get_blast_radius`](/mcp-tools/get-blast-radius) on a table lists its readers
  and writers as `confirmed` dependents, in SQL and in C#.
- [`find_importers`](/mcp-tools/find-importers) with `edgeKinds: ["writes"]`
  lists every writer of a table.
- The [contexts view](/cli/contexts) reports tables that two or more candidate
  contexts read or write.

Without this plugin the C# plugin emits no SQL edges. A table that C# code
references but no indexed `.sql` file defines stays an unresolved reference in
the graph and appears as an external resource in the contexts view.

## Effects on the other tools

- **Blast radius.** `reads`, `writes` and `executes` are `confirmed` tiers, so the
  safe-edit guard also guards heavily used tables and procedures.
- **Dead code.** Symbols in `.sql` files are never reported by
  [`find_dead_code`](/mcp-tools/find-dead-code): their consumers may live outside
  the index.
- **Communities.** Data edges stay out of symbol-level communities and boundary
  violations; the contexts view reports data coupling instead.
- **Search.** [`search_symbols`](/mcp-tools/search-symbols) and
  [`get_symbol_importance`](/mcp-tools/get-symbol-importance) accept `kind`
  `table`, `view` and `procedure`.

## Known limitations

- **T-SQL only**, with `dbo` as the default schema. Neither is configurable yet.
- **Top-level DML is skipped.** An `INSERT` or `SELECT` outside any definition
  (a migration or seed script) produces no edges. Co-change still links those
  scripts to the code that changes with them.
- **`ALTER TABLE ... ADD` columns count only in the defining file.**
- **CTE scope.** A CTE name is skipped from its `WITH` to the next top-level `;`
  or the end of the batch. A table that reuses a CTE name later in the same
  batch without a `;` in between is therefore skipped here, while ScriptDom (the
  C# side) reads it.
- **Constant SQL only.** Dynamic SQL is not followed.

The rules are pinned by a conformance corpus in
`packages/sql-extract/corpus` that `@ctxo/sql-extract`, this plugin and the C#
plugin's ScriptDom parser all run, so the TypeScript and C# sides agree. The
design record is
[ADR-017](https://github.com/alperhankendi/Ctxo/blob/master/docs/architecture/ADR/adr-017-plugin-protocol-v2-and-data-coupling.md).

## Related

- [C#](/languages/csharp): SQL at call sites
- [Edge kinds](/reference/edge-kinds) and [Symbol IDs](/reference/symbol-ids)
- [`ctxo contexts`](/cli/contexts): shared tables between candidate contexts
- [Writing a plugin](/languages/writing-a-plugin): the protocol v2 surface
