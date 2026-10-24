import { describe, expect, it } from 'vitest';
import type { BoundaryViolationRecord, CrossContextSummary } from '../boundaries.js';
import { buildContextMap, suggestRung, type ContextMapBoundaries, type ContextMapInput } from '../context-map.js';
import type { ContextHistoryEntry, MovedFile } from '../context-metrics.js';
import { DEFAULT_DOMAIN_CONFIG } from '../domain-config.js';
import {
  contextNodeId,
  REPO_WIDE_CONTEXT,
  ruleNodeId,
  termKey,
  termNodeId,
  type DomainGraph,
  type DomainLink,
  type RuleNode,
  type TermDefinition,
  type TermNode,
} from '../domain-graph.js';
import { indexGraph, type DomainSnapshot } from '../domain-graph-query.js';
import type { ContextMaturityFacts, CrossContextCoChange, MaturityArtifact } from '../maturity.js';
import type { Ownership } from '../ownership.js';
import type { DomainContext, DomainRegistry, Rung } from '../registry.js';
import type { ShadowCandidate } from '../shadow-candidates.js';

const REGISTRY_HASH = '0123456789abcdef';
const LENDING_CARD = 'docs/domain/lending/domain.md';
const BILLING_CARD = 'docs/domain/billing/domain.md';
const GLOSSARY = 'docs/domain/glossary.md';

function ctx(id: string, extra: Partial<DomainContext> = {}): DomainContext {
  return { id, name: id[0]!.toUpperCase() + id.slice(1), paths: [`src/${id}/**`], rung: 'fear', contracts: {}, ...extra };
}

const LENDING = ctx('lending', { card: LENDING_CARD, rung: 'named' });
const BILLING = ctx('billing', { card: BILLING_CARD, rung: 'fear' });
const AUDIT = ctx('audit', { rung: 'pinned' });

const NO_OWNERSHIP: Ownership = {
  owners: () => [],
  ownerOf: () => undefined,
  isAllowedUnowned: () => false,
  isContract: () => false,
};

function registryOf(contexts: readonly DomainContext[]): DomainRegistry {
  return { version: 1, contexts, unownedAllow: [], glossary: GLOSSARY, contextMap: 'docs/domain/context-map.md' };
}

function rule(ruleId: string, context: string, card: string, line: number, untested?: string): RuleNode {
  return {
    id: ruleNodeId(ruleId),
    ruleId,
    context,
    card,
    title: `${ruleId} title`,
    line,
    text: '',
    ...(untested === undefined ? {} : { untested }),
  };
}

function testLink(ruleId: string, file: string): DomainLink {
  return { kind: 'rule-test', from: ruleNodeId(ruleId), to: { file }, source: 'mention', at: { file, line: 1 } };
}

function def(origin: TermDefinition['origin'], line: number): TermDefinition {
  return { text: 'a definition', at: { file: origin === 'card' ? LENDING_CARD : GLOSSARY, line }, origin };
}

function term(context: string, name: string, definitions: readonly TermDefinition[]): TermNode {
  return { id: termNodeId(context, name), context, key: termKey(name), term: name, definitions, identifierCount: 0 };
}

interface GraphParts {
  readonly rules?: readonly RuleNode[];
  readonly terms?: readonly TermNode[];
  readonly links?: readonly DomainLink[];
}

function snapshotOf(registry: DomainRegistry, parts: GraphParts = {}, pinnedCoverage = 0.8): DomainSnapshot {
  const graph: DomainGraph = {
    ctxoArtifact: 'domain-graph',
    version: 1,
    registryHash: REGISTRY_HASH,
    cardsHash: 'fedcba9876543210',
    contexts: registry.contexts.map((c) => ({
      id: contextNodeId(c.id),
      context: c.id,
      name: c.name,
      rung: c.rung,
      ...(c.card === undefined ? {} : { card: c.card }),
    })),
    rules: parts.rules ?? [],
    terms: parts.terms ?? [],
    decisions: [],
    sections: [],
    openQuestions: [],
    links: parts.links ?? [],
    unresolved: [],
  };
  return {
    registry,
    registryPath: 'docs/domain/contexts.yaml',
    config: { ...DEFAULT_DOMAIN_CONFIG, rungs: { pinnedCoverage } },
    ownership: NO_OWNERSHIP,
    graph,
    index: indexGraph(graph),
    staleCards: false,
    generation: 1,
  };
}

