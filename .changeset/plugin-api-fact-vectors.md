---
"@ctxo/plugin-api": patch
---

Third-party plugin authors were told to test their fact detectors against the conformance vectors, but the npm package did not contain them. `@ctxo/plugin-api` now ships `conformance/fact-vectors.json` (read it from `node_modules/@ctxo/plugin-api/conformance/fact-vectors.json`), the vectors every official plugin's fact rules are tested against. The type docs now say that `CodeFact.text` and the official plugins' `detail.literal` are capped at 200 Unicode code points (not characters, never inside a surrogate pair) and that `PluginContext.config.facts` is a host-reserved key holding the fact detector options, set only when facts are requested. No API change.
