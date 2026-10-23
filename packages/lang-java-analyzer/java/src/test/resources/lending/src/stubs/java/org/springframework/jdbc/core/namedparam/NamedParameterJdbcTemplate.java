package org.springframework.jdbc.core.namedparam;

import java.util.List;
import java.util.Map;

/** Test stub with the real Spring JDBC name; no dependency JAR is needed. */
public class NamedParameterJdbcTemplate {
  public List<Map<String, Object>> queryForList(String sql, Map<String, ?> paramMap) {
    return null;
  }

  public int update(String sql, Map<String, ?> paramMap) {
    return 0;
  }
}
