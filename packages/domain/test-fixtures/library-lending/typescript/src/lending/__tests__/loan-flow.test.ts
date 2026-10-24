import { expect, it } from 'vitest';
import type { ChargeService } from '../../billing/charge-service.js';
import { LoansController } from '../api/loans.controller.js';
import { LoanService } from '../loan-service.js';

const noCharges: ChargeService = { chargeFine: () => undefined };

it('[characterization] borrow and read', () => {
  const controller = new LoansController(new LoanService(noCharges));
  expect(controller.borrow(1, 1001)).toBe(true);
  expect(controller.find('1')).toBe('loan 1');
});
