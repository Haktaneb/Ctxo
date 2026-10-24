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

const source = (n: number): string => `package a\n\nfunc F(n int) bool {\n\tif n >= ${n} {\n\t\treturn true\n\t}\n\treturn false\n}\n`;

describe('GoAnalyzerAdapter stale fact evidence (B-I1)', () => {
  beforeEach(() => {
    mockedRun.mockReset();
  });

  it('a save after the batch: symbols stay full tier, facts come from the tree-sitter collector, no re-run', async () => {
    mockedRun.mockResolvedValueOnce(batch([fileResult('a.go', source(5), 5)]));
    const adapter = readyAdapter();
    expect((await adapter.extractFacts('a.go', source(5))).map((f) => f.text)).toEqual(['n >= 5']);
    expect(mockedRun).toHaveBeenCalledTimes(1);

    // The watch order for a save: extractSymbols, extractEdges, then extractFacts with the new bytes.
    expect((await adapter.extractSymbols('a.go', source(6))).map((s) => s.symbolId)).toEqual(['a.go::F::function']);
    expect(await adapter.extractEdges('a.go', source(6))).toEqual([{ from: 'a.go::F::function', to: 'other.go::G::function', kind: 'calls' }]);
    const facts = await adapter.extractFacts('a.go', source(6));
    expect(facts.map((f) => [f.symbolId, f.text])).toEqual([['a.go::F::function', 'n >= 6']]);
    expect(mockedRun).toHaveBeenCalledTimes(1);

    // Every later save is served the same way; the analyzer never runs again.
    for (const n of [7, 8, 9]) {
      expect((await adapter.extractFacts('a.go', source(n))).map((f) => f.text)).toEqual([`n >= ${n}`]);
    }
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(adapter.hasBatchFailed()).toBe(false);
    expect(await adapter.isUsable()).toBe(true);
  });

  it('a stale file uses the syntax-tier collector it was given', async () => {
    mockedRun.mockResolvedValueOnce(batch([fileResult('a.go', source(5), 5)]));
    const calls: string[] = [];
    const adapter = new GoAnalyzerAdapter({
      facts: DEFAULT_FACT_OPTIONS,
      syntaxFacts: {
        extractFacts: async (filePath: string) => {
          calls.push(filePath);
          return [];
        },
      },
    });
    Object.assign(adapter as unknown as Record<string, unknown>, { binaryPath: '/bin/analyzer', moduleRoot: '/repo', initialized: true });
    expect((await adapter.extractFacts('a.go', source(5))).map((f) => f.text)).toEqual(['n >= 5']);
    expect(calls).toEqual([]);
    expect(await adapter.extractFacts('a.go', source(6))).toEqual([]);
    expect(calls).toEqual(['a.go']);
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });

  it('a failed initial batch still marks the analyzer as failed', async () => {
    mockedRun.mockResolvedValueOnce(FAILED);
    const adapter = readyAdapter();
    expect(await adapter.isUsable()).toBe(false);
    expect(adapter.hasBatchFailed()).toBe(true);
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
