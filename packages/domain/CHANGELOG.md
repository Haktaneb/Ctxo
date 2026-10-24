# @ctxo/domain

## 0.16.1

## 0.16.0

### Minor Changes

- 663f7ea: Business rules that live only in code are invisible to the cards an agent reads, so it can break them without breaking a test; this release finds them (#156 Phase 4). The TypeScript, C#, Java and Go plugins now detect literal comparisons, string normalization, retry and timeout values and public endpoints in every tier they have with one shared rule set (the analyzers collect evidence behind `--facts=`), and with `@ctxo/domain` and its registry file (`domain.registry`), or with `index.facts: true`, every indexed file of these languages gets a `facts` array (possibly empty) in its index JSON on the next re-index, so run a full `ctxo index` once after upgrading and again after adding the registry. Without a registry `@ctxo/domain` requests no facts, and the index is byte-identical to a run without the package. A fact extraction failure in any of the four plugins warns on stderr and gives `facts: []` for that file; TypeScript `typeof` guards give no facts; in `ctxo watch` a saved Go file takes its facts from the tree-sitter tier and a saved Java file reads the keep-alive analyzer's result without starting a second JVM. `@ctxo/domain` adds a text-scan fallback, `find_shadow_specs` and `get_context_map` (14 core tools, 18 with the package), `ctxo domain shadow-specs <context>`, `ctxo domain map`, `shadow-specs.yaml` resolutions and `ctxo verify-domain` check 12, plus the `domain.facts`, `domain.tests.characterization`, `domain.tests.contract` and `domain.rungs` config keys. Fingerprints go into `shadow-specs.yaml` as YAML single-quoted scalars (`- fingerprint: '...'`), the form `ctxo domain shadow-specs` prints. When `ctxo index` builds the domain graph but not the candidates or the maturity facts, it removes both loop artifacts, so the tools ask for a new `ctxo index` instead of serving old data. The `ctxo-domain-fold` skill marker moved to v0.16: run `ctxo init --domain` or `ctxo doctor --fix` after upgrading to refresh copies installed by 0.15.

## 0.15.0

### Minor Changes

- 2054a25: `@ctxo/domain` builds a domain graph from cards (rules, terms, decisions) linked to tests, code and provenance, adds `get_domain_context`, `get_rule` and a domain scope for `get_ranked_context`, and adds rule and card fields to `get_blast_radius`, `get_context_for_task`, `get_why_context` and `get_pr_impact` (#156). `@ctxo/cli` adds document search to its BM25 engine and three module seams (async enrichers, a token reservation for `get_context_for_task`, ranked-context scopes).

  Behaviour changes: `@ctxo/cli` no longer ships source maps in its npm package (about 2.1 MB to about 0.8 MB unpacked); `get_pr_impact` with an empty diff now carries `_meta` and goes through masking; `verify-domain` check 6 now errors on a `Code:` file that does not exist and on a `Tests:` or `Code:` value that names a directory, warns on a symbol ID the index does not hold (use `file#Name` for a plain test name, since `::` now marks a symbol ID) and on an unknown rule ID of a rule prefix in a production `rule:` comment; a `rule:` comment above a declaration links to that declaration; an H1 heading now ends a card's "Rules and invariants" section; and the `ctxo-domain-fold` skill marker moves to v0.15, so `ctxo doctor` reports older installed copies as outdated until `ctxo init --only domain` reinstalls them.

## 0.14.0

### Minor Changes

- 979bed8: The opt-in `@ctxo/domain` package adds a context registry, `contexts-touched`, a fold guard, `verify-domain`, loader rules and boundary checks by named context (#156). `@ctxo/cli` loads it through an internal API and supports one global install for MCP, hooks and CLI.
