import { describe, expect, it } from 'vitest';
import { contextNodeId, type ContextNode } from '../domain-graph.js';
import { compareCandidates, type CandidateKind, type ShadowCandidate } from '../shadow-candidates.js';
import type { ResolutionEntry, ShadowSpecsProblem } from '../shadow-specs-file.js';
import { SHADOW_VIEW_LIST_CAP, shadowSpecsView, type ShadowSpecsViewInput } from '../shadow-specs-view.js';

const CONTEXT: ContextNode = { id: contextNodeId('lending'), context: 'lending', name: 'Lending', rung: 'named', card: 'docs/domain/lending/domain.md' };
const RESOLUTION_FILE = 'docs/domain/lending/shadow-specs.yaml';

function candidate(kind: CandidateKind, line: number, extra: Partial<ShadowCandidate> = {}): ShadowCandidate {
  return {
    fingerprint: `${kind} | LoanPolicy.CanBorrow | text ${line}`,
    kind,
    context: 'lending',
    file: 'src/Lending/LoanPolicy.cs',
    line,
    text: `text ${line}`,
    source: 'native',
    ...extra,
  };
}

const OPEN_LIMIT = candidate('literal-comparison', 12);
const RESOLVED_LIMIT = candidate('literal-comparison', 20, { resolution: { by: 'shadow-specs', rule: 'LEND-03' } });
const OPEN_ENDPOINT = candidate('endpoint', 5);
const RESOLVED_RETRY = candidate('retry-timeout', 30, { resolution: { by: 'shadow-specs', notARule: 'transport timeout' } });
const OTHER_CONTEXT = candidate('endpoint', 1, { context: 'billing', file: 'src/Billing/Api.cs' });
// Out of order on purpose: the view sorts.
const CANDIDATES = [RESOLVED_RETRY, OPEN_LIMIT, OTHER_CONTEXT, RESOLVED_LIMIT, OPEN_ENDPOINT];

function entry(fingerprint: string, line: number, rule?: string): ResolutionEntry {
  return { fingerprint, resolution: rule === undefined ? { notARule: 'reason' } : { rule }, line };
}

function inputOf(over: Partial<ShadowSpecsViewInput> = {}): ShadowSpecsViewInput {
  return {
    context: CONTEXT,
    candidates: CANDIDATES,
    includeResolved: false,
    resolutionFile: RESOLUTION_FILE,
    stale: [],
    unknownRules: [],
    problems: [],
    ...over,
  };
}

