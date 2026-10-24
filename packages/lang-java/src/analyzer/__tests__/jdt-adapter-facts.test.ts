import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FactOptions } from '../../facts/fact-types.js';
import { DEFAULT_FACT_OPTIONS } from '../../facts/fact-options.js';
import type { JdtFileResult } from '../jdt-process.js';

const keepAlive = vi.hoisted(() => ({
  options: [] as unknown[],
  results: [] as unknown[],
  reportsFacts: true,
}));

vi.mock('../jdt-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jdt-process.js')>()),
  runBatchIndex: vi.fn(),
  JdtKeepAlive: class {
    constructor(_java: string, _jar: string, _root: string, options: unknown) {
      keepAlive.options.push(options);
    }
    start(): Promise<boolean> { return Promise.resolve(true); }
    isAlive(): boolean { return true; }
    reportsFacts(): boolean { return keepAlive.reportsFacts; }
    analyzeFile(): Promise<unknown> { return Promise.resolve(keepAlive.results.shift() ?? null); }
    shutdown(): Promise<void> { return Promise.resolve(); }
  },
}));

import { runBatchIndex } from '../jdt-process.js';
import { JdtAnalyzerAdapter } from '../jdt-adapter.js';

const mockedRun = vi.mocked(runBatchIndex);
const FILE = 'src/main/java/lending/facts/LoanRules.java';
const CONTROLLER = 'src/main/java/lending/facts/LoanController.java';

/** An adapter that looks ready without a JRE; the batch run and the keep-alive are mocked. */
function readyAdapter(options: { sqlCallSites?: boolean; facts?: FactOptions }): JdtAnalyzerAdapter {
  const adapter = new JdtAnalyzerAdapter(options);
  Object.assign(adapter as unknown as Record<string, unknown>, {
    initialized: true,
    jarPath: '/fake/analyzer.jar',
    root: '/work/lending',
  });
  return adapter;
}

function rules(value: string, line: number): JdtFileResult {
  return {
    type: 'file',
    file: FILE,
    symbols: [
      { symbolId: `${FILE}::LoanRules::class`, name: 'LoanRules', kind: 'class', startLine: 2, endLine: 30 },
      { symbolId: `${FILE}::MAX_RETRIES::variable`, name: 'MAX_RETRIES', kind: 'variable', startLine: line, endLine: line },
    ],
    edges: [],
    complexity: [],
    factEvidence: [
      { kind: 'binding', symbolId: `${FILE}::MAX_RETRIES::variable`, line, name: 'MAX_RETRIES', value },
      { kind: 'comparison', symbolId: `${FILE}::LoanRules::class`, line: 9, text: 'x == null', operator: '==', literal: 'null', literalKind: 'null' },
    ],
  };
}

const controller: JdtFileResult = {
  type: 'file',
  file: CONTROLLER,
  symbols: [
    { symbolId: `${CONTROLLER}::LoanController::class`, name: 'LoanController', kind: 'class', startLine: 8, endLine: 25, annotations: [{ name: 'RequestMapping', args: ['/api/loans'] }] },
    { symbolId: `${CONTROLLER}::renew::method`, name: 'renew', kind: 'method', startLine: 21, endLine: 24, annotations: [{ name: 'RequestMapping', args: ['/renew'], named: { method: 'RequestMethod.POST' } }] },
  ],
  edges: [],
  complexity: [],
};

