import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStorageAdapter } from '../../storage/sqlite-storage-adapter.js';
import { MaskingPipeline } from '../../../core/masking/masking-pipeline.js';
import { JsonIndexWriter } from '../../storage/json-index-writer.js';
import { CoChangeReader } from '../../storage/co-change-reader.js';
import { MAX_RESERVED_SHARE, handleGetContextForTask, reservedTokens } from '../get-context-for-task.js';
import type { FileIndex } from '../../../core/types.js';
import type { ResponseEnricher } from '../../../ports/i-ctxo-module.js';

function buildTestIndices(): FileIndex[] {
  return [
    {
      file: 'src/main.ts',
      lastModified: 1,
      symbols: [{ symbolId: 'src/main.ts::main::function', name: 'main', kind: 'function', startLine: 0, endLine: 20 }],
      edges: [
        { from: 'src/main.ts::main::function', to: 'src/service.ts::Service::class', kind: 'imports' },
        { from: 'src/main.ts::main::function', to: 'src/types.ts::Config::interface', kind: 'imports' },
      ],
      intent: [],
      antiPatterns: [{ hash: 'abc', message: 'Revert "add caching"', date: '2024-01-01' }],
    },
    {
      file: 'src/service.ts',
      lastModified: 1,
      symbols: [{ symbolId: 'src/service.ts::Service::class', name: 'Service', kind: 'class', startLine: 0, endLine: 50 }],
      edges: [{ from: 'src/service.ts::Service::class', to: 'src/types.ts::Config::interface', kind: 'implements' }],
      complexity: [{ symbolId: 'src/service.ts::Service::class', cyclomatic: 8 }],
      intent: [],
      antiPatterns: [],
    },
    {
      file: 'src/types.ts',
      lastModified: 1,
      symbols: [{ symbolId: 'src/types.ts::Config::interface', name: 'Config', kind: 'interface', startLine: 0, endLine: 10 }],
      edges: [],
      intent: [],
      antiPatterns: [],
    },
    {
      file: 'src/consumer.ts',
      lastModified: 1,
      symbols: [{ symbolId: 'src/consumer.ts::Consumer::class', name: 'Consumer', kind: 'class', startLine: 0, endLine: 30 }],
      edges: [{ from: 'src/consumer.ts::Consumer::class', to: 'src/main.ts::main::function', kind: 'calls' }],
      intent: [],
      antiPatterns: [],
    },
  ];
}

