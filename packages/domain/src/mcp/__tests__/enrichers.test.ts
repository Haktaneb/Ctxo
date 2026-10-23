import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModuleHost } from '@ctxo/cli/internal';
import { DomainArtifactStore, type BoundariesArtifact, type ContextsArtifact } from '../../adapters/artifact-store.js';
import type { BoundaryViolationRecord } from '../../core/boundaries.js';
import type { ContextHistoryEntry } from '../../core/context-metrics.js';
import { registryHash } from '../../core/registry.js';
import { createDomainState } from '../domain-state.js';
import { ENRICHER_TIMEOUT_MS, createEnrichers, withTimeout } from '../enrichers.js';
import {
  buildFixtureGraph,
  LENDING_CARD,
  LENDING_FIXTURE,
  POLICY_FILE,
  REGISTRY_TEXT,
  ROOT,
  TEST,
} from '../../core/__tests__/lending-graph.fixture.js';

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    paths: ["src/Lending/**"]
    rung: named
  - id: billing
    name: Billing
    paths: ["src/Billing/**"]
    rung: bounded
`;

const HASH = registryHash(REGISTRY);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctxo-domain-enrich-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function contexts(hash: string = HASH): ContextsArtifact {
  return {
    ctxoArtifact: 'domain-contexts',
    version: 1,
    registryHash: hash,
    contexts: [
      { id: 'lending', name: 'Lending', rung: 'named', fileCount: 2, files: ['src/Lending/Loan.ts', 'src/Shared/Both.ts'] },
      { id: 'billing', name: 'Billing', rung: 'bounded', fileCount: 2, files: ['src/Billing/Invoice.ts', 'src/Shared/Both.ts'] },
    ],
    unowned: { count: 1, files: ['src/Loose.ts'] },
    multiplyOwned: [{ file: 'src/Shared/Both.ts', contexts: ['billing', 'lending'] }],
    movedFiles: [],
  };
}

function violation(i: number): BoundaryViolationRecord {
  return {
    from: { symbolId: `src/Lending/L${i}.ts::L${i}::class`, file: `src/Lending/L${i}.ts`, context: 'lending' },
    to: { symbolId: `src/Billing/B${i}.ts::B${i}::class`, file: `src/Billing/B${i}.ts`, context: 'billing' },
    edgeKind: 'imports',
    severity: 'error',
  };
}

function boundaries(violations: readonly BoundaryViolationRecord[], hash: string = HASH): BoundariesArtifact {
  return {
    ctxoArtifact: 'domain-boundaries',
    version: 1,
    registryHash: hash,
    mode: 'by-rung',
    blockingRungs: ['bounded', 'boring'],
    crossEdges: [],
    violations,
  };
}

function historyEntry(sha: string, committedAt: number, crossShare: number, hash: string = HASH): ContextHistoryEntry {
  return {
    ctxoArtifact: 'domain-history',
    version: 1,
    commitSha: sha,
    committedAt,
    registryHash: hash,
    contexts: [{ id: 'lending', files: 1, internalEdges: 4, crossOut: 1, crossIn: 0, crossShare }],
  };
}

interface Setup {
  registry?: boolean;
  hash?: string;
  violations?: readonly BoundaryViolationRecord[];
  history?: readonly ContextHistoryEntry[];
}

function enrichers(setup: Setup = {}) {
  if (setup.registry !== false) {
    mkdirSync(join(dir, 'docs', 'domain'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'domain', 'contexts.yaml'), REGISTRY);
  }
  const host = createModuleHost({ projectRoot: dir, mode: 'cli' });
  const store = new DomainArtifactStore(host.ctxoRoot);
  store.writeIfChanged('contexts.json', contexts(setup.hash ?? HASH));
  store.writeIfChanged('boundaries.json', boundaries(setup.violations ?? [], setup.hash ?? HASH));
  for (const entry of setup.history ?? []) store.writeHistory(entry);
  return createEnrichers(host, createDomainState(host));
}

const run = (
  e: ReturnType<typeof enrichers>,
  tool: keyof ReturnType<typeof enrichers>,
  payload: Record<string, unknown>,
  args: Record<string, unknown> = {},
): Record<string, unknown> => e[tool]!(structuredClone(payload), args);

/** `run` for an enricher that may return a Promise (`get_pr_impact` adds its asynchronous domain fields). */
const runAsync = async (
  e: ReturnType<typeof enrichers>,
  tool: keyof ReturnType<typeof enrichers>,
  payload: Record<string, unknown>,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => await e[tool]!(structuredClone(payload), args);

describe('createEnrichers', () => {
  it('registers an enricher for the seven tools', () => {
    expect(Object.keys(enrichers()).sort()).toEqual([
      'find_importers',
      'get_blast_radius',
      'get_context_for_task',
      'get_logic_slice',
      'get_pr_impact',
      'get_why_context',
      'search_symbols',
    ]);
  });

  it('search_symbols adds context to entries of singly-owned files and nothing for unowned files', () => {
    const result = run(enrichers(), 'search_symbols', {
      totalMatches: 4,
      results: [
        { symbolId: 'src/Lending/Loan.ts::Loan::class', file: 'src/Lending/Loan.ts' },
        { symbolId: 'src/Loose.ts::Loose::class', file: 'src/Loose.ts' },
        { symbolId: 'src/Shared/Both.ts::Both::class', file: 'src/Shared/Both.ts' },
        { symbolId: 'src/Billing/Invoice.ts::Invoice::class', file: 'src/Billing/Invoice.ts' },
      ],
    });

    expect(result['results']).toEqual([
      { symbolId: 'src/Lending/Loan.ts::Loan::class', file: 'src/Lending/Loan.ts', context: 'lending' },
      { symbolId: 'src/Loose.ts::Loose::class', file: 'src/Loose.ts' },
      { symbolId: 'src/Shared/Both.ts::Both::class', file: 'src/Shared/Both.ts' },
      { symbolId: 'src/Billing/Invoice.ts::Invoice::class', file: 'src/Billing/Invoice.ts', context: 'billing' },
    ]);
    expect(result['totalMatches']).toBe(4);
  });

  it('get_blast_radius adds context to entries of singly-owned files and nothing for unowned files', () => {
    const result = run(enrichers(), 'get_blast_radius', {
      impactScore: 2,
      impactedSymbols: [
        { symbolId: 'src/Lending/Loan.ts::Loan::class', depth: 1 },
        { symbolId: 'src/Loose.ts::Loose::class', depth: 2 },
      ],
    });

    expect(result['impactedSymbols']).toEqual([
      { symbolId: 'src/Lending/Loan.ts::Loan::class', depth: 1, context: 'lending' },
      { symbolId: 'src/Loose.ts::Loose::class', depth: 2 },
    ]);
  });

  it('find_importers adds context to entries of singly-owned files and nothing for unowned files', () => {
    const result = run(enrichers(), 'find_importers', {
      importers: [
        { symbolId: 'x', file: 'src/Billing/Invoice.ts' },
        { symbolId: 'y', file: 'src/Shared/Both.ts' },
        { symbolId: 'z', file: 'src/Loose.ts' },
      ],
    });

    expect(result['importers']).toEqual([
      { symbolId: 'x', file: 'src/Billing/Invoice.ts', context: 'billing' },
      { symbolId: 'y', file: 'src/Shared/Both.ts' },
      { symbolId: 'z', file: 'src/Loose.ts' },
    ]);
  });

  it('get_logic_slice adds context to the root of a single slice and to each root of a batch', () => {
    const e = enrichers();

    const single = run(e, 'get_logic_slice', {
      root: { symbolId: 'src/Lending/Loan.ts::Loan::class', name: 'Loan' },
      dependencies: [],
    });
    const batch = run(e, 'get_logic_slice', {
      batch: true,
      results: [
        { root: { symbolId: 'src/Billing/Invoice.ts::Invoice::class' } },
        { root: { symbolId: 'src/Loose.ts::Loose::class' } },
        { found: false, symbolId: 'missing' },
      ],
    });

    expect(single['root']).toEqual({ symbolId: 'src/Lending/Loan.ts::Loan::class', name: 'Loan', context: 'lending' });
    expect(batch['results']).toEqual([
      { root: { symbolId: 'src/Billing/Invoice.ts::Invoice::class', context: 'billing' } },
      { root: { symbolId: 'src/Loose.ts::Loose::class' } },
      { found: false, symbolId: 'missing' },
    ]);
  });

  it('get_pr_impact adds context to symbols of singly-owned files and nothing for unowned files', async () => {
    const result = await runAsync(enrichers(), 'get_pr_impact', {
      files: [
        { file: 'src/Lending/Loan.ts', symbols: [{ symbolId: 'src/Lending/Loan.ts::Loan::class' }] },
        { file: 'src/Loose.ts', symbols: [{ symbolId: 'src/Loose.ts::Loose::class' }] },
      ],
    });

    expect(result['files']).toEqual([
      { file: 'src/Lending/Loan.ts', symbols: [{ symbolId: 'src/Lending/Loan.ts::Loan::class', context: 'lending' }] },
      { file: 'src/Loose.ts', symbols: [{ symbolId: 'src/Loose.ts::Loose::class' }] },
    ]);
  });

  it('without a registry the payload is unchanged', async () => {
    const e = enrichers({ registry: false });
    const payload = { results: [{ symbolId: 'a', file: 'src/Lending/Loan.ts' }] };

    expect(run(e, 'search_symbols', payload)).toEqual(payload);
    expect(await runAsync(e, 'get_pr_impact', { files: [] })).toEqual({ files: [] });
    expect(run(e, 'get_why_context', { symbolId: 'src/Lending/Loan.ts::Loan::class' }, { symbolId: 'src/Lending/Loan.ts::Loan::class' })).toEqual({
      symbolId: 'src/Lending/Loan.ts::Loan::class',
    });
  });

  it('stale artifacts add nothing', async () => {
    const e = enrichers({
      hash: 'not-the-current-hash',
      violations: [violation(1)],
      history: [historyEntry('aaaaaaa1', 100, 0.2, 'not-the-current-hash')],
    });
    const search = { results: [{ symbolId: 'a', file: 'src/Lending/Loan.ts' }] };
    const pr = { files: [{ file: 'src/Lending/L1.ts', symbols: [{ symbolId: 'src/Lending/L1.ts::L1::class' }] }] };

    expect(run(e, 'search_symbols', search)).toEqual(search);
    expect(await runAsync(e, 'get_pr_impact', pr)).toEqual(pr);
    const why = { symbolId: 'src/Lending/Loan.ts::Loan::class' };
    expect(run(e, 'get_why_context', why, why)).toEqual(why);
  });

  it('contextBoundaryViolations lists the violations touching changed symbols', async () => {
    const e = enrichers({ violations: [violation(1), violation(2), violation(3)] });

    const result = await runAsync(e, 'get_pr_impact', {
      files: [
        { file: 'src/Lending/L1.ts', symbols: [{ symbolId: 'src/Lending/L1.ts::L1::class' }] },
        // The `to` end of violation 3 is a changed symbol too.
        { file: 'src/Billing/B3.ts', symbols: [{ symbolId: 'src/Billing/B3.ts::B3::class' }] },
      ],
    });

    expect(result['contextBoundaryViolations']).toEqual([violation(1), violation(3)]);
    expect(result).not.toHaveProperty('contextBoundaryViolationsTotal');
  });

  it('contextBoundaryViolations is absent when no violation touches a changed symbol', async () => {
    const e = enrichers({ violations: [violation(1)] });

    const result = await runAsync(e, 'get_pr_impact', {
      files: [{ file: 'src/Lending/Other.ts', symbols: [{ symbolId: 'src/Lending/Other.ts::O::class' }] }],
    });

    expect(result).not.toHaveProperty('contextBoundaryViolations');
  });

  it('contextBoundaryViolations is capped at 50 with contextBoundaryViolationsTotal', async () => {
    const many = Array.from({ length: 60 }, (_, i) => violation(i));
    const changed = {
      files: many.map((v) => ({ file: v.from.file, symbols: [{ symbolId: v.from.symbolId }] })),
    };

    const capped = await runAsync(enrichers({ violations: many }), 'get_pr_impact', changed);

    expect(capped['contextBoundaryViolations']).toEqual(many.slice(0, 50));
    expect(capped['contextBoundaryViolationsTotal']).toBe(60);
  });

  it('contextBoundaryViolations keeps all ten with no total field', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => violation(i));
    const changed = { files: ten.map((v) => ({ file: v.from.file, symbols: [{ symbolId: v.from.symbolId }] })) };

    const result = await runAsync(enrichers({ violations: ten }), 'get_pr_impact', changed);

    expect(result['contextBoundaryViolations']).toEqual(ten);
    expect(result).not.toHaveProperty('contextBoundaryViolationsTotal');
  });

  it('contextDrift appears for a symbol whose context has history', () => {
    const e = enrichers({ history: [historyEntry('aaaaaaa1', 100, 0.2), historyEntry('bbbbbbb2', 200, 0.4)] });
    const args = { symbolId: 'src/Lending/Loan.ts::Loan::class' };

    const result = run(e, 'get_why_context', { symbolId: args.symbolId, commitHistory: [] }, args);

    expect(result['contextDrift']).toMatchObject({
      context: 'lending',
      crossShare: { current: 0.4, previous: 0.2 },
      distinctCommits: 2,
      confidence: 'low',
    });
  });

  it('contextDrift is absent for an unowned file or a context without history', () => {
    const e = enrichers({ history: [historyEntry('aaaaaaa1', 100, 0.2)] });
    const loose = { symbolId: 'src/Loose.ts::Loose::class' };
    const billing = { symbolId: 'src/Billing/Invoice.ts::Invoice::class' };

    expect(run(e, 'get_why_context', { ...loose }, loose)).not.toHaveProperty('contextDrift');
    expect(run(e, 'get_why_context', { ...billing }, billing)).not.toHaveProperty('contextDrift');
  });

  it('picks up a rewritten artifact after its mtime changes', () => {
    const e = enrichers();
    const payload = { results: [{ symbolId: 'a', file: 'src/Lending/Loan.ts' }] };
    expect(run(e, 'search_symbols', payload)['results']).toEqual([{ symbolId: 'a', file: 'src/Lending/Loan.ts', context: 'lending' }]);

    const host = createModuleHost({ projectRoot: dir, mode: 'cli' });
    const next = contexts();
    new DomainArtifactStore(host.ctxoRoot).writeIfChanged('contexts.json', {
      ...next,
      contexts: next.contexts.map((c) => (c.id === 'lending' ? { ...c, files: [] } : c)),
    });

    // Same size or not, a different mtime or size invalidates the cache; force a distinct mtime.
    const file = join(host.ctxoRoot, 'index', 'domain', 'contexts.json');
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, future, future);

    expect(run(e, 'search_symbols', payload)).toEqual(payload);
  });
  it('never maps a 2-part data reference to a file context', () => {
    const e = enrichers();
    const entry = { symbolId: 'src/Lending/Loan.ts::table' };
    expect(run(e, 'get_blast_radius', { impactedSymbols: [{ ...entry }] })['impactedSymbols']).toEqual([entry]);
    expect(run(e, 'get_why_context', { ...entry }, entry)).not.toHaveProperty('contextDrift');
    // a canonical 3-part id still maps
    const three = { symbolId: 'src/Lending/Loan.ts::Loan::class' };
    expect(run(e, 'get_blast_radius', { impactedSymbols: [{ ...three }] })['impactedSymbols']).toEqual([{ ...three, context: 'lending' }]);
  });

  it('loads config.yaml once until its mtime or size changes', () => {
    mkdirSync(join(dir, '.ctxo'), { recursive: true });
    const configPath = join(dir, '.ctxo', 'config.yaml');
    writeFileSync(configPath, 'version: "1.0"\n');
    mkdirSync(join(dir, 'docs', 'domain'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'domain', 'contexts.yaml'), REGISTRY);
    const base = createModuleHost({ projectRoot: dir, mode: 'cli' });
    const loadConfig = vi.fn(base.services.loadConfig);
    const spied = { ...base, services: { ...base.services, loadConfig } };
    const e = createEnrichers(spied, createDomainState(spied));
    const payload = { results: [{ symbolId: 'a', file: 'src/Lending/Loan.ts' }] };

    e.search_symbols!(structuredClone(payload), {});
    e.search_symbols!(structuredClone(payload), {});
    e.find_importers!({ importers: [] }, {});
    expect(loadConfig).toHaveBeenCalledTimes(1);

    writeFileSync(configPath, 'version: "1.0"\nstats:\n  enabled: false\n');
    e.search_symbols!(structuredClone(payload), {});
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });

  it("createEnrichers composes PR 2B's fields with the graph fields", async () => {
    mkdirSync(join(dir, 'docs', 'domain', 'lending'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'domain', 'contexts.yaml'), REGISTRY_TEXT);
    for (const [path, text] of Object.entries(LENDING_FIXTURE.cards)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const host = createModuleHost({ projectRoot: dir, mode: 'cli' });
    const store = new DomainArtifactStore(host.ctxoRoot);
    store.writeIfChanged('contexts.json', {
      ...contexts(registryHash(REGISTRY_TEXT)),
      contexts: [{ id: 'lending', name: 'Lending', rung: 'bounded', fileCount: 1, files: [POLICY_FILE] }],
      multiplyOwned: [],
    });
    store.writeIfChanged('graph.json', buildFixtureGraph());
    const e = createEnrichers(host, createDomainState(host));

    const result = await e.get_blast_radius!({ symbolId: ROOT, impactedSymbols: [{ symbolId: ROOT }, { symbolId: TEST }] }, {});
    expect(result['impactedSymbols']).toEqual([{ symbolId: ROOT, context: 'lending' }, { symbolId: TEST }]);
    expect((result['rulesAffected'] as { ruleId: string }[]).map((r) => r.ruleId)).toEqual(['LEND-03']);
    expect(result['cardsToUpdate']).toEqual([{ context: 'lending', card: LENDING_CARD }]);

    const why = await e.get_why_context!({ commitHistory: [] }, { symbolId: ROOT });
    expect(why['decisions']).toHaveLength(5);

    const task = e.get_context_for_task!({ context: [], totalTokens: 0, tokenBudget: 4000 }, { symbolId: ROOT });
    expect(task).not.toBeInstanceOf(Promise);
    expect((task as Record<string, unknown>)['cardExcerpt']).toMatchObject({ context: 'lending', card: LENDING_CARD });
  });

  it('get_context_for_task adds nothing without a registry (byte-identical payload)', () => {
    const e = enrichers({ registry: false });
    const payload = { context: [{ symbolId: 'a' }], totalTokens: 10, tokenBudget: 4000 };
    expect(JSON.stringify(e.get_context_for_task!(structuredClone(payload), { symbolId: 'a' }))).toBe(JSON.stringify(payload));
  });
});

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(`falls back to the core payload with a warning when an async enricher does not settle within ${ENRICHER_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const never = (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      payload['added'] = true;
      return new Promise(() => undefined);
    };
    const bounded = withTimeout('get_pr_impact', never, warn);
    const payload = { files: [] };
    const pending = bounded(payload, {});
    await vi.advanceTimersByTimeAsync(ENRICHER_TIMEOUT_MS - 1);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The core payload, without the fields the enricher had started to add.
    await expect(pending).resolves.toEqual({ files: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      `The get_pr_impact domain fields did not settle within ${ENRICHER_TIMEOUT_MS} ms; they are left out of this response`,
    );
    expect(ENRICHER_TIMEOUT_MS).toBe(5_000);
  });

  it('a rejection after the timeout stays silent', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectLate: (err: Error) => void = () => undefined;
      const late = (): Promise<Record<string, unknown>> =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        });
      const warn = vi.fn();
      const pending = withTimeout('get_why_context', late, warn, 100)({ a: 1 }, {});
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({ a: 1 });
      rejectLate(new Error('too late'));
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('leaves no timer after a success or a rejection in time', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    await expect(withTimeout('get_blast_radius', async (p) => ({ ...p, b: 2 }), warn)({ x: 1 }, {})).resolves.toEqual({ x: 1, b: 2 });
    expect(vi.getTimerCount()).toBe(0);
    await expect(withTimeout('get_blast_radius', () => Promise.reject(new Error('boom')), warn)({}, {})).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a synchronous result through and a settled Promise result through', async () => {
    const warn = vi.fn();
    const sync = withTimeout('get_blast_radius', (p) => ({ ...p, a: 1 }), warn);
    expect(sync({ x: 1 }, {})).toEqual({ x: 1, a: 1 });
    const async = withTimeout('get_blast_radius', async (p) => ({ ...p, b: 2 }), warn, 50);
    await expect(async({ x: 1 }, {})).resolves.toEqual({ x: 1, b: 2 });
    const rejecting = withTimeout('get_blast_radius', () => Promise.reject(new Error('boom')), warn, 50);
    await expect(rejecting({ x: 1 }, {})).rejects.toThrow('boom');
    expect(warn).not.toHaveBeenCalled();
  });
});
