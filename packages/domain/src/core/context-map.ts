/**
 * The context map (spec 12.3, H9 to H12): per registry context its card, rules, tests, cross-context edges,
 * co-change, drift, boundary violations and shadow-spec candidates, the owner's rung, a suggested rung and the
 * status of every rung criterion. Each criterion is computed on its own, so the owner sees what blocks the next
 * rung even when a lower one already fails. Pure: the caller loads the artifacts; the suggestion never changes the
 * registry.
 */

import type { BoundaryViolationRecord, CrossContextSummary } from './boundaries.js';
import { contextDrift, type ContextDrift, type ContextHistoryEntry, type MovedFile } from './context-metrics.js';
import { REPO_WIDE_CONTEXT, type TermNode } from './domain-graph.js';
import { rulesWithoutTests, type DomainSnapshot } from './domain-graph-query.js';
import type { ContextMaturityFacts, CrossContextCoChange, MaturityArtifact } from './maturity.js';
import { RUNGS, type DomainContext, type Rung } from './registry.js';
import type { ShadowCandidate } from './shadow-candidates.js';

/** The most Language terms without a glossary entry one `named` status lists. */
export const NAMED_MISSING_CAP = 10;

export interface PinnedStatus {
  readonly met: boolean;
  readonly mainPaths: number;
  readonly reached: number;
  /** `reached / mainPaths` rounded to 3 decimals for display; null without main paths. `met` compares the exact ratio. */
  readonly coverage: number | null;
  readonly threshold: number;
  readonly characterizationTests: number;
  readonly unreached: readonly string[];
}

export interface NamedStatus {
  readonly met: boolean;
  readonly card: boolean;
  readonly terms: number;
  readonly inGlossary: number;
  /** Language terms without a glossary entry, in card order, at most NAMED_MISSING_CAP. */
  readonly missing: readonly string[];
}

export interface BoundedStatus {
  readonly met: boolean;
  readonly contractSymbols: number;
  readonly reached: number;
  readonly unreached: readonly string[];
  readonly boundaryViolations: number;
}

export interface BoringStatus {
  readonly met: boolean;
  readonly rules: number;
  readonly rulesWithoutTests: number;
  readonly openCandidates: number;
}

export interface ContextMapEntry {
  readonly id: string;
  readonly name: string;
  readonly rung: Rung;
  readonly suggestedRung: Rung;
  readonly card: { readonly path?: string; readonly present: boolean };
  readonly rules: { readonly count: number; readonly withTests: number; readonly share: number | null };
  readonly tests: { readonly characterization: number; readonly contract: number };
  readonly crossContextEdges: { readonly in: number; readonly out: number };
  readonly coChange: { readonly pairs: number; readonly top: readonly CrossContextCoChange[] };
  readonly drift: {
    readonly crossShare: ContextDrift['crossShare'];
    readonly movedFiles: number;
    readonly distinctCommits: number;
    readonly confidence: ContextDrift['confidence'];
  } | null;
  readonly boundaryViolations: { readonly total: number; readonly errors: number; readonly warnings: number };
  readonly shadowSpecs: { readonly open: number; readonly resolved: number };
  readonly criteria: { readonly pinned: PinnedStatus; readonly named: NamedStatus; readonly bounded: BoundedStatus; readonly boring: BoringStatus };
  /**
   * False when no boundaries artifact was given: the cross-edge and violation counts are 0 and unknown, and
   * `bounded` (so also `boring`) is not met.
   */
  readonly boundariesKnown: boolean;
}

export interface RungCriteriaMet {
  readonly pinned: boolean;
  readonly named: boolean;
  readonly bounded: boolean;
  readonly boring: boolean;
}

/** The boundary facts the map reads (W9: core types, not the stored artifact). */
export interface ContextMapBoundaries {
  readonly crossEdges: readonly CrossContextSummary[];
  readonly violations: readonly BoundaryViolationRecord[];
}

export interface ContextMapInput {
  readonly snapshot: DomainSnapshot;
  /** Absent when no boundaries artifact exists: counts stay 0, `boundariesKnown` is false and `bounded` is not met. */
  readonly boundaries?: ContextMapBoundaries;
  readonly history: readonly ContextHistoryEntry[];
  readonly movedFiles: readonly MovedFile[];
  /** Its `registryHash` selects the drift history; the caller checks it against the registry. */
  readonly maturity: MaturityArtifact;
  /** Every context's candidates, with the `shadow-specs.yaml` resolutions applied. */
  readonly candidates: readonly ShadowCandidate[];
  readonly cardExists: (repoPath: string) => boolean;
}

