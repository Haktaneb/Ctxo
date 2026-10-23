package lending;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;

/** No stub for JdbcTemplate here: the call site matches through the field's declared type and the import. */
public class LegacyDao {
  private final JdbcTemplate jdbc;

  public LegacyDao(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public List<Map<String, Object>> load() {
    return jdbc.queryForList("SELECT Id, MemberId FROM dbo.Loans WHERE ClosedAt IS NULL");
  }
}
