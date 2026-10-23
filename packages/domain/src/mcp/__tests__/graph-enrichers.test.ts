import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModuleHost, type FileIndex } from '@ctxo/cli/internal';
import { DomainArtifactStore } from '../../adapters/artifact-store.js';
import { buildCardExcerpt, targetExcerptTokens } from '../../core/card-excerpt.js';
import {
  BILLING_CARD,
  buildFixtureGraph,
  CHARGE,
  fixtureSnapshot,
  GLOSSARY_PATH,
  GLOSSARY_TEXT,
  LENDING_CARD,
  LENDING_FIXTURE,
  LOOSE,
  manyContextsFixture,
  REGISTRY_PATH,
  RENEW,
  ROOT,
  SEND,
  TEST,
  type FixtureInput,
} from '../../core/__tests__/lending-graph.fixture.js';
import { createDomainState, type DomainState } from '../domain-state.js';
import {
  blastRadiusDomainFields,
  taskContextDomainFields,
  taskContextReservation,
  whyContextDomainFields,
} from '../graph-enrichers.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxo-domain-graph-enrich-'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function write(path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf-8');
}

interface Setup {
  readonly fixture?: FixtureInput;
  readonly registry?: boolean;
  /** Registry text written instead of the fixture's (the graph keeps the fixture's hash). */
  readonly registryText?: string;
}

function state(setup: Setup = {}): DomainState {
  const fixture = setup.fixture ?? LENDING_FIXTURE;
  if (setup.registry !== false) write(REGISTRY_PATH, setup.registryText ?? fixture.registryText);
  for (const [path, text] of Object.entries(fixture.cards)) write(path, text);
  if (fixture.glossaryText !== undefined) write(GLOSSARY_PATH, fixture.glossaryText);
  const host = createModuleHost({ cliVersion: '0.0.0', mode: 'mcp', projectRoot: root });
  new DomainArtifactStore(host.ctxoRoot).writeIfChanged('graph.json', buildFixtureGraph(fixture));
  return createDomainState(host);
}

type Payload = Record<string, unknown>;

async function call(enricher: (p: Payload, a: Payload) => Payload | Promise<Payload>, payload: Payload, args: Payload = {}): Promise<Payload> {
  return await enricher(structuredClone(payload), args);
}

