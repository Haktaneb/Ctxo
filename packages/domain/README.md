# @ctxo/domain

The Ctxo domain knowledge layer, an opt-in module for `@ctxo/cli`. It lets a team name its bounded contexts, say which paths and which markdown card each one owns, and keep cards in step with code. Ctxo supplies structure, linkage, verification and retrieval; it never writes domain text.

```bash
ctxo install domain      # installs @ctxo/domain at this CLI's version
ctxo init --domain       # config defaults, registry skeleton, fold guard, skill
```

## What it adds

- A registry, `docs/domain/contexts.yaml`: context IDs, paths, cards, rungs and contracts.
- `ctxo contexts-touched`: which named contexts a set of changes touched, and whether each has a card change or a `Domain-Unchanged` trailer.
- A fold guard for Claude Code (`ctxo domain-guard-hook`): it blocks a session once when its commits changed a context without a card update or a trailer. Fail-open.
- `ctxo verify-domain`: the CI gate (eleven checks; exit 0, 1 or 2). Use `--since origin/main` with `fetch-depth: 0`.
- `ctxo domain rules --write | --check`: generated path-scoped loader rules, so the agent reads the card before it edits the context's code.
- `ctxo domain discover`: proposes tracker prefixes, rule trait keys and test folders from the repository.
- Boundaries and drift by named context, written to `.ctxo/index/domain/` by `ctxo index`.
- Additive fields on core tools: `context`, `contextBoundaryViolations`, `contextDrift`.
- The domain graph, `.ctxo/index/domain/graph.json`, built by `ctxo index` from the cards and the glossary: rules linked to tests (framework annotations, test titles, `rule:` comments, card `Tests:` lines) and to code (card `Code:` lines, `rule:` comments), decisions linked to provenance, terms linked to identifiers.
- Fields from the graph on core tools: `rulesAffected` and `cardsToUpdate` on `get_blast_radius`, `decisions` on `get_why_context`, `cardExcerpt` on `get_context_for_task` (within its token budget), `contextsTouched`, `cardsChanged` and `rulesWithoutTests` on `get_pr_impact`.
- Two MCP tools: `get_domain_context({ symbolId?, path? })`, the card of the context that owns a symbol or file, and `get_rule({ ruleId })`, one rule with its tests, symbols, decisions and provenance. Ctxo has 14 core tools; with this package, 16.
- The `domain` scope of `get_ranked_context` (`scope: "domain"`): BM25 over rules, terms, decisions, card sections and the in-repo files decisions link to.
- The `ctxo-domain-fold` skill and three `ctxo doctor` checks.

Without a registry, the commands print a hint and exit 0, no fields are added, and the two tools answer `{ found: false, hint }`.

## Version line

`@ctxo/domain` and `@ctxo/cli` share one version (a changesets `fixed` group). The module runs only against the `@ctxo/cli` minor it was built for: on a mismatch it logs a warning and stays inactive. It builds against the `@ctxo/cli/internal` API, as types only (ADR-018).

## Docs

- Feature doc and "Ctxo domain conventions v1": [docs/features/domain-knowledge.md](https://github.com/alperhankendi/Ctxo/blob/master/docs/features/domain-knowledge.md)
- Design record: [ADR-018](https://github.com/alperhankendi/Ctxo/blob/master/docs/architecture/ADR/adr-018-domain-knowledge-layer.md)
- Commands: [ctxo.dev domain commands](https://github.com/alperhankendi/Ctxo/blob/master/site/docs/cli/domain.md)
- Tools: [get_domain_context](https://github.com/alperhankendi/Ctxo/blob/master/site/docs/mcp-tools/get-domain-context.md), [get_rule](https://github.com/alperhankendi/Ctxo/blob/master/site/docs/mcp-tools/get-rule.md)
