---
"@ctxo/cli": patch
"@ctxo/lang-typescript": patch
"@ctxo/lang-go": patch
"@ctxo/lang-java": patch
"@ctxo/lang-csharp": patch
---

Fix `ctxo update` reporting an update forever after a successful install.

- `ctxo update` now reads CURRENT from the installed `package.json` in the project's `node_modules` instead of the running binary (often a stale global) or the plugin's self-reported version. `--global` still compares the running binary.
- When the running `ctxo` differs from the project's `@ctxo/cli`, `ctxo update` prints a hint to run `ctxo update --global` or use `npx ctxo`.
- `@ctxo/lang-typescript`, `@ctxo/lang-go`, `@ctxo/lang-java` and `@ctxo/lang-csharp` now read `plugin.version` from their own `package.json`. They previously reported a hardcoded `0.7.0-alpha.0` / `0.8.0-alpha.0` in `ctxo update`, `ctxo doctor` and `ctxo --version --verbose`.
