# @ctxo/sql-extract

Zero-dependency T-SQL tokenizer and data-access recognizers shared by Ctxo language plugins.

This is a library, not a plugin. It has no runtime dependencies. `@ctxo/lang-sql` builds on it, and so do the other language hosts that recognize embedded SQL.

It exposes two functions (added alongside the recognizers): one that extracts the table and procedure accesses from a SQL text, and one that extracts the definitions (tables, views, procedures, functions) a SQL file declares. Names are canonicalized as `schema.name`, with the `dbo` default and a fold of ASCII A-Z only.
