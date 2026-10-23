import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../jdt-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jdt-process.js')>()),
  runBatchIndex: vi.fn(),
}));

import { runBatchIndex } from '../jdt-process.js';
import { JdtAnalyzerAdapter } from '../jdt-adapter.js';

const mockedRun = vi.mocked(runBatchIndex);

/** An adapter that looks ready without a JRE; the batch run is the mocked one. */
function readyAdapter(sqlCallSites: boolean): JdtAnalyzerAdapter {
  const adapter = new JdtAnalyzerAdapter({ sqlCallSites });
  Object.assign(adapter as unknown as Record<string, unknown>, {
    initialized: true,
    jarPath: '/fake/analyzer.jar',
    root: '/work/lending',
  });
  return adapter;
}

describe('JdtAnalyzerAdapter - SQL statistics logging', () => {
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
    mockedRun.mockResolvedValue({ files: [], totalFiles: 0, elapsed: '1ms', sql: { constant: 3, nonConstant: 1 } });
    const adapter = readyAdapter(true);

    await adapter.extractSymbols('src/A.java', '');

    expect(stderr.join('')).toContain('3 constant, 1 non-constant');
    expect(adapter.getSqlStats()).toEqual({ constant: 3, nonConstant: 1 });
  });

  it('warns when SQL call sites were requested and the analyzer reports no statistics', async () => {
    mockedRun.mockResolvedValue({ files: [], totalFiles: 0, elapsed: '1ms' });

    await readyAdapter(true).extractSymbols('src/A.java', '');

    expect(stderr.join('')).toContain('no SQL statistics');
  });

  it('stays quiet about statistics when SQL call sites were not requested', async () => {
    mockedRun.mockResolvedValue({ files: [], totalFiles: 0, elapsed: '1ms' });

    await readyAdapter(false).extractSymbols('src/A.java', '');

    expect(stderr.join('')).not.toContain('SQL statistics');
  });
});
