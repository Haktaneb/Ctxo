import { describe, it, expect, afterEach, vi } from 'vitest';
import { JavaCompositeAdapter } from '../../composite-adapter.js';
import { CAN_RUN_JDT, JDT_FIXTURE, testAnalyzerJar } from '../../__tests__/helpers/analyzer-jar.js';

describe.skipIf(!CAN_RUN_JDT)('Java watch keep-alive (real jar)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reindexFile returns resolved edges + tree-sitter complexity for one file', async () => {
    vi.stubEnv('CTXO_JDT_ANALYZER_JAR', testAnalyzerJar()!);
    const composite = new JavaCompositeAdapter();
    await composite.initialize(JDT_FIXTURE);
    const cap = composite.getIncrementalReindex();
    expect(cap).not.toBeNull();
    expect(cap!.isReady()).toBe(true);
    expect(await cap!.startKeepAlive()).toBe(true);
    const result = await cap!.reindexFile('Foo.java');
    expect(result).not.toBeNull();
    expect(result!.edges.some((e) => e.kind === 'calls' && e.to.includes('helper'))).toBe(true);
    expect(Array.isArray(result!.complexity)).toBe(true);
    await cap!.dispose();
  }, 130_000);
});
