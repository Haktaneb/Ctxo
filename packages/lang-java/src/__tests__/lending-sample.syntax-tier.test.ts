import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LENDING_FIXTURE } from './helpers/analyzer-jar.js';
import { JavaAdapter } from '../java-adapter.js';

const TEST_FILE = 'src/test/java/lending/LoanPolicyTest.java';
const LOAN_FILE = 'src/main/java/lending/domain/Loan.java';

const read = (file: string): string => readFileSync(resolve(LENDING_FIXTURE, file), 'utf-8');

describe('lending sample (tree-sitter syntax tier)', () => {
  it('test methods under src/test/java are method symbols with their JUnit annotations in the syntax tier', async () => {
    const symbols = await new JavaAdapter().extractSymbols(TEST_FILE, read(TEST_FILE));
    const test = symbols.find((s) => s.symbolId === `${TEST_FILE}::memberHoldsAtMostFiveLoans::method`);
    expect(test).toBeDefined();
    expect(test!.kind).toBe('method');
    expect(test!.annotations).toEqual([
      { name: 'Test' },
      { name: 'Tag', args: ['LEND-03'] },
      { name: 'DisplayName', args: ['a member holds at most five loans'] },
    ]);
    const cls = symbols.find((s) => s.symbolId === `${TEST_FILE}::LoanPolicyTest::class`);
    expect(cls).toBeDefined();
    expect(cls).not.toHaveProperty('annotations');
  });

  it('the entity class and its field carry their string annotations; non-string values are skipped', async () => {
    const symbols = await new JavaAdapter().extractSymbols(LOAN_FILE, read(LOAN_FILE));
    const byId = new Map(symbols.map((s) => [s.symbolId, s]));
    expect(byId.get(`${LOAN_FILE}::Loan::class`)?.annotations).toEqual([
      { name: 'Entity' },
      { name: 'Table', named: { name: 'Loans' } },
    ]);
    expect(byId.get(`${LOAN_FILE}::memberId::variable`)?.annotations).toEqual([
      { name: 'Column', named: { name: 'member_id' } },
    ]);
  });
});
