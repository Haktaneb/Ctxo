package lending.facts;

public class LoanRules {
  public static final int MAX_RETRIES = 3;
  static final java.time.Duration HOLD_TIMEOUT = java.time.Duration.ofMinutes(90);
  private static final int SETTLEMENT_DAYS = 3;

  public boolean canBorrow(int openLoans, String member) {
    if (member == null) return false;
    if (openLoans >= 5 && !member.isEmpty()) return false;
    return true;
  }

  public double fee(String tier) {
    switch (tier) {
      case "gold": return 0;
      case "": return 1;
      default: return 2.5;
    }
  }

  public String key(String email) {
    return email.trim().toLowerCase();
  }

  public boolean same(String a, String b) {
    return a.equalsIgnoreCase(b);
  }

  public String label(int days) {
    return days > 14 ? "late" : "ok";
  }

  private String note() {
    return "if (x > 5) timeout = 30";
  }
}
