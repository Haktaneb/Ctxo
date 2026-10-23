import type { Account } from './account.js';

export const MAX_LOANS = 5;

export function canBorrow(account: Account): boolean {
  return account.activeLoans < MAX_LOANS;
}
