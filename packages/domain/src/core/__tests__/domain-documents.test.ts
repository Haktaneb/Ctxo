import { describe, expect, it } from 'vitest';
import type { FileIndex, SearchResponse } from '@ctxo/cli/internal';
import { buildSearchDocuments, EXCERPT_MAX_CHARS, packDomainHits, provenancePaths, type DomainDocument } from '../domain-documents.js';
import { buildFixtureGraph, INDICES, LENDING_CARD, LENDING_FIXTURE } from './lending-graph.fixture.js';
import { estimateTokens } from '../token-estimate.js';

const SPEC = 'docs/specs/loan-limit.md';
const SPEC_INDEX: FileIndex = { file: SPEC, lastModified: 1, symbols: [], edges: [], intent: [], antiPatterns: [] };

/** The Lending fixture with `docs/specs/loan-limit.md` present (its ADR link stays missing). */
const graph = buildFixtureGraph({ ...LENDING_FIXTURE, indices: [...INDICES, SPEC_INDEX] });
const provenance = [{ path: SPEC, title: 'Loan limit', text: 'The limit rose from three to five loans after the renewal study.' }];

function response(ids: readonly [string, number][]): SearchResponse {
  return {
    query: 'q',
    results: ids.map(([symbolId, relevanceScore]) => ({
      symbolId,
      name: symbolId,
      kind: 'rule',
      filePath: LENDING_CARD,
      startLine: 0,
      endLine: 0,
      relevanceScore,
      importanceScore: 0,
      combinedScore: relevanceScore,
    })),
    metrics: { porterHits: ids.length, trigramHits: 0, phase2Activated: false, fuzzyApplied: false, latencyMs: 1 },
  } as SearchResponse;
}

