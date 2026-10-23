import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModuleHost } from '@ctxo/cli/internal';
import { DomainArtifactStore, type BoundariesArtifact, type ContextsArtifact } from '../../adapters/artifact-store.js';
import type { BoundaryViolationRecord } from '../../core/boundaries.js';
import type { ContextHistoryEntry } from '../../core/context-metrics.js';
import { registryHash } from '../../core/registry.js';
import { createEnrichers } from '../enrichers.js';

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
  return createEnrichers(host);
}

const run = (
  e: ReturnType<typeof enrichers>,
  tool: keyof ReturnType<typeof enrichers>,
  payload: Record<string, unknown>,
  args: Record<string, unknown> = {},
): Record<string, unknown> => e[tool]!(structuredClone(payload), args);

describe('createEnrichers', () => {
  it('registers an enricher for the six tools', () => {
    expect(Object.keys(enrichers()).sort()).toEqual([
      'find_importers',
      'get_blast_radius',
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

  it('get_pr_impact adds context to symbols of singly-owned files and nothing for unowned files', () => {
    const result = run(enrichers(), 'get_pr_impact', {
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

  it('without a registry the payload is unchanged', () => {
    const e = enrichers({ registry: false });
    const payload = { results: [{ symbolId: 'a', file: 'src/Lending/Loan.ts' }] };

    expect(run(e, 'search_symbols', payload)).toEqual(payload);
    expect(run(e, 'get_pr_impact', { files: [] })).toEqual({ files: [] });
    expect(run(e, 'get_why_context', { symbolId: 'src/Lending/Loan.ts::Loan::class' }, { symbolId: 'src/Lending/Loan.ts::Loan::class' })).toEqual({
      symbolId: 'src/Lending/Loan.ts::Loan::class',
    });
  });

  it('stale artifacts add nothing', () => {
    const e = enrichers({
      hash: 'not-the-current-hash',
      violations: [violation(1)],
      history: [historyEntry('aaaaaaa1', 100, 0.2, 'not-the-current-hash')],
    });
    const search = { results: [{ symbolId: 'a', file: 'src/Lending/Loan.ts' }] };
    const pr = { files: [{ file: 'src/Lending/L1.ts', symbols: [{ symbolId: 'src/Lending/L1.ts::L1::class' }] }] };

    expect(run(e, 'search_symbols', search)).toEqual(search);
    expect(run(e, 'get_pr_impact', pr)).toEqual(pr);
    const why = { symbolId: 'src/Lending/Loan.ts::Loan::class' };
    expect(run(e, 'get_why_context', why, why)).toEqual(why);
  });

  it('contextBoundaryViolations lists the violations touching changed symbols', () => {
    const e = enrichers({ violations: [violation(1), violation(2), violation(3)] });

    const result = run(e, 'get_pr_impact', {
      files: [
        { file: 'src/Lending/L1.ts', symbols: [{ symbolId: 'src/Lending/L1.ts::L1::class' }] },
        // The `to` end of violation 3 is a changed symbol too.
        { file: 'src/Billing/B3.ts', symbols: [{ symbolId: 'src/Billing/B3.ts::B3::class' }] },
      ],
    });

    expect(result['contextBoundaryViolations']).toEqual([violation(1), violation(3)]);
    expect(result).not.toHaveProperty('contextBoundaryViolationsTotal');
  });

  it('contextBoundaryViolations is absent when no violation touches a changed symbol', () => {
    const e = enrichers({ violations: [violation(1)] });

    const result = run(e, 'get_pr_impact', {
      files: [{ file: 'src/Lending/Other.ts', symbols: [{ symbolId: 'src/Lending/Other.ts::O::class' }] }],
    });

    expect(result).not.toHaveProperty('contextBoundaryViolations');
  });

  it('contextBoundaryViolations is capped at 50 with contextBoundaryViolationsTotal', () => {
    const many = Array.from({ length: 60 }, (_, i) => violation(i));
    const changed = {
      files: many.map((v) => ({ file: v.from.file, symbols: [{ symbolId: v.from.symbolId }] })),
    };

    const capped = run(enrichers({ violations: many }), 'get_pr_impact', changed);

    expect(capped['contextBoundaryViolations']).toEqual(many.slice(0, 50));
    expect(capped['contextBoundaryViolationsTotal']).toBe(60);
  });

  it('contextBoundaryViolations keeps all ten with no total field', () => {
    const ten = Array.from({ length: 10 }, (_, i) => violation(i));
    const changed = { files: ten.map((v) => ({ file: v.from.file, symbols: [{ symbolId: v.from.symbolId }] })) };

    const result = run(enrichers({ violations: ten }), 'get_pr_impact', changed);

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
});
