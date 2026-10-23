package org.springframework.jdbc.core;

import java.sql.ResultSet;
import java.sql.SQLException;

/** Test stub with the real Spring JDBC name; no dependency JAR is needed. */
@FunctionalInterface
public interface RowMapper<T> {
  T mapRow(ResultSet rs, int rowNum) throws SQLException;
}
