import { describe, expect, it } from 'vitest';
import type { ChargeService } from '../charge-service.js';
import { InvoiceLedger } from '../invoice-ledger.js';

describe('[characterization] charges', () => {
  it('charges a fine', () => {
    const ledger = new InvoiceLedger();
    const charges: ChargeService = ledger;
    charges.chargeFine(7, 3);
    expect(ledger.balanceOf(7)).toBe(6);
  });
});
