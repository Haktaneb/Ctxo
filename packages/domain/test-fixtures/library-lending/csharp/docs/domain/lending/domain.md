# Lending

Members borrow books and bring them back. Terms are in the [glossary](../glossary.md#loan).

## Language

- **Loan**: one book held by one member until its due date.
- **Member account**: the member id and the loans the member holds now.
- **Account**: the member account, as the Lending code names it.
- **Fine**: an unpaid charge for a late return that Lending was told about.

## Rules and invariants

### LEND-01 A loan lasts fourteen days
Untested: the due date is set by the loan service and has no test yet

### LEND-02 A returned book closes its loan
Untested: covered only by manual checks at the desk

### LEND-03 A member holds at most five loans
Tests: `tests/Lending.Tests/LoanLimitTests.cs`
Code: `src/Lending/LoanLimit.cs`

### LEND-04 A member with an unpaid fine cannot borrow
Untested: the unpaid-fine check has no test yet

### LEND-05 A loan can be renewed once
Untested: renewals are not built yet

## Boundary contracts

Lending asks Billing to charge a fine through the charge service only (`src/Billing/IChargeService.cs`). See the [context map](../context-map.md).

## Decisions

- Loan limits are a constant, not a setting, until the board asks otherwise.
- 2026-09-12: Loan limit raised from 3 to 5 (LEND-03). [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)
- 2026-10-01: Any unpaid fine blocks a new loan, whatever the amount (LEND-04). https://example.com/issues/45

## Open questions

- Should a renewed loan keep its original due date for fine purposes?
- Should renewals count as new loans?
