# Billing

Billing turns late returns into fines and invoices.

## Language

- **Account**: the payer who settles invoices: the payer id and the balance owed.

## Rules and invariants

### BILL-01 A fine is two cents per overdue day
Untested: the rate is a constant and has no test yet

### BILL-02 An invoice is never deleted
Untested: nothing deletes invoices yet

### BILL-03 A paid invoice cannot be charged again
Untested: payment is not built yet

## Boundary contracts

Other contexts reach Billing only through the charge service.

## Decisions

- Balances are kept in whole cents.

## Open questions

- Do members under twelve pay fines at all?