describe('JdtAnalyzerAdapter facts', () => {
  beforeEach(() => {
    mockedRun.mockReset();
    keepAlive.options.length = 0;
    keepAlive.results.length = 0;
    keepAlive.reportsFacts = true;
  });

  describe('the facts marker (an analyzer too old for --facts= ignores it)', () => {
    const WARNING = 'analyzer too old for facts; run ctxo install java --full-tier';
    let stderr: string[];

    beforeEach(() => {
      stderr = [];
      // No DEBUG: the warning must reach the user whatever the debug namespaces are.
      vi.stubEnv('DEBUG', '');
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    const warnings = (): number => stderr.filter((line) => line.includes(WARNING)).length;

    it('warns once when facts were requested and neither the done line nor the ready line carries the marker', async () => {
      mockedRun.mockResolvedValue({ files: [rules('3', 3)], totalFiles: 1, elapsed: '1ms' });
      keepAlive.reportsFacts = false;
      const adapter = readyAdapter({ facts: DEFAULT_FACT_OPTIONS });
      await adapter.extractFacts(FILE, '');
      expect(warnings()).toBe(1);
      expect(stderr.find((line) => line.includes(WARNING))).toBe(`[ctxo:lang-java] ${WARNING}\n`);
      expect(await adapter.startKeepAlive()).toBe(true);
      expect(warnings()).toBe(1);
    });

    it('the keep-alive ready line without the marker warns too', async () => {
      keepAlive.reportsFacts = false;
      const adapter = readyAdapter({ facts: DEFAULT_FACT_OPTIONS });
      expect(await adapter.startKeepAlive()).toBe(true);
      expect(warnings()).toBe(1);
    });

    it('stays quiet when the analyzer reports facts, or when facts were not requested', async () => {
      mockedRun.mockResolvedValue({ files: [rules('3', 3)], totalFiles: 1, elapsed: '1ms', facts: true });
      const adapter = readyAdapter({ facts: DEFAULT_FACT_OPTIONS });
      await adapter.extractFacts(FILE, '');
      await adapter.startKeepAlive();

      mockedRun.mockResolvedValue({ files: [rules('3', 3)], totalFiles: 1, elapsed: '1ms' });
      keepAlive.reportsFacts = false;
      const plain = readyAdapter({});
      await plain.extractSymbols(FILE, '');
      await plain.startKeepAlive();
      expect(warnings()).toBe(0);
    });
  });

  it('extractFacts finishes the cached evidence plus annotation routes; the batch and the keep-alive get the options', async () => {
    mockedRun.mockResolvedValue({ files: [rules('3', 3), controller], totalFiles: 2, elapsed: '1ms' });
    const adapter = readyAdapter({ sqlCallSites: true, facts: DEFAULT_FACT_OPTIONS });

    expect(await adapter.extractFacts(FILE, '')).toEqual([
      { kind: 'retry-timeout', symbolId: `${FILE}::MAX_RETRIES::variable`, line: 3, text: 'MAX_RETRIES = 3', detail: { name: 'MAX_RETRIES', value: '3' } },
    ]);
    expect(await adapter.extractFacts(CONTROLLER, '')).toEqual([
      { kind: 'endpoint', symbolId: `${CONTROLLER}::renew::method`, line: 21, text: 'POST /api/loans/renew', detail: { verb: 'POST', route: '/api/loans/renew' } },
    ]);
    expect(await adapter.extractFacts('src/Missing.java', '')).toEqual([]);
    expect(mockedRun.mock.calls[0]![3]).toEqual({ sqlCallSites: true, facts: DEFAULT_FACT_OPTIONS });

    expect(await adapter.startKeepAlive()).toBe(true);
    expect(keepAlive.options).toEqual([{ sqlCallSites: true, facts: DEFAULT_FACT_OPTIONS }]);
  });

  it('after reindexFileRaw, extractFacts returns the new facts (the keep-alive result refreshes the cache)', async () => {
    mockedRun.mockResolvedValue({ files: [rules('3', 3)], totalFiles: 1, elapsed: '1ms' });
    const adapter = readyAdapter({ facts: DEFAULT_FACT_OPTIONS });
    expect((await adapter.extractFacts(FILE, '')).map((f) => f.text)).toEqual(['MAX_RETRIES = 3']);

    expect(await adapter.startKeepAlive()).toBe(true);
    keepAlive.results.push(rules('7', 4));
    const raw = await adapter.reindexFileRaw(FILE);
    expect(raw?.factEvidence?.[0]).toMatchObject({ value: '7' });

    expect(await adapter.extractFacts(FILE, '')).toEqual([
      { kind: 'retry-timeout', symbolId: `${FILE}::MAX_RETRIES::variable`, line: 4, text: 'MAX_RETRIES = 7', detail: { name: 'MAX_RETRIES', value: '7' } },
    ]);
    expect((await adapter.extractSymbols(FILE, '')).find((s) => s.name === 'MAX_RETRIES')?.startLine).toBe(4);
    expect(mockedRun).toHaveBeenCalledTimes(1);

    // A failed keep-alive request leaves the cache as it was.
    const failed = await adapter.reindexFileRaw(FILE);
    expect(failed).toBeNull();
    expect((await adapter.extractFacts(FILE, '')).map((f) => f.text)).toEqual(['MAX_RETRIES = 7']);
  });

  it('in watch order (keep-alive first) extractFacts reads the keep-alive result and never runs a batch (B-I2)', async () => {
    // A batch would fail (no files), which used to clear the cache and give facts: [] for the saved file.
    mockedRun.mockResolvedValue({ files: [], totalFiles: 0, elapsed: '1ms' });
    const adapter = readyAdapter({ facts: DEFAULT_FACT_OPTIONS });

    expect(await adapter.startKeepAlive()).toBe(true);
    keepAlive.results.push(rules('7', 4));
    expect(await adapter.reindexFileRaw(FILE)).not.toBeNull();

    expect(await adapter.extractFacts(FILE, '')).toEqual([
      { kind: 'retry-timeout', symbolId: `${FILE}::MAX_RETRIES::variable`, line: 4, text: 'MAX_RETRIES = 7', detail: { name: 'MAX_RETRIES', value: '7' } },
    ]);
    expect(mockedRun).not.toHaveBeenCalled();

    // A second save is served the same way.
    keepAlive.results.push(rules('9', 5));
    await adapter.reindexFileRaw(FILE);
    expect((await adapter.extractFacts(FILE, '')).map((f) => f.text)).toEqual(['MAX_RETRIES = 9']);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('without facts extractFacts returns [] and the analyzer gets no fact options', async () => {
    mockedRun.mockResolvedValue({ files: [rules('3', 3), controller], totalFiles: 2, elapsed: '1ms' });
    const adapter = readyAdapter({});
    expect(await adapter.extractFacts(FILE, '')).toEqual([]);
    expect(await adapter.extractFacts(CONTROLLER, '')).toEqual([]);
    expect(adapter.facts).toBeUndefined();
    await adapter.extractSymbols(FILE, '');
    expect(mockedRun.mock.calls[0]![3]).toEqual({ sqlCallSites: false });
    await adapter.startKeepAlive();
    expect(keepAlive.options).toEqual([{ sqlCallSites: false }]);
  });
});
