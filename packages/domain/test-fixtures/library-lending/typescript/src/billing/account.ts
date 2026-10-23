/** A payer's account in Billing: who pays and what is owed, in cents. */
export interface Account {
  payerId: number;
  balance: number;
}
