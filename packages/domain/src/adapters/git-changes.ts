import type { FileChange, IGitPort, RangeCommit } from '@ctxo/cli/internal';
import { resolveBaseRef } from '../core/base-resolver.js';
import type { DomainConfig } from '../core/domain-config.js';
import { DOMAIN_UNCHANGED_TRAILER } from '../core/trailer.js';

export type ResolvedBase =
  | { readonly base: string; readonly head: string }
  | { readonly error: 'unknown-ref' | 'no-merge-base' };

/**
 * Reads the git facts `contexts-touched` and the guard evaluate. The domain package has no `ports/`
 * (PF14): this adapter consumes the CLI's `IGitPort` and returns undefined on any git trouble.
 */
export class GitChangeReader {
  constructor(private readonly git: IGitPort) {}

  /** The default base ref (`resolveBaseRef`), or undefined when none is found. */
  async defaultBase(config: DomainConfig): Promise<string | undefined> {
    if (config.guard.base !== undefined) return config.guard.base;
    return resolveBaseRef(config, await this.git.getRefs?.());
  }

  /** Full SHAs of the merge base of `since` and HEAD, and of HEAD. */
  async resolveBase(since: string): Promise<ResolvedBase> {
    if ((await this.git.resolveCommit?.(since)) === undefined) return { error: 'unknown-ref' };
    const head = await this.git.resolveCommit?.('HEAD');
    if (head === undefined) return { error: 'unknown-ref' };
    const base = await this.git.mergeBase?.(since, 'HEAD');
    if (base === undefined) return { error: 'no-merge-base' };
    return { base, head };
  }

  async committed(exclude: readonly string[]): Promise<RangeCommit[] | undefined> {
    return this.git.getRangeLog?.({ head: 'HEAD', exclude }, { trailerKey: DOMAIN_UNCHANGED_TRAILER });
  }

  async workingTree(scope: 'all' | 'staged'): Promise<FileChange[] | undefined> {
    return this.git.getWorkingTreeChanges?.(scope);
  }
}
