---
title: "get_context_map"
description: "Every named context with its metrics, the owner's rung, a suggested rung and the status of each criterion (needs @ctxo/domain)."
---

# get_context_map

A registry says each context is `pinned` or `bounded`, but nothing checks that the code agrees. A context marked
`bounded` with no contract tests and two boundary violations gives an agent false confidence. `get_context_map`
puts every context on one page: its card, rules and tests, its crossings, co-change and drift, its open shadow-spec
candidates, the owner's rung and a suggested rung, with the status of every criterion, so the team sees what blocks
the next rung.

::: info Needs @ctxo/domain
This tool is registered only when the opt-in [`@ctxo/domain`](/concepts/domain-knowledge) package is installed
(`ctxo install domain`). Ctxo has 14 core tools; 18 with the package. It reads the artifacts `ctxo index` writes
under `.ctxo/index/domain/` (`maturity.json`, `shadow-candidates.json`, `boundaries.json`, `contexts.json`,
`history/`). The suggestion never changes the registry.
:::

## Parameters

None.

## Response

From a synthetic library-lending project (TypeScript) with two contexts:

```json
{
  "contextMap": [
    {
      "id": "lending",
      "name": "Lending",
      "rung": "pinned",
      "suggestedRung": "fear",
      "card": { "path": "docs/domain/lending/domain.md", "present": true },
      "rules": { "count": 2, "withTests": 1, "share": 0.5 },
      "tests": { "characterization": 1, "contract": 0 },
      "crossContextEdges": { "in": 0, "out": 0 },
      "coChange": { "pairs": 0, "top": [] },
      "drift": null,
      "boundaryViolations": { "total": 0, "errors": 0, "warnings": 0 },
      "shadowSpecs": { "open": 4, "resolved": 2 },
      "criteria": {
        "pinned": {
          "met": false,
          "mainPaths": 1,
          "reached": 0,
          "coverage": 0,
          "threshold": 0.8,
          "characterizationTests": 1,
          "unreached": ["src/lending/routes.ts::routes::variable"]
        },
        "named": { "met": false, "card": true, "terms": 1, "inGlossary": 0, "missing": ["Loan"] },
        "bounded": { "met": true, "contractSymbols": 0, "reached": 0, "unreached": [], "boundaryViolations": 0 },
        "boring": { "met": false, "rules": 2, "rulesWithoutTests": 1, "openCandidates": 4 }
      },
      "boundariesKnown": true
    },
    {
      "id": "billing",
      "name": "Billing",
      "rung": "fear",
      "suggestedRung": "fear",
      "card": { "present": false },
      "rules": { "count": 0, "withTests": 0, "share": null },
      "tests": { "characterization": 0, "contract": 0 },
      "crossContextEdges": { "in": 0, "out": 0 },
      "coChange": { "pairs": 0, "top": [] },
      "drift": null,
      "boundaryViolations": { "total": 0, "errors": 0, "warnings": 0 },
      "shadowSpecs": { "open": 1, "resolved": 0 },
      "criteria": {
        "pinned": { "met": false, "mainPaths": 0, "reached": 0, "coverage": null, "threshold": 0.8, "characterizationTests": 0, "unreached": [] },
        "named": { "met": false, "card": false, "terms": 0, "inGlossary": 0, "missing": [] },
        "bounded": { "met": true, "contractSymbols": 0, "reached": 0, "unreached": [], "boundaryViolations": 0 },
        "boring": { "met": false, "rules": 0, "rulesWithoutTests": 0, "openCandidates": 1 }
      },
      "boundariesKnown": true
    }
  ],
  "summary": { "contexts": 2, "agree": 1, "suggestedAbove": 0, "suggestedBelow": 1 },
  "settings": { "pinnedCoverage": 0.8 },
  "_meta": { "totalItems": 2, "returnedItems": 2, "truncated": false }
}
```

