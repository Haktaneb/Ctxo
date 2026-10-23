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
export function resolveBaseRef(
  config: { readonly guard: Pick<DomainConfig['guard'], 'base'> },
  refs: GitRefs | undefined,
): string | undefined {
  const configured = config.guard.base;
  if (configured !== undefined) return configured;
  if (refs === undefined) return undefined;

  if (isOnDefaultBranch(refs) && refs.upstream !== undefined) return refs.upstream;

  if (refs.originHead !== undefined) return refs.originHead;
  if (refs.branches.includes('main')) return 'main';
  if (refs.branches.includes('master')) return 'master';
  return undefined;
}

/**
 * Whether HEAD is on the default branch: origin/HEAD without its remote, else `main` or `master`. False on
 * a detached HEAD.
 */
export function isOnDefaultBranch(refs: Pick<GitRefs, 'currentBranch' | 'originHead'>): boolean {
  const current = refs.currentBranch;
  if (current === undefined) return false;
  const defaultBranch = refs.originHead !== undefined ? refs.originHead.slice(refs.originHead.indexOf('/') + 1) : undefined;
  return defaultBranch !== undefined ? current === defaultBranch : current === 'main' || current === 'master';
}
