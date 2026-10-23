import { describe, it, expect } from 'vitest';
import { createModuleHost, type CommitChangeSet } from '@ctxo/cli/internal';
import type { BoundaryResult, ContextEdgeCounts } from '../boundaries.js';
import { contextDrift, historyEntry, movedFiles, type ContextHistoryEntry, type MovedFile } from '../context-metrics.js';
import { createOwnership } from '../ownership.js';
import { parseRegistry } from '../registry.js';

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    paths: ["src/Lending/**"]
    rung: bounded
  - id: billing
    name: Billing
    paths: ["src/Billing/**"]
    rung: named
`;

function ownership() {
  const { registry } = parseRegistry(REGISTRY);
  const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });
  return createOwnership(registry!, host.services.makeGlobMatcher);
}

function boundaries(perContext: Record<string, ContextEdgeCounts>): BoundaryResult {
  return { crossEdges: [], violations: [], perContext: new Map(Object.entries(perContext)) };
}

function entry(commitSha: string, committedAt: number, crossShare: Record<string, number>, hash = 'h1'): ContextHistoryEntry {
  return {
    ctxoArtifact: 'domain-history',
    version: 1,
    commitSha,
    committedAt,
    registryHash: hash,
    contexts: Object.entries(crossShare).map(([id, share]) => ({ id, files: 1, internalEdges: 1, crossOut: 0, crossIn: 0, crossShare: share })),
  };
}

function commit(hash: string, date: string, changes: CommitChangeSet['changes']): CommitChangeSet {
  return { hash, message: 'm', date, author: 'a', committedAt: Date.parse(date) / 1000, changes };
}

describe('historyEntry', () => {
  it('crossShare counts internal and outgoing edges', () => {
    const result = historyEntry(
      { sha: 'abc1234', committedAt: 1_700_000_000 },
      'h1',
      new Map([
        ['lending', 4],
        ['billing', 2],
      ]),
      boundaries({
        lending: { internal: 2, out: 1, in: 5 },
        billing: { internal: 0, out: 0, in: 1 },
      }),
    );

    expect(result).toEqual({
      ctxoArtifact: 'domain-history',
      version: 1,
      commitSha: 'abc1234',
      committedAt: 1_700_000_000,
      registryHash: 'h1',
      contexts: [
        { id: 'billing', files: 2, internalEdges: 0, crossOut: 0, crossIn: 1, crossShare: 0 },
        { id: 'lending', files: 4, internalEdges: 2, crossOut: 1, crossIn: 5, crossShare: 0.333 },
      ],
    });
  });
});

describe('movedFiles', () => {
  it('movedFiles lists renames that cross contexts', () => {
    const commits = [
      commit('c3', '2026-03-03T10:00:00+02:00', [
        { status: 'R', oldPath: 'src/Billing/Fee.ts', path: 'src/Lending/Fee.ts' },
        { status: 'R', oldPath: 'src/Lending/A.ts', path: 'src/Lending/B.ts' },
        { status: 'M', path: 'src/Billing/Invoice.ts' },
      ]),
      commit('c2', '2026-03-02T10:00:00Z', [
        { status: 'R', oldPath: 'src/Host/Late.ts', path: 'src/Billing/Late.ts' },
        { status: 'R', oldPath: 'src/Lending/Charge.ts', path: 'src/Billing/Charge.ts' },
        { status: 'C', oldPath: 'src/Lending/Copy.ts', path: 'src/Billing/Copy.ts' },
      ]),
      commit('c1', '2026-03-01T10:00:00Z', [{ status: 'R', oldPath: 'src/Lending/Old.ts', path: 'src/Elsewhere/Old.ts' }]),
    ];

    expect(movedFiles(commits, ownership())).toEqual<MovedFile[]>([
      { file: 'src/Lending/Fee.ts', from: 'src/Billing/Fee.ts', fromContext: 'billing', toContext: 'lending', commit: 'c3', date: '2026-03-03T10:00:00+02:00' },
      { file: 'src/Billing/Charge.ts', from: 'src/Lending/Charge.ts', fromContext: 'lending', toContext: 'billing', commit: 'c2', date: '2026-03-02T10:00:00Z' },
      { file: 'src/Billing/Late.ts', from: 'src/Host/Late.ts', toContext: 'billing', commit: 'c2', date: '2026-03-02T10:00:00Z' },
      { file: 'src/Elsewhere/Old.ts', from: 'src/Lending/Old.ts', fromContext: 'lending', commit: 'c1', date: '2026-03-01T10:00:00Z' },
    ]);
  });
});

describe('contextDrift', () => {
  it('contextDrift compares with the newest entry of another commit and ignores entries of another registry', () => {
    const history = [
      entry('aaa', 100, { lending: 0.1 }),
      entry('bbb', 200, { lending: 0.2 }),
      entry('ccc', 300, { lending: 0.25 }, 'other'),
      entry('ddd', 400, { lending: 0.5, billing: 0 }),
    ];
    const moved: MovedFile[] = [
      { file: 'src/Lending/Fee.ts', from: 'src/Billing/Fee.ts', fromContext: 'billing', toContext: 'lending', commit: 'c3', date: '2026-03-03T10:00:00Z' },
      { file: 'src/Billing/X.ts', from: 'src/Other/X.ts', toContext: 'billing', commit: 'c2', date: '2026-03-02T10:00:00Z' },
    ];

    const drift = contextDrift('lending', [...history].reverse(), moved, 'h1');

    expect(drift).toEqual({
      context: 'lending',
      crossShare: { current: 0.5, previous: 0.2, delta: 0.3 },
      trend: [
        { commitSha: 'aaa', crossShare: 0.1 },
        { commitSha: 'bbb', crossShare: 0.2 },
        { commitSha: 'ddd', crossShare: 0.5 },
      ],
      movedFiles: [moved[0]],
      distinctCommits: 3,
      confidence: 'medium',
    });
  });

  it('a single entry has no previous value; an unknown context or registry gives undefined', () => {
    const history = [entry('aaa', 100, { lending: 0.1 })];

    expect(contextDrift('lending', history, [], 'h1')).toEqual({
      context: 'lending',
      crossShare: { current: 0.1 },
      trend: [{ commitSha: 'aaa', crossShare: 0.1 }],
      movedFiles: [],
      distinctCommits: 1,
      confidence: 'low',
    });
    expect(contextDrift('billing', history, [], 'h1')).toBeUndefined();
    expect(contextDrift('lending', history, [], 'other')).toBeUndefined();
  });

  it('confidence follows the distinct-commit thresholds', () => {
    const history = (n: number): ContextHistoryEntry[] =>
      Array.from({ length: n }, (_, i) => entry(`s${i}`, 100 + i, { lending: 0.1 }));
    const confidence = (n: number) => contextDrift('lending', history(n), [], 'h1')?.confidence;

    expect(confidence(2)).toBe('low');
    expect(confidence(3)).toBe('medium');
    expect(confidence(6)).toBe('medium');
    expect(confidence(7)).toBe('high');
    expect(contextDrift('lending', history(7), [], 'h1')?.distinctCommits).toBe(7);
  });
});