describe('buildSearchDocuments', () => {
  it('builds one document per rule, term, decision, section and existing provenance file', () => {
    const docs = buildSearchDocuments(graph, provenance);
    const count = (kind: string): number => docs.filter((d) => d.kind === kind).length;
    expect(count('rule')).toBe(graph.rules.length);
    expect(count('term')).toBe(graph.terms.length);
    expect(count('decision')).toBe(graph.decisions.length);
    expect(count('section')).toBe(graph.sections.length);
    expect(count('provenance')).toBe(1);
    expect(docs.length).toBe(graph.rules.length + graph.terms.length + graph.decisions.length + graph.sections.length + 1);

    // Codepoint order of the search key, each key once.
    const ids = docs.map((d) => d.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(ids).size).toBe(ids.length);

    const rule = docs.find((d) => d.nodeId === 'rule:LEND-03')!;
    expect(rule).toMatchObject({ kind: 'rule', title: 'LEND-03 A member holds at most five loans', path: LENDING_CARD, context: 'lending' });
    expect(rule.text).toContain('Five is the limit.');
    expect(rule.line).toBe(graph.rules.find((r) => r.ruleId === 'LEND-03')!.line);

    const term = docs.find((d) => d.nodeId === 'term:lending/loan')!;
    expect(term).toMatchObject({ kind: 'term', title: 'Loan', text: 'a book lent to a member', path: LENDING_CARD, context: 'lending' });

    const decision = docs.find((d) => d.nodeId === 'decision:lending/2026-09-12-1')!;
    expect(decision).toMatchObject({ kind: 'decision', title: '2026-09-12 decision', path: LENDING_CARD });
    expect(decision.text).toContain('loan limit raised from 3 to 5');

    const contracts = graph.sections.find((s) => s.kind === 'contracts')!;
    expect(docs.find((d) => d.nodeId === contracts.id)).toMatchObject({ kind: 'section', title: 'Boundary contracts', line: contracts.line });

    expect(docs.find((d) => d.kind === 'provenance')).toEqual({
      id: `file:${SPEC}`,
      nodeId: `file:${SPEC}`,
      kind: 'provenance',
      title: 'Loan limit',
      path: SPEC,
      text: provenance[0]!.text,
    });
  });

  it('leaves out provenance texts no existing decision-provenance file link names', () => {
    const missing = buildFixtureGraph(LENDING_FIXTURE);
    expect(buildSearchDocuments(missing, provenance).filter((d) => d.kind === 'provenance')).toEqual([]);
    expect(provenancePaths(graph)).toEqual([SPEC]);
    expect(provenancePaths(missing)).toEqual([]);
  });

  it('keys the sections of a card two contexts share by id and context, so neither shadows the other', () => {
    const registry = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/shared.md
    paths: ["src/Lending/**"]
    rung: named
  - id: billing
    name: Billing
    card: docs/domain/shared.md
    paths: ["src/Billing/**"]
    rung: named
`;
    const shared = buildFixtureGraph({
      registryText: registry,
      cards: { 'docs/domain/shared.md': '# Shared\n\nOne card for two contexts.\n' },
    });
    const sections = buildSearchDocuments(shared, []).filter((d) => d.kind === 'section');
    expect(sections.map((d) => [d.nodeId, d.context])).toEqual([
      ['section:docs/domain/shared.md:1', 'billing'],
      ['section:docs/domain/shared.md:1', 'lending'],
    ]);
    expect(new Set(sections.map((d) => d.id)).size).toBe(2);
  });
});

describe('packDomainHits', () => {
  const docs = buildSearchDocuments(graph, provenance);
  const byId = new Map(docs.map((d) => [d.id, d] as const));
  const key = (nodeId: string): string => docs.find((d) => d.nodeId === nodeId)!.id;

  it('excerpts collapse whitespace and stop at 300 characters', () => {
    expect(EXCERPT_MAX_CHARS).toBe(300);
    const long: DomainDocument = { id: 'rule:LONG-1', nodeId: 'rule:LONG-1', kind: 'rule', title: 'LONG-1 Long', path: 'c.md', text: `a  b\n\n\tc ${'x'.repeat(400)}`, line: 3 };
    const short: DomainDocument = { id: 'rule:SHORT-1', nodeId: 'rule:SHORT-1', kind: 'rule', title: 'SHORT-1 Short', path: 'c.md', text: '  one\n two  ' };
    const map = new Map([long, short].map((d) => [d.id, d] as const));
    const { results } = packDomainHits(response([['rule:LONG-1', 2], ['rule:SHORT-1', 1]]), map, 10_000);
    expect(results[0]!.excerpt.length).toBe(EXCERPT_MAX_CHARS);
    expect(results[0]!.excerpt.startsWith('a b c xxx')).toBe(true);
    expect(results[0]!.excerpt.endsWith('...')).toBe(true);
    expect(results[1]!.excerpt).toBe('one two');
  });

  it('packs hits in order with ids, rounded scores and measured tokens', () => {
    const { results, totalTokens } = packDomainHits(response([[key('rule:LEND-03'), 1.23456], [key(`file:${SPEC}`), 0.5]]), byId, 10_000);
    expect(results.map((r) => r.id)).toEqual(['rule:LEND-03', `file:${SPEC}`]);
    expect(results[0]).toMatchObject({ kind: 'rule', title: 'LEND-03 A member holds at most five loans', context: 'lending', path: LENDING_CARD, relevanceScore: 1.235 });
    expect(results[1]).not.toHaveProperty('context');
    expect(results[1]).not.toHaveProperty('line');
    for (const hit of results) expect(estimateTokens(hit)).toBe(hit.tokens);
    expect(totalTokens).toBe(results.reduce((sum, r) => sum + r.tokens, 0));
  });

  it('packs greedily within the budget and skips hits it does not know', () => {
    const all = packDomainHits(response([[key('rule:LEND-03'), 3], ['rule:GONE-1', 2], [key('term:lending/loan'), 1]]), byId, 10_000);
    expect(all.results.map((r) => r.id)).toEqual(['rule:LEND-03', 'term:lending/loan']);
    const budget = all.results[1]!.tokens;
    const packed = packDomainHits(response([[key('rule:LEND-03'), 3], [key('term:lending/loan'), 1]]), byId, budget);
    expect(packed.results.map((r) => r.id)).toEqual(['term:lending/loan']);
    expect(packed.totalTokens).toBeLessThanOrEqual(budget);
  });
});
