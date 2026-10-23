import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStorageAdapter } from '../../storage/sqlite-storage-adapter.js';
import { MaskingPipeline } from '../../../core/masking/masking-pipeline.js';
import { handleGetLogicSlice } from '../get-logic-slice.js';
import type { FileIndex } from '../../../core/types.js';
import type { ResponseEnricher } from '../../../ports/i-ctxo-module.js';

function buildTestFileIndex(): FileIndex {
  return {
    file: 'src/foo.ts',
    lastModified: 1711620000,
    symbols: [
      {
        symbolId: 'src/foo.ts::processPayment::function',
        name: 'processPayment',
        kind: 'function',
        startLine: 0,
        endLine: 10,
      },
    ],
    edges: [
      {
        from: 'src/foo.ts::processPayment::function',
        to: 'src/bar.ts::TokenValidator::class',
        kind: 'imports',
      },
    ],
    intent: [],
    antiPatterns: [],
  };
}

function buildDepFileIndex(): FileIndex {
  return {
    file: 'src/bar.ts',
    lastModified: 1711620000,
    symbols: [
      {
        symbolId: 'src/bar.ts::TokenValidator::class',
        name: 'TokenValidator',
        kind: 'class',
        startLine: 0,
        endLine: 50,
      },
    ],
    edges: [],
    intent: [],
    antiPatterns: [],
  };
}

