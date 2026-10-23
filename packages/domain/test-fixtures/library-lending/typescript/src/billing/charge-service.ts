/** The only door into Billing for other contexts. */
export interface ChargeService {
  chargeFine(payerId: number, overdueDays: number): void;
}
