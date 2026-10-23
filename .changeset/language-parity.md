---
"@ctxo/lang-typescript": minor
"@ctxo/lang-java": minor
"@ctxo/lang-java-analyzer": minor
"@ctxo/lang-go": minor
"@ctxo/cli": patch
---

Language parity for TypeScript, Java and Go (#156 Phase 1): the three plugins now report TypeScript decorators, Java annotations (JDT and tree-sitter tiers) and Go struct tags as symbol annotations, index TypeScript test blocks and Go `_test.go` files as symbols with edges, and, when `@ctxo/lang-sql` is installed, add `reads`, `writes` and `executes` edges for constant SQL at known call sites (pg, mysql2, mssql, knex, Prisma, TypeORM, Sequelize and better-sqlite3 raw SQL; JDBC, Spring `JdbcTemplate`, JPA native queries and MyBatis; `database/sql`, sqlx, pgx and gorm raw SQL). They parse that SQL with `@ctxo/sql-extract`, the zero-dependency library that the ADR-017 dependency exception allows, and stay on protocol `'1'`, so older CLIs keep loading them, ignore the annotations and never request SQL edges. The first re-index after upgrading changes the committed index JSON of TypeScript, Java and Go files, tests now count as blast-radius dependents (so the safe-edit gate may fire more often on well-tested symbols), and the `ctxo install sql` help line names the new host languages.

The Java analyzer (`@ctxo/lang-java-analyzer`) now reads sources as UTF-8 and escapes non-ASCII output, so Windows users get intact non-ASCII names. The Go full tier no longer stores an empty result when the analyzer run fails, crashes or times out: those files fall back to the tree-sitter syntax tier with a warning. `ctxo visualize` escapes symbol names in the page it embeds, which matters now that test titles are symbol names.
