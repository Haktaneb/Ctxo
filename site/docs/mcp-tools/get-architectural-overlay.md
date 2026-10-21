---
title: "get_architectural_overlay"
description: "Regex layers, data-driven community clusters, god nodes, and candidate bounded contexts."
---

# get_architectural_overlay

Returns three views of your codebase's architecture:

1. **Regex layers** (Domain / Adapter / Ports / Tests / Composition / Configuration / Unknown) derived from filename conventions — the pre-v0.8 behaviour.
2. **Data-driven communities** derived from Louvain clustering over the symbol graph — layers that emerge from **actual dependencies**, not folder names. See [Architectural Intelligence](/concepts/architectural-intelligence).
3. **Candidate contexts** (`mode: "contexts"`) derived from file-level clustering of dependencies and co-change, with hub files damped. Each candidate is a suggestion for a bounded context, with a label, top terms and cohesion; type names whose shapes differ between candidates are listed as collisions. See [Mode `contexts`](#mode-contexts).

::: tip When to use
First call when entering a new repo. Pair with
[`get_symbol_importance`](/mcp-tools/get-symbol-importance) to find the
critical symbols inside each layer or community.
:::

## Parameters

| Name    | Type                                        | Required | Description                                                                                           |
| ------- | ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `layer` | string                                      | no       | Return only files in this regex layer (e.g. `"Domain"`, `"Adapter"`).                                  |
| `mode`  | `"regex"` \| `"communities"` \| `"both"` \| `"contexts"` | no | Which view to return. Default `"both"`. When `"communities"` and no snapshot exists, returns a hint. `"contexts"` returns the candidate contexts. |
| `candidate` | positive integer                        | no       | With `mode: "contexts"`: the id of one candidate to return in full. Omit it for the summary of all candidates. |

## Examples

Full overlay (layers + communities):

```json
{}
```

Communities only (skip regex layer classification):

```json
{ "mode": "communities" }
```

Candidate contexts, summary of all candidates:

```json
{ "mode": "contexts" }
```

One candidate in full:

```json
{ "mode": "contexts", "candidate": 2 }
```

Drill into one regex layer:

```json
{ "layer": "Domain" }
```

## Response (full, `mode: "both"`)

```json
{
  "layers": {
    "Domain": [
      "packages/cli/src/core/graph/symbol-graph.ts",
      "packages/cli/src/ports/i-storage-port.ts"
    ],
    "Adapter": [
      "packages/cli/src/adapters/storage/sqlite-storage-adapter.ts"
    ]
  },
  "communities": {
    "modularity": 0.735,
    "edgeQuality": "mixed",
    "crossClusterEdges": 191,
    "commitSha": "78ccc33",
    "computedAt": "2026-04-16T10:00:00.000Z",
    "clusters": [
      {
        "id": 0,
        "label": "packages/cli/src/adapters/storage",
        "memberCount": 24,
        "members": [
          "packages/cli/src/adapters/storage/json-index-reader.ts::JsonIndexReader::class"
        ],
        "godNodes": [
          "packages/cli/src/adapters/storage/json-index-reader.ts::JsonIndexReader::class"
        ]
      }
    ]
  }
}
```

### Community field reference

| Field | Meaning |
| :--- | :--- |
| `modularity` | Louvain modularity score (0..1). `0.3+` indicates a recognisable cluster structure. |
| `edgeQuality` | `"full"` / `"mixed"` / `"syntax-only"` — flags when part of the graph ran on tree-sitter fallback, signalling how much to trust clustering. |
| `crossClusterEdges` | Total edges that cross cluster boundaries in the current snapshot. |
| `commitSha` | Git HEAD the snapshot was computed against. |
| `clusters[].label` | Human-readable name. Defaults to the longest common path prefix of members, falls back to `"<TopSymbol> area"`. |
| `clusters[].godNodes` | Symbols in this cluster that bridge ≥ 3 other clusters. These hold architecture together — refactor carefully. |
| `clusters[].members` | Up to 15 preview members per cluster. Full list is in `.ctxo/index/communities.json`. |

## Response (filtered by regex layer)

```json
{
  "layer": "Domain",
  "files": [
    "packages/cli/src/core/graph/symbol-graph.ts",
    "packages/cli/src/ports/i-storage-port.ts"
  ]
}
```

## Response (communities-only, no snapshot)

```json
{
  "hint": "No community snapshot available. Run `ctxo index` to generate one."
}
```

::: info Response envelope
Responses carry the usual [`_meta` envelope](/reference/response-envelope). Cluster member arrays are preview-capped at 15 entries per cluster; read `.ctxo/index/communities.json` for the full list.
:::

## Mode `contexts`

Candidate bounded contexts come from `.ctxo/index/contexts-view.json`, written by `ctxo index` (see [`ctxo contexts`](/cli/contexts) and the [`contextsView` config](/reference/config-schema#contextsview)). The tool reads the file; it does not recompute anything. A `layer` argument takes precedence over `mode`.

### Summary (default)

Every candidate is listed in brief, so the whole map fits in one response. Paths below are synthetic.

```json
{
  "commitSha": "857052d",
  "coverage": { "files": 124, "covered": 118, "ratio": 0.952 },
  "candidates": [
    {
      "id": 1,
      "label": "src/billing",
      "fingerprint": "9f2c1a7e04b3d856",
      "fileCount": 52,
      "cohesion": 0.81,
      "topTerms": [{ "term": "invoice", "files": 21 }, { "term": "payment", "files": 14 }]
    }
  ],
  "hubs": [{ "file": "src/shared/db-factory.ts", "reasons": ["fan-in", "god-node"], "candidate": 3 }],
  "hubsTotal": 2,
  "collisions": [{ "name": "Customer", "minJaccard": 0.1, "candidates": [1, 2], "occurrenceCount": 2 }],
  "collisionsTotal": 1,
  "unclustered": { "count": 6 },
  "hint": "Pass candidate: <id> for one candidate in full; run ctxo contexts --json for the whole view.",
  "_meta": { "totalItems": 1, "returnedItems": 1, "truncated": false, "totalBytes": 910 }
}
```

- `candidates` lists every candidate with its top 5 terms. It is the only truncatable array in this response.
- `hubs` and `collisions` are capped at 50 entries each, with `hubsTotal` and `collisionsTotal` giving the real counts. The envelope never truncates them.
- `unclustered` carries only the count, and there is no settings block in the MCP response.

### One candidate (`candidate: <id>`)

```json
{
  "commitSha": "857052d",
  "candidate": {
    "id": 1,
    "label": "src/billing",
    "fingerprint": "9f2c1a7e04b3d856",
    "fileCount": 52,
    "files": ["src/billing/invoice.ts", "src/billing/ledger.ts"],
    "cohesion": 0.81,
    "topTerms": [{ "term": "invoice", "files": 21 }],
    "crossEdges": [{ "candidate": 3, "total": 17, "byKind": { "imports": 12, "calls": 5 } }],
    "coChangePairs": [
      { "file": "src/billing/invoice.ts", "otherFile": "src/accounts/customer.ts", "otherCandidate": 2, "frequency": 0.4, "sharedCommits": 6 }
    ]
  },
  "hubs": [{ "file": "src/shared/db-factory.ts", "reasons": ["fan-in", "god-node"], "dependents": 48, "damping": 0.172 }],
  "hubsTotal": 1,
  "collisions": [
    {
      "name": "Customer",
      "minJaccard": 0.1,
      "candidates": [1, 2],
      "occurrenceCount": 2,
      "occurrences": [
        { "symbolId": "src/billing/customer.ts::Customer::class", "members": ["id", "billingAddress"], "memberCount": 2 }
      ]
    }
  ],
  "collisionsTotal": 1,
  "hint": "Run ctxo contexts --json for full member sets.",
  "_meta": { "totalItems": 0, "returnedItems": 0, "truncated": false, "totalBytes": 1480 }
}
```

- `files` is capped at 15, with the real count in `fileCount`.
- `hubs` are the hubs assigned to this candidate (at most 50, with `hubsTotal`).
- `collisions` are the collisions this candidate takes part in (at most 10, with `collisionsTotal`). Each lists only **this candidate's own** occurrences (at most 5), each with its `symbolId`, the first 5 members and `memberCount`; the other candidates are named in `candidates`.
- An unknown `candidate` id, or a repo with no contexts view, returns `{ "found": false, "hint": "..." }`. Run `ctxo index` to generate the view.
- For the full member sets of every candidate, use `ctxo contexts --json`.

### Field reference

| Field | Meaning |
| :--- | :--- |
| `commitSha` | Git HEAD the view was computed against. |
| `coverage` | `files` nodes in the graph, `covered` of them in a candidate, and `ratio` (0 when there are no nodes). |
| `candidates[].label` | Suggested name: the longest common directory of the members. At the repo root it falls back to the directory of the member with the highest PageRank; labels that two candidates share are refined the same way. It is not a domain name. |
| `candidates[].fingerprint` | Hash of the sorted members; stays the same when candidates are renumbered. |
| `candidates[].cohesion` | Internal weight over internal plus boundary weight (hub edges excluded). Higher means a tighter group. |
| `candidates[].topTerms` | Dominant type-name words by number of files, technical words (`Service`, `Dto`, ...) dropped. |
| `hubs[].reasons` | `fan-in`, `god-node` or `configured`. Hubs are damped, not clustered, and assigned to the candidate of their strongest remaining edge. |
| `collisions[]` | The same type name in two candidates with different member shapes (Jaccard below 0.5): input for a glossary session, not a definition. |
| `unclustered` | Files with no edge to any candidate. |

## Killer example: regex lies, communities don't

Suppose `src/utils/payments-helper.ts` sits under `utils/`. The regex classifier returns `Unknown`. But dependency-wise every call into it comes from the billing cluster. After v0.8:

```json
{
  "layers": { "Unknown": ["src/utils/payments-helper.ts"] },
  "communities": {
    "clusters": [
      { "label": "src/billing", "members": ["src/billing/checkout.ts::...", "src/utils/payments-helper.ts::..."] }
    ]
  }
}
```

The file's *real* home — the billing cluster — is now visible. A misplaced utility is no longer invisible architecture.

## When to use

- **Onboarding** — communities give you a map of the codebase that matches how it actually works, not how its folders are arranged.
- **Architectural lint** — hand the `godNodes` list to code review checklists; these are the symbols that hold your architecture together.
- **Scoped search** — filter by a cluster label before calling [`get_symbol_importance`](/mcp-tools/get-symbol-importance) or [`find_dead_code`](/mcp-tools/find-dead-code).
- **Non-conforming codebases** — the regex classifier returns `Unknown` for everything when folders do not encode layers; communities still produce useful structure.

## Pitfalls

::: warning Communities need an indexed repo
Community data comes from `.ctxo/index/communities.json`, written during `ctxo index`. If you ran `ctxo index --skip-community` or your index predates v0.8, only `layers` is returned. Re-run `ctxo index`.
:::

- **Low modularity (< 0.3) often means low-quality edges** (syntax-only tree-sitter fallback). Check `edgeQuality`.
- **Contexts need a recent `ctxo index`.** The view is recomputed on every index run and by the post-commit hook, but not by `ctxo watch`, and not with `--skip-community`. Without a view, `mode: "contexts"` returns `found: false`.
- **Labels can collide across clusters with identical path prefixes** — disambiguation adds a numeric suffix (e.g. `src/shared (2)`).
