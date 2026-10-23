# @ctxo/lang-typescript

## 0.8.0

### Minor Changes

- 5e7d482: Minor release: bump all packages to a new minor version line.

## 0.7.2

### Patch Changes

- 8db20d8: Patch release: dependency maintenance (zod 4.6.7) and CI action updates (setup-node 7.1.0, upload-artifact 7.0.2, test-reporter 3.2.0).
- Updated dependencies [8db20d8]
  - @ctxo/plugin-api@0.7.3

## 0.7.1

### Patch Changes

- 5b1ea92: Release pipeline hardening:

  - Release workflow now runs `pnpm -r typecheck` and `pnpm -r test` before publishing, so broken builds cannot ship to npm.
  - Verifies `NPM_TOKEN` secret is present before doing any work (fast fail with actionable message).
  - After publish, automatically fixes npm dist-tags so prerelease versions (`-alpha`, `-beta`, `-rc`, `-next`) move to the matching channel tag and `latest` stays pinned to the highest stable version.
  - All public packages now declare `publishConfig.access: public` and `publishConfig.provenance: true` so per-package npm publishes (manual or automated) keep provenance and visibility consistent.
  - New `dist-tag-repair` workflow available from the Actions tab to manually re-align dist-tags for any package, with a `dry_run` switch.

- Updated dependencies [5b1ea92]
  - @ctxo/plugin-api@0.7.1
