import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JdtFileResult, JdtSymbol } from '../jdt-process.js';

const ANNOTATED: JdtSymbol = {
  symbolId: 'src/test/java/lending/LoanPolicyTest.java::memberHoldsAtMostFiveLoans::method',
  name: 'memberHoldsAtMostFiveLoans',
  kind: 'method',
  startLine: 9,
  endLine: 17,
  startOffset: 210,
  endOffset: 480,
  annotations: [
    { name: 'Test' },
    { name: 'Tag', args: ['LEND-03'] },
    { name: 'Column', named: { name: 'member_id', nullable: 'false' } },
  ],
};

// The composite activates whatever JdtAnalyzerAdapter this module exports.
vi.mock('../jdt-adapter.js', () => ({
  JdtAnalyzerAdapter: class {
    async initialize(): Promise<void> {}
    isReady(): boolean { return true; }
    async startKeepAlive(): Promise<boolean> { return true; }
    async reindexFileRaw(relativePath: string): Promise<JdtFileResult> {
      return { type: 'file', file: relativePath, symbols: [ANNOTATED], edges: [], complexity: [] };
    }
    async extractSymbols(): Promise<never[]> { return []; }
    async extractEdges(): Promise<never[]> { return []; }
    async dispose(): Promise<void> {}
  },
}));

import { toSymbolNode } from '../jdt-mapping.js';
import { JavaCompositeAdapter } from '../../composite-adapter.js';

describe('toSymbolNode', () => {
  it('toSymbolNode copies annotations and offsets and omits absent ones', () => {
    expect(toSymbolNode(ANNOTATED)).toEqual({
      symbolId: ANNOTATED.symbolId,
      name: 'memberHoldsAtMostFiveLoans',
      kind: 'method',
      startLine: 9,
      endLine: 17,
      startOffset: 210,
      endOffset: 480,
      annotations: [
        { name: 'Test' },
        { name: 'Tag', args: ['LEND-03'] },
        { name: 'Column', named: { name: 'member_id', nullable: 'false' } },
      ],
    });

    const bare = toSymbolNode({ symbolId: 'A.java::A::class', name: 'A', kind: 'class', startLine: 0, endLine: 3 });
    expect(bare).toEqual({ symbolId: 'A.java::A::class', name: 'A', kind: 'class', startLine: 0, endLine: 3 });
    expect(Object.keys(bare)).not.toContain('annotations');
    expect(Object.keys(bare)).not.toContain('startOffset');

    // Empty lists from an older or looser analyzer never reach the index.
    const empty = toSymbolNode({
      symbolId: 'A.java::m::method', name: 'm', kind: 'method', startLine: 1, endLine: 1,
      annotations: [],
    });
    expect(Object.keys(empty)).not.toContain('annotations');
    const loose = toSymbolNode({
      symbolId: 'A.java::m::method', name: 'm', kind: 'method', startLine: 1, endLine: 1,
      annotations: [{ name: 'Test', args: [], named: {} }],
    });
    expect(loose.annotations).toEqual([{ name: 'Test' }]);
    expect(Object.keys(loose.annotations![0]!)).toEqual(['name']);
  });

  it('the keep-alive reindexFile keeps annotations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ctxo-jdt-mapping-'));
    try {
      const composite = new JavaCompositeAdapter();
      await composite.initialize(root);
      expect(composite.getTier()).toBe('full');
      const cap = composite.getIncrementalReindex();
      expect(cap).not.toBeNull();
      const result = await cap!.reindexFile('src/test/java/lending/LoanPolicyTest.java');
      expect(result).not.toBeNull();
      expect(result!.symbols).toHaveLength(1);
      expect(result!.symbols[0]).toEqual(toSymbolNode(ANNOTATED));
      expect(result!.symbols[0]!.annotations).toEqual([
        { name: 'Test' },
        { name: 'Tag', args: ['LEND-03'] },
        { name: 'Column', named: { name: 'member_id', nullable: 'false' } },
      ]);
      await composite.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
