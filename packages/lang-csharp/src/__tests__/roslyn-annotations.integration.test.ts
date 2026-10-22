import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { SymbolNode } from '@ctxo/plugin-api';
import { RoslynAdapter } from '../roslyn/roslyn-adapter.js';

const HAS_DOTNET = (() => {
  try {
    const v = execFileSync('dotnet', ['--version'], { encoding: 'utf-8' }).trim();
    return parseInt(v.split('.')[0]!, 10) >= 8;
  } catch { return false; }
})();

const FIXTURE_DIR = resolve(import.meta.dirname, 'fixtures/csharp-v2-sample');
const TESTS_FILE = 'CsharpV2Sample/Tests/LoanPolicyTests.cs';
const TEST_CLASS = 'CsharpV2Sample.Tests.LoanPolicyTests';

describe.skipIf(!HAS_DOTNET)('Roslyn attribute annotations', () => {
  let adapter: RoslynAdapter;
  let symbols: SymbolNode[] = [];

  beforeAll(async () => {
    adapter = new RoslynAdapter();
    await adapter.initialize(FIXTURE_DIR);
    if (adapter.isReady()) {
      await adapter.batchIndex();
    }
    symbols = await adapter.extractSymbols(TESTS_FILE, '');
  }, 120_000);

  afterAll(async () => {
    await adapter.dispose();
  });

  function method(name: string): SymbolNode {
    const symbol = symbols.find(s => s.name === `${TEST_CLASS}.${name}` && s.kind === 'method');
    expect(symbol, `method ${name}`).toBeDefined();
    return symbol!;
  }

  it('MemberHoldsAtMostFiveLoans carries Fact and Trait with resolved types', () => {
    expect(method('MemberHoldsAtMostFiveLoans').annotations).toEqual([
      { name: 'Fact', named: { type: 'Xunit.FactAttribute' } },
      { name: 'Trait', args: ['Rule', 'LEND-03'], named: { type: 'Xunit.TraitAttribute' } },
    ]);
  });

  it('CharacterizesOverdueFees carries Theory then Trait from one attribute list', () => {
    expect(method('CharacterizesOverdueFees').annotations).toEqual([
      { name: 'Theory', named: { type: 'Xunit.TheoryAttribute' } },
      { name: 'Trait', args: ['Kind', 'Characterization'], named: { type: 'Xunit.TraitAttribute' } },
    ]);
  });

  it('UsesAnUnresolvedAttribute falls back to syntax and has no type', () => {
    expect(method('UsesAnUnresolvedAttribute').annotations).toEqual([
      { name: 'Unresolved', args: ['x'], named: { Level: '2' } },
    ]);
  });

  it('HasTwelveArgs flattens the params array and keeps the first 10 values', () => {
    const annotations = method('HasTwelveArgs').annotations;
    expect(annotations).toHaveLength(1);
    expect(annotations![0]!.name).toBe('Args');
    expect(annotations![0]!.args).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(annotations![0]!.named).toEqual({ type: 'CsharpV2Sample.Tests.ArgsAttribute' });
  });

  it('HasALongArg truncates the constant argument to 200 characters', () => {
    const annotations = method('HasALongArg').annotations;
    expect(annotations).toHaveLength(1);
    expect(annotations![0]!.name).toBe('Note');
    expect(annotations![0]!.args).toHaveLength(1);
    expect(annotations![0]!.args![0]).toHaveLength(200);
  });

  it('HasTwentyFiveAttributes keeps the first 20 attributes', () => {
    const annotations = method('HasTwentyFiveAttributes').annotations;
    expect(annotations).toHaveLength(20);
    expect(annotations!.map(a => a.name)).toEqual(Array.from({ length: 20 }, (_, i) => `A${i}`));
  });

  it('the test class itself carries no annotations field', () => {
    const cls = symbols.find(s => s.name === TEST_CLASS && s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls).not.toHaveProperty('annotations');
  });
});
