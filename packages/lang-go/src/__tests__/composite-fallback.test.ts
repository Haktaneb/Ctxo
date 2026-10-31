import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../analyzer/analyzer-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analyzer/analyzer-process.js')>()),
  runBatchAnalyze: vi.fn(),
}));

import { runBatchAnalyze } from '../analyzer/analyzer-process.js';
import { GoAnalyzerAdapter } from '../analyzer/analyzer-adapter.js';
import { GoCompositeAdapter } from '../composite-adapter.js';
import { DEFAULT_FACT_OPTIONS } from '../facts/fact-options.js';

const mockedRun = vi.mocked(runBatchAnalyze);

const SOURCE = 'package loans\n\nfunc Close() {}\n';

/** An analyzer adapter that looks ready without a Go toolchain; the batch run is the mocked one. */
function readyAnalyzer(): GoAnalyzerAdapter {
  const analyzer = new GoAnalyzerAdapter();
  Object.assign(analyzer as unknown as Record<string, unknown>, {
    initialized: true,
    binaryPath: '/fake/analyzer',
    moduleRoot: '/work/lending',
  });
  return analyzer;
}

function compositeWith(analyzer: GoAnalyzerAdapter): GoCompositeAdapter {
  const composite = new GoCompositeAdapter();
  (composite as unknown as { analyzer: GoAnalyzerAdapter }).analyzer = analyzer;
  return composite;
}

describe('GoCompositeAdapter - failed analyzer run', () => {
  beforeEach(() => mockedRun.mockReset());

  it('falls back to tree-sitter when the analyzer run failed, instead of returning empty results', async () => {
    mockedRun.mockResolvedValue({
      files: [], dead: [], hasMain: false, timeout: false, totalFiles: 0, elapsed: '', failed: true,
    });
    const composite = compositeWith(readyAnalyzer());

    const symbols = await composite.extractSymbols('loans/close.go', SOURCE);

    expect(symbols.map((s) => s.name)).toContain('Close');
    expect(composite.getTier()).toBe('syntax');
    expect(composite.getAnalyzerDelegate()).toBeNull();
    expect(mockedRun).toHaveBeenCalledTimes(1);
    await composite.extractEdges('loans/close.go', SOURCE);
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });

  it('keeps using the analyzer when its run succeeded', async () => {
    mockedRun.mockResolvedValue({
      files: [{
        type: 'file', file: 'loans/close.go', edges: [], complexity: [],
        symbols: [{ symbolId: 'loans/close.go::Close::function', name: 'Close', kind: 'function', startLine: 3, endLine: 3 }],
      }],
      dead: [], hasMain: false, timeout: false, totalFiles: 1, elapsed: '1ms',
    });
    const composite = compositeWith(readyAnalyzer());

    const symbols = await composite.extractSymbols('loans/close.go', SOURCE);

    expect(symbols.map((s) => s.symbolId)).toEqual(['loans/close.go::Close::function']);
    expect(composite.getTier()).toBe('full');
  });
});

describe('GoCompositeAdapter - fact extraction failure (B-M1)', () => {
  it('an internal failure is warned on stderr and gives [] (warn-and-continue)', async () => {
    const composite = new GoCompositeAdapter({ facts: DEFAULT_FACT_OPTIONS });
    const treeSitter = (composite as unknown as { treeSitter: { parse(source: string): unknown } }).treeSitter;
    vi.spyOn(treeSitter, 'parse').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    let facts: unknown;
    try {
      facts = await composite.extractFacts('loans/close.go', SOURCE);
    } finally {
      spy.mockRestore();
    }
    expect(facts).toEqual([]);
    expect(writes.join('')).toContain('[ctxo:lang-go] Fact extraction failed for loans/close.go: Maximum call stack size exceeded');
  });
});
