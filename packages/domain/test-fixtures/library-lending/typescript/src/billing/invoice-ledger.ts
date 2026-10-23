import type { ChargeService } from './charge-service.js';
import type { Account } from './account.js';

const CENTS_PER_DAY = 2;

export class InvoiceLedger implements ChargeService {
  private readonly accounts = new Map<number, Account>();

  chargeFine(payerId: number, overdueDays: number): void {
    const account = this.accounts.get(payerId) ?? { payerId, balance: 0 };
    account.balance += overdueDays * CENTS_PER_DAY;
    this.accounts.set(payerId, account);
  }

  balanceOf(payerId: number): number {
    return this.accounts.get(payerId)?.balance ?? 0;
  }
}
