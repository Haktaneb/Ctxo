/**
 * A loan runs for one period and can be renewed once, so it never gets a third period.
 * `loanPeriods` is the periods the loan has run so far: 1 for a new loan, 2 after one renewal.
 */
export function canRenew(loanPeriods: number): boolean {
  if (loanPeriods >= 2) return false;
  return true;
}
