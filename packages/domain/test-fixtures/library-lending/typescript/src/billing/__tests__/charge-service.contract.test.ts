import { describe, expect, it } from 'vitest';
import type { ChargeService } from '../charge-service.js';
import { InvoiceLedger } from '../invoice-ledger.js';

describe('[contract] charge service', () => {
  it('accepts any payer', () => {
    const charges: ChargeService = new InvoiceLedger();
    expect(() => charges.chargeFine(1, 0)).not.toThrow();
    expect(() => charges.chargeFine(2, 14)).not.toThrow();
  });
});
