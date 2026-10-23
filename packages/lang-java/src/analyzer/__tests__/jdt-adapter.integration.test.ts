import { describe, it, expect, afterEach, vi } from 'vitest';
import { JdtAnalyzerAdapter } from '../jdt-adapter.js';
import { CAN_RUN_JDT, JDT_FIXTURE, testAnalyzerJar } from '../../__tests__/helpers/analyzer-jar.js';

describe.skipIf(!CAN_RUN_JDT)('JdtAnalyzerAdapter (real jar)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('initializes ready and serves symbols + resolved edges per file', async () => {
    vi.stubEnv('CTXO_JDT_ANALYZER_JAR', testAnalyzerJar()!);
    const a = new JdtAnalyzerAdapter();
    await a.initialize(JDT_FIXTURE);
    expect(a.isReady()).toBe(true);
    const symbols = await a.extractSymbols('Foo.java', '');
    expect(symbols.find((s) => s.name === 'Foo')?.kind).toBe('class');
    const edges = await a.extractEdges('Foo.java', '');
    expect(edges.some((e) => e.kind === 'calls' && e.to.includes('helper'))).toBe(true);
    expect(await a.extractComplexity('Foo.java', '')).toEqual([]);
    await a.dispose();
  }, 130_000);
});
