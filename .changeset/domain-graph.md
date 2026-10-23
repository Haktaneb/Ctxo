---
"@ctxo/cli": minor
"@ctxo/domain": minor
---

`@ctxo/domain` builds a domain graph from cards (rules, terms, decisions) linked to tests, code and provenance, adds `get_domain_context`, `get_rule` and a domain scope for `get_ranked_context`, and adds rule and card fields to `get_blast_radius`, `get_context_for_task`, `get_why_context` and `get_pr_impact` (#156). `@ctxo/cli` adds document search to its BM25 engine and three module seams (async enrichers, a token reservation for `get_context_for_task`, ranked-context scopes).

Behaviour changes: `@ctxo/cli` no longer ships source maps in its npm package (about 2.1 MB to about 0.8 MB unpacked); `get_pr_impact` with an empty diff now carries `_meta` and goes through masking; `verify-domain` check 6 now errors on a `Code:` file that does not exist and on a `Tests:` or `Code:` value that names a directory, warns on a symbol ID the index does not hold (use `file#Name` for a plain test name, since `::` now marks a symbol ID) and on an unknown rule ID of a rule prefix in a production `rule:` comment; a `rule:` comment above a declaration links to that declaration; an H1 heading now ends a card's "Rules and invariants" section; and the `ctxo-domain-fold` skill marker moves to v0.15, so `ctxo doctor` reports older installed copies as outdated until `ctxo init --only domain` reinstalls them.
