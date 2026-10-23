package io.ctxo.jdt;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class AnnotationsTest {
  private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
  private static final Path LENDING = Paths.get("src/test/resources/lending").toAbsolutePath();
  private static final String DOMAIN = "src/main/java/lending/domain/";
  private static List<Dtos.FileResult> lending;

  @BeforeAll
  static void analyzeLending() {
    lending = analyze(LENDING);
  }

  private static List<Dtos.FileResult> analyze(Path root) {
    return new Analyzer(root.toString(), new String[0]).analyze(Main.discoverJavaFiles(root.toString()));
  }

  private static Dtos.Sym find(List<Dtos.FileResult> results, String symbolId) {
    return results.stream().flatMap(r -> r.symbols.stream())
        .filter(s -> s.symbolId.equals(symbolId)).findFirst()
        .orElseThrow(() -> new AssertionError("no symbol " + symbolId));
  }

  /** The annotations as the analyzer serializes them (key order included). */
  private static String annotationsJson(List<Dtos.FileResult> results, String symbolId) {
    return GSON.toJson(find(results, symbolId).annotations);
  }

  private static void write(Path root, String rel, String source) throws IOException {
    Path p = root.resolve(rel);
    Files.createDirectories(p.getParent());
    Files.write(p, source.getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void testMethodsCarryTheirJUnitAnnotations() {
    assertEquals(
        "[{\"name\":\"Test\"},{\"name\":\"Tag\",\"args\":[\"LEND-03\"]},"
            + "{\"name\":\"DisplayName\",\"args\":[\"a member holds at most five loans\"]}]",
        annotationsJson(lending, "src/test/java/lending/LoanPolicyTest.java::memberHoldsAtMostFiveLoans::method"));
  }

  @Test
  void typesCarryAnnotations(@TempDir Path tmp) throws IOException {
    assertEquals("[{\"name\":\"Entity\"},{\"name\":\"Table\",\"named\":{\"name\":\"Loans\"}}]",
        annotationsJson(lending, DOMAIN + "Loan.java::Loan::class"));
    assertNull(find(lending, DOMAIN + "Limits.java::Limits::class").annotations);

    // A qualified annotation keeps its simple name, resolved or not; enums, records and
    // annotation types carry theirs too.
    write(tmp, "q/Kinds.java", String.join("\n",
        "package q;",
        "@java.lang.Deprecated class Kinds {}",
        "@org.example.Missing(\"m\") enum Kind { A }",
        "@Deprecated record Point(int x) {}",
        "@Deprecated @interface Marker {}", ""));
    List<Dtos.FileResult> r = analyze(tmp);
    assertEquals("[{\"name\":\"Deprecated\"}]", annotationsJson(r, "q/Kinds.java::Kinds::class"));
    assertEquals("[{\"name\":\"Missing\",\"args\":[\"m\"]}]", annotationsJson(r, "q/Kinds.java::Kind::type"));
    assertEquals("[{\"name\":\"Deprecated\"}]", annotationsJson(r, "q/Kinds.java::Point::class"));
    assertEquals("[{\"name\":\"Deprecated\"}]", annotationsJson(r, "q/Kinds.java::Marker::interface"));
  }

  @Test
  void fieldsCarryAnnotations(@TempDir Path tmp) throws IOException {
    assertEquals("[{\"name\":\"Column\",\"named\":{\"name\":\"member_id\",\"nullable\":\"false\"}}]",
        annotationsJson(lending, DOMAIN + "Loan.java::memberId::variable"));

    // Every fragment of a field declaration gets the declaration's annotations.
    write(tmp, "f/Pair.java", "package f;\nclass Pair {\n  @Deprecated int left, right;\n  int plain;\n}\n");
    List<Dtos.FileResult> r = analyze(tmp);
    assertEquals("[{\"name\":\"Deprecated\"}]", annotationsJson(r, "f/Pair.java::left::variable"));
    assertEquals("[{\"name\":\"Deprecated\"}]", annotationsJson(r, "f/Pair.java::right::variable"));
    assertNull(find(r, "f/Pair.java::plain::variable").annotations);
  }

  @Test
  void constantsEnumsAndClassLiteralsAreFormatted() {
    assertEquals(
        "[{\"name\":\"Retry\",\"args\":[\"renewal\"],"
            + "\"named\":{\"times\":\"3\",\"unit\":\"TimeUnit.SECONDS\",\"on\":\"java.lang.IllegalStateException\"}}]",
        annotationsJson(lending, DOMAIN + "Loan.java::renew::method"));
  }

  @Test
  void arraysFlattenAndNestedAnnotationsAreSkipped() {
    assertEquals("[{\"name\":\"SuppressWarnings\",\"args\":[\"unchecked\",\"rawtypes\"]},{\"name\":\"Notes\"}]",
        annotationsJson(lending, DOMAIN + "Loan.java::legacy::method"));
  }

  @Test
  void unresolvedAnnotationTypesFallBackToSyntax(@TempDir Path tmp) throws IOException {
    // No `Unknown` type anywhere: the syntax gives the values.
    assertEquals("[{\"name\":\"Unknown\",\"args\":[\"x\"],\"named\":{\"level\":\"2\"}}]",
        annotationsJson(lending, DOMAIN + "Loan.java::audited::method"));

    // Review Focus 5: no stubs and no dependency JARs, so JUnit and JPA types do not resolve.
    Path test = LENDING.resolve("src/test/java/lending/LoanPolicyTest.java");
    Path loan = LENDING.resolve(DOMAIN + "Loan.java");
    write(tmp, "src/test/java/lending/LoanPolicyTest.java", Files.readString(test));
    write(tmp, DOMAIN + "Loan.java", Files.readString(loan));
    List<Dtos.FileResult> r = analyze(tmp);
    assertEquals(
        annotationsJson(lending, "src/test/java/lending/LoanPolicyTest.java::memberHoldsAtMostFiveLoans::method"),
        annotationsJson(r, "src/test/java/lending/LoanPolicyTest.java::memberHoldsAtMostFiveLoans::method"));
    assertEquals("[{\"name\":\"Entity\"},{\"name\":\"Table\",\"named\":{\"name\":\"Loans\"}}]",
        annotationsJson(r, DOMAIN + "Loan.java::Loan::class"));
    assertEquals("[{\"name\":\"Column\",\"named\":{\"name\":\"member_id\",\"nullable\":\"false\"}}]",
        annotationsJson(r, DOMAIN + "Loan.java::memberId::variable"));
    // Unresolved enum constants and class literals keep the text as written.
    String renew = annotationsJson(r, DOMAIN + "Loan.java::renew::method");
    assertTrue(renew.startsWith("[{\"name\":\"Retry\",\"args\":[\"renewal\"],\"named\":{\"times\":"), renew);
    assertTrue(renew.contains("\"unit\":\"TimeUnit.SECONDS\""), renew);
  }

  @Test
  void memberNamedTypeIsDropped(@TempDir Path tmp) throws IOException {
    // `named.type` is reserved in every language (QR1): a member named `type` is dropped.
    write(tmp, "t/Typed.java", String.join("\n",
        "package t;",
        "@interface Col { String type() default \"\"; String name() default \"\"; }",
        "class Typed {",
        "  @Col(type = \"int\", name = \"member_id\") long resolved;",
        "  @Missing(type = \"int\", name = \"member_id\") long unresolved;",
        "  @Col(type = \"int\") long onlyType;",
        "}", ""));
    List<Dtos.FileResult> r = analyze(tmp);
    assertEquals("[{\"name\":\"Col\",\"named\":{\"name\":\"member_id\"}}]", annotationsJson(r, "t/Typed.java::resolved::variable"));
    assertEquals("[{\"name\":\"Missing\",\"named\":{\"name\":\"member_id\"}}]", annotationsJson(r, "t/Typed.java::unresolved::variable"));
    assertEquals("[{\"name\":\"Col\"}]", annotationsJson(r, "t/Typed.java::onlyType::variable"));
  }

  @Test
  void capsLimitAnnotationsArgsNamedAndLength(@TempDir Path tmp) throws IOException {
    StringBuilder src = new StringBuilder("package caps;\n");
    for (int i = 0; i < 25; i++) src.append("@A").append(i).append(' ');
    src.append("\npublic class Capped {\n");
    src.append("  static final String LONG = \"").append("x".repeat(250)).append("\";\n");
    src.append("  @interface Many { String type() default \"\";");
    for (int i = 0; i < 12; i++) src.append(" String m").append(i).append("() default \"\";");
    src.append(" }\n");
    src.append("  @SuppressWarnings({");
    for (int i = 0; i < 12; i++) src.append(i == 0 ? "" : ", ").append("\"v").append(i).append('"');
    src.append("}) void arrays() {}\n");
    src.append("  @Many(type = \"t\"");
    for (int i = 0; i < 12; i++) src.append(", m").append(i).append(" = \"").append(i).append('"');
    src.append(") void members() {}\n");
    src.append("  @SuppressWarnings(LONG) @Many(m0 = LONG, m1 = {LONG}) void longValue() {}\n");
    src.append("}\n");
    write(tmp, "caps/Capped.java", src.toString());
    List<Dtos.FileResult> r = analyze(tmp);

    List<Dtos.Ann> onClass = find(r, "caps/Capped.java::Capped::class").annotations;
    assertEquals(20, onClass.size());
    assertEquals("A0", onClass.get(0).name);
    assertEquals("A19", onClass.get(19).name);

    List<String> args = find(r, "caps/Capped.java::arrays::method").annotations.get(0).args;
    assertEquals(10, args.size());
    assertEquals("v0", args.get(0));
    assertEquals("v9", args.get(9));

    Map<String, String> named = find(r, "caps/Capped.java::members::method").annotations.get(0).named;
    assertEquals(10, named.size());
    assertEquals(List.of("m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"), new ArrayList<>(named.keySet()));

    List<Dtos.Ann> longValue = find(r, "caps/Capped.java::longValue::method").annotations;
    assertEquals("x".repeat(200), longValue.get(0).args.get(0));
    assertEquals("x".repeat(200), longValue.get(1).named.get("m0"));
    assertEquals("x".repeat(200), longValue.get(1).named.get("m1"));
  }

  @Test
  void discoversTestSourcesAndSkipsBuildFolders(@TempDir Path tmp) throws IOException {
    write(tmp, "src/test/java/a/ATest.java", "package a;\nclass ATest {}\n");
    write(tmp, "target/B.java", "class B {}\n");
    List<String> files = Main.discoverJavaFiles(tmp.toString());
    assertEquals(1, files.size(), files.toString());
    assertTrue(files.get(0).replace('\\', '/').endsWith("src/test/java/a/ATest.java"), files.get(0));
  }
}
