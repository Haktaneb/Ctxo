---
title: "find_dead_code"
description: "Unreachable symbols, unused exports, dead files, and scaffolding tagged with TODO/FIXME/HACK."
---

# find_dead_code

Finds symbols no one references, files with zero live symbols, exports that
are never imported, and scaffolding comments (TODO/FIXME/HACK) left behind
during development. Each dead symbol comes with a confidence score and a
human-readable reason.

::: tip When to use
Cleanup sprints, pre-release housekeeping, and whenever
[`get_changed_symbols`](/mcp-tools/get-changed-symbols) surfaces files you
suspect nothing consumes anymore.
:::

## Parameters

| Name           | Type    | Required | Description                                                                   |
| -------------- | ------- | -------- | ----------------------------------------------------------------------------- |
| `includeTests` | boolean | no       | Count test files as normal reachable code. Default `false`                    |
| `intent`       | string  | no       | Filter `deadSymbols` by keyword (e.g. `"adapter"`, `"core"`, `"function"`)    |

## Example

```json
{ "includeTests": false }
```

Narrow to adapters only:

```json
{ "intent": "adapters" }
```

## Response

```json
{
  "totalSymbols": 1847,
  "reachableSymbols": 1792,
  "deadSymbols": [
    {
      "symbolId": "packages/cli/src/adapters/storage/legacy.ts::oldSerialize::function",
      "name": "oldSerialize",
      "kind": "function",
      "file": "packages/cli/src/adapters/storage/legacy.ts",
      "confidence": 1.0,
      "reason": "Zero importers -- no code references this symbol"
    }
  ],
  "unusedExports": [ /* exports nothing else imports */ ],
  "deadFiles": [
    "packages/cli/src/adapters/storage/legacy.ts"
  ],
  "scaffolding": [
    { "file": "packages/cli/src/core/foo.ts", "line": 42, "kind": "TODO", "text": "handle empty case" }
  ],
  "deadCodePercentage": 3.0,
  "_meta": { "totalItems": 55, "returnedItems": 55, "truncated": false }
}
```

## Test files

Test files are recognised by the same classifier the contexts view uses: the
default test globs (`**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`,
`**/test/**`, `**/tests/**`, `**/*_test.go`, `**/src/test/**` and the C# and
Python patterns) plus every file in which a test-framework annotation (`Fact`,
`Test`, `TestMethod` and the rest) marks a symbol. With `includeTests: false`
(the default):

- test symbols are never reported dead, even a TypeScript test block or a Go
  test function with no outgoing edges;
- production code called only from tests is not dead. In particular, Go
  functions whose only callers are `_test.go` functions are no longer reported,
  as in the other languages;
- production code under a folder named `test/` or `src/test/`, and any file
  with a test-annotated symbol, is left out of the analysis as well.

`index.tests` globs are not consulted here. Symbols in `.sql` files are never
reported.

## Confidence tiers

| Score | Meaning                                                              |
| ----- | -------------------------------------------------------------------- |
| `1.0` | Zero importers -- no code references this symbol                     |
| `0.9` | Only referenced from test/config files                               |
| `0.7` | All importers are themselves dead (cascading dead code)              |

## When to use

- **Cleanup PRs** -- start with `confidence: 1.0` symbols.
- **Scaffolding audit** -- the `scaffolding[]` field surfaces every TODO/FIXME/HACK with file+line for triage.
- **Unused exports** -- the `unusedExports[]` field is subtler than `deadSymbols`; an unused export may still be an entry point, so review before deleting.

## Pitfalls

::: warning Dynamic dispatch is invisible
Reflection, string-based lookups, and framework auto-registration (e.g.
dependency injection by name) look like "no importers" to the graph. Verify
with [`find_importers`](/mcp-tools/find-importers) plus a quick grep before
deleting anything even at `confidence: 1.0`.
:::

- **Framework entry points** are filtered by heuristic patterns. If your framework is unusual, expect false positives.
- **`includeTests: false`** (default) leaves test files out of the analysis: test symbols are never reported, and a production symbol whose only callers are tests is not dead. Flip to `true` to analyse test files as ordinary code.
- **Requires** `ctxo index`.

## Related tools

- [`find_importers`](/mcp-tools/find-importers) -- double-check before deleting
- [`get_blast_radius`](/mcp-tools/get-blast-radius) -- confirm nothing transitive breaks
- [`get_change_intelligence`](/mcp-tools/get-change-intelligence) -- dead + churny = the easiest wins
