package lending.data;

import java.util.List;
import lending.domain.Loan;
import org.springframework.data.jpa.repository.Query;

public interface LoanJpaRepository {
  @Query(value = "SELECT * FROM dbo.Loans WHERE DueAt < CURRENT_TIMESTAMP", nativeQuery = true)
  List<Loan> findOverdue();

  @Query("SELECT l FROM Loan l WHERE l.memberId = ?1")
  List<Loan> findByMember(long memberId);
}
