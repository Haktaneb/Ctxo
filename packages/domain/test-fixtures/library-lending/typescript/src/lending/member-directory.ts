export function memberKey(email: string): string {
  return email.trim().toLowerCase();
}
