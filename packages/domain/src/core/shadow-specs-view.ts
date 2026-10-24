/**
 * The shadow-spec view of one context (spec 12.2): its candidates after the `shadow-specs.yaml` resolutions, the
 * counts, and what is wrong with the resolution file. `shadowSpecs` is the one list the response envelope truncates;
 * the three file reports are capped here (W28) and carry a `<name>Total` only when cut. Pure.
 */

import type { ContextNode } from './domain-graph.js';
import { CANDIDATE_KINDS, candidatesOf, compareCandidates, type CandidateKind, type ShadowCandidate } from './shadow-candidates.js';
import type { ResolutionEntry, ShadowSpecsProblem } from './shadow-specs-file.js';

/** The most stale entries, unknown rules or file problems one view lists (W28). */
export const SHADOW_VIEW_LIST_CAP = 50;

export interface ShadowSpecsViewInput {
  readonly context: ContextNode;
  /** Candidates with the file resolutions applied; other contexts' candidates are left out. */
  readonly candidates: readonly ShadowCandidate[];
  /** Undefined or empty: every kind. */
  readonly kinds?: readonly CandidateKind[];
  readonly includeResolved: boolean;
  readonly resolutionFile: string;
  readonly stale: readonly ResolutionEntry[];
  readonly unknownRules: readonly ResolutionEntry[];
  readonly problems: readonly ShadowSpecsProblem[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function byEntryLine(a: ResolutionEntry, b: ResolutionEntry): number {
  return a.line - b.line || compare(a.fingerprint, b.fingerprint);
}

function byProblemLine(a: ShadowSpecsProblem, b: ShadowSpecsProblem): number {
  return a.line - b.line || compare(a.severity, b.severity) || compare(a.message, b.message);
}

/** Sorted, capped at SHADOW_VIEW_LIST_CAP; `<name>Total` follows the list only when it was cut. */
function putCapped<T>(out: Record<string, unknown>, name: string, items: readonly T[]): void {
  out[name] = items.slice(0, SHADOW_VIEW_LIST_CAP);
  if (items.length > SHADOW_VIEW_LIST_CAP) out[`${name}Total`] = items.length;
}

/**
 * `{ context, counts, shadowSpecs, resolutionFile, staleResolutions, unknownRules, resolutionProblems }`. Counts are
 * per candidate (several may share a fingerprint) and cover the kinds filter; `byKind` lists the kinds that have
 * candidates, in `CANDIDATE_KINDS` order. `shadowSpecs` holds the open candidates, plus the resolved ones with
 * `includeResolved`, in `compareCandidates` order. An entry can be both stale and an unknown rule: the two lists are
 * reported as they are and never summed.
 */
export function shadowSpecsView(input: ShadowSpecsViewInput): Record<string, unknown> {
  const { context } = input;
  const scoped = candidatesOf(input.candidates, context.context, input.kinds).sort(compareCandidates);

  const perKind = new Map<string, { open: number; resolved: number }>();
  let open = 0;
  for (const candidate of scoped) {
    const counts = perKind.get(candidate.kind) ?? { open: 0, resolved: 0 };
    if (candidate.resolution === undefined) {
      counts.open++;
      open++;
    } else counts.resolved++;
    perKind.set(candidate.kind, counts);
  }
  const byKind: Record<string, { open: number; resolved: number }> = {};
  for (const kind of CANDIDATE_KINDS) {
    const counts = perKind.get(kind);
    if (counts !== undefined) byKind[kind] = counts;
  }

  const out: Record<string, unknown> = {
    context: { id: context.context, name: context.name, rung: context.rung },
    counts: { open, resolved: scoped.length - open, byKind },
    shadowSpecs: input.includeResolved ? scoped : scoped.filter((c) => c.resolution === undefined),
    resolutionFile: input.resolutionFile,
  };
  putCapped(
    out,
    'staleResolutions',
    [...input.stale].sort(byEntryLine).map((e) => ({ fingerprint: e.fingerprint, line: e.line })),
  );
  putCapped(
    out,
    'unknownRules',
    [...input.unknownRules]
      .sort(byEntryLine)
      .map((e) => ({ fingerprint: e.fingerprint, rule: 'rule' in e.resolution ? e.resolution.rule : '', line: e.line })),
  );
  putCapped(
    out,
    'resolutionProblems',
    [...input.problems].sort(byProblemLine).map((p) => ({ line: p.line, severity: p.severity, message: p.message })),
  );
  return out;
}
