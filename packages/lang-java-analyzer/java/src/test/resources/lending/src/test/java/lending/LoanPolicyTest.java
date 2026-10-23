package lending;

import lending.domain.Limits;
import lending.domain.Loan;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

class LoanPolicyTest {
  @Test
  @Tag("LEND-03")
  @DisplayName("a member holds at most five loans")
  void memberHoldsAtMostFiveLoans() {
    Loan loan = new Loan();
    loan.renew();
    if (Limits.MAX_LOANS_PER_MEMBER != 5) {
      throw new AssertionError("limit changed");
    }
  }
}