export interface ContextMapView {
  readonly contextMap: readonly ContextMapEntry[];
  readonly summary: { readonly contexts: number; readonly agree: number; readonly suggestedAbove: number; readonly suggestedBelow: number };
  readonly settings: { readonly pinnedCoverage: number };
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const LADDER = RUNGS.filter((rung): rung is Exclude<Rung, 'fear'> => rung !== 'fear');
const RUNG_RANK = new Map<Rung, number>(RUNGS.map((rung, i) => [rung, i]));

/** The highest rung whose criterion and every lower one are met (the ladder is cumulative); `fear` otherwise. */
export function suggestRung(met: RungCriteriaMet): Rung {
  let rung: Rung = 'fear';
  for (const step of LADDER) {
    if (!met[step]) break;
    rung = step;
  }
  return rung;
}

function emptyFacts(context: string): ContextMaturityFacts {
  return {
    context,
    tests: { characterization: 0, contract: 0 },
    mainPaths: { total: 0, reached: 0, unreached: [] },
    contractSymbols: { total: 0, reached: 0, unreached: [] },
    coChange: { pairs: 0, top: [] },
  };
}

function pinnedStatus(facts: ContextMaturityFacts, threshold: number): PinnedStatus {
  const { total, reached, unreached } = facts.mainPaths;
  const coverage = total === 0 ? null : round3(reached / total);
  const characterizationTests = facts.tests.characterization;
  return {
    met: total === 0 ? characterizationTests >= 1 : reached / total >= threshold,
    mainPaths: total,
    reached,
    coverage,
    threshold,
    characterizationTests,
    unreached: [...unreached],
  };
}

const hasOrigin = (term: TermNode, origin: 'card' | 'glossary'): boolean => term.definitions.some((d) => d.origin === origin);

function namedStatus(context: DomainContext, snapshot: DomainSnapshot, cardExists: (path: string) => boolean): NamedStatus {
  const card = context.card !== undefined && cardExists(context.card);
  const repoWide = new Set((snapshot.index.termsByContext.get(REPO_WIDE_CONTEXT) ?? []).map((t) => t.key));
  const language = (snapshot.index.termsByContext.get(context.id) ?? []).filter((t) => hasOrigin(t, 'card'));
  const missing = language.filter((t) => !hasOrigin(t, 'glossary') && !repoWide.has(t.key)).map((t) => t.term);
  const inGlossary = language.length - missing.length;
  return {
    met: card && language.length >= 1 && inGlossary === language.length,
    card,
    terms: language.length,
    inGlossary,
    missing: missing.slice(0, NAMED_MISSING_CAP),
  };
}

function boundedStatus(facts: ContextMaturityFacts, violations: number, known: boolean): BoundedStatus {
  const { total, reached, unreached } = facts.contractSymbols;
  return { met: known && reached >= total && violations === 0, contractSymbols: total, reached, unreached: [...unreached], boundaryViolations: violations };
}

const sumKinds = (byKind: Readonly<Record<string, number>>): number => Object.values(byKind).reduce((sum, n) => sum + n, 0);

function entryOf(context: DomainContext, input: ContextMapInput, facts: ContextMaturityFacts): ContextMapEntry {
  const { snapshot } = input;
  const id = context.id;

  const rules = snapshot.index.rulesByContext.get(id) ?? [];
  const withoutTests = rulesWithoutTests(snapshot.index, [id]).length;
  const withTests = rules.length - withoutTests;

  let edgesIn = 0;
  let edgesOut = 0;
  for (const edge of input.boundaries?.crossEdges ?? []) {
    if (edge.to === id) edgesIn += sumKinds(edge.byKind);
    if (edge.from === id) edgesOut += sumKinds(edge.byKind);
  }

  let errors = 0;
  let warnings = 0;
  for (const v of input.boundaries?.violations ?? []) {
    if (v.from.context !== id && v.to.context !== id) continue;
    if (v.severity === 'error') errors++;
    else warnings++;
  }
  const violations = errors + warnings;

  let open = 0;
  let resolved = 0;
  for (const candidate of input.candidates) {
    if (candidate.context !== id) continue;
    if (candidate.resolution === undefined) open++;
    else resolved++;
  }

  const drift = contextDrift(id, input.history, input.movedFiles, input.maturity.registryHash);

  const pinned = pinnedStatus(facts, snapshot.config.rungs.pinnedCoverage);
  const named = namedStatus(context, snapshot, input.cardExists);
  const boundariesKnown = input.boundaries !== undefined;
  const bounded = boundedStatus(facts, violations, boundariesKnown);
  const boring: BoringStatus = { met: withoutTests === 0 && open === 0, rules: rules.length, rulesWithoutTests: withoutTests, openCandidates: open };

  return {
    id,
    name: context.name,
    rung: context.rung,
    suggestedRung: suggestRung({ pinned: pinned.met, named: named.met, bounded: bounded.met, boring: boring.met }),
    card: { ...(context.card === undefined ? {} : { path: context.card }), present: named.card },
    rules: { count: rules.length, withTests, share: rules.length === 0 ? null : round3(withTests / rules.length) },
    tests: { characterization: facts.tests.characterization, contract: facts.tests.contract },
    crossContextEdges: { in: edgesIn, out: edgesOut },
    coChange: { pairs: facts.coChange.pairs, top: [...facts.coChange.top] },
    drift:
      drift === undefined
        ? null
        : { crossShare: drift.crossShare, movedFiles: drift.movedFiles.length, distinctCommits: drift.distinctCommits, confidence: drift.confidence },
    boundaryViolations: { total: violations, errors, warnings },
    shadowSpecs: { open, resolved },
    criteria: { pinned, named, bounded, boring },
    boundariesKnown,
  };
}

/** One entry per registry context, in registry order. A context missing from the maturity artifact counts zero. */
export function buildContextMap(input: ContextMapInput): ContextMapView {
  const factsById = new Map(input.maturity.contexts.map((f) => [f.context, f]));
  const contextMap = input.snapshot.registry.contexts.map((context) => entryOf(context, input, factsById.get(context.id) ?? emptyFacts(context.id)));

  let agree = 0;
  let suggestedAbove = 0;
  let suggestedBelow = 0;
  for (const entry of contextMap) {
    const diff = RUNG_RANK.get(entry.suggestedRung)! - RUNG_RANK.get(entry.rung)!;
    if (diff === 0) agree++;
    else if (diff > 0) suggestedAbove++;
    else suggestedBelow++;
  }

  return {
    contextMap,
    summary: { contexts: contextMap.length, agree, suggestedAbove, suggestedBelow },
    settings: { pinnedCoverage: input.snapshot.config.rungs.pinnedCoverage },
  };
}
