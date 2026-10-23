# @ctxo/sql-extract

Zero-dependency T-SQL tokenizer and data-access recognizers shared by [Ctxo](https://github.com/alperhankendi/Ctxo) language plugins.

This is a library, not a plugin. It has no runtime dependencies and is never discovered by the Ctxo CLI. [`@ctxo/lang-sql`](https://github.com/alperhankendi/Ctxo/tree/master/packages/lang-sql) builds on it, and so do the TypeScript, Java and Go plugins, which parse the constant SQL they find at known call sites with it. It is the one package a Ctxo language plugin may depend on besides `@ctxo/plugin-api` ([ADR-017](https://github.com/alperhankendi/Ctxo/blob/master/docs/architecture/ADR/adr-017-plugin-protocol-v2-and-data-coupling.md)).

It exposes two functions:

- `extractSqlAccesses(text, kind?)`: the `reads`, `writes` and `executes` accesses of a SQL text (`kind` `statement`, the default, or `procedureName`), as canonical names.
- `extractSqlDefinitions(source)`: the tables, views, procedures and functions a SQL file defines, with table columns and the accesses of each body.

Names are canonicalized as `schema.name`: delimiters removed, ASCII A-Z folded to lowercase (every other character kept), default schema `dbo` (`DEFAULT_SQL_SCHEMA`). The dialect is T-SQL (`SQL_DIALECT`). The [conformance corpus](https://github.com/alperhankendi/Ctxo/tree/master/packages/sql-extract/corpus) pins the rules, and the C# plugin's ScriptDom parser runs the same cases. Corpus cases written in TypeScript, Java and Go (`<case>.<ts|java|go>.fixture`) are run by the matching plugin.