interface FactsOver {
  readonly characterization?: number;
  readonly contract?: number;
  readonly mainPaths?: readonly [number, number, (readonly string[])?];
  readonly contractSymbols?: readonly [number, number, (readonly string[])?];
  readonly coChange?: { readonly pairs: number; readonly top: readonly CrossContextCoChange[] };
}

function facts(context: string, over: FactsOver = {}): ContextMaturityFacts {
  const [mTotal, mReached, mUnreached] = over.mainPaths ?? [0, 0];
  const [cTotal, cReached, cUnreached] = over.contractSymbols ?? [0, 0];
  return {
    context,
    tests: { characterization: over.characterization ?? 0, contract: over.contract ?? 0 },
    mainPaths: { total: mTotal, reached: mReached, unreached: mUnreached ?? [] },
    contractSymbols: { total: cTotal, reached: cReached, unreached: cUnreached ?? [] },
    coChange: over.coChange ?? { pairs: 0, top: [] },
  };
}

function maturityOf(contexts: readonly ContextMaturityFacts[]): MaturityArtifact {
  return { ctxoArtifact: 'domain-maturity', version: 1, registryHash: REGISTRY_HASH, cardsHash: 'fedcba9876543210', contexts };
}

function candidate(context: string, line: number, resolved = false): ShadowCandidate {
  return {
    fingerprint: `literal-comparison | Policy.Check | x >= ${line}`,
    kind: 'literal-comparison',
    context,
    file: `src/${context}/Policy.cs`,
    line,
    text: `x >= ${line}`,
    source: 'native',
    ...(resolved ? { resolution: { by: 'shadow-specs' as const, notARule: 'not a rule' } } : {}),
  };
}

function violation(from: string, to: string, severity: BoundaryViolationRecord['severity']): BoundaryViolationRecord {
  return {
    from: { symbolId: `src/${from}/A.cs::A::class`, file: `src/${from}/A.cs`, context: from },
    to: { symbolId: `src/${to}/B.cs::B::class`, file: `src/${to}/B.cs`, context: to },
    edgeKind: 'calls',
    severity,
  };
}

function cross(from: string, to: string, byKind: Record<string, number>): CrossContextSummary {
  return { from, to, byKind, allowed: 0, violations: 0 };
}

const ALWAYS = (): boolean => true;

function inputOf(over: Partial<ContextMapInput> & Pick<ContextMapInput, 'snapshot'>): ContextMapInput {
  return {
    history: [],
    movedFiles: [],
    maturity: maturityOf([]),
    candidates: [],
    cardExists: ALWAYS,
    // Known and empty unless a test passes others or `boundaries: undefined`.
    boundaries: { crossEdges: [], violations: [] },
    ...over,
  };
}

/** One context, every criterion met unless the test changes it. */
function singleContext(context: DomainContext = LENDING): { snapshotParts: GraphParts; maturity: ContextMaturityFacts } {
  return {
    snapshotParts: {
      rules: [rule('LEND-01', context.id, LENDING_CARD, 10)],
      terms: [term(context.id, 'Loan', [def('card', 7), def('glossary', 3)])],
      links: [testLink('LEND-01', 'tests/LoanTests.cs')],
    },
    maturity: facts(context.id, { characterization: 1, contract: 1, mainPaths: [5, 5], contractSymbols: [2, 2] }),
  };
}

function entryOf(view: ReturnType<typeof buildContextMap>, id: string) {
  const entry = view.contextMap.find((e) => e.id === id);
  if (entry === undefined) throw new Error(`no entry ${id}`);
  return entry;
}

describe('suggestRung', () => {
  const none = { pinned: false, named: false, bounded: false, boring: false };
  it.each<[string, typeof none, Rung]>([
    ['nothing', none, 'fear'],
    ['pinned', { ...none, pinned: true }, 'pinned'],
    ['pinned and named', { ...none, pinned: true, named: true }, 'named'],
    ['named alone', { ...none, named: true }, 'fear'],
    ['all four', { pinned: true, named: true, bounded: true, boring: true }, 'boring'],
    ['pinned, named and boring without bounded', { pinned: true, named: true, bounded: false, boring: true }, 'named'],
  ])('suggestRung follows the cumulative ladder: %s', (_label, met, expected) => {
    expect(suggestRung(met)).toBe(expected);
  });
});

