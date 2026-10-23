import { isOnDefaultBranch, resolveBaseRef } from './base-resolver.js';
import type { TouchedContext } from './touched.js';
import { DOMAIN_UNCHANGED_TRAILER } from './trailer.js';

/**
 * The pure parts of the domain fold guard (spec 10.4, ADR-018 Decision 5): the hook payload, the branch
 * range, the per-session fingerprint and the reason text. `domain-guard-hook-command.ts` wires them to git
 * and the session store.
 */

export type HookEvent = 'SessionStart' | 'Stop' | 'SubagentStop' | 'TaskCompleted';

const HOOK_EVENTS: ReadonlySet<string> = new Set<HookEvent>(['SessionStart', 'Stop', 'SubagentStop', 'TaskCompleted']);

export interface GuardPayload {
  readonly sessionId: string;
  readonly event: HookEvent;
  readonly stopHookActive: boolean;
  readonly cwd?: string;
}

/** The Claude Code hook payload. Undefined when it is not a JSON object, has no session_id, or names another event. */
export function parseGuardPayload(raw: string): GuardPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sessionId = record['session_id'];
  const event = record['hook_event_name'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  if (typeof event !== 'string' || !HOOK_EVENTS.has(event)) return undefined;
  const cwd = record['cwd'];
  return {
    sessionId,
    event: event as HookEvent,
    stopHookActive: record['stop_hook_active'] === true,
    ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
  };
}

export interface BranchFacts {
  readonly currentBranch?: string;
  readonly originHead?: string;
  readonly branches: readonly string[];
  readonly upstream?: string;
  readonly configuredBase?: string;
}

/**
 * What to leave out of the session's commits besides `startHead` (spec 10.4 "Branch range", PF23, PF33).
 * On the default branch, before any configured base: its upstream (`@{u}..HEAD`, the unpushed commits), or
 * nothing without one, so `startHead..HEAD` alone counts. Elsewhere, a detached HEAD included: the merge
 * base with the ref `resolveBaseRef` picks (the configured base, origin/HEAD, `main`, `master`), or nothing
 * when none resolves.
 */
export function branchExclude(facts: BranchFacts): { readonly kind: 'upstream' | 'merge-base' | 'none'; readonly ref?: string } {
  const refs = {
    branches: facts.branches,
    ...(facts.currentBranch !== undefined ? { currentBranch: facts.currentBranch } : {}),
    ...(facts.originHead !== undefined ? { originHead: facts.originHead } : {}),
    ...(facts.upstream !== undefined ? { upstream: facts.upstream } : {}),
  };
  if (isOnDefaultBranch(refs)) {
    return facts.upstream !== undefined ? { kind: 'upstream', ref: facts.upstream } : { kind: 'none' };
  }
  const ref = resolveBaseRef({ guard: facts.configuredBase !== undefined ? { base: facts.configuredBase } : {} }, refs);
  return ref !== undefined ? { kind: 'merge-base', ref } : { kind: 'none' };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The HEAD SHA plus the sorted unresolved context IDs: the guard blocks once per fingerprint and session. */
export function guardFingerprint(head: string, unresolved: readonly string[]): string {
  return `${head}|${[...unresolved].sort(cmp).join(',')}`;
}

const MAX_FILES = 3;

/** The block reason (spec 10.4), at most three files per context (D11). */
export function formatGuardReason(contexts: readonly TouchedContext[]): string {
  const n = contexts.length;
  const lines = [`ctxo domain guard: ${n} ${n === 1 ? 'context has' : 'contexts have'} committed changes without a card update.`];
  for (const context of contexts) {
    const k = context.files.length;
    const shown = context.files.slice(0, MAX_FILES).join(', ');
    lines.push(`- ${context.id}: ${k} ${k === 1 ? 'file' : 'files'} (${shown}${k > MAX_FILES ? ', ...' : ''})`);
    lines.push(`  card: ${context.card ?? 'none'} (unchanged)`);
  }
  lines.push(
    'Update the card if behaviour changed (rules, decisions, contracts), then commit it.',
    'If behaviour did not change, add this trailer to a commit:',
    `  ${DOMAIN_UNCHANGED_TRAILER}: ${contexts.map((c) => c.id).join(', ')} (reason)`,
  );
  return lines.join('\n');
}
