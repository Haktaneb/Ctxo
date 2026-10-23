---
"@ctxo/cli": patch
---

`find_dead_code` recognises test files with the shared test-file classifier (the default test globs plus every file in which a test-framework annotation such as `@Test` marks a symbol) instead of its own path patterns, which missed `_test.go`, `src/test/java`, `*.test.js` and `*.test.tsx` files (#156). Unless `includeTests` is set, test symbols are never reported dead, even without outgoing edges, and production code called only from tests is not dead, so Go functions whose only callers are tests are no longer reported. As a deliberate consequence, production code under a folder named `test/` or `src/test/`, and any file with a test-annotated symbol, is now left out of the analysis as well.
