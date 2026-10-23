package lending.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.util.concurrent.TimeUnit;

@Entity
@Table(name = "Loans")
public class Loan {
  @Column(name = "member_id", nullable = false)
  private long memberId;

  @Retry(value = "renewal", times = Limits.MAX_RETRIES, unit = TimeUnit.SECONDS, on = IllegalStateException.class)
  public void renew() {
  }

  @SuppressWarnings({"unchecked", "rawtypes"})
  @Notes({@Note("a")})
  public void legacy() {
  }

  @Unknown(value = "x", level = 2)
  public void audited() {
  }

  public long memberId() {
    return memberId;
  }
}
