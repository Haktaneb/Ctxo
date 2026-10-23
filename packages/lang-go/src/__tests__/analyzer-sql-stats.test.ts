import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../analyzer/analyzer-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analyzer/analyzer-process.js')>()),
  runBatchAnalyze: vi.fn(),
}));

import { runBatchAnalyze } from '../analyzer/analyzer-process.js';
import { GoAnalyzerAdapter } from '../analyzer/analyzer-adapter.js';

const mockedRun = vi.mocked(runBatchAnalyze);

/** An analyzer adapter that looks ready without a Go toolchain; the batch run is the mocked one. */
function sqlAnalyzer(sqlCallSites: boolean): GoAnalyzerAdapter {
  const analyzer = new GoAnalyzerAdapter({ sqlCallSites });
  Object.assign(analyzer as unknown as Record<string, unknown>, {
    initialized: true,
    binaryPath: '/fake/analyzer',
    moduleRoot: '/work/lending',
  });
  return analyzer;
}

const BASE = { files: [], dead: [], hasMain: false, timeout: false, totalFiles: 0, elapsed: '1ms' };

describe('GoAnalyzerAdapter - SQL statistics logging', () => {
  let stderr: string[];

  beforeEach(() => {
    mockedRun.mockReset();
    stderr = [];
    vi.stubEnv('DEBUG', 'ctxo:*');
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('logs the constant and non-constant counts of a batch', async () => {
    mockedRun.mockResolvedValue({ ...BASE, sql: { constant: 4, nonConstant: 2 } });

    await sqlAnalyzer(true).extractSymbols('loans/close.go', '');

    expect(stderr.join('')).toContain('4 constant, 2 non-constant');
  });

  it('warns when the analyzer reports no statistics although SQL call sites were requested', async () => {
    mockedRun.mockResolvedValue({ ...BASE });

    await sqlAnalyzer(true).extractSymbols('loans/close.go', '');

    expect(stderr.join('')).toContain('no SQL statistics');
  });

  it('stays quiet about statistics when SQL call sites were not requested', async () => {
    mockedRun.mockResolvedValue({ ...BASE });

    await sqlAnalyzer(false).extractSymbols('loans/close.go', '');

    expect(stderr.join('')).not.toContain('SQL statistics');
  });
});
