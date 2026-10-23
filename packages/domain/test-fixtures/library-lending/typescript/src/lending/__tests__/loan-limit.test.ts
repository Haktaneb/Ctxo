import { describe, expect, it } from 'vitest';
import { canBorrow } from '../loan-limit.js';

describe('loan limit', () => {
  it('LEND-03 rejects the sixth loan', () => {
    expect(canBorrow({ memberId: 1, activeLoans: 5 })).toBe(false);
    expect(canBorrow({ memberId: 1, activeLoans: 4 })).toBe(true);
  });
});
