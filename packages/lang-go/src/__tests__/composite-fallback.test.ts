import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../analyzer/analyzer-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analyzer/analyzer-process.js')>()),
  runBatchAnalyze: vi.fn(),
}));

import { runBatchAnalyze } from '../analyzer/analyzer-process.js';
import { GoAnalyzerAdapter } from '../analyzer/analyzer-adapter.js';
import { GoCompositeAdapter } from '../composite-adapter.js';

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
