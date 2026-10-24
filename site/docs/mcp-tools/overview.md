---
title: "MCP Tools Overview"
description: "All Ctxo MCP tools: 14 core tools, plus 4 with @ctxo/domain, grouped by purpose, with links to detailed specs and cross-cutting behavior."
---

# MCP Tools Overview

Ctxo ships **14 core MCP tools, plus 4 with `@ctxo/domain`** over stdio transport with **zero external network dependencies**: every tool reads from the local `.ctxo/` index and returns results in **under 500ms** on typical repositories. Tools are grouped into the categories of the sidebar: Context & Search, Impact & Change, Structure & Deps, History & Cleanup, and Domain for the four tools of the opt-in `@ctxo/domain` package.

See [the mandatory sequence](/mcp-tools/tool-selection-guide#modifying-existing-code) before editing.

## Context & Search

| Tool | Purpose |
| --- | --- |
| [`get_logic_slice`](/mcp-tools/get-logic-slice) | Symbol plus transitive dependencies with progressive detail (L1-L4) |
| [`get_context_for_task`](/mcp-tools/get-context-for-task) | Task-aware bundle for `fix` / `extend` / `refactor` / `understand` |
| [`get_ranked_context`](/mcp-tools/get-ranked-context) | Two-phase BM25 search (camelCase-aware, trigram fallback, fuzzy) + PageRank within a token budget |
| [`search_symbols`](/mcp-tools/search-symbols) | Symbol name or regex lookup across the index (supports `mode: 'fts'`) |

## Impact & Change

| Tool | Purpose |
| --- | --- |
| [`get_blast_radius`](/mcp-tools/get-blast-radius) | Impact score + affected symbols in three tiers (confirmed / likely / potential) + v0.8 cluster breakdown |
| [`get_pr_impact`](/mcp-tools/get-pr-impact) | Full PR risk assessment: changes + blast radius + co-change history + v0.8 boundary violations |
| [`get_changed_symbols`](/mcp-tools/get-changed-symbols) | Symbols in recently changed files (git diff) |
| [`get_change_intelligence`](/mcp-tools/get-change-intelligence) | Complexity x churn composite score for hotspot detection |

## Structure & Deps

| Tool | Purpose |
| --- | --- |
| [`get_architectural_overlay`](/mcp-tools/get-architectural-overlay) | Regex layers (Domain / Adapter / Ports / ...), data-driven community clusters with god nodes, and candidate bounded contexts (`mode: "contexts"`) |
| [`find_importers`](/mcp-tools/find-importers) | Reverse dependency lookup — who uses this symbol? |
| [`get_class_hierarchy`](/mcp-tools/get-class-hierarchy) | Class inheritance tree (ancestors + descendants) |
| [`get_symbol_importance`](/mcp-tools/get-symbol-importance) | PageRank centrality ranking of symbols |

## History & Cleanup

| Tool | Purpose |
| --- | --- |
| [`get_why_context`](/mcp-tools/get-why-context) | Git commit intent + anti-pattern / revert warnings |
| [`find_dead_code`](/mcp-tools/find-dead-code) | Unreachable symbols and files |

## Domain (`@ctxo/domain`)

Registered only when the opt-in [`@ctxo/domain`](/concepts/domain-knowledge) package is installed. They read the team's domain cards through the domain graph and the loop artifacts `ctxo index` builds; without a registry, a graph or the artifacts they answer `{ found: false, hint }`.

| Tool | Purpose |
| --- | --- |
| [`get_domain_context`](/mcp-tools/get-domain-context) | The card of the named context that owns a symbol or file: terms, rules with their tests and code, contracts, decisions, open questions |
| [`get_rule`](/mcp-tools/get-rule) | One rule by ID: its text, the tests and symbols linked to it with the source of each link, decisions and provenance |
| [`find_shadow_specs`](/mcp-tools/find-shadow-specs) | The Deletion Test: business-looking code in a context that no rule pins yet (facts, owned data objects, rules without tests), with fingerprints and resolutions |
| [`get_context_map`](/mcp-tools/get-context-map) | Every context with its metrics, the owner's rung, a suggested rung and the status of each criterion |

With the package, [`get_ranked_context`](/mcp-tools/get-ranked-context#the-domain-scope) also takes `scope: "domain"`, and `get_blast_radius`, `get_context_for_task`, `get_why_context` and `get_pr_impact` gain additive domain fields.

## Cross-cutting Features

All tools, the core 14 and the 4 domain tools, share the same response envelope and behavior. See [Response Format](/mcp-tools/response-format) for full examples.

### The `_meta` envelope

Every successful response carries a `_meta` block:

```json
{
  "_meta": {
    "totalItems": 128,
    "returnedItems": 42,
    "truncated": true,
    "totalBytes": 8192,
    "hint": "Response truncated — narrow with `intent` or raise CTXO_RESPONSE_LIMIT"
  }
}
```

Truncation threshold defaults to **8192 bytes** and is configurable via the `CTXO_RESPONSE_LIMIT` environment variable.

### Intent filtering

[`get_blast_radius`](/mcp-tools/get-blast-radius), [`get_logic_slice`](/mcp-tools/get-logic-slice), [`find_importers`](/mcp-tools/find-importers), and [`find_dead_code`](/mcp-tools/find-dead-code) accept an optional `intent` parameter — a keyword filter applied to symbol names, file paths, and commit messages — to narrow noisy result sets before truncation kicks in.

### Tool annotations

Every tool declares MCP annotations so clients can reason about safety:

| Annotation | Meaning |
| --- | --- |
| `readOnlyHint` | Tool never mutates repo or index state |
| `idempotentHint` | Identical inputs produce identical outputs |
| `openWorldHint` | Tool may touch unbounded external state (always `false` for Ctxo — all reads are local) |

::: info Resources
Ctxo also exposes one MCP resource — `ctxo://status` — as a health-check endpoint to prevent `-32601 Method not found` errors from clients that call `listResources` at startup.
:::

## Next

- [Tool Selection Guide](/mcp-tools/tool-selection-guide) — decision tree mapping tasks to tools
- [Response Format](/mcp-tools/response-format) — full envelope, error shapes, and examples