describe('get_blast_radius domain fields', () => {
  it('rulesAffected lists rules linked to the root through Code and to impacted tests, with their cards', async () => {
    const result = await call(blastRadiusDomainFields(state()), { symbolId: ROOT, impactedSymbols: [{ symbolId: TEST }] });
    expect(result['rulesAffected']).toEqual([
      {
        ruleId: 'LEND-03',
        title: 'A member holds at most five loans',
        context: 'lending',
        card: LENDING_CARD,
        via: [
          { symbolId: ROOT, link: 'code' },
          { symbolId: TEST, link: 'test' },
        ],
        viaCount: 2,
      },
    ]);
    expect(result['cardsToUpdate']).toEqual([{ context: 'lending', card: LENDING_CARD }]);
    expect(result).not.toHaveProperty('rulesAffectedTotal');
    expect(result).not.toHaveProperty('cardsToUpdateTotal');
  });

  it('rules linked to the root come first', async () => {
    const result = await call(blastRadiusDomainFields(state()), {
      symbolId: RENEW,
      impactedSymbols: [{ symbolId: ROOT }, { symbolId: SEND }],
    });
    expect((result['rulesAffected'] as { ruleId: string }[]).map((r) => r.ruleId)).toEqual(['LEND-05', 'BILL-01', 'LEND-03']);
    // Cards once each, in registry order (lending is listed first; its card path sorts after billing's).
    expect(LENDING_CARD > BILLING_CARD).toBe(true);
    expect(result['cardsToUpdate']).toEqual([
      { context: 'lending', card: LENDING_CARD },
      { context: 'billing', card: BILLING_CARD },
    ]);
  });

  it('a file-level link matches every symbol of its file', async () => {
    const result = await call(blastRadiusDomainFields(state()), { symbolId: CHARGE, impactedSymbols: [] });
    expect((result['rulesAffected'] as { ruleId: string; via: unknown }[]).map((r) => [r.ruleId, r.via])).toEqual([
      ['LEND-04', [{ symbolId: CHARGE, link: 'code' }]],
    ]);
  });

  it('via keeps the first five with the full count', async () => {
    // Six symbols of the Fines file all match LEND-04's file-level link.
    const impacted = [1, 2, 3, 4, 5].map((i) => ({ symbolId: `src/Lending/Fines.cs::Fines.M${i}::method` }));
    const result = await call(blastRadiusDomainFields(state()), { symbolId: CHARGE, impactedSymbols: impacted });
    const [rule] = result['rulesAffected'] as { via: { symbolId: string }[]; viaCount: number }[];
    expect(rule!.via.map((v) => v.symbolId)).toEqual([CHARGE, ...impacted.slice(0, 4).map((s) => s.symbolId)]);
    expect(rule!.viaCount).toBe(6);
  });

  it('adds empty lists when no rule is linked', async () => {
    const result = await call(blastRadiusDomainFields(state()), { symbolId: LOOSE, impactedSymbols: [{ symbolId: 'x' }] });
    expect(result['rulesAffected']).toEqual([]);
    expect(result['cardsToUpdate']).toEqual([]);
  });

  it('adds nothing without a registry or with a stale registry', async () => {
    const payload = { symbolId: ROOT, impactedSymbols: [{ symbolId: TEST }] };
    expect(await call(blastRadiusDomainFields(state({ registry: false })), payload)).toEqual(payload);
    const stale = state({ registryText: LENDING_FIXTURE.registryText.replace('name: Lending', 'name: Lending desk') });
    expect(await call(blastRadiusDomainFields(stale), payload)).toEqual(payload);
    expect(await call(whyContextDomainFields(stale), { symbolId: ROOT }, { symbolId: ROOT })).toEqual({ symbolId: ROOT });
    expect(await call(taskContextDomainFields(stale), { context: [], totalTokens: 0, tokenBudget: 4000 }, { symbolId: ROOT })).toEqual({
      context: [],
      totalTokens: 0,
      tokenBudget: 4000,
    });
    expect(taskContextReservation(stale)({ symbolId: ROOT })).toBe(0);
  });

  it('rulesAffected and cardsToUpdate are capped at 50 with their totals', async () => {
    const index: FileIndex = {
      file: 'src/Shared/Root.cs',
      lastModified: 1,
      symbols: [{ symbolId: 'src/Shared/Root.cs::Root::class', name: 'Root', kind: 'class', startLine: 0, endLine: 3 }],
      edges: [],
      intent: [],
      antiPatterns: [],
    };
    const impacted = [{ symbolId: 'a::b::class' }];
    const many = await call(blastRadiusDomainFields(state({ fixture: manyContextsFixture(60, 'src/Shared/Root.cs::Root::class', [index]) })), {
      symbolId: 'src/Shared/Root.cs::Root::class',
      impactedSymbols: impacted,
    });
    expect(many['rulesAffected']).toHaveLength(50);
    expect(many['rulesAffectedTotal']).toBe(60);
    expect(many['cardsToUpdate']).toHaveLength(50);
    expect(many['cardsToUpdateTotal']).toBe(60);
    expect(many['impactedSymbols']).toEqual(impacted);
    rmSync(join(root, 'docs'), { recursive: true, force: true });

    const few = await call(blastRadiusDomainFields(state({ fixture: manyContextsFixture(3, 'src/Shared/Root.cs::Root::class', [index]) })), {
      symbolId: 'src/Shared/Root.cs::Root::class',
      impactedSymbols: [],
    });
    expect(few['rulesAffected']).toHaveLength(3);
    expect(few['cardsToUpdate']).toHaveLength(3);
    expect(few).not.toHaveProperty('rulesAffectedTotal');
    expect(few).not.toHaveProperty('cardsToUpdateTotal');
  });
});

