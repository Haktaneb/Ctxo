---
title: "get_ranked_context"
description: "Natural-language search ranked by BM25 relevance and PageRank importance, packed into a token budget."
---

# get_ranked_context

Ask a natural-language question, get back the most relevant symbols in your
codebase -- ranked by a blend of textual relevance (BM25, camelCase-aware,
trigram fallback, typo correction) and structural importance (PageRank), then
greedily packed to fit your token budget.

::: tip When to use
Use this when you know **what you want** but not **where it lives**. It is the
natural-language counterpart to [`search_symbols`](/mcp-tools/search-symbols),
which takes a name or regex.
:::

## Parameters

| Name          | Type                                          | Required | Description                                                        |
| ------------- | --------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `query`       | string                                        | yes      | Free-text query (e.g. `"how do we mask secrets in responses"`)     |
| `tokenBudget` | number (min 100)                              | no       | Packing budget. Default `4000`                                     |
| `strategy`    | `"combined" \| "dependency" \| "importance"` | no       | Ranking blend. Default `"combined"`                                |
| `searchMode`  | `"fts" \| "legacy"`                          | no       | `fts` = BM25 engine, `legacy` = substring matcher. Default `"fts"` |
| `scope`       | `"code" \| "domain"`                         | no       | Only with `@ctxo/domain`: `code` (default) ranks symbols; `domain` searches the domain cards. See [The domain scope](#the-domain-scope) |

### Strategies

| Strategy     | Behavior                                                    |
| ------------ | ----------------------------------------------------------- |
| `combined`   | BM25 relevance x PageRank importance (recommended)          |
| `dependency` | Prefers symbols that the query text references structurally |
| `importance` | Forces the legacy pipeline; falls back from `fts`           |

## Example

```json
{
  "query": "sanitize secrets before returning to MCP client",
  "tokenBudget": 6000
}
```

## Response (fts mode)

```json
{
  "query": "sanitize secrets before returning to MCP client",
  "strategy": "combined",
  "results": [
    {
      "symbolId": "packages/cli/src/core/masking/secret-masker.ts::SecretMasker::class",
      "name": "SecretMasker",
      "kind": "class",
      "file": "packages/cli/src/core/masking/secret-masker.ts",
      "relevanceScore": 0.842,
      "importanceScore": 0.613,
      "combinedScore": 0.755,
      "tokens": 210
    }
  ],
  "totalTokens": 3920,
  "tokenBudget": 6000,
  "searchMetrics": { "tier": "bm25", "tookMs": 14, "candidates": 87 },
  "fuzzyCorrection": { "from": "santize", "to": "sanitize" },
  "_meta": { "totalItems": 18, "returnedItems": 18, "truncated": false }
}
```

## How the BM25 engine works

1. **Tokenization** -- splits names on camelCase, snake_case, and kebab-case so `SecretMasker` matches `secret mask`.
2. **BM25 ranking** -- classic term-frequency scoring across the symbol corpus.
3. **Trigram fallback** -- if no BM25 hits, falls back to trigram similarity.
4. **Typo correction** -- in `fts` mode typo correction runs automatically and is reported in `fuzzyCorrection`.
5. **Importance blend** -- final score mixes BM25 relevance with normalized reverse-edge count (a lightweight PageRank proxy).
6. **Token packing** -- greedy pack until `tokenBudget` is reached.

## The domain scope

With `@ctxo/domain` installed, the tool gains a `scope` parameter. `"code"`, the default, is the symbol ranking above, unchanged. `"domain"` runs the same BM25 engine (with `k1 1.2`, `b 0.75` and no PageRank blend) over the domain knowledge of the repository:

- card rules (`<ID> <title>` and the rule text), terms from the cards' `Language` sections and the glossary, dated decisions and the other card sections (intro, boundary contracts, open questions), all from the domain graph `ctxo index` writes;
- in-repo provenance files: the files a card decision links to, read at query time (regular files inside the repository, up to 256 KB each, cached by modification time). External provenance (`#123`, URLs) is never fetched.

Without the package the parameter does not exist and the tool's schema and output are exactly as before. `strategy` and `searchMode` do not apply to the domain scope. Punctuation in the query is ignored; rule IDs keep their shape (`LEND-03`).

```json
{ "query": "five loans", "scope": "domain" }
```

```json
{
  "query": "five loans",
  "scope": "domain",
  "results": [
    {
      "id": "rule:LEND-03",
      "kind": "rule",
      "title": "LEND-03 A member holds at most five loans",
      "context": "lending",
      "path": "docs/domain/lending/domain.md",
      "line": 20,
      "excerpt": "",
      "relevanceScore": 3.929,
      "tokens": 51
    },
    {
      "id": "file:docs/specs/loan-limit.md",
      "kind": "provenance",
      "title": "Loan limit",
      "path": "docs/specs/loan-limit.md",
      "excerpt": "# Loan limit The limit rose from three to five loans after the renewal study.",
      "relevanceScore": 3.275,
      "tokens": 60
    }
  ],
  "totalTokens": 111,
  "tokenBudget": 4000,
  "searchMetrics": { "porterHits": 5, "trigramHits": 0, "phase2Activated": false, "fuzzyApplied": false, "latencyMs": 0.18 },
  "_meta": { "totalItems": 2, "returnedItems": 2, "truncated": false }
}
```

- `kind` is `rule`, `term`, `decision`, `section` or `provenance`; `id` is the graph node id (`rule:LEND-03`, `term:lending/loan`, `decision:lending/2026-09-12-1`, `section:<card>:<line>`, `file:<path>`). Glossary terms without a `(context: <id>)` have the context `*`.
- `excerpt` is the text with whitespace collapsed, cut at 300 characters. Hits are ordered by the engine's final score, highest first, and packed greedily into `tokenBudget`.
- Without a registry or a graph the response is `{ found: false, hint }`; after a card edit not yet indexed it adds `stale: true` and a hint to run `ctxo index`.
- Follow a rule hit with [`get_rule`](/mcp-tools/get-rule): the hit's `id` (`rule:LEND-03`) can be passed to `get_rule` as is. Follow a card hit with [`get_domain_context`](/mcp-tools/get-domain-context).

## When to use

- **Discovery** -- "where is the retry logic for HTTP calls?"
- **Onboarding** -- natural-language map of an unfamiliar area.
- **Query-to-context** -- feed an agent the top N symbols relevant to the user's prompt.
- For exact names or regex, prefer [`search_symbols`](/mcp-tools/search-symbols).

## Pitfalls

::: warning Index freshness
The FTS index rebuilds when the graph's node count changes. If you added files
but the count is stable, run `ctxo index` to refresh.
:::

- **Strategy `"importance"` always uses the legacy pipeline** -- keep the default `combined` for BM25 quality.
- **`tokenBudget` is greedy**, not optimal. Very large symbols can fill the budget with one entry; narrow the query if this happens.
- **Requires** `ctxo index`.