describe('buildContextMap criteria', () => {
  it('pinned uses coverage against pinnedCoverage and falls back to a characterization test without main paths', () => {
    const contexts = [ctx('a'), ctx('b'), ctx('c'), ctx('d')];
    const view = buildContextMap(
      inputOf({
        snapshot: snapshotOf(registryOf(contexts)),
        maturity: maturityOf([
          facts('a', { mainPaths: [5, 4, ['src/a/X.cs::X::method']] }),
          facts('b', { mainPaths: [5, 3, ['src/b/X.cs::X::method', 'src/b/Y.cs::Y::method']], characterization: 4 }),
          facts('c'),
          facts('d', { characterization: 1 }),
        ]),
      }),
    );
    expect(entryOf(view, 'a').criteria.pinned).toEqual({
      met: true,
      mainPaths: 5,
      reached: 4,
      coverage: 0.8,
      threshold: 0.8,
      characterizationTests: 0,
      unreached: ['src/a/X.cs::X::method'],
    });
    expect(entryOf(view, 'b').criteria.pinned).toMatchObject({ met: false, coverage: 0.6, characterizationTests: 4 });
    expect(entryOf(view, 'c').criteria.pinned).toEqual({
      met: false,
      mainPaths: 0,
      reached: 0,
      coverage: null,
      threshold: 0.8,
      characterizationTests: 0,
      unreached: [],
    });
    expect(entryOf(view, 'd').criteria.pinned).toMatchObject({ met: true, coverage: null, characterizationTests: 1 });
    expect(view.settings).toEqual({ pinnedCoverage: 0.8 });
  });

  it('pinned compares the exact ratio, not the rounded coverage', () => {
    const contexts = [ctx('a'), ctx('b'), ctx('c')];
    const view = buildContextMap(
      inputOf({
        snapshot: snapshotOf(registryOf(contexts)),
        maturity: maturityOf([facts('a', { mainPaths: [2000, 1599] }), facts('b', { mainPaths: [5000, 3998] }), facts('c', { mainPaths: [2000, 1600] })]),
      }),
    );
    expect(entryOf(view, 'a').criteria.pinned).toMatchObject({ met: false, coverage: 0.8 });
    expect(entryOf(view, 'b').criteria.pinned).toMatchObject({ met: false, coverage: 0.8 });
    expect(entryOf(view, 'c').criteria.pinned).toMatchObject({ met: true, coverage: 0.8 });
  });

  it('without boundaries bounded is not met and the entry says the boundaries are unknown', () => {
    const { snapshotParts, maturity } = singleContext();
    const base = { snapshot: snapshotOf(registryOf([LENDING]), snapshotParts), maturity: maturityOf([maturity]) };
    const absent = entryOf(buildContextMap(inputOf({ ...base, boundaries: undefined })), 'lending');
    expect(absent.boundariesKnown).toBe(false);
    expect(absent.criteria.bounded).toEqual({ met: false, contractSymbols: 2, reached: 2, unreached: [], boundaryViolations: 0 });
    expect(absent.crossContextEdges).toEqual({ in: 0, out: 0 });
    expect(absent.boundaryViolations).toEqual({ total: 0, errors: 0, warnings: 0 });
    // The ladder is cumulative: boring is met on its own but not suggested.
    expect(absent.criteria.boring.met).toBe(true);
    expect(absent.suggestedRung).toBe('named');

    const present = entryOf(buildContextMap(inputOf({ ...base, boundaries: { crossEdges: [], violations: [] } })), 'lending');
    expect(present.boundariesKnown).toBe(true);
    expect(present.criteria.bounded.met).toBe(true);
    expect(present.suggestedRung).toBe('boring');
  });

  it('pinned reads the configured threshold and rounds coverage to 3 decimals', () => {
    const view = buildContextMap(
      inputOf({
        snapshot: snapshotOf(registryOf([ctx('a')]), {}, 0.6),
        maturity: maturityOf([facts('a', { mainPaths: [3, 2] })]),
      }),
    );
    expect(entryOf(view, 'a').criteria.pinned).toMatchObject({ met: true, coverage: 0.667, threshold: 0.6 });
    expect(view.settings).toEqual({ pinnedCoverage: 0.6 });
  });

  it('named needs a card and every Language term in the glossary', () => {
    const contexts = [LENDING, BILLING];
    const terms = [
      // In the context's glossary.
      term('lending', 'Loan', [def('card', 7), def('glossary', 3)]),
      // Through a repository-wide glossary entry of the same key.
      term('lending', 'Member', [def('card', 8)]),
      term(REPO_WIDE_CONTEXT, 'member', [def('glossary', 5)]),
      // Glossary only: not a Language term.
      term('lending', 'Fine', [def('glossary', 4)]),
      term('billing', 'Invoice', [def('card', 7)]),
      term('billing', 'Account', [def('card', 8), def('glossary', 9)]),
    ];
    const view = buildContextMap(inputOf({ snapshot: snapshotOf(registryOf(contexts), { terms }) }));
    expect(entryOf(view, 'lending').criteria.named).toEqual({ met: true, card: true, terms: 2, inGlossary: 2, missing: [] });
    expect(entryOf(view, 'billing').criteria.named).toEqual({ met: false, card: true, terms: 2, inGlossary: 1, missing: ['Invoice'] });
  });

  it('named needs at least one Language term and caps missing at 10', () => {
    const many = Array.from({ length: 12 }, (_, i) => term('billing', `Term ${String(i).padStart(2, '0')}`, [def('card', 10 + i)]));
    const view = buildContextMap(inputOf({ snapshot: snapshotOf(registryOf([LENDING, BILLING]), { terms: many }) }));
    expect(entryOf(view, 'lending').criteria.named).toEqual({ met: false, card: true, terms: 0, inGlossary: 0, missing: [] });
    const named = entryOf(view, 'billing').criteria.named;
    expect(named).toMatchObject({ met: false, terms: 12, inGlossary: 0 });
    expect(named.missing).toEqual(many.slice(0, 10).map((t) => t.term));
  });

  it('a context without a card fails named and keeps its counts', () => {
    const terms = [term('audit', 'Entry', [def('card', 7), def('glossary', 2)])];
    const missingCard = (path: string): boolean => path !== BILLING_CARD;
    const view = buildContextMap(
      inputOf({ snapshot: snapshotOf(registryOf([AUDIT, BILLING]), { terms: [...terms, term('billing', 'Invoice', [def('card', 7), def('glossary', 3)])] }), cardExists: missingCard }),
    );
    // No card named in the registry.
    expect(entryOf(view, 'audit').card).toEqual({ present: false });
    expect(entryOf(view, 'audit').criteria.named).toEqual({ met: false, card: false, terms: 1, inGlossary: 1, missing: [] });
    // A card named but not on disk.
    expect(entryOf(view, 'billing').card).toEqual({ path: BILLING_CARD, present: false });
    expect(entryOf(view, 'billing').criteria.named).toEqual({ met: false, card: false, terms: 1, inGlossary: 1, missing: [] });
  });

  it('bounded needs every contract symbol reached and no violation in or out', () => {
    const contexts = [ctx('a'), ctx('b'), ctx('c'), ctx('d'), ctx('e')];
    const boundaries: ContextMapBoundaries = {
      crossEdges: [],
      violations: [violation('c', 'x', 'warning'), violation('x', 'd', 'error'), violation('d', 'x', 'warning')],
    };
    const view = buildContextMap(
      inputOf({
        snapshot: snapshotOf(registryOf(contexts)),
        boundaries,
        maturity: maturityOf([
          facts('a', { contractSymbols: [2, 2] }),
          facts('b', { contractSymbols: [2, 1, ['src/b/Api.cs::Api.Get::method']] }),
          facts('c', { contractSymbols: [2, 2] }),
          facts('d', { contractSymbols: [1, 1] }),
          facts('e'),
        ]),
      }),
    );
    expect(entryOf(view, 'a').criteria.bounded).toEqual({ met: true, contractSymbols: 2, reached: 2, unreached: [], boundaryViolations: 0 });
    expect(entryOf(view, 'b').criteria.bounded).toEqual({
      met: false,
      contractSymbols: 2,
      reached: 1,
      unreached: ['src/b/Api.cs::Api.Get::method'],
      boundaryViolations: 0,
    });
    // Out, any severity.
    expect(entryOf(view, 'c').criteria.bounded).toMatchObject({ met: false, boundaryViolations: 1 });
    // In and out.
    expect(entryOf(view, 'd').criteria.bounded).toMatchObject({ met: false, boundaryViolations: 2 });
    expect(entryOf(view, 'd').boundaryViolations).toEqual({ total: 2, errors: 1, warnings: 1 });
    // No contract symbols and no violations.
    expect(entryOf(view, 'e').criteria.bounded).toMatchObject({ met: true, contractSymbols: 0 });
  });

  it('boring needs every rule tested and no open candidate; Untested rules block it', () => {
    const contexts = [ctx('a'), ctx('b'), ctx('c')];
    const rules = [
      rule('A-01', 'a', 'docs/domain/a/domain.md', 5),
      rule('B-01', 'b', 'docs/domain/b/domain.md', 5),
      rule('B-02', 'b', 'docs/domain/b/domain.md', 9, 'covered by manual QA'),
      rule('C-01', 'c', 'docs/domain/c/domain.md', 5),
    ];
    const links = [testLink('A-01', 'tests/A.cs'), testLink('B-01', 'tests/B.cs'), testLink('C-01', 'tests/C.cs')];
    const candidates = [candidate('a', 3, true), candidate('c', 3, true), candidate('c', 4)];
    const view = buildContextMap(inputOf({ snapshot: snapshotOf(registryOf(contexts), { rules, links }), candidates }));
    expect(entryOf(view, 'a').criteria.boring).toEqual({ met: true, rules: 1, rulesWithoutTests: 0, openCandidates: 0 });
    expect(entryOf(view, 'b').criteria.boring).toEqual({ met: false, rules: 2, rulesWithoutTests: 1, openCandidates: 0 });
    expect(entryOf(view, 'c').criteria.boring).toEqual({ met: false, rules: 1, rulesWithoutTests: 0, openCandidates: 1 });
    expect(entryOf(view, 'b').rules).toEqual({ count: 2, withTests: 1, share: 0.5 });
    expect(entryOf(view, 'c').shadowSpecs).toEqual({ open: 1, resolved: 1 });
  });

  it('every criterion is reported even when a lower one fails', () => {
    const { snapshotParts, maturity } = singleContext();
    const view = buildContextMap(
      inputOf({
        snapshot: snapshotOf(registryOf([LENDING]), snapshotParts),
        maturity: maturityOf([{ ...maturity, mainPaths: { total: 5, reached: 1, unreached: [] } }]),
      }),
    );
    const entry = entryOf(view, 'lending');
    expect(entry.criteria.pinned.met).toBe(false);
    expect(entry.criteria.named.met).toBe(true);
    expect(entry.criteria.bounded.met).toBe(true);
    expect(entry.criteria.boring.met).toBe(true);
    expect(entry.suggestedRung).toBe('fear');
  });

  it('a context meeting every criterion is suggested boring', () => {
    const { snapshotParts, maturity } = singleContext();
    const view = buildContextMap(inputOf({ snapshot: snapshotOf(registryOf([LENDING]), snapshotParts), maturity: maturityOf([maturity]) }));
    expect(entryOf(view, 'lending').suggestedRung).toBe('boring');
  });

  it('a context without rules has share null', () => {
    const view = buildContextMap(inputOf({ snapshot: snapshotOf(registryOf([AUDIT])) }));
    expect(entryOf(view, 'audit').rules).toEqual({ count: 0, withTests: 0, share: null });
    expect(entryOf(view, 'audit').criteria.boring).toEqual({ met: true, rules: 0, rulesWithoutTests: 0, openCandidates: 0 });
  });

  it('the summary counts agreement', () => {
    // lending (owner named) meets everything: boring, above. billing (owner fear) meets nothing: agree.
    // audit (owner pinned) meets nothing: below.
    const { snapshotParts, maturity } = singleContext();
    const view = buildContextMap(
      inputOf({
        snapshot: snapshotOf(registryOf([LENDING, BILLING, AUDIT]), {
          ...snapshotParts,
          terms: [...(snapshotParts.terms ?? []), term('billing', 'Invoice', [def('card', 7)])],
        }),
        maturity: maturityOf([maturity]),
        candidates: [candidate('billing', 4)],
      }),
    );
    expect(view.contextMap.map((e) => [e.id, e.rung, e.suggestedRung])).toEqual([
      ['lending', 'named', 'boring'],
      ['billing', 'fear', 'fear'],
      ['audit', 'pinned', 'fear'],
    ]);
    expect(view.summary).toEqual({ contexts: 3, agree: 1, suggestedAbove: 1, suggestedBelow: 1 });
  });
});

