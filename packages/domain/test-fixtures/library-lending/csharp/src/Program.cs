using LibraryLending.Billing;
using LibraryLending.Lending;

var ledger = new InvoiceLedger();
var service = new LoanService(ledger);
service.Borrow(new LibraryLending.Lending.Account(7, 0), 1001);
