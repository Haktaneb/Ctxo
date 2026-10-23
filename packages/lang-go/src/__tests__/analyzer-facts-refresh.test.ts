import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnalyzerBatchResult, AnalyzerFileResult } from '../analyzer/analyzer-process.js';

vi.mock('../analyzer/analyzer-process.js', () => ({ runBatchAnalyze: vi.fn() }));

import { runBatchAnalyze } from '../analyzer/analyzer-process.js';
import { GoAnalyzerAdapter } from '../analyzer/analyzer-adapter.js';
import { DEFAULT_FACT_OPTIONS } from '../facts/fact-options.js';

const mockedRun = vi.mocked(runBatchAnalyze);

const hash = (source: string): string => createHash('sha256').update(source, 'utf8').digest('hex');

/** One analyzed file: a function `F` with one comparison against `limit`. */
function fileResult(file: string, source: string, limit: number): AnalyzerFileResult {
  const id = `${file}::F::function`;
  return {
    type: 'file',
    file,
    symbols: [{ symbolId: id, name: 'F', kind: 'function', startLine: 1, endLine: 5 }],
    edges: [{ from: id, to: 'other.go::G::function', kind: 'calls' }],
    complexity: [],
    factEvidence: [
      { kind: 'comparison', symbolId: id, line: 2, text: `n >= ${limit}`, operator: '>=', literal: String(limit), literalKind: 'number' },
    ],
    factSourceHash: hash(source),
  };
}

function batch(files: AnalyzerFileResult[]): AnalyzerBatchResult {
  return { files, dead: [], hasMain: false, timeout: false, totalFiles: files.length, elapsed: '1ms' };
}

const FAILED: AnalyzerBatchResult = { files: [], dead: [], hasMain: false, timeout: false, totalFiles: 0, elapsed: '', failed: true };

/** An adapter that is ready without a Go toolchain (the batch process is mocked). */
function readyAdapter(): GoAnalyzerAdapter {
  const adapter = new GoAnalyzerAdapter({ facts: DEFAULT_FACT_OPTIONS });
  Object.assign(adapter as unknown as Record<string, unknown>, { binaryPath: '/bin/analyzer', moduleRoot: '/repo', initialized: true });
  return adapter;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const source = (n: number): string => `package a\n\nfunc F(n int) bool { return n >= ${n} }\n`;

describe('GoAnalyzerAdapter stale fact re-runs', () => {
  beforeEach(() => {
    mockedRun.mockReset();
  });

  it('a stale file plus a failing re-run keeps the full tier for symbols and edges', async () => {
    mockedRun.mockResolvedValueOnce(batch([fileResult('a.go', source(5), 5)]));
    mockedRun.mockResolvedValueOnce(FAILED);
    const adapter = readyAdapter();

    expect((await adapter.extractFacts('a.go', source(5))).map((f) => f.text)).toEqual(['n >= 5']);
    await expect(adapter.extractFacts('a.go', source(6))).rejects.toThrow(/re-run/);
    expect(mockedRun).toHaveBeenCalledTimes(2);

    expect(adapter.hasBatchFailed()).toBe(false);
    expect(await adapter.isUsable()).toBe(true);
    expect((await adapter.extractSymbols('a.go', source(6))).map((s) => s.symbolId)).toEqual(['a.go::F::function']);
    expect(await adapter.extractEdges('a.go', source(6))).toEqual([{ from: 'a.go::F::function', to: 'other.go::G::function', kind: 'calls' }]);
  });

  it('a failed initial batch still marks the analyzer as failed', async () => {
    mockedRun.mockResolvedValueOnce(FAILED);
    const adapter = readyAdapter();
    expect(await adapter.isUsable()).toBe(false);
    expect(adapter.hasBatchFailed()).toBe(true);
  });

  it('many stale files during one run cause at most one follow-up run', async () => {
    const files = ['a.go', 'b.go', 'c.go', 'd.go', 'e.go'];
    mockedRun.mockResolvedValueOnce(batch(files.map((f) => fileResult(f, source(5), 5))));
    const adapter = readyAdapter();
    await adapter.extractFacts('a.go', source(5));
    expect(mockedRun).toHaveBeenCalledTimes(1);

    const second = deferred<AnalyzerBatchResult>();
    const third = deferred<AnalyzerBatchResult>();
    mockedRun.mockReturnValueOnce(second.promise);
    mockedRun.mockReturnValueOnce(third.promise);

    // a.go goes stale first and starts a re-run; the other four go stale while it runs.
    const first = adapter.extractFacts('a.go', source(6));
    await vi.waitFor(() => expect(mockedRun).toHaveBeenCalledTimes(2));
    const rest = files.slice(1).map((f) => adapter.extractFacts(f, source(6)));
    // Let all four find their evidence stale while the re-run is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedRun).toHaveBeenCalledTimes(2);

    second.resolve(batch(files.map((f) => fileResult(f, source(6), 6))));
    expect((await first).map((f) => f.text)).toEqual(['n >= 6']);
    await vi.waitFor(() => expect(mockedRun).toHaveBeenCalledTimes(3));
    third.resolve(batch(files.map((f) => fileResult(f, source(6), 6))));

    for (const facts of await Promise.all(rest)) expect(facts.map((f) => f.text)).toEqual(['n >= 6']);
    expect(mockedRun).toHaveBeenCalledTimes(3);

    // Nothing is stale any more: no further runs.
    await adapter.extractFacts('c.go', source(6));
    expect(mockedRun).toHaveBeenCalledTimes(3);
  });
});