Lending's characterization test calls `canBorrow`, but its one main path is the Express route registered in
top-level code (the module symbol of `routes.ts`), which the test does not reach in the graph, so `pinned` is not
met and the suggestion stays at `fear`. Each criterion is still reported: `bounded` holds, `named` misses a glossary
entry for `Loan`, and `boring` waits for one untested rule and four open candidates.

| Field | Meaning |
| --- | --- |
| `rung`, `suggestedRung` | The owner's rung from the registry, and the highest rung whose criterion and every lower one are met |
| `card` | `path` and `present` (the file exists inside the repository) |
| `rules` | `count`, `withTests`, `share` (3 decimals, `null` without rules) |
| `tests` | Characterization and contract test counts (`domain.tests.characterization` and `domain.tests.contract`) |
| `crossContextEdges` | Edges `in` and `out` across the boundary |
| `coChange` | Co-change `pairs` with files of other contexts (frequency 0.5 or more) and the `top` 10 |
| `drift` | `crossShare`, `movedFiles`, `distinctCommits`, `confidence` from the domain history; `null` without history |
| `boundaryViolations` | `total`, `errors`, `warnings`, leading in or out |
| `shadowSpecs` | `open` and `resolved` candidates (see [`find_shadow_specs`](/mcp-tools/find-shadow-specs)) |
| `criteria` | One status per rung, each with `met` and its counts (below) |
| `boundariesKnown` | `false` without `boundaries.json`: the edge and violation counts are unknown and `bounded` is not met |
| `summary` | `contexts`, `agree`, `suggestedAbove`, `suggestedBelow` |
| `settings` | `pinnedCoverage` |

### The criteria

| Rung | Met when |
| --- | --- |
| `pinned` | At least `pinnedCoverage` (default 0.8) of the main paths (the symbols of the context's `endpoint` facts and its contract symbols) are reached from a characterization test over `calls`, `uses`, `imports`, `extends` and `implements` edges. Without main paths, one characterization test is enough |
| `named` | A card exists, its Language section has at least one term, and every such term has a glossary entry |
| `bounded` | Every contract symbol is reached from a contract test and no boundary violation leads in or out (met with no contract symbols and no violations) |
| `boring` | Every rule has a test link and no shadow-spec candidate is open |

The ladder is cumulative: `named` counts only when `pinned` is met, and so on. Tests that reach code over HTTP
create no graph edges, so a context tested only that way can stay below `pinned`.

## Graceful misses

| Situation | Response |
| --- | --- |
| No registry, or a registry with problems | `{ "found": false, "hint": "..." }` |
| No loop artifacts (not indexed with this release) | `{ "found": false, "hint": "No shadow-spec data yet; run \"ctxo index\"." }` |
| No `boundaries.json` | The map, with `boundariesKnown: false` and a hint |
| Artifacts built for another registry, or cards changed since the last index | The map, plus `stale: true` and a hint to run `ctxo index` |
| An unexpected failure | `{ "error": true, "message": "..." }` |

## Truncation

`contextMap` is truncatable; an entry can reach 4 to 5 KB, so a large registry may be cut, with
`_meta.hint`: `Run "ctxo domain map --json" for the full context map.`

## CLI

`ctxo domain map [--json]` prints the whole map with no truncation (see [domain commands](/cli/domain#ctxo-domain-map)).
Under `ctxo watch`, the map refreshes only on the next `ctxo index`.

## When to use

- Planning which context to harden next, and what blocks its rung.
- Checking whether the registry's rungs still match the code.
- Before tightening `domain.boundaries.blockingRungs`.

## Related tools

- [`find_shadow_specs`](/mcp-tools/find-shadow-specs): the open candidates behind `boring`.
- [`get_domain_context`](/mcp-tools/get-domain-context): one context's card.
- [`get_architectural_overlay`](/mcp-tools/get-architectural-overlay) with `mode: "contexts"`: candidate contexts found from the code.
