package io.ctxo.jdt;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class SqlCallSitesTest {
  private static final Path LENDING = Paths.get("src/test/resources/lending").toAbsolutePath();
  private static final Path MISSING = Paths.get("src/test/resources/sql-missing-classpath").toAbsolutePath();
  private static final String DATA = "src/main/java/lending/data/";
  private static final String REPOSITORY = DATA + "LoanRepository.java";
  private static final String JPA = DATA + "LoanJpaRepository.java";
  private static final String MAPPER = DATA + "LoanMapper.java";
  private static Analyzer analyzer;
  private static List<Dtos.FileResult> lending;

  @BeforeAll
  static void analyzeLending() {
    analyzer = new Analyzer(LENDING.toString(), new String[0], true);
    lending = analyzer.analyze(Main.discoverJavaFiles(LENDING.toString()));
  }

  private static Dtos.FileResult file(List<Dtos.FileResult> results, String file) {
    return results.stream().filter(fr -> fr.file.equals(file)).findFirst()
        .orElseThrow(() -> new AssertionError("no file result " + file));
  }

  /** {@code <symbolId>|<kind>|<text>} of every site of one file, in emitted order. */
  private static List<String> sites(List<Dtos.FileResult> results, String file) {
    List<Dtos.SqlSite> sites = file(results, file).sqlCallSites;
    if (sites == null) return List.of();
    return sites.stream().map(s -> s.symbolId + "|" + s.kind + "|" + s.text).collect(Collectors.toList());
  }

  private static String method(String file, String name) {
    return file + "::" + name + "::method";
  }

  /** The 0-based line of the only line of a fixture file that contains {@code needle}. */
  private static int lineOf(Path root, String file, String needle) throws IOException {
    List<String> lines = Files.readAllLines(root.resolve(file), StandardCharsets.UTF_8);
    int found = -1;
    for (int i = 0; i < lines.size(); i++) {
      if (!lines.get(i).contains(needle)) continue;
      assertEquals(-1, found, "more than one line holds " + needle);
      found = i;
    }
    assertNotEquals(-1, found, "no line holds " + needle);
    return found;
  }

  private static void write(Path root, String rel, String source) throws IOException {
    Path p = root.resolve(rel);
    Files.createDirectories(p.getParent());
    Files.write(p, source.getBytes(StandardCharsets.UTF_8));
  }

  /** Copies one of the lending fixture's stubs into a temp project. */
  private static void copyStub(Path root, String rel) throws IOException {
    write(root, "src/stubs/java/" + rel, Files.readString(LENDING.resolve("src/stubs/java/" + rel)));
  }

  @Test
  void jdbcSpringAndJpaCallSitesReportConstantSql() throws IOException {
    assertEquals(List.of(
        method(REPOSITORY, "findActive") + "|statement|SELECT l.Id FROM dbo.Loans l JOIN [dbo].[Members] m ON m.Id = l.MemberId",
        method(REPOSITORY, "close") + "|procedureName|dbo.usp_CloseLoan",
        method(REPOSITORY, "archive")
            + "|statement|INSERT INTO dbo.LoanArchive (Id) SELECT Id FROM dbo.Loans WHERE ClosedAt IS NOT NULL",
        method(REPOSITORY, "holdsFor") + "|statement|SELECT * FROM dbo.Holds WHERE MemberId = :id",
        method(REPOSITORY, "purge") + "|statement|DELETE FROM dbo.Holds WHERE ExpiresAt < CURRENT_TIMESTAMP",
        method(REPOSITORY, "flagAll") + "|statement|UPDATE dbo.Loans SET Flag = 1",
        method(REPOSITORY, "flagAll") + "|statement|UPDATE dbo.Members SET Flag = 1",
        method(REPOSITORY, "later") + "|statement|UPDATE dbo.Holds SET Flag = 1"),
        sites(lending, REPOSITORY));

    // Lines are 0-based and point at the SQL text.
    List<Dtos.SqlSite> sites = file(lending, REPOSITORY).sqlCallSites;
    assertEquals(lineOf(LENDING, REPOSITORY, "jdbc.query(ACTIVE_SQL"), sites.get(0).line);
    assertEquals(lineOf(LENDING, REPOSITORY, "{call dbo.usp_CloseLoan"), sites.get(1).line);
    assertEquals(lineOf(LENDING, REPOSITORY, "INSERT INTO dbo.LoanArchive"), sites.get(2).line);
    assertEquals(lineOf(LENDING, REPOSITORY, "named.queryForList(\"\"\""), sites.get(3).line);
    assertEquals(lineOf(LENDING, REPOSITORY, "jdbc.batchUpdate("), sites.get(5).line);
    assertEquals(sites.get(5).line, sites.get(6).line);
  }

  @Test
  void nativeQueryAndMyBatisAnnotationsReportSql(@TempDir Path tmp) throws IOException {
    assertEquals(List.of(
        method(JPA, "findOverdue") + "|statement|SELECT * FROM dbo.Loans WHERE DueAt < CURRENT_TIMESTAMP"),
        sites(lending, JPA));
    assertEquals(List.of(
        method(MAPPER, "active") + "|statement|SELECT * FROM dbo.Loans WHERE ClosedAt IS NULL",
        method(MAPPER, "add") + "|statement|INSERT INTO dbo.Loans (Id, MemberId) VALUES (#{id}, #{memberId})",
        method(MAPPER, "renew") + "|statement|UPDATE dbo.Loans SET RenewedAt = CURRENT_TIMESTAMP WHERE Id = #{id}",
        method(MAPPER, "remove") + "|statement|DELETE FROM dbo.Loans WHERE Id = #{id}"),
        sites(lending, MAPPER));
    assertEquals(lineOf(LENDING, MAPPER, "@Select("), file(lending, MAPPER).sqlCallSites.get(0).line);

    // A procedure call escape is a procedure name in an annotation too; nativeQuery = false gives
    // nothing, and the members may come in any order.
    copyStub(tmp, "org/apache/ibatis/annotations/Select.java");
    copyStub(tmp, "org/springframework/data/jpa/repository/Query.java");
    write(tmp, "src/main/java/m/Calls.java", String.join("\n",
        "package m;",
        "import org.apache.ibatis.annotations.Select;",
        "import org.springframework.data.jpa.repository.Query;",
        "interface Calls {",
        "  @Select(\"{ ? = CALL dbo.usp_NextLoanId(#{memberId}) }\") long next(long memberId);",
        "  @Query(value = \"SELECT * FROM dbo.Members\", nativeQuery = false) Object jpql();",
        "  @Query(nativeQuery = true, value = \"SELECT * FROM dbo.Holds\") Object holds();",
        "}", ""));
    Analyzer calls = new Analyzer(tmp.toString(), new String[0], true);
    List<Dtos.FileResult> r = calls.analyze(Main.discoverJavaFiles(tmp.toString()));
    assertEquals(List.of(
        method("src/main/java/m/Calls.java", "next") + "|procedureName|dbo.usp_NextLoanId",
        method("src/main/java/m/Calls.java", "holds") + "|statement|SELECT * FROM dbo.Holds"),
        sites(r, "src/main/java/m/Calls.java"));
    assertEquals(2, calls.sqlStats().constant);
    assertEquals(0, calls.sqlStats().nonConstant);
  }

  @Test
  void lambdaCallSitesBelongToTheEnclosingMethod(@TempDir Path tmp) throws IOException {
    assertTrue(sites(lending, REPOSITORY).contains(method(REPOSITORY, "later") + "|statement|UPDATE dbo.Holds SET Flag = 1"));

    // Constructor bodies count, nested lambdas belong to their method, field initializers and
    // initializer blocks are no method bodies (no site, not counted).
    copyStub(tmp, "org/springframework/jdbc/core/JdbcTemplate.java");
    copyStub(tmp, "org/springframework/jdbc/core/RowMapper.java");
    write(tmp, "src/main/java/jobs/Jobs.java", String.join("\n",
        "package jobs;",
        "import org.springframework.jdbc.core.JdbcTemplate;",
        "class Jobs {",
        "  static final JdbcTemplate SHARED = new JdbcTemplate();",
        "  static final Runnable AT_FIELD = () -> SHARED.update(\"UPDATE dbo.Holds SET Flag = 2\");",
        "  static { SHARED.update(\"UPDATE dbo.Holds SET Flag = 3\"); }",
        "  private final Runnable onConstruction;",
        "  Jobs(JdbcTemplate jdbc) {",
        "    this.onConstruction = () -> jdbc.update(\"UPDATE dbo.Loans SET Flag = 2\");",
        "  }",
        "  Runnable nested(JdbcTemplate jdbc) {",
        "    return () -> {",
        "      Runnable inner = () -> jdbc.update(\"UPDATE dbo.Members SET Flag = 2\");",
        "      inner.run();",
        "    };",
        "  }",
        "}", ""));
    Analyzer jobs = new Analyzer(tmp.toString(), new String[0], true);
    List<Dtos.FileResult> r = jobs.analyze(Main.discoverJavaFiles(tmp.toString()));
    String file = "src/main/java/jobs/Jobs.java";
    assertEquals(List.of(
        method(file, "Jobs") + "|statement|UPDATE dbo.Loans SET Flag = 2",
        method(file, "nested") + "|statement|UPDATE dbo.Members SET Flag = 2"),
        sites(r, file));
    assertEquals(2, jobs.sqlStats().constant);
    assertEquals(0, jobs.sqlStats().nonConstant);
  }

  @Test
  void statsCountThirteenConstantAndOneNonConstantText() {
    assertEquals(13, analyzer.sqlStats().constant);
    assertEquals(1, analyzer.sqlStats().nonConstant);

    // The stats describe one analyze() run, so a keep-alive tick that re-analyzes every file does
    // not add up.
    Analyzer twice = new Analyzer(LENDING.toString(), new String[0], true);
    twice.analyze(Main.discoverJavaFiles(LENDING.toString()));
    twice.analyze(Main.discoverJavaFiles(LENDING.toString()));
    assertEquals(13, twice.sqlStats().constant);
    assertEquals(1, twice.sqlStats().nonConstant);
  }

  @Test
  void withoutTheFlagThereAreNoSitesAndNoStats() {
    Analyzer twoArgs = new Analyzer(LENDING.toString(), new String[0]);
    List<Dtos.FileResult> r = twoArgs.analyze(Main.discoverJavaFiles(LENDING.toString()));
    assertFalse(r.isEmpty());
    for (Dtos.FileResult fr : r) assertNull(fr.sqlCallSites, fr.file);
    assertNull(twoArgs.sqlStats());

    Analyzer off = new Analyzer(LENDING.toString(), new String[0], false);
    for (Dtos.FileResult fr : off.analyze(Main.discoverJavaFiles(LENDING.toString()))) assertNull(fr.sqlCallSites, fr.file);
    assertNull(off.sqlStats());

    // With the flag, a file without call sites has no list either.
    assertNull(file(lending, "src/main/java/lending/domain/Loan.java").sqlCallSites);
  }

  @Test
  void missingClasspathTypesMatchThroughDeclaredTypesAndImports(@TempDir Path tmp) throws IOException {
    // Review Focus 5: no stub and no dependency JAR, so JdbcTemplate does not resolve.
    Analyzer missing = new Analyzer(MISSING.toString(), new String[0], true);
    List<Dtos.FileResult> r = missing.analyze(Main.discoverJavaFiles(MISSING.toString()));
    assertEquals(List.of(
        method("src/main/java/lending/LegacyDao.java", "load")
            + "|statement|SELECT Id, MemberId FROM dbo.Loans WHERE ClosedAt IS NULL"),
        sites(r, "src/main/java/lending/LegacyDao.java"));
    assertEquals(1, missing.sqlStats().constant);
    assertEquals(0, missing.sqlStats().nonConstant);

    // Parameters, `this.field`, a fully qualified local, the same package and annotations through
    // the imports; a String-typed non-constant counts, a receiver of another type and a first
    // argument that is no String do not.
    write(tmp, "src/main/java/legacy/LegacyService.java", String.join("\n",
        "package legacy;",
        "import com.example.bus.Bus;",
        "import org.apache.ibatis.annotations.Select;",
        "import org.springframework.data.jpa.repository.Query;",
        "import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;",
        "class LegacyService {",
        "  private NamedParameterJdbcTemplate shared;",
        "  @Select({\"SELECT * FROM dbo.Holds\", \"WHERE MemberId = #{id}\"}) Object holds(long id);",
        "  @Query(value = \"SELECT * FROM dbo.Members\", nativeQuery = true) Object members();",
        "  @Query(\"SELECT m FROM Member m\") Object jpql();",
        "  void run(NamedParameterJdbcTemplate named, Bus bus, String sql, Builder builder) {",
        "    named.update(\"DELETE FROM dbo.Holds\", null);",
        "    this.shared.update(\"UPDATE dbo.Members SET Flag = 3\", null);",
        "    jakarta.persistence.EntityManager em = open();",
        "    em.createNativeQuery(\"UPDATE dbo.Loans SET Flag = 3\");",
        "    bus.query(\"SELECT * FROM dbo.NotATable\");",
        "    named.update(sql, null);",
        "    named.update(builder, null);",
        "  }",
        "}", ""));
    write(tmp, "src/main/java/org/springframework/jdbc/core/LocalDao.java", String.join("\n",
        "package org.springframework.jdbc.core;",
        "class LocalDao {",
        "  void run(JdbcTemplate jdbc) { jdbc.execute(\"TRUNCATE TABLE dbo.LoanArchive\"); }",
        "}", ""));
    Analyzer legacy = new Analyzer(tmp.toString(), new String[0], true);
    List<Dtos.FileResult> lr = legacy.analyze(Main.discoverJavaFiles(tmp.toString()));
    String service = "src/main/java/legacy/LegacyService.java";
    assertEquals(List.of(
        method(service, "holds") + "|statement|SELECT * FROM dbo.Holds WHERE MemberId = #{id}",
        method(service, "members") + "|statement|SELECT * FROM dbo.Members",
        method(service, "run") + "|statement|DELETE FROM dbo.Holds",
        method(service, "run") + "|statement|UPDATE dbo.Members SET Flag = 3",
        method(service, "run") + "|statement|UPDATE dbo.Loans SET Flag = 3"),
        sites(lr, service));
    String localDao = "src/main/java/org/springframework/jdbc/core/LocalDao.java";
    assertEquals(List.of(method(localDao, "run") + "|statement|TRUNCATE TABLE dbo.LoanArchive"), sites(lr, localDao));
    assertEquals(6, legacy.sqlStats().constant);
    assertEquals(1, legacy.sqlStats().nonConstant);
  }

  @Test
  void bindingsDecideTheStringParameterAndEveryArgumentOfAnAllStringBatchUpdate(@TempDir Path tmp) throws IOException {
    // With bindings, a matched member whose first parameter is no java.lang.String is no call
    // site; every argument of batchUpdate(String...) is a text, and so is every element of an
    // array passed to it.
    write(tmp, "src/stubs/java/org/springframework/jdbc/core/JdbcTemplate.java", String.join("\n",
        "package org.springframework.jdbc.core;",
        "public class JdbcTemplate {",
        "  public interface ConnectionCallback<T> { T run(); }",
        "  public <T> T execute(ConnectionCallback<T> action) { return null; }",
        "  public void execute(String sql) {}",
        "  public int[] batchUpdate(String... sql) { return null; }",
        "  public int[] batchUpdate(String sql, java.util.List<Object[]> batchArgs) { return null; }",
        "}", ""));
    write(tmp, "src/main/java/b/Batch.java", String.join("\n",
        "package b;",
        "import org.springframework.jdbc.core.JdbcTemplate;",
        "class Batch {",
        "  static final String LOANS = \"DELETE FROM dbo.Loans\";",
        "  void run(JdbcTemplate jdbc, String dynamic) {",
        "    jdbc.execute(() -> \"not sql\");",
        "    jdbc.batchUpdate(new String[] {LOANS, \"DELETE FROM dbo.Holds\"});",
        "    jdbc.batchUpdate(\"UPDATE dbo.Members SET Flag = ?\", java.util.List.of());",
        "    jdbc.batchUpdate(LOANS, dynamic);",
        "  }",
        "}", ""));
    Analyzer batch = new Analyzer(tmp.toString(), new String[0], true);
    List<Dtos.FileResult> r = batch.analyze(Main.discoverJavaFiles(tmp.toString()));
    String file = "src/main/java/b/Batch.java";
    assertEquals(List.of(
        method(file, "run") + "|statement|DELETE FROM dbo.Holds",
        method(file, "run") + "|statement|DELETE FROM dbo.Loans",
        method(file, "run") + "|statement|UPDATE dbo.Members SET Flag = ?",
        method(file, "run") + "|statement|DELETE FROM dbo.Loans"),
        sites(r, file));
    assertEquals(4, batch.sqlStats().constant);
    assertEquals(1, batch.sqlStats().nonConstant);
  }

  @Test
  void nonAsciiSqlTextIsReadAsUtf8(@TempDir Path tmp) throws IOException {
    // QR22: JDT reads the sources as UTF-8, whatever the platform encoding is.
    String sql = "UPDATE dbo.Üyeler SET Ad = 'Şule çığ' WHERE Id = 1";
    write(tmp, "src/main/java/u/Members.java", String.join("\n",
        "package u;",
        "import org.springframework.jdbc.core.JdbcTemplate;",
        "class Members {",
        "  void rename(JdbcTemplate jdbc) {",
        "    jdbc.update(\"" + sql + "\");",
        "  }",
        "}", ""));
    Analyzer members = new Analyzer(tmp.toString(), new String[0], true);
    List<Dtos.FileResult> r = members.analyze(Main.discoverJavaFiles(tmp.toString()));
    assertEquals(List.of(method("src/main/java/u/Members.java", "rename") + "|statement|" + sql),
        sites(r, "src/main/java/u/Members.java"));
  }
}
