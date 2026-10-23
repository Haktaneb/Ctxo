# @ctxo/lang-java

## 0.10.1

### Patch Changes

- cacea40: Plugin protocol v2 and data coupling (#156 Phase 1): `@ctxo/plugin-api` adds the data kinds (`table`, `view`, `procedure` with `reads`, `writes` and `executes` edges), typed symbol annotations, an opt-in facts channel and host capabilities, and the new `@ctxo/lang-sql` plugin (built on the zero-dependency `@ctxo/sql-extract` library, installed with `ctxo install sql`) indexes T-SQL definitions and the tables their bodies read and write. `@ctxo/lang-csharp` reports attribute annotations, adds SQL edges at known ADO.NET, Dapper, `SqlBulkCopy` and EF Core call sites when `@ctxo/lang-sql` is installed, and falls back to tree-sitter when its Roslyn helper cannot restore or build. The CLI puts data edges in the confirmed blast-radius tier, reports shared tables, ownership and external resources in the contexts view, recognises test files by test-framework annotations and adds the `csharp_tier` doctor check, and the other official plugins widen their `@ctxo/plugin-api` peer range.

## 0.10.0

### Minor Changes

- 5e7d482: Minor release: bump all packages to a new minor version line.

## 0.9.1

### Patch Changes

- 8db20d8: Patch release: dependency maintenance (zod 4.6.7) and CI action updates (setup-node 7.1.0, upload-artifact 7.0.2, test-reporter 3.2.0).
- Updated dependencies [8db20d8]
  - @ctxo/plugin-api@0.7.3

## 0.9.0

### Minor Changes

- 3d9aa7d: Support Java 11+ full tier via dual-JAR strategy.

  The full tier now activates with JRE 11+ (previously required JRE 17+). The
  `@ctxo/lang-java-analyzer` companion package ships two prebuilt JARs; the
  correct variant is selected automatically at runtime based on the detected JRE:

  - JRE 11–16 → `ctxo-jdt-analyzer-11.jar` (JDT Core 3.33.0, analyzes Java 8–19)
  - JRE 17+ → `ctxo-jdt-analyzer-17.jar` (JDT Core 3.39.0, analyzes Java 8–21)

  No configuration required. Falls back to syntax tier silently when JRE is
  absent or below 11.

## 0.8.1

### Patch Changes

- a91cadd: Pin tree-sitter grammar deps to exact versions to close the lockfile-regen landmine

  The caret ranges on `tree-sitter-c-sharp` (`^0.23.1`), `tree-sitter-go` (`^0.23.4`),
  and `tree-sitter-java` (`^0.23.5`) permitted newer grammar releases whose peer
  `tree-sitter ^0.25.0` is not satisfied by the pinned `tree-sitter@^0.22.4` core.
  Any lockfile regeneration (Dependabot rebase, `pnpm install`, `pnpm update`) could
  silently pull in e.g. `tree-sitter-c-sharp@0.23.5`, which pnpm placed under a
  peer-specific virtual path and skipped its native build script, breaking the DTS
  build with `TS2307: Cannot find module 'tree-sitter-c-sharp'`. Pinning to exact
  versions closes the landmine. A coordinated `tree-sitter@^0.25.0` ecosystem upgrade
  is tracked separately (#106 Option 2).

## 0.8.0

### Minor Changes

- a1dfd9b: Add the Java language plugin (`@ctxo/lang-java`). Ships a tree-sitter syntax tier (symbols, `imports`/`extends`/`implements` edges, cyclomatic complexity) as the always-present baseline, plus an Eclipse JDT Core full tier that adds resolved `calls`/`uses` edges, cross-file symbol IDs, generics, and partial bindings on broken builds. Single runtime tier (JRE 17 base; analyzes Java 8 to 21).

  The full-tier JDT analyzer ships as the companion `@ctxo/lang-java-analyzer` package whose tarball carries the prebuilt uber-JAR; the plugin resolves it from `node_modules` (integrity + provenance via npm — no download, no manual SHA pin). It is acquired opt-in via `ctxo install java --full-tier`, a smart default that installs the analyzer when a JRE 17+ is detected. The plugin degrades cleanly to the syntax tier when no JRE 17+ or analyzer package is present, and the active tier is surfaced by `ctxo index`, `ctxo doctor`, and MCP `_meta`. See [ADR-014](https://github.com/alperhankendi/Ctxo/blob/master/docs/architecture/ADR/adr-014-java-full-tier-via-eclipse-jdt.md).
