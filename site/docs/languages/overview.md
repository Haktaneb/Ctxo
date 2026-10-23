---
title: "Languages Overview"
description: "Language support tiers and plugin architecture."
---

# Languages Overview

Ctxo ships language support as separate plugin packages. The CLI has no built-in
parsers: it discovers plugins at runtime by scanning the consumer project's
`package.json` for names matching `@ctxo/lang-*` (official) or `ctxo-lang-*`
(community). Each plugin implements the Plugin API contract exported by
[`@ctxo/plugin-api`](/languages/writing-a-plugin), a stable surface with zero
runtime dependencies on `@ctxo/cli`. The CLI accepts plugins on protocol v1 and
v2; v2 adds data kinds, annotations, facts and host capabilities.

## Support matrix

| Language              | Plugin                 | Parser                                           | Tier     | Extensions                 | Annotations | Test symbols | SQL at call sites |
| --------------------- | ---------------------- | ------------------------------------------------ | -------- | -------------------------- | ----------- | ------------ | ----------------- |
| TypeScript/JavaScript | `@ctxo/lang-typescript` | ts-morph                                         | `full`   | `.ts .tsx .js .jsx`        | decorators | test blocks (`describe` / `it` / `test`) | yes |
| Go                    | `@ctxo/lang-go`         | `ctxo-go-analyzer` (Go 1.22+) + tree-sitter-go   | `full`   | `.go`                      | struct tags (both tiers) | `_test.go` functions (full tier) | full tier |
| C#                    | `@ctxo/lang-csharp`     | `ctxo-roslyn` (.NET SDK 8+) + tree-sitter-c-sharp | `full`  | `.cs`                      | attributes (both tiers) | test methods | Roslyn tier |
| Java                  | `@ctxo/lang-java` + `@ctxo/lang-java-analyzer` | Eclipse JDT Core (JRE 11+) + tree-sitter-java | `full` | `.java` | annotations (both tiers) | test methods (`src/test/java`) | JDT full tier |
| SQL (T-SQL)           | `@ctxo/lang-sql`        | `@ctxo/sql-extract` (TypeScript tokenizer)       | `syntax` | `.sql`                   | `columns` on tables | none | defines the targets |

SQL at call sites needs `@ctxo/lang-sql` installed: without it, no language
emits data edges. Annotations and test symbols are always on.

Two tiers are defined by the plugin contract:

- **`full`** — the plugin has access to a real semantic analyzer (ts-morph,
  Roslyn, or the Go analyzer binary). Produces resolved edges (`calls`,
  `extends`, `implements`, `uses`) plus rich complexity.
- **`syntax`** — tree-sitter or equivalent syntax-level parser. Produces
  symbols, `imports`, and approximate edges. Used as a graceful fallback.

The Go, C#, and Java plugins advertise `tier: 'full'` and auto-downgrade to
syntax at runtime when the required toolchain or analyzer package is missing.
For Java, full tier requires the `@ctxo/lang-java-analyzer` companion package
and a JRE 11+ on PATH - not a build toolchain. You can see the active tier in
`ctxo doctor --json` under the language coverage check.

## What gets extracted

Every plugin returns the same shapes, defined in `@ctxo/plugin-api`: symbols,
edges, and a per-symbol cyclomatic complexity count. See
[Symbol IDs](/reference/symbol-ids) and [Edge kinds](/reference/edge-kinds) for
the canonical enums and format.

Protocol v2 adds data coupling: the SQL plugin emits `table`, `view` and
`procedure` symbols with `reads`, `writes` and `executes` edges, and with it
installed the C#, TypeScript, Java and Go plugins link constant SQL at known
call sites to the same tables. All four report annotations (attributes,
decorators, Java annotations, Go struct tags); test-framework annotations such
as `Fact` or `@Test` mark test files for the contexts view and
`find_dead_code`. Tests are symbols with edges in all four languages, so they
count as blast-radius dependents.

## Detection

`ctxo init` and `ctxo doctor` use `detectLanguages()` to figure out which
plugins a project needs. Detection combines two signals:

1. **Manifest markers** in the project root:
   - `tsconfig.json` → typescript
   - `go.mod` / `go.work` → go
   - `*.csproj` / `*.sln` → csharp
   - `pom.xml` / `build.gradle` / `build.gradle.kts` → java
   - `pyproject.toml`, `Cargo.toml`, `Gemfile`, ... (reserved)
2. **Extension counts** from `git ls-files`, mapped through a canonical
   extension table (e.g. `.ts` and `.tsx` both map to `typescript`, and `.sql`
   maps to `sql`).

A manifest marker is enough on its own. A language found by extension only,
such as SQL, needs at least 5 files that are also at least 2% of the files
`git ls-files` lists (files without an extension are not counted). The result
drives the auto-install flow.

## Auto-install

`ctxo init` prompts to install detected plugins. `ctxo index --install-missing`
installs them non-interactively before indexing. Both paths use the detected
package manager (pnpm / npm / yarn) and add packages to `devDependencies`:

::: code-group
```bash [pnpm]
pnpm add -D @ctxo/lang-typescript @ctxo/lang-go @ctxo/lang-csharp @ctxo/lang-java
```
```bash [npm]
npm install --save-dev @ctxo/lang-typescript @ctxo/lang-go @ctxo/lang-csharp @ctxo/lang-java
```
```bash [yarn]
yarn add -D @ctxo/lang-typescript @ctxo/lang-go @ctxo/lang-csharp @ctxo/lang-java
```
:::

You can also run `ctxo install <id>...` directly (for example
`ctxo install sql`), or `ctxo install --dry-run` to preview the plan without
touching `package.json`.

## Per-language pages

- [TypeScript / JavaScript](/languages/typescript)
- [Go](/languages/go)
- [C#](/languages/csharp)
- [Java](/languages/java)
- [SQL](/languages/sql)
- [Writing a plugin](/languages/writing-a-plugin)

## Related

- [Dependency graph](/concepts/dependency-graph)
- [Symbol IDs](/reference/symbol-ids)
- [Edge kinds](/reference/edge-kinds)
