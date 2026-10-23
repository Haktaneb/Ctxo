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
