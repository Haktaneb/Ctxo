import { LoanService } from './lending/loan-service.js';
import { InvoiceLedger } from './billing/invoice-ledger.js';

const ledger = new InvoiceLedger();
const service = new LoanService(ledger);
service.borrow({ memberId: 7, activeLoans: 0 }, 1001);
