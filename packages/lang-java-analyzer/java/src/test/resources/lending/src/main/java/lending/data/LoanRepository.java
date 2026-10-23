package lending.data;

import jakarta.persistence.EntityManager;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

public class LoanRepository {
  static final String ACTIVE_SQL = "SELECT l.Id FROM dbo.Loans l " + "JOIN [dbo].[Members] m ON m.Id = l.MemberId";

  private final JdbcTemplate jdbc;
  private final NamedParameterJdbcTemplate named;
  private final Connection connection;
  private final Statement statement;
  private final EntityManager entityManager;
  private final RowMapper<Long> mapper;

  public LoanRepository(JdbcTemplate jdbc, NamedParameterJdbcTemplate named, Connection connection,
      Statement statement, EntityManager entityManager, RowMapper<Long> mapper) {
    this.jdbc = jdbc;
    this.named = named;
    this.connection = connection;
    this.statement = statement;
    this.entityManager = entityManager;
    this.mapper = mapper;
  }

  public List<Long> findActive() {
    return jdbc.query(ACTIVE_SQL, mapper);
  }

  public CallableStatement close() throws SQLException {
    return connection.prepareCall("{call dbo.usp_CloseLoan(?)}");
  }

  public int archive() throws SQLException {
    return statement.executeUpdate("INSERT INTO dbo.LoanArchive (Id) "
        + "SELECT Id FROM dbo.Loans WHERE ClosedAt IS NOT NULL");
  }

  public List<Map<String, Object>> holdsFor(Map<String, ?> params) {
    return named.queryForList("""
        SELECT * FROM dbo.Holds WHERE MemberId = :id""", params);
  }

  public int purge() {
    return entityManager.createNativeQuery("DELETE FROM dbo.Holds WHERE ExpiresAt < CURRENT_TIMESTAMP")
        .executeUpdate();
  }

  public int[] flagAll() {
    return jdbc.batchUpdate("UPDATE dbo.Loans SET Flag = 1", "UPDATE dbo.Members SET Flag = 1");
  }

  public Runnable later() {
    return () -> jdbc.update("UPDATE dbo.Holds SET Flag = 1");
  }

  public List<Long> dynamic(String table) {
    return jdbc.query("SELECT * FROM " + table, mapper);
  }

  public ResultSet prepared(PreparedStatement ps) throws SQLException {
    return ps.executeQuery();
  }
}
