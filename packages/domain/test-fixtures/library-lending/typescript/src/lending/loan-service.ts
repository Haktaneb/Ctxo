import type { ChargeService } from '../billing/charge-service.js';
import type { Account } from './account.js';
import { blocksBorrowing } from './fine-check.js';
import { canBorrow } from './loan-limit.js';

export class LoanService {
  constructor(private readonly charges: ChargeService) {}

  borrow(account: Account, bookId: number): boolean {
    if (!canBorrow(account)) return false;
    if (blocksBorrowing(account)) return false;
    account.activeLoans += 1;
    return bookId > 0;
  }

  returnLate(account: Account, overdueDays: number): void {
    account.activeLoans -= 1;
    this.charges.chargeFine(account.memberId, overdueDays);
  }
}
