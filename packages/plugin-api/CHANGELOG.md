# @ctxo/plugin-api

## 0.9.1

### Patch Changes

- 0353c01: Third-party plugin authors were told to test their fact detectors against the conformance vectors, but the npm package did not contain them. `@ctxo/plugin-api` now ships `conformance/fact-vectors.json` (read it from `node_modules/@ctxo/plugin-api/conformance/fact-vectors.json`), the vectors every official plugin's fact rules are tested against. The type docs now say that `CodeFact.text` and the official plugins' `detail.literal` are capped at 200 Unicode code points (not characters, never inside a surrogate pair) and that `PluginContext.config.facts` is a host-reserved key holding the fact detector options, set only when facts are requested. No API change.

## 0.9.0

### Minor Changes

- cacea40: Plugin protocol v2 and data coupling (#156 Phase 1): `@ctxo/plugin-api` adds the data kinds (`table`, `view`, `procedure` with `reads`, `writes` and `executes` edges), typed symbol annotations, an opt-in facts channel and host capabilities, and the new `@ctxo/lang-sql` plugin (built on the zero-dependency `@ctxo/sql-extract` library, installed with `ctxo install sql`) indexes T-SQL definitions and the tables their bodies read and write. `@ctxo/lang-csharp` reports attribute annotations, adds SQL edges at known ADO.NET, Dapper, `SqlBulkCopy` and EF Core call sites when `@ctxo/lang-sql` is installed, and falls back to tree-sitter when its Roslyn helper cannot restore or build. The CLI puts data edges in the confirmed blast-radius tier, reports shared tables, ownership and external resources in the contexts view, recognises test files by test-framework annotations and adds the `csharp_tier` doctor check, and the other official plugins widen their `@ctxo/plugin-api` peer range.

## 0.8.0

### Minor Changes

- 5e7d482: Minor release: bump all packages to a new minor version line.

## 0.7.3

### Patch Changes

- 8db20d8: Patch release: dependency maintenance (zod 4.6.7) and CI action updates (setup-node 7.1.0, upload-artifact 7.0.2, test-reporter 3.2.0).

## 0.7.2

### Patch Changes

- c8165d8: Ship the CLI-side Java support that pairs with `@ctxo/lang-java` and `@ctxo/lang-java-analyzer` 0.8.0. Without this release the published Java plugins do not work end to end, because the CLI half was missing.

  - `ctxo install java --full-tier` / `--syntax-only` with a JRE-aware smart default (installs the analyzer companion package when a JRE 17+ is detected).
  - `ctxo doctor` Java tier check (runtime + analyzer presence + actionable hint); `ctxo index` surfaces the active Java tier.
  - core: accept name-reference edge targets (`EdgeTargetSchema`) plus a resilient index read, and resolve those targets by unambiguous name+kind in the symbol graph. Without these, Java `extends`/`implements`/`uses`/`calls` edges are dropped on read or left unresolved, so blast-radius, find-importers, and class-hierarchy return nothing for Java.
  - watch: a generic `IIncrementalReindex` keep-alive capability (new in `@ctxo/plugin-api`) replaces the C#-hardcoded path. `@ctxo/lang-csharp` now exposes `getIncrementalReindex()` so C# watch keep-alive keeps working with the generalized watch command.

## 0.7.1

### Patch Changes

- 5b1ea92: Release pipeline hardening:

  - Release workflow now runs `pnpm -r typecheck` and `pnpm -r test` before publishing, so broken builds cannot ship to npm.
  - Verifies `NPM_TOKEN` secret is present before doing any work (fast fail with actionable message).
  - After publish, automatically fixes npm dist-tags so prerelease versions (`-alpha`, `-beta`, `-rc`, `-next`) move to the matching channel tag and `latest` stays pinned to the highest stable version.
  - All public packages now declare `publishConfig.access: public` and `publishConfig.provenance: true` so per-package npm publishes (manual or automated) keep provenance and visibility consistent.
  - New `dist-tag-repair` workflow available from the Actions tab to manually re-align dist-tags for any package, with a `dry_run` switch.
