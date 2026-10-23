import { describe, it, expect } from 'vitest';
import { TsMorphAdapter } from '../ts-morph-adapter.js';
import { readLendingSample } from './helpers/lending-sample.js';

describe('lending sample decorators', () => {
  it('the entity and the controller carry their decorators', async () => {
    const adapter = new TsMorphAdapter();
    const files = readLendingSample();

    const entity = await adapter.extractSymbols('src/loan.entity.ts', files.get('src/loan.entity.ts')!);
    const loan = entity.find((s) => s.name === 'Loan');
    expect(loan?.annotations).toEqual([
      { name: 'Entity', args: ['loans'] },
      { name: 'PrimaryGeneratedColumn', named: { member: 'id' } },
      { name: 'Column', named: { member: 'memberId', name: 'member_id' } },
    ]);
    expect(entity.some((s) => s.name === 'Loan.memberId' || s.name === 'Loan.note')).toBe(false);

    const controller = await adapter.extractSymbols('src/loan.controller.ts', files.get('src/loan.controller.ts')!);
    expect(controller.find((s) => s.name === 'LoanController')?.annotations).toEqual([
      { name: 'Controller', args: ['loans'] },
    ]);
    expect(controller.find((s) => s.name === 'LoanController.find')?.annotations).toEqual([
      { name: 'Get', args: [':id'] },
      { name: 'HttpCode' },
    ]);
  });
});

describe('lending sample test blocks', () => {
  it('the policy test yields test-block symbols with calls into the sample', async () => {
    const files = readLendingSample();
    const testFile = 'src/__tests__/loan-policy.test.ts';
    const adapter = new TsMorphAdapter();

    const policy = await adapter.extractSymbols('src/loan-policy.ts', files.get('src/loan-policy.ts')!);
    const blocks = await adapter.extractSymbols(testFile, files.get(testFile)!);

    expect(blocks.map((s) => s.name)).toEqual([
      'LoanPolicy',
      'LoanPolicy > LEND-03 a member holds at most five loans',
      'LoanPolicy > renewal',
      'LoanPolicy > renewal > extends by seven days',
    ]);
    expect(blocks.every((s) => s.kind === 'function' && s.annotations?.[0]?.name === 'test')).toBe(true);

    adapter.loadProjectSources(files);
    const edges = await adapter.extractEdges(testFile, files.get(testFile)!);
    const policyIds = new Set(policy.map((s) => s.symbolId));
    const blockIds = new Set(blocks.map((s) => s.symbolId));
    const calls = edges.filter((e) => e.kind === 'calls' && blockIds.has(e.from));

    expect(calls).toEqual([
      {
        from: `${testFile}::LoanPolicy > LEND-03 a member holds at most five loans::function`,
        to: 'src/loan-policy.ts::canBorrow::function',
        kind: 'calls',
      },
      {
        from: `${testFile}::LoanPolicy > renewal > extends by seven days::function`,
        to: 'src/loan-policy.ts::renewalDue::function',
        kind: 'calls',
      },
    ]);
    expect(calls.every((e) => policyIds.has(e.to))).toBe(true);
    expect(edges).toContainEqual({
      from: `${testFile}::LoanPolicy > LEND-03 a member holds at most five loans::function`,
      to: 'src/loan-policy.ts::MAX_LOANS::variable',
      kind: 'uses',
    });
  });
});
