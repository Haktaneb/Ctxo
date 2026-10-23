# @ctxo/domain

The Ctxo domain knowledge layer, an opt-in module for `@ctxo/cli`.

```bash
ctxo install domain
```

The module runs only against the `@ctxo/cli` minor it was built for: `@ctxo/domain` and `@ctxo/cli` share one version line (a changesets `fixed` group). On a mismatch it logs a warning and stays inactive. It builds against the `@ctxo/cli/internal` API, as types only (ADR-018).

This package is a skeleton in this release; later changes add the domain features.
