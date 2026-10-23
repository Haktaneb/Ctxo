# @ctxo/lang-typescript

## 0.9.0

### Minor Changes

- 663cfae: Language parity for TypeScript, Java and Go (#156 Phase 1): the three plugins now report TypeScript decorators, Java annotations (JDT and tree-sitter tiers) and Go struct tags as symbol annotations, index TypeScript test blocks and Go `_test.go` files as symbols with edges, and, when `@ctxo/lang-sql` is installed, add `reads`, `writes` and `executes` edges for constant SQL at known call sites (pg, mysql2, mssql, knex, Prisma, TypeORM, Sequelize and better-sqlite3 raw SQL; JDBC, Spring `JdbcTemplate`, JPA native queries and MyBatis; `database/sql`, sqlx, pgx and gorm raw SQL). They parse that SQL with `@ctxo/sql-extract`, the zero-dependency library that the ADR-017 dependency exception allows, and stay on protocol `'1'`, so older CLIs keep loading them, ignore the annotations and never request SQL edges. The first re-index after upgrading changes the committed index JSON of TypeScript, Java and Go files, tests now count as blast-radius dependents (so the safe-edit gate may fire more often on well-tested symbols), and the `ctxo install sql` help line names the new host languages.

  The Java analyzer (`@ctxo/lang-java-analyzer`) now reads sources as UTF-8 and escapes non-ASCII output, so Windows users get intact non-ASCII names. The Go full tier no longer stores an empty result when the analyzer run fails, crashes or times out: those files fall back to the tree-sitter syntax tier with a warning. `ctxo visualize` escapes symbol names in the page it embeds, which matters now that test titles are symbol names.

## 0.8.1

### Patch Changes

- cacea40: Plugin protocol v2 and data coupling (#156 Phase 1): `@ctxo/plugin-api` adds the data kinds (`table`, `view`, `procedure` with `reads`, `writes` and `executes` edges), typed symbol annotations, an opt-in facts channel and host capabilities, and the new `@ctxo/lang-sql` plugin (built on the zero-dependency `@ctxo/sql-extract` library, installed with `ctxo install sql`) indexes T-SQL definitions and the tables their bodies read and write. `@ctxo/lang-csharp` reports attribute annotations, adds SQL edges at known ADO.NET, Dapper, `SqlBulkCopy` and EF Core call sites when `@ctxo/lang-sql` is installed, and falls back to tree-sitter when its Roslyn helper cannot restore or build. The CLI puts data edges in the confirmed blast-radius tier, reports shared tables, ownership and external resources in the contexts view, recognises test files by test-framework annotations and adds the `csharp_tier` doctor check, and the other official plugins widen their `@ctxo/plugin-api` peer range.

## 0.8.0

### Minor Changes

- 5e7d482: Minor release: bump all packages to a new minor version line.

## 0.7.2

### Patch Changes

- 8db20d8: Patch release: dependency maintenance (zod 4.6.7) and CI action updates (setup-node 7.1.0, upload-artifact 7.0.2, test-reporter 3.2.0).
- Updated dependencies [8db20d8]
  - @ctxo/plugin-api@0.7.3

## 0.7.1

### Patch Changes

- 5b1ea92: Release pipeline hardening:

  - Release workflow now runs `pnpm -r typecheck` and `pnpm -r test` before publishing, so broken builds cannot ship to npm.
  - Verifies `NPM_TOKEN` secret is present before doing any work (fast fail with actionable message).
  - After publish, automatically fixes npm dist-tags so prerelease versions (`-alpha`, `-beta`, `-rc`, `-next`) move to the matching channel tag and `latest` stays pinned to the highest stable version.
  - All public packages now declare `publishConfig.access: public` and `publishConfig.provenance: true` so per-package npm publishes (manual or automated) keep provenance and visibility consistent.
  - New `dist-tag-repair` workflow available from the Actions tab to manually re-align dist-tags for any package, with a `dry_run` switch.

- Updated dependencies [5b1ea92]
  - @ctxo/plugin-api@0.7.1
