import type { Account } from './account.js';

// rule: LEND-04
export function blocksBorrowing(account: Account): boolean {
  return (account.unpaidFineCents ?? 0) > 0;
}