describe('buildContextMap metrics', () => {
  const coChangeTop: CrossContextCoChange = {
    file: 'src/lending/Loan.cs',
    otherFile: 'src/billing/Invoice.cs',
    otherContext: 'billing',
    frequency: 0.6,
    sharedCommits: 6,
  };

  function history(sha: string, at: number, crossShare: number, registryHash = REGISTRY_HASH): ContextHistoryEntry {
    return {
      ctxoArtifact: 'domain-history',
      version: 1,
      commitSha: sha,
      committedAt: at,
      registryHash,
      contexts: [{ id: 'lending', files: 3, internalEdges: 10, crossOut: 2, crossIn: 1, crossShare }],
    };
  }

  const moved: MovedFile[] = [
    { file: 'src/lending/Fine.cs', from: 'src/billing/Fine.cs', fromContext: 'billing', toContext: 'lending', commit: 'c2', date: '2026-10-01T00:00:00Z' },
    { file: 'src/audit/Log.cs', from: 'src/misc/Log.cs', toContext: 'audit', commit: 'c2', date: '2026-10-01T00:00:00Z' },
  ];

  function fullInput(): ContextMapInput {
    const { snapshotParts, maturity } = singleContext();
    return inputOf({
      snapshot: snapshotOf(registryOf([LENDING, BILLING]), {
        ...snapshotParts,
        rules: [...(snapshotParts.rules ?? []), rule('BILL-01', 'billing', BILLING_CARD, 5)],
      }),
      boundaries: {
        crossEdges: [cross('lending', 'billing', { calls: 3, imports: 1 }), cross('billing', 'lending', { uses: 2 }), cross('audit', 'lending', { calls: 1 })],
        violations: [violation('billing', 'lending', 'warning')],
      },
      history: [history('c1', 100, 0.2), history('c2', 200, 0.25), history('c0', 50, 0.9, 'another-registry')],
      movedFiles: moved,
      maturity: maturityOf([
        { ...maturity, coChange: { pairs: 1, top: [coChangeTop] } },
        facts('billing', { characterization: 2, contract: 3 }),
      ]),
      candidates: [candidate('lending', 3, true), candidate('billing', 4), candidate('billing', 5)],
    });
  }

  it('reports the metrics of each context in registry order', () => {
    const view = buildContextMap(fullInput());
    expect(view.contextMap.map((e) => e.id)).toEqual(['lending', 'billing']);
    const lending = entryOf(view, 'lending');
    expect(lending).toMatchObject({
      id: 'lending',
      name: 'Lending',
      rung: 'named',
      card: { path: LENDING_CARD, present: true },
      rules: { count: 1, withTests: 1, share: 1 },
      tests: { characterization: 1, contract: 1 },
      crossContextEdges: { in: 3, out: 4 },
      coChange: { pairs: 1, top: [coChangeTop] },
      drift: { crossShare: { current: 0.25, previous: 0.2, delta: 0.05 }, movedFiles: 1, distinctCommits: 2, confidence: 'low' },
      boundaryViolations: { total: 1, errors: 0, warnings: 1 },
      shadowSpecs: { open: 0, resolved: 1 },
    });
    const billing = entryOf(view, 'billing');
    expect(billing).toMatchObject({
      rules: { count: 1, withTests: 0, share: 0 },
      tests: { characterization: 2, contract: 3 },
      crossContextEdges: { in: 4, out: 2 },
      coChange: { pairs: 0, top: [] },
      drift: null,
      shadowSpecs: { open: 2, resolved: 0 },
    });
  });

  it('a context missing from the maturity artifact and the boundaries counts zero', () => {
    const view = buildContextMap(inputOf({ snapshot: snapshotOf(registryOf([AUDIT])), boundaries: undefined }));
    const audit = entryOf(view, 'audit');
    expect(audit.boundariesKnown).toBe(false);
    expect(audit.tests).toEqual({ characterization: 0, contract: 0 });
    expect(audit.crossContextEdges).toEqual({ in: 0, out: 0 });
    expect(audit.boundaryViolations).toEqual({ total: 0, errors: 0, warnings: 0 });
    expect(audit.criteria.pinned).toMatchObject({ met: false, coverage: null, mainPaths: 0 });
  });

  it('counts candidates one by one, also when several share a fingerprint', () => {
    const shared = candidate('lending', 3);
    const view = buildContextMap(
      inputOf({
        snapshot: snapshotOf(registryOf([LENDING])),
        candidates: [shared, { ...shared, line: 9 }, { ...shared, line: 12, resolution: { by: 'shadow-specs', rule: 'LEND-01' } }],
      }),
    );
    expect(entryOf(view, 'lending').shadowSpecs).toEqual({ open: 2, resolved: 1 });
    expect(entryOf(view, 'lending').criteria.boring.openCandidates).toBe(2);
  });

  it('two builds from the same input construction give deep-equal views', () => {
    const first = buildContextMap(fullInput());
    const second = buildContextMap(fullInput());
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
