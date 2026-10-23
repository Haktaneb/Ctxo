import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CAN_RUN_JDT, LENDING_FIXTURE, testAnalyzerJar } from './helpers/analyzer-jar.js';
import { JavaCompositeAdapter } from '../composite-adapter.js';

const TEST_FILE = 'src/test/java/lending/LoanPolicyTest.java';
const LOAN_FILE = 'src/main/java/lending/domain/Loan.java';

describe.skipIf(!CAN_RUN_JDT)('lending sample (JDT full tier, real jar)', () => {
  const composite = new JavaCompositeAdapter();

  beforeAll(async () => {
    vi.stubEnv('CTXO_JDT_ANALYZER_JAR', testAnalyzerJar()!);
    await composite.initialize(LENDING_FIXTURE);
  }, 130_000);

  afterAll(async () => {
    await composite.dispose();
    vi.unstubAllEnvs();
  });

  it('test methods under src/test/java are method symbols with their JUnit annotations', async () => {
    expect(composite.getTier()).toBe('full');
    const symbols = await composite.extractSymbols(TEST_FILE, '');
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
  }, 130_000);

  it('the entity class and its field carry their annotations', async () => {
    const symbols = await composite.extractSymbols(LOAN_FILE, '');
    const byId = new Map(symbols.map((s) => [s.symbolId, s]));
    expect(byId.get(`${LOAN_FILE}::Loan::class`)?.annotations).toEqual([
      { name: 'Entity' },
      { name: 'Table', named: { name: 'Loans' } },
    ]);
    expect(byId.get(`${LOAN_FILE}::memberId::variable`)?.annotations).toEqual([
      { name: 'Column', named: { name: 'member_id', nullable: 'false' } },
    ]);
    expect(byId.get(`${LOAN_FILE}::renew::method`)?.annotations).toEqual([
      {
        name: 'Retry',
        args: ['renewal'],
        named: { times: '3', unit: 'TimeUnit.SECONDS', on: 'java.lang.IllegalStateException' },
      },
    ]);
    expect(byId.get(`${LOAN_FILE}::audited::method`)?.annotations).toEqual([
      { name: 'Unknown', args: ['x'], named: { level: '2' } },
    ]);
    expect(byId.get(`${LOAN_FILE}::memberId::method`)).not.toHaveProperty('annotations');
  }, 130_000);
});
