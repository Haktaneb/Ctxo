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

  it('a caller between the end of a run and the start of the queued follow-up joins the follow-up', async () => {
    mockedRun.mockResolvedValueOnce(batch([fileResult('a.go', source(5), 5)]));
    const adapter = readyAdapter();
    await adapter.extractFacts('a.go', source(5));
    expect(mockedRun).toHaveBeenCalledTimes(1);

    // The gap: the running re-run has cleared itself, the queued follow-up has not started yet.
    const queued = deferred<boolean>();
    const state = adapter as unknown as { refreshRunning: Promise<boolean> | null; refreshQueued: Promise<boolean> | null; requestRefresh(): Promise<boolean> };
    state.refreshRunning = null;
    state.refreshQueued = queued.promise;

    const joined = state.requestRefresh();
    expect(joined).toBe(queued.promise);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    queued.resolve(true);
    expect(await joined).toBe(true);
  });

  it('a re-run that rejects does not leave the follow-up stuck; a later request still re-runs', async () => {
    const files = ['a.go', 'b.go'];
    mockedRun.mockResolvedValueOnce(batch(files.map((f) => fileResult(f, source(5), 5))));
    const adapter = readyAdapter();
    await adapter.extractFacts('a.go', source(5));

    mockedRun.mockImplementationOnce(() => {
      throw new Error('spawn EACCES');
    });
    mockedRun.mockImplementationOnce(() => {
      throw new Error('spawn EACCES');
    });
    const failing = files.map((f) => adapter.extractFacts(f, source(6)).then(() => 'ok', (err: Error) => err.message));
    expect(await Promise.all(failing)).toEqual([
      'Go analyzer re-run failed; no fact evidence for a.go',
      'Go analyzer re-run failed; no fact evidence for b.go',
    ]);
    expect(mockedRun).toHaveBeenCalledTimes(3);
    expect(adapter.hasBatchFailed()).toBe(false);

    mockedRun.mockResolvedValueOnce(batch(files.map((f) => fileResult(f, source(6), 6))));
    expect((await adapter.extractFacts('b.go', source(6))).map((f) => f.text)).toEqual(['n >= 6']);
    expect(mockedRun).toHaveBeenCalledTimes(4);
  });

  it('dispose during an in-flight re-run keeps the late result out of the cache', async () => {
    mockedRun.mockResolvedValueOnce(batch([fileResult('a.go', source(5), 5)]));
    const adapter = readyAdapter();
    await adapter.extractFacts('a.go', source(5));

    const late = deferred<AnalyzerBatchResult>();
    mockedRun.mockReturnValueOnce(late.promise);
    const pending = adapter.extractFacts('a.go', source(6)).catch(() => []);
    await vi.waitFor(() => expect(mockedRun).toHaveBeenCalledTimes(2));

    await adapter.dispose();
    late.resolve(batch([fileResult('a.go', source(6), 6)]));
    expect(await pending).toEqual([]);
    expect((adapter as unknown as { cache: Map<string, unknown> }).cache.size).toBe(0);
  });

  it('a chained duration amount finishes as one product', async () => {
    const id = 'a.go::Wait::function';
    const file: AnalyzerFileResult = {
      type: 'file',
      file: 'a.go',
      symbols: [{ symbolId: id, name: 'Wait', kind: 'function', startLine: 1, endLine: 4 }],
      edges: [],
      complexity: [],
      factEvidence: [
        { kind: 'duration', symbolId: id, line: 1, text: '2 * time.Second * 3', constructor: 'time.Second', unit: 's', amount: '(2) * (3)' },
        { kind: 'duration', symbolId: id, line: 2, text: '4 * (time.Minute * 15)', name: 'graceTimeout', constructor: 'time.Minute', unit: 'min', amount: '(15) * (4)' },
      ],
      factSourceHash: hash('wait'),
    };
    mockedRun.mockResolvedValueOnce(batch([file]));
    const facts = await readyAdapter().extractFacts('a.go', 'wait');
    expect(facts.map((f) => [f.text, f.detail])).toEqual([
      ['time.Second = 6s', { name: 'time.Second', value: '6s' }],
      ['graceTimeout = 60min', { name: 'graceTimeout', value: '60min' }],
    ]);
  });
});
