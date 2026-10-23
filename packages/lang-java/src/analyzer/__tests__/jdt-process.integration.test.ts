import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectJavaRuntime } from '../toolchain-detect.js';
import { runBatchIndex } from '../jdt-process.js';
import { CAN_RUN_JDT, JDT_FIXTURE, testAnalyzerJar } from '../../__tests__/helpers/analyzer-jar.js';

describe.skipIf(!CAN_RUN_JDT)('runBatchIndex (real jar)', () => {
  it('emits file results with resolved call edges', async () => {
    const java = detectJavaRuntime();
    const result = await runBatchIndex(java.javaBin, testAnalyzerJar()!, JDT_FIXTURE, { timeoutMs: 120_000 });
    expect(result.files.length).toBeGreaterThan(0);
    const foo = result.files.find((f) => f.file.endsWith('Foo.java'));
    expect(foo).toBeDefined();
    expect(foo!.edges.some((e) => e.kind === 'calls' && e.to.includes('helper'))).toBe(true);
    expect(foo!.edges.some((e) => e.kind === 'extends')).toBe(true);
  }, 130_000);

  it('non-ASCII annotation values arrive intact whatever the analyzer stdout encoding is', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ctxo-jdt-ascii-'));
    try {
      mkdirSync(join(root, 'a'));
      // Java unicode escapes keep the source ASCII, so the source encoding plays no part.
      writeFileSync(
        join(root, 'a', 'NameTest.java'),
        'package a;\nclass NameTest {\n  @DisplayName("caf\\u00e9 \\u00fcye \\u015f \\ud83d\\udcda")\n  void holds() {}\n}\n',
      );
      const java = detectJavaRuntime();
      const result = await runBatchIndex(java.javaBin, testAnalyzerJar()!, root, { timeoutMs: 120_000 });
      const holds = result.files.flatMap((f) => f.symbols).find((s) => s.symbolId === 'a/NameTest.java::holds::method');
      expect(holds?.annotations).toEqual([{ name: 'DisplayName', args: ['café üye ş \u{1F4DA}'] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 130_000);
});
