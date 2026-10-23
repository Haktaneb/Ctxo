package lending.data;

import java.util.List;
import lending.domain.Loan;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

public interface LoanMapper {
  @Select({"SELECT * FROM dbo.Loans", "WHERE ClosedAt IS NULL"})
  List<Loan> active();

  @Insert("INSERT INTO dbo.Loans (Id, MemberId) VALUES (#{id}, #{memberId})")
  int add(Loan loan);

  @Update("UPDATE dbo.Loans SET RenewedAt = CURRENT_TIMESTAMP WHERE Id = #{id}")
  int renew(long id);

  @Delete("DELETE FROM dbo.Loans WHERE Id = #{id}")
  int remove(long id);
}
