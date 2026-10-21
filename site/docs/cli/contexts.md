---
title: "ctxo contexts"
description: "Show the candidate bounded contexts computed by ctxo index."
---

# ctxo contexts

Prints the **contexts view**: candidate bounded contexts that `ctxo index`
computed from file-level clusters of dependencies and co-change, with hub files
damped. It reads `.ctxo/index/contexts-view.json` and computes nothing itself,
so it is instant and read-only.

Candidates are a starting point for a context map, not a verdict. The label is a
suggestion (the common directory of the members), and the terms and collisions
are input for a glossary session. See
[`get_architectural_overlay`](/mcp-tools/get-architectural-overlay) for the same
data over MCP.

## Synopsis

```shell
ctxo contexts [--json]
```

## Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--json` | `false` | Print the full `contexts-view.json` to stdout instead of a table to stderr |

## Table output

The table goes to stderr, like the other human-readable commands, so stdout
stays clean for `--json`. Paths below are synthetic.

```
[ctxo] Contexts view at 857052d: 3 candidates cover 118/124 files (95%), 2 hubs, 6 unclustered, 1 collisions
#1  52 files  cohesion 0.81  src/billing  terms: invoice, payment, ledger
#2  41 files  cohesion 0.74  src/accounts  terms: customer, account, address
#3  25 files  cohesion 0.69  src/shared  terms: config, retry, clock
hub src/shared/db-factory.ts (fan-in, god-node, 48 dependents) -> #3
hub src/shared/logger.ts (fan-in, 31 dependents) -> #3
```

## JSON output shape

`--json` prints the whole artifact, including the settings that produced it and
the full member lists (the MCP tool caps these).

```json
{
  "version": 1,
  "commitSha": "857052d",
  "settings": { "weights": { "dependency": 1, "coChange": 1 }, "resolution": 1, "minCandidateFiles": 3 },
  "coverage": { "files": 124, "covered": 118, "ratio": 0.952 },
  "candidates": [
    {
      "id": 1,
      "label": "src/billing",
      "fingerprint": "9f2c1a7e04b3d856",
      "fileCount": 52,
      "files": ["src/billing/invoice.ts", "src/billing/ledger.ts"],
      "cohesion": 0.81,
      "topTerms": [{ "term": "invoice", "files": 21 }, { "term": "payment", "files": 14 }],
      "crossEdges": [{ "candidate": 3, "total": 17, "byKind": { "imports": 12, "calls": 5 } }],
      "coChangePairs": [
        { "file": "src/billing/invoice.ts", "otherFile": "src/accounts/customer.ts", "otherCandidate": 2, "frequency": 0.4, "sharedCommits": 6 }
      ]
    }
  ],
  "hubs": [
    { "file": "src/shared/db-factory.ts", "reasons": ["fan-in", "god-node"], "dependents": 48, "damping": 0.172, "candidate": 3 }
  ],
  "unclustered": { "count": 6, "files": ["src/legacy/old-script.ts"] },
  "collisions": [
    {
      "name": "Customer",
      "minJaccard": 0.1,
      "occurrences": [
        { "candidate": 1, "file": "src/billing/customer.ts", "symbolId": "src/billing/customer.ts::Customer::class", "members": ["id", "billingAddress"] },
        { "candidate": 2, "file": "src/accounts/customer.ts", "symbolId": "src/accounts/customer.ts::Customer::class", "members": ["id", "email", "status"] }
      ]
    }
  ]
}
```

The example is abbreviated (`settings` also holds `exclude`, `hubs` and
`technicalTerms`). The settings are described under
[`contextsView` in the config reference](/reference/config-schema#contextsview).
`fingerprint` is a hash of the sorted members, so it stays the same when
candidates are renumbered. The file has no timestamp: the same index, config and
commit always produce byte-identical output.

## No view yet

If `contexts-view.json` is missing or unreadable, the table mode prints
`No contexts view. Run ctxo index (without --skip-community).` to stderr, and
`--json` prints `{"found":false,"hint":"..."}` to stdout. Both exit `0`.

## When the view is refreshed

- On every `ctxo index` run, full or incremental (`--files`, `--commit`), which
  includes the post-commit hook.
- Not on `ctxo index --skip-community`.
- Not by [`ctxo watch`](./watch.md). Run `ctxo index` after a long watch session
  before reading the view.

## Examples

::: code-group
```shell [table]
ctxo contexts
```

```shell [full artifact]
ctxo contexts --json > contexts-view.json
```

```shell [jq: sizes]
ctxo contexts --json | jq '.candidates[] | { id, label, fileCount, cohesion }'
```

```shell [jq: collisions]
ctxo contexts --json | jq '.collisions[] | { name, minJaccard, candidates: [.occurrences[].candidate] }'
```
:::

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Always, including when no view exists |

## See also

- [`ctxo index`](./index.md) - computes the view.
- [`get_architectural_overlay`](/mcp-tools/get-architectural-overlay) - the same data over MCP (`mode: "contexts"`).
- [config.yaml reference](/reference/config-schema#contextsview) - tune `contextsView`.