describe('GetLogicSliceHandler', () => {
  let tempDir: string;
  let storage: SqliteStorageAdapter;
  let handler: ReturnType<typeof handleGetLogicSlice>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ctxo-mcp-'));
    storage = new SqliteStorageAdapter(tempDir);
    await storage.init();
    storage.bulkWrite([buildTestFileIndex(), buildDepFileIndex()]);

    const masking = new MaskingPipeline();
    handler = handleGetLogicSlice(storage, masking, undefined, tempDir);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns MCP response with content array for valid symbolId', () => {
    const result = handler({ symbolId: 'src/foo.ts::processPayment::function' });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.root.symbolId).toBe('src/foo.ts::processPayment::function');
    expect(payload.dependencies).toHaveLength(1);
  });

  it('returns { found: false, hint } for missing symbol', () => {
    const result = handler({ symbolId: 'src/missing.ts::nothing::function' });

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.found).toBe(false);
    expect(payload.hint).toContain('ctxo index');
  });

  it('returns { error: true, message } for invalid params (Zod rejection)', () => {
    const result = handler({ symbolId: '' });

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toBe(true);
    expect(payload.message).toBeDefined();
  });

  it('get_logic_slice walks dependencies from a 2-part procedure id', () => {
    const PROC = 'db/procs.sql::dbo.usp_close::procedure';
    storage.bulkWrite([
      { file: 'db/loans.sql', lastModified: 1, symbols: [{ symbolId: 'db/loans.sql::dbo.loans::table', name: 'dbo.loans', kind: 'table', startLine: 0, endLine: 9 }], edges: [], intent: [], antiPatterns: [] },
      {
        file: 'db/procs.sql',
        lastModified: 1,
        symbols: [{ symbolId: PROC, name: 'dbo.usp_close', kind: 'procedure', startLine: 0, endLine: 9 }],
        edges: [{ from: PROC, to: 'dbo.loans::table', kind: 'writes' }],
        intent: [],
        antiPatterns: [],
      },
    ]);

    const payload = JSON.parse(handler({ symbolId: 'dbo.usp_close::procedure', level: 3 }).content[0]!.text);
    expect(payload.root.symbolId).toBe(PROC);
    expect(payload.dependencies.map((d: { symbolId: string }) => d.symbolId)).toEqual(['db/loans.sql::dbo.loans::table']);
    expect(payload.edges).toEqual([{ from: PROC, to: 'db/loans.sql::dbo.loans::table', kind: 'writes' }]);
  });

  it('returns correct shape for detail level 1', () => {
    const result = handler({ symbolId: 'src/foo.ts::processPayment::function', level: 1 });

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.level).toBe(1);
    expect(payload.dependencies).toEqual([]);
  });

  it('returns correct shape for detail level 3', () => {
    const result = handler({ symbolId: 'src/foo.ts::processPayment::function', level: 3 });

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.level).toBe(3);
    expect(payload.dependencies).toHaveLength(1);
  });

  it('applies masking — planted AWS key in fixture is redacted', () => {
    // Add a symbol with AWS key in its name (simulates sensitive data in response)
    const sensitiveIndex: FileIndex = {
      file: 'src/config.ts',
      lastModified: 1711620000,
      symbols: [
        {
          symbolId: 'src/config.ts::AKIAIOSFODNN7EXAMPLE::variable',
          name: 'AKIAIOSFODNN7EXAMPLE',
          kind: 'variable',
          startLine: 0,
          endLine: 1,
        },
      ],
      edges: [],
      intent: [],
      antiPatterns: [],
    };
    storage.writeSymbolFile(sensitiveIndex);

    const result = handler({ symbolId: 'src/config.ts::AKIAIOSFODNN7EXAMPLE::variable' });
    expect(result.content[0]!.text).toContain('[REDACTED:AWS_KEY]');
    expect(result.content[0]!.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('never throws — returns error shape on internal failure', () => {
    // Pass completely invalid args
    const result = handler({ symbolId: 123 as unknown as string });

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toBe(true);
  });

  it('rejects detail level outside 1-4 range', () => {
    const result = handler({ symbolId: 'src/foo.ts::processPayment::function', level: 5 });

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toBe(true);
  });

  it('supports batch query with symbolIds array', () => {
    const result = handler({
      symbolIds: ['src/foo.ts::processPayment::function', 'src/bar.ts::TokenValidator::class'],
    });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    expect(payload.batch).toBe(true);
    expect(payload.results.length).toBe(2);
  });

  it('includes levelDescription in response', () => {
    const result = handler({ symbolId: 'src/foo.ts::processPayment::function', level: 1 });
    const payload = JSON.parse(result.content[result.content.length - 1]!.text);

    expect(payload.levelDescription).toContain('L1');
  });

  it('works with staleness check', () => {
    const mockStaleness = { check: () => ({ message: 'Index stale' }) };
    const stalenessHandler = handleGetLogicSlice(storage, new MaskingPipeline(), mockStaleness as never, tempDir);
    const result = stalenessHandler({ symbolId: 'src/foo.ts::processPayment::function' });

    expect(result.content.length).toBeGreaterThanOrEqual(2);
    expect(result.content[0]!.text).toContain('stale');
  });

  it('applies the enricher before the envelope and masking', () => {
    const seen: Array<{ hadMeta: boolean; args: Readonly<Record<string, unknown>> }> = [];
    const markRoot = (slice: Record<string, unknown>) =>
      slice['root'] ? { ...slice, root: { ...(slice['root'] as Record<string, unknown>), enrichedBy: 'stub' } } : slice;
    // Enriches the root of a single slice, or the root of every slice in a batch.
    const enrich: ResponseEnricher = (payload, args) => {
      seen.push({ hadMeta: '_meta' in payload, args });
      const body = Array.isArray(payload['results'])
        ? { ...payload, results: (payload['results'] as Array<Record<string, unknown>>).map(markRoot) }
        : markRoot(payload);
      return { ...body, enrichedBy: 'stub', enrichedSecret: 'AKIAIOSFODNN7EXAMPLE' };
    };
    const enriched = handleGetLogicSlice(storage, new MaskingPipeline(), undefined, tempDir, enrich);

    const single = enriched({ symbolId: 'src/foo.ts::processPayment::function' });
    expect(single.content[0]!.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    const singlePayload = JSON.parse(single.content[0]!.text);
    expect(singlePayload.root).toMatchObject({ symbolId: 'src/foo.ts::processPayment::function', enrichedBy: 'stub' });
    expect(singlePayload.enrichedBy).toBe('stub');
    expect(singlePayload.enrichedSecret).toBe('[REDACTED:AWS_KEY]');
    expect(singlePayload._meta).toBeDefined();

    const batch = enriched({ symbolIds: ['src/foo.ts::processPayment::function', 'src/bar.ts::TokenValidator::class'] });
    const batchPayload = JSON.parse(batch.content[0]!.text);
    expect(batchPayload.batch).toBe(true);
    expect(batchPayload.enrichedBy).toBe('stub');
    expect(batchPayload.results.map((r: { root: { enrichedBy?: string } }) => r.root.enrichedBy)).toEqual(['stub', 'stub']);
    expect(batchPayload._meta.totalItems).toBe(2);

    expect(seen.map((s) => s.hadMeta)).toEqual([false, false]);
    expect(seen[0]!.args).toMatchObject({ symbolId: 'src/foo.ts::processPayment::function', level: 3 });

    // Without an enricher the slice carries no added field.
    const plain = JSON.parse(handler({ symbolId: 'src/foo.ts::processPayment::function' }).content[0]!.text);
    expect(plain.enrichedBy).toBeUndefined();
    expect(plain.root.enrichedBy).toBeUndefined();
  });
});
