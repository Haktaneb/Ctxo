import type { GitRefs } from '@ctxo/cli/internal';
import type { DomainConfig } from './domain-config.js';

/**
 * The one base-ref resolver for `ctxo contexts-touched` and the safe-edit guard (PF23, spec 10.4):
 *
 * 1. the configured base (`domain.guard.base`);
 * 2. on the default branch, its upstream (the range is then `@{u}..HEAD`, the unpushed commits);
 * 3. origin/HEAD;
 * 4. `main`, then `master`, when such a branch exists.
 *
 * Returns the ref to take the merge base against, or undefined when nothing qualifies.
 */
export function resolveBaseRef(config: DomainConfig, refs: GitRefs | undefined): string | undefined {
  const configured = config.guard.base;
  if (configured !== undefined) return configured;
  if (refs === undefined) return undefined;

  const defaultBranch = refs.originHead !== undefined ? refs.originHead.slice(refs.originHead.indexOf('/') + 1) : undefined;
  const current = refs.currentBranch;
  const onDefault =
    current !== undefined &&
    (defaultBranch !== undefined ? current === defaultBranch : current === 'main' || current === 'master');
  if (onDefault && refs.upstream !== undefined) return refs.upstream;

  if (refs.originHead !== undefined) return refs.originHead;
  if (refs.branches.includes('main')) return 'main';
  if (refs.branches.includes('master')) return 'master';
  return undefined;
}
