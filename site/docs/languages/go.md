---
title: "Go"
description: "@ctxo/lang-go: ctxo-go-analyzer + tree-sitter, full tier."
---

# Go

Plugin: **`@ctxo/lang-go`** ([npm](https://www.npmjs.com/package/@ctxo/lang-go))
Parser: **`ctxo-go-analyzer`** (Go binary, full tier) with
**tree-sitter-go** fallback
Tier: **`full`** (advertised), downgrades to `syntax` when Go toolchain is missing
Extensions: `.go`

## What this plugin does

The Go plugin ships a small Go program (`tools/ctxo-go-analyzer`) that uses
`go/packages` + `go/types` to produce fully resolved symbols and edges across
a module. At index time the plugin compiles the analyzer to a binary, runs
one batch analysis pass over the module, and caches the per-file results.
Individual `extractSymbols` / `extractEdges` calls read from that cache,
keeping the `ILanguageAdapter` per-file contract intact while only invoking
the Go toolchain once per index.

If Go 1.22+ is not on `PATH`, or no `go.mod` / `go.work` is discoverable,
the plugin transparently downgrades to a tree-sitter-go syntax adapter.
Complexity is always computed by tree-sitter, because the analyzer binary
intentionally emits empty complexity.

## Install

::: code-group
```bash [pnpm]
pnpm add -D @ctxo/lang-go
```
```bash [npm]
npm install --save-dev @ctxo/lang-go
```
```bash [yarn]
yarn add -D @ctxo/lang-go
```
:::

Or:

```bash
ctxo install go --yes
```

For full tier, also install a Go 1.22+ toolchain. The first `ctxo index` run
builds the analyzer binary into the plugin's `node_modules` directory
(typically under 5 seconds, cached after).

## What it extracts

### Symbols

| Kind        | Sources                                                    |
| ----------- | ---------------------------------------------------------- |
| `function`  | Top-level `func` declarations (in `_test.go` files too, full tier) |
| `method`    | Methods with receivers (`func (r *T) M()`)                 |
| `class`     | struct types                                               |
| `type`      | other `type` declarations (aliases, named primitives)      |
| `interface` | `type X interface { ... }` declarations                    |
| `variable`  | Package-level `var` and `const` declarations               |

### Edges

| Kind         | Notes                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| `imports`    | `import` statements. Standard-library and module imports both tracked.      |
| `calls`      | Function and method calls resolved by `go/types`                            |
| `implements` | Struct-implements-interface relationships (structural, not declared)        |
| `uses`       | Type references in field lists, function signatures, composite literals    |
| `reads`, `writes`, `executes` | Constant SQL at known call sites, full tier with `@ctxo/lang-sql` installed ([below](#sql-at-call-sites)) |

Note that Go has no `extends`. Embedding is modeled as a mix of `uses` and
`implements` relationships because the analyzer reports implementation
satisfaction explicitly via `go/types`.

## Annotations: struct tags

Struct field tags become annotations on the struct, in both tiers (always on).
Each tagged field gives one `tag` annotation with the field name in
`named.member` and one entry per tag key; untagged fields give nothing, and an
embedded field is named by its type's last identifier. Fields do not become
symbols.

```go
type Loan struct {
	LoanID string `json:"loan_id" gorm:"column:loan_id;primaryKey"`
}
// Loan: [{ name: 'tag', named: { member: 'LoanID', json: 'loan_id', gorm: 'column:loan_id;primaryKey' } }]
```

- Parsing follows `reflect.StructTag`: the first key wins and parsing stops at
  the first malformed pair. A key named `type` is dropped (`named.type` is
  reserved). Caps: 20 per struct, 10 keys per field, 200 characters per value.
- The analyzer emits the raw tags and one parser builds the annotations for
  both tiers, so they agree. The tree-sitter tier reads exported structs only,
  and decodes interpreted (double-quoted) tag literals with JSON rules rather
  than Go unquote rules, so `\x41`, octal and `\a` escapes can differ;
  raw-string tags, the usual form, agree.

## Test symbols

The full tier loads packages with their tests (`Tests: true`). Functions and
methods in `_test.go` files become symbols with `calls` edges, analysed once
each in the first test variant that holds them, so a test fake can implement a
production interface. Tests are therefore blast-radius dependents of the code
they call, and `find_dead_code` no longer reports functions whose only callers
are tests. Production analysis, `hasMain` and the analyzer's dead list are
unchanged and never hold a test symbol.

- Build-tagged test files (for example `//go:build integration`) are not loaded,
  so the full tier gives them no symbols.
- Loading and type-checking test packages makes full-tier runs slower on
  modules with many tests.
- `t.Run` subtests are not symbols of their own.

## SQL at call sites

With [`@ctxo/lang-sql`](/languages/sql) installed and the full tier active,
ctxo-go-analyzer reports constant SQL at known call sites, and the plugin adds
`reads`, `writes` and `executes` edges from the enclosing function (a closure
belongs to its function declaration), parsed by `@ctxo/sql-extract`. The
tree-sitter tier gives no SQL edges, and without `@ctxo/lang-sql` there are
none.

| Package | Members |
| --- | --- |
| `database/sql` | `Query`, `QueryRow`, `Exec`, `Prepare` and their `Context` forms on `DB`, `Tx`, `Conn`, `Stmt` |
| `github.com/jmoiron/sqlx` | `Select`, `Get`, `Queryx`, `NamedExec`, `MustExec` (methods and package functions) |
| `github.com/jackc/pgx` v4 and v5 | `Query`, `QueryRow`, `Exec`, including `pgxpool` |
| `gorm.io/gorm` | `Raw`, `Exec` |

- **Matching:** the callee resolves through `go/types`; its receiver type
  (pointer stripped) names the owner, so the `*sql.DB` methods promoted onto
  `sqlx.DB` count too.
- **Text:** the argument bound to the callee's first `string` parameter, when
  `go/types` gives it a constant value (literals, `const` declarations,
  constant concatenation). A `*sql.Stmt` method has no SQL argument: its text
  was read at `Prepare`.
- **Limits:** user-defined interfaces (sqlc's `DBTX`), method values and method
  expressions give no call sites, and the sqlx `...Context` forms are not
  listed. Non-constant SQL is counted in the analyzer's summary
  (`sql: { constant, nonConstant }`, debug log only), never guessed.

## Go modules and workspaces

The analyzer discovers the module root by walking up from the project root
looking for `go.mod` and then `go.work`. A Go workspace (`go.work`) is
supported: all modules listed in the `use` block are analyzed in a single
pass. For repositories that nest a Go module inside a larger polyglot
workspace, the analyzer rebases symbol IDs relative to the ctxo project
root, not the module root.

## Graceful degradation

| Condition                                | Result                                       |
| ---------------------------------------- | -------------------------------------------- |
| Go toolchain missing or < 1.22           | Falls back to tree-sitter syntax tier        |
| No `go.mod` / `go.work` found            | Falls back to tree-sitter syntax tier        |
| Analyzer build fails                     | Falls back to tree-sitter syntax tier, warn  |
| Analyzer batch times out                 | Marks batch `timedOut`, uses partial results |
| Analyzer run fails, crashes or is killed (120 s limit) | Falls back to tree-sitter syntax tier for the run, warn |

The active tier is reported by `ctxo doctor` (look for the Go language
coverage check).

## Known issues

- **tree-sitter peer version:** `tree-sitter@0.22.x` and the native
  `tree-sitter-go@0.23.x` binding currently advertise mismatched peer ranges
  in the pnpm dependency graph. Installs succeed but may emit a peer warning.
  This is a known upstream issue and does not affect runtime behaviour.
- **Generics:** type parameter lists are parsed but the `uses` edges for
  generic constraints are best-effort under the syntax fallback.
- **CGo files** (`import "C"`) are indexed as regular Go files; the C side
  is not analyzed.

## Related

- [Dependency graph](/concepts/dependency-graph)
- [Edge kinds](/reference/edge-kinds)
- [Languages overview](/languages/overview)