describe('shadowSpecsView', () => {
  it('open candidates only unless includeResolved', () => {
    const open = shadowSpecsView(inputOf());
    expect(open['context']).toEqual({ id: 'lending', name: 'Lending', rung: 'named' });
    expect(open['shadowSpecs']).toEqual([OPEN_ENDPOINT, OPEN_LIMIT]);
    expect(open['counts']).toEqual({
      open: 2,
      resolved: 2,
      byKind: { 'literal-comparison': { open: 1, resolved: 1 }, 'retry-timeout': { open: 0, resolved: 1 }, endpoint: { open: 1, resolved: 0 } },
    });
    expect(open['resolutionFile']).toBe(RESOLUTION_FILE);

    const all = shadowSpecsView(inputOf({ includeResolved: true }));
    const expected = [OPEN_ENDPOINT, OPEN_LIMIT, RESOLVED_LIMIT, RESOLVED_RETRY].sort(compareCandidates);
    expect(all['shadowSpecs']).toEqual(expected);
    expect(all['shadowSpecs']).toEqual([OPEN_ENDPOINT, OPEN_LIMIT, RESOLVED_LIMIT, RESOLVED_RETRY]);
    expect(all['counts']).toEqual(open['counts']);
  });

  it('counts cover the kinds filter', () => {
    const view = shadowSpecsView(inputOf({ kinds: ['literal-comparison', 'procedure'], includeResolved: true }));
    expect(view['shadowSpecs']).toEqual([OPEN_LIMIT, RESOLVED_LIMIT]);
    expect(view['counts']).toEqual({ open: 1, resolved: 1, byKind: { 'literal-comparison': { open: 1, resolved: 1 } } });
  });

  it('an empty kinds list means every kind', () => {
    expect(shadowSpecsView(inputOf({ kinds: [] }))).toEqual(shadowSpecsView(inputOf()));
  });

  it('counts candidates one by one, also when several share a fingerprint', () => {
    const twin = { ...OPEN_LIMIT, line: 40 };
    const view = shadowSpecsView(inputOf({ candidates: [OPEN_LIMIT, twin] }));
    expect(view['counts']).toEqual({ open: 2, resolved: 0, byKind: { 'literal-comparison': { open: 2, resolved: 0 } } });
    expect(view['shadowSpecs']).toEqual([OPEN_LIMIT, twin]);
  });

  it('reports stale entries, unknown rules and problems in line order', () => {
    const fpA = 'literal-comparison | Old.Check | x > 1';
    const fpB = 'endpoint | Old.Get | GET /old';
    const problems: ShadowSpecsProblem[] = [
      { line: 9, severity: 'warning', message: 'duplicate fingerprint; the entry at line 3 wins' },
      { line: 2, severity: 'error', message: 'resolution must be { rule: <ID> } or { notARule: <reason> }' },
    ];
    const view = shadowSpecsView(
      inputOf({
        stale: [entry(fpB, 7), entry(fpA, 3, 'NOPE-01')],
        unknownRules: [entry(fpA, 3, 'NOPE-01')],
        problems,
      }),
    );
    expect(view['staleResolutions']).toEqual([
      { fingerprint: fpA, line: 3 },
      { fingerprint: fpB, line: 7 },
    ]);
    // The same entry is in both lists: they are reported as they are, never merged or summed.
    expect(view['unknownRules']).toEqual([{ fingerprint: fpA, rule: 'NOPE-01', line: 3 }]);
    expect(view['resolutionProblems']).toEqual([problems[1], problems[0]]);
    expect(Object.keys(view)).not.toContain('staleResolutionsTotal');
    expect(Object.keys(view)).not.toContain('unknownRulesTotal');
    expect(Object.keys(view)).not.toContain('resolutionProblemsTotal');
  });

  it('lists sit at the top level so the envelope can truncate shadowSpecs, staleResolutions, unknownRules and resolutionProblems', () => {
    const view = shadowSpecsView(inputOf());
    expect(Object.keys(view)).toEqual(['context', 'counts', 'shadowSpecs', 'resolutionFile', 'staleResolutions', 'unknownRules', 'resolutionProblems']);
    for (const key of ['shadowSpecs', 'staleResolutions', 'unknownRules', 'resolutionProblems']) expect(Array.isArray(view[key])).toBe(true);
  });

  it(`caps staleResolutions at ${SHADOW_VIEW_LIST_CAP} in line order and adds staleResolutionsTotal`, () => {
    const stale = Array.from({ length: 60 }, (_, i) => entry(`endpoint | Old.Get | GET /old/${i}`, 60 - i));
    const view = shadowSpecsView(inputOf({ stale }));
    const list = view['staleResolutions'] as { fingerprint: string; line: number }[];
    expect(SHADOW_VIEW_LIST_CAP).toBe(50);
    expect(list).toHaveLength(50);
    expect(list.map((s) => s.line)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(view['staleResolutionsTotal']).toBe(60);
    expect(Object.keys(view).indexOf('staleResolutionsTotal')).toBe(Object.keys(view).indexOf('staleResolutions') + 1);
    expect(Object.keys(view)).not.toContain('unknownRulesTotal');
  });

  it('caps unknownRules at 50 in line order and adds unknownRulesTotal', () => {
    const unknownRules = Array.from({ length: 51 }, (_, i) => entry(`endpoint | Old.Get | GET /old/${i}`, 100 - i, `NOPE-${i}`));
    const view = shadowSpecsView(inputOf({ unknownRules }));
    const list = view['unknownRules'] as { rule: string; line: number }[];
    expect(list).toHaveLength(50);
    expect(list[0]).toEqual({ fingerprint: 'endpoint | Old.Get | GET /old/50', rule: 'NOPE-50', line: 50 });
    expect(list.every((u, i) => i === 0 || list[i - 1]!.line < u.line)).toBe(true);
    expect(view['unknownRulesTotal']).toBe(51);
    expect(Object.keys(view)).not.toContain('staleResolutionsTotal');
  });

  it('caps resolutionProblems at 50 in line order and adds resolutionProblemsTotal', () => {
    const problems: ShadowSpecsProblem[] = Array.from({ length: 75 }, (_, i) => ({ line: 75 - i, severity: 'error', message: `problem ${75 - i}` }));
    const view = shadowSpecsView(inputOf({ problems }));
    const list = view['resolutionProblems'] as ShadowSpecsProblem[];
    expect(list).toHaveLength(50);
    expect(list[0]).toEqual({ line: 1, severity: 'error', message: 'problem 1' });
    expect(list[49]!.line).toBe(50);
    expect(view['resolutionProblemsTotal']).toBe(75);
  });

  it('exactly 50 items are not cut and get no Total', () => {
    const stale = Array.from({ length: 50 }, (_, i) => entry(`endpoint | Old.Get | GET /old/${i}`, i + 1));
    const view = shadowSpecsView(inputOf({ stale }));
    expect(view['staleResolutions']).toHaveLength(50);
    expect(Object.keys(view)).not.toContain('staleResolutionsTotal');
  });

  it('does not change its inputs and gives deep-equal views for the same input', () => {
    const candidates = [...CANDIDATES];
    const stale = [entry('endpoint | Old.Get | GET /b', 9), entry('endpoint | Old.Get | GET /a', 4)];
    const first = shadowSpecsView(inputOf({ candidates, stale, includeResolved: true }));
    expect(candidates).toEqual(CANDIDATES);
    expect(stale.map((s) => s.line)).toEqual([9, 4]);
    expect(shadowSpecsView(inputOf({ candidates, stale, includeResolved: true }))).toEqual(first);
  });
});