describe('GetContextForTaskHandler', () => {
  let tempDir: string;
  let storage: SqliteStorageAdapter;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ctxo-ctx-'));
    storage = new SqliteStorageAdapter(tempDir);
    await storage.initEmpty();

    const writer = new JsonIndexWriter(tempDir);
    for (const idx of buildTestIndices()) {
      writer.write(idx);
      storage.writeSymbolFile(idx);
    }
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns context entries with relevanceScore for understand task', () => {
    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);
    const result = handler({ symbolId: 'src/main.ts::main::function', taskType: 'understand' });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    expect(payload.target.symbolId).toBe('src/main.ts::main::function');
    expect(payload.taskType).toBe('understand');
    expect(payload.context.length).toBeGreaterThan(0);
    expect(payload.totalTokens).toBeLessThanOrEqual(payload.tokenBudget);

    for (const entry of payload.context) {
      expect(entry).toHaveProperty('symbolId');
      expect(entry).toHaveProperty('relevanceScore');
      expect(entry).toHaveProperty('reason');
      expect(entry).toHaveProperty('tokens');
    }
  });

  it('returns different rankings for fix vs extend task', () => {
    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);

    const fixResult = handler({ symbolId: 'src/main.ts::main::function', taskType: 'fix' });
    const extendResult = handler({ symbolId: 'src/main.ts::main::function', taskType: 'extend' });

    const fixPayload = JSON.parse(fixResult.content[fixResult.content.length - 1]!.text);
    const extendPayload = JSON.parse(extendResult.content[extendResult.content.length - 1]!.text);

    // Config (interface) should score higher in extend than fix
    const fixConfig = fixPayload.context.find((c: { name: string }) => c.name === 'Config');
    const extendConfig = extendPayload.context.find((c: { name: string }) => c.name === 'Config');

    if (fixConfig && extendConfig) {
      expect(extendConfig.relevanceScore).toBeGreaterThanOrEqual(fixConfig.relevanceScore);
    }
  });

  it('includes blast radius dependents for refactor task', () => {
    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);
    const result = handler({ symbolId: 'src/main.ts::main::function', taskType: 'refactor' });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    // Consumer calls main → should be in context for refactor
    const consumer = payload.context.find((c: { name: string }) => c.name === 'Consumer');
    expect(consumer).toBeDefined();
    expect(consumer.reason).toContain('blast radius');
  });

  it('respects tokenBudget parameter', () => {
    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);
    const result = handler({ symbolId: 'src/main.ts::main::function', taskType: 'understand', tokenBudget: 100 });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    expect(payload.totalTokens).toBeLessThanOrEqual(100);
  });

  it('includes warnings for anti-patterns in target file', () => {
    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);
    const result = handler({ symbolId: 'src/main.ts::main::function', taskType: 'fix' });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    expect(payload.warnings.length).toBeGreaterThan(0);
    expect(payload.warnings[0]).toContain('anti-pattern');
  });

  it('returns { found: false } for non-existent symbol', () => {
    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);
    const result = handler({ symbolId: 'src/missing.ts::X::function', taskType: 'understand' });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    expect(payload.found).toBe(false);
  });

  it('returns { error: true } for invalid taskType', () => {
    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);
    const result = handler({ symbolId: 'src/main.ts::main::function', taskType: 'invalid' });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    expect(payload.error).toBe(true);
  });

  it('applies masking to response', () => {
    const writer = new JsonIndexWriter(tempDir);
    writer.write({
      file: 'src/secret.ts',
      lastModified: 1,
      symbols: [{ symbolId: 'src/secret.ts::AKIAIOSFODNN7EXAMPLE::variable', name: 'AKIAIOSFODNN7EXAMPLE', kind: 'variable', startLine: 0, endLine: 1 }],
      edges: [{ from: 'src/main.ts::main::function', to: 'src/secret.ts::AKIAIOSFODNN7EXAMPLE::variable', kind: 'imports' }],
      intent: [],
      antiPatterns: [],
    });

    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);
    const result = handler({ symbolId: 'src/main.ts::main::function', taskType: 'understand' });

    expect(result.content[result.content.length - 1]!.text).toContain('[REDACTED:AWS_KEY]');
  });

  it('works with staleness check', () => {
    const mockStaleness = { check: () => ({ message: 'Index stale for 3 file(s)' }) };
    const handler = handleGetContextForTask(storage, new MaskingPipeline(), mockStaleness as never, tempDir);
    const result = handler({ symbolId: 'src/main.ts::main::function', taskType: 'understand' });

    expect(result.content.length).toBeGreaterThanOrEqual(2);
    expect(result.content[0]!.text).toContain('stale');
  });

  it('returns error for missing symbolId', () => {
    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);
    const result = handler({ taskType: 'understand' });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    expect(payload.error).toBe(true);
  });

  it('populates context when reverse edges come from files without exported symbols', () => {
    // Regression for a bug where a symbol imported only by test/config files
    // (which have no exported symbols themselves) produced context=[] because
    // the edge source nodes were missing from symbols[]. BlastRadius now
    // keeps orphan edge sources and ContextAssembler synthesizes a placeholder
    // node from the symbolId so they still land in the scored candidate pool.
    const writer = new JsonIndexWriter(tempDir);

    writer.write({
      file: 'src/target.ts',
      lastModified: 1,
      symbols: [{ symbolId: 'src/target.ts::WellConnected::class', name: 'WellConnected', kind: 'class', startLine: 0, endLine: 50 }],
      edges: [],
      intent: [],
      antiPatterns: [],
    });

    // Three spec files that only import WellConnected — each ships an edge
    // whose `from` is a synthetic file-module symbolId that never lands in any
    // symbols[] array. Exactly the ts-morph shape that caused the original bug.
    for (const n of [1, 2, 3]) {
      writer.write({
        file: `tests/spec${n}.ts`,
        lastModified: 1,
        symbols: [],
        edges: [
          {
            from: `tests/spec${n}.ts::spec${n}::variable`,
            to: 'src/target.ts::WellConnected::class',
            kind: 'imports',
          },
        ],
        intent: [],
        antiPatterns: [],
      });
    }

    const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);
    const result = handler({ symbolId: 'src/target.ts::WellConnected::class', taskType: 'understand' });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    expect(payload.target.name).toBe('WellConnected');
    expect(payload.context.length).toBeGreaterThan(0);
    expect(payload.totalTokens).toBeGreaterThan(0);
    const specEntries = payload.context.filter((c: { file: string }) => c.file.startsWith('tests/spec'));
    expect(specEntries.length).toBeGreaterThanOrEqual(1);
  });

  describe('co-change', () => {
    type ContextItem = { name: string; confidence?: string };

    /** Importer only imports main (a potential dependent); Consumer, from the shared fixture, calls it. */
    function addImporterThatCoChangesWithMain(): void {
      const writer = new JsonIndexWriter(tempDir);
      writer.write({
        file: 'src/importer.ts',
        lastModified: 1,
        symbols: [{ symbolId: 'src/importer.ts::Importer::class', name: 'Importer', kind: 'class', startLine: 0, endLine: 10 }],
        edges: [{ from: 'src/importer.ts::Importer::class', to: 'src/main.ts::main::function', kind: 'imports' }],
        intent: [],
        antiPatterns: [],
      });
      writer.writeCoChanges({
        version: 1,
        timestamp: 1,
        entries: [{ file1: 'src/importer.ts', file2: 'src/main.ts', sharedCommits: 4, frequency: 0.8 }],
      });
    }

    function contextOf(handler: ReturnType<typeof handleGetContextForTask>): ContextItem[] {
      const result = handler({ symbolId: 'src/main.ts::main::function', taskType: 'refactor' });
      return JSON.parse(result.content[result.content.length - 1]!.text).context as ContextItem[];
    }

    it('shows a co-changing potential dependent with likely confidence', () => {
      addImporterThatCoChangesWithMain();
      const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir, new CoChangeReader(tempDir));

      const context = contextOf(handler);

      expect(context.find((c) => c.name === 'Importer')?.confidence).toBe('likely');
      expect(context.find((c) => c.name === 'Consumer')?.confidence).toBe('confirmed');
      // Dependencies of the target are not dependents: they carry no tier.
      expect(context.find((c) => c.name === 'Service')).not.toHaveProperty('confidence');
    });

    it('keeps that dependent potential when no co-change port is wired', () => {
      addImporterThatCoChangesWithMain();
      const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);

      expect(contextOf(handler).find((c) => c.name === 'Importer')?.confidence).toBe('potential');
    });

    it('the new parameters follow the co-change parameter', () => {
      addImporterThatCoChangesWithMain();
      const enrich: ResponseEnricher = (payload) => ({ ...payload, enrichedBy: 'stub' });
      const handler = handleGetContextForTask(
        storage,
        new MaskingPipeline(),
        undefined,
        tempDir,
        new CoChangeReader(tempDir),
        enrich,
        () => 250,
      );

      const result = handler({ symbolId: 'src/main.ts::main::function', taskType: 'refactor', tokenBudget: 1000 });
      const payload = JSON.parse(result.content[result.content.length - 1]!.text);

      expect((payload.context as ContextItem[]).find((c) => c.name === 'Importer')?.confidence).toBe('likely');
      expect(payload.enrichedBy).toBe('stub');
      expect(payload.tokenBudget).toBe(1000);
      expect(payload.totalTokens).toBeLessThanOrEqual(750);
    });
  });

  describe('token reservation and enricher', () => {
    const MAIN = 'src/main.ts::main::function';
    let errorSpy: MockInstance<typeof console.error>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function warnings(): string[] {
      return errorSpy.mock.calls.map((args) => args.map(String).join(' ')).filter((line) => line.includes('WARN'));
    }

    function payloadOf(handler: ReturnType<typeof handleGetContextForTask>, args: Record<string, unknown>): Record<string, unknown> {
      const result = handler(args);
      return JSON.parse(result.content[result.content.length - 1]!.text) as Record<string, unknown>;
    }

    it('packs the code context into the budget left after the reservation and reports the requested budget', () => {
      const args = { symbolId: MAIN, taskType: 'understand', tokenBudget: 1000 };
      const seen: Array<Readonly<Record<string, unknown>>> = [];
      // 400 is above the cap: a quarter of 1000 is reserved, so the code context gets 750.
      const reserved = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir, undefined, undefined, (a) => {
        seen.push(a);
        return 400;
      });
      const plain = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);

      const withReservation = payloadOf(reserved, args);
      const without = payloadOf(plain, args);

      // Without the reservation the fixture fills more than 750 of the 1000 tokens, so the cut is visible.
      expect(without['totalTokens'] as number).toBeGreaterThan(750);
      expect(withReservation['totalTokens'] as number).toBeLessThanOrEqual(750);
      expect(withReservation['tokenBudget']).toBe(1000);
      expect(without['tokenBudget']).toBe(1000);
      expect(seen).toEqual([{ symbolId: MAIN, taskType: 'understand', tokenBudget: 1000 }]);

      // Within the cap the whole reservation comes off: 2000 - 400 leaves 1600, and the context fits whole.
      const wide = payloadOf(reserved, { ...args, tokenBudget: 2000 });
      expect(wide['tokenBudget']).toBe(2000);
      expect(wide['totalTokens']).toBe(without['totalTokens']);
    });

    it('reservedTokens caps the reservation at a quarter of the budget', () => {
      const args = { symbolId: MAIN };
      expect(MAX_RESERVED_SHARE).toBe(0.25);
      expect(reservedTokens(() => 5000, args, 1000)).toBe(250);
      expect(reservedTokens(() => Number.NaN, args, 1000)).toBe(0);
      expect(reservedTokens(() => Number.POSITIVE_INFINITY, args, 1000)).toBe(0);
      expect(reservedTokens(undefined, args, 1000)).toBe(0);
      expect(reservedTokens(() => -50, args, 1000)).toBe(0);
      expect(reservedTokens(() => 120.6, args, 1000)).toBe(121);
      expect(reservedTokens(() => 300, args, 1001)).toBe(250);
      expect(reservedTokens((() => '200') as never, args, 1000)).toBe(0);
      // NaN, infinity and a string each warn once; undefined, a negative and an in-range value do not.
      expect(warnings()).toHaveLength(3);
    });

    it('a throwing reservation reserves nothing', () => {
      const args = { symbolId: MAIN, taskType: 'understand', tokenBudget: 1000 };
      const throwing = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir, undefined, undefined, () => {
        throw new Error('reservation exploded');
      });
      const plain = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir);

      expect(payloadOf(throwing, args)).toEqual(payloadOf(plain, args));
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('reservation exploded');
    });

    it('applies the enricher before the envelope and masking', () => {
      const seen: Array<{ hadMeta: boolean; args: Readonly<Record<string, unknown>> }> = [];
      const enrich: ResponseEnricher = (payload, args) => {
        seen.push({ hadMeta: '_meta' in payload, args });
        return { ...payload, enrichedBy: 'stub', enrichedSecret: 'AKIAIOSFODNN7EXAMPLE' };
      };
      const handler = handleGetContextForTask(storage, new MaskingPipeline(), undefined, tempDir, undefined, enrich);

      const result = handler({ symbolId: MAIN, taskType: 'fix' });

      expect(result.content[result.content.length - 1]!.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
      const payload = JSON.parse(result.content[result.content.length - 1]!.text);
      expect(payload.enrichedBy).toBe('stub');
      expect(payload.enrichedSecret).toBe('[REDACTED:AWS_KEY]');
      expect(payload._meta).toBeDefined();
      expect(payload.tokenBudget).toBe(4000);
      expect(seen).toEqual([{ hadMeta: false, args: { symbolId: MAIN, taskType: 'fix', tokenBudget: 4000 } }]);
    });
  });
});