describe('get_why_context domain fields', () => {
  it("decisions are the context's five, rule-linked ones first, with provenance", async () => {
    const result = await call(whyContextDomainFields(state()), { symbolId: ROOT, commitHistory: [] }, { symbolId: ROOT });
    const decisions = result['decisions'] as { id: string; rules: string[]; provenance: unknown[] }[];
    expect(decisions.map((d) => d.id)).toEqual([
      'decision:lending/2026-09-12-1',
      'decision:lending/2025-01-01-1',
      'decision:lending/2026-05-01-1',
      'decision:lending/2026-04-01-1',
      'decision:lending/2026-03-01-1',
    ]);
    expect(decisions[0]).toEqual({
      id: 'decision:lending/2026-09-12-1',
      date: '2026-09-12',
      text: expect.stringContaining('loan limit raised from 3 to 5'),
      card: LENDING_CARD,
      line: expect.any(Number),
      rules: ['LEND-03'],
      provenance: [
        { kind: 'file', path: 'docs/specs/loan-limit.md', exists: false, label: 'spec' },
        { kind: 'file', path: 'docs/adr/adr-007-loan-limit.md', exists: false, label: 'ADR-007' },
      ],
    });
    expect(result['commitHistory']).toEqual([]);
  });

  it('decisions beyond five add decisionsTotal', async () => {
    const s = state();
    const seven = await call(whyContextDomainFields(s), {}, { symbolId: ROOT });
    expect(seven['decisions']).toHaveLength(5);
    expect(seven['decisionsTotal']).toBe(7);

    const three = await call(whyContextDomainFields(s), {}, { symbolId: SEND });
    expect((three['decisions'] as { id: string }[]).map((d) => d.id)).toEqual([
      'decision:billing/2026-03-01-1',
      'decision:billing/2026-02-01-1',
      'decision:billing/2026-01-01-1',
    ]);
    expect(three).not.toHaveProperty('decisionsTotal');
  });

  it('a symbol outside every context gets an empty decisions list', async () => {
    const s = state();
    expect(await call(whyContextDomainFields(s), {}, { symbolId: LOOSE })).toEqual({ decisions: [] });
    // A file path (no ::) selects its context like 2B's contextDrift.
    expect((await call(whyContextDomainFields(s), {}, { symbolId: 'src/Billing/Invoice.cs' }))['decisions']).toHaveLength(3);
  });
});

describe('get_context_for_task domain fields', () => {
  it('cardExcerpt fits the budget left by the code context', async () => {
    const s = state();
    const payload = { target: {}, context: [{ symbolId: RENEW }, { symbolId: CHARGE }], totalTokens: 3950, tokenBudget: 4000 };
    const result = await call(taskContextDomainFields(s), payload, { symbolId: ROOT, tokenBudget: 4000 });
    const excerpt = result['cardExcerpt'] as { tokens: number; omitted: number };
    expect(3950 + excerpt.tokens).toBeLessThanOrEqual(4000);
    expect(excerpt).toEqual(buildCardExcerpt(fixtureSnapshot(), ROOT, [RENEW, CHARGE], 50));

    const roomy = await call(taskContextDomainFields(s), { ...payload, totalTokens: 100 }, { symbolId: ROOT });
    expect((roomy['cardExcerpt'] as { omitted: number }).omitted).toBe(0);
    expect((roomy['cardExcerpt'] as { rules: unknown[] }).rules).toHaveLength(3);
  });

  it('the reservation equals targetExcerptTokens', () => {
    const s = state();
    expect(taskContextReservation(s)({ symbolId: ROOT })).toBe(targetExcerptTokens(fixtureSnapshot(), ROOT));
    expect(taskContextReservation(s)({})).toBe(0);
    rmSync(join(root, REGISTRY_PATH));
    expect(taskContextReservation(state({ registry: false }))({ symbolId: ROOT })).toBe(0);
  });
});
