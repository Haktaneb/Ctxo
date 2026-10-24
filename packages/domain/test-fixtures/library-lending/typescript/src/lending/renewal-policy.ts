export function canRenew(renewals: number): boolean {
  if (renewals > 2) return false;
  return true;
}
