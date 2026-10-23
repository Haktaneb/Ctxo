# Lending

Members borrow books and bring them back. Terms are in the [glossary](../glossary.md#loan).

## Language

- Loan: one book held by one member until its due date.
- Member account: the member id and the loans the member holds now.

## Rules and invariants

### LEND-01 A loan lasts fourteen days
Untested: the due date is set by the loan service and has no test yet

### LEND-02 A returned book closes its loan
Untested: covered only by manual checks at the desk

### LEND-03 A member holds at most five loans
Tests: `src/lending/__tests__/loan-limit.test.ts`

### LEND-04 A member with an unpaid fine cannot borrow
Untested: needs the Billing charge service, which has no test double yet

### LEND-05 A loan can be renewed once
Untested: renewals are not built yet

## Boundary contracts

Lending asks Billing to charge a fine through the charge service only. See the [context map](../context-map.md).

## Decisions

- Loan limits are a constant, not a setting, until the board asks otherwise.

## Open questions

- Should a renewed loan keep its original due date for fine purposes?
