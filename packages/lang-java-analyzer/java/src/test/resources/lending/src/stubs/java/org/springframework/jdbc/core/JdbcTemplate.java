package org.springframework.jdbc.core;

import java.util.List;
import java.util.Map;

/** Test stub with the real Spring JDBC name; no dependency JAR is needed. */
public class JdbcTemplate {
  public <T> List<T> query(String sql, RowMapper<T> rowMapper) {
    return null;
  }

  public List<Map<String, Object>> queryForList(String sql, Object... args) {
    return null;
  }

  public int update(String sql, Object... args) {
    return 0;
  }

  public int[] batchUpdate(String... sql) {
    return null;
  }

  public void execute(String sql) {
  }
}
