import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileIndex } from '@ctxo/cli/internal';
import { readTestFiles } from '../test-file-source.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxo-domain-tests-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(file: string, text: string): void {
  const full = join(root, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

describe('readTestFiles', () => {
  it('lists tracked test files by path and by annotation, in codepoint order', () => {
    put('tests/b.test.ts', 'b');
    put('tests/Z.test.ts', 'Z');
    put('src/Loans/LoanRules.cs', 'annotated');
    put('src/plain.ts', 'plain');
    const annotated: FileIndex = {
      file: 'src/Loans/LoanRules.cs',
      lastModified: 1,
      symbols: [],
      edges: [],
      intent: [],
      antiPatterns: [],
    };
    const isTest = (p: string): boolean => p.endsWith('.test.ts') || p === 'src/Loans/LoanRules.cs';
    const result = readTestFiles(
      root,
      ['tests/b.test.ts', 'src/plain.ts', 'tests\\Z.test.ts', 'src/Loans/LoanRules.cs', 'tests/b.test.ts', 'tests/missing.test.ts'],
      isTest,
      [annotated],
    );
    expect(result.map((r) => r.file)).toEqual(['src/Loans/LoanRules.cs', 'tests/Z.test.ts', 'tests/b.test.ts']);
    expect(result[0]?.text).toBe('annotated');
    expect(result[0]?.index).toBe(annotated);
    expect(result[1]?.index).toBeUndefined();
  });
});
