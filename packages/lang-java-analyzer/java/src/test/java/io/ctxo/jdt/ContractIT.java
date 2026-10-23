package io.ctxo.jdt;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ContractIT {
  @Test
  void fileResultSerializesToExpectedShape() throws Exception {
    Path root = Paths.get("src/test/resources/fixture").toAbsolutePath();
    List<Dtos.FileResult> r = new Analyzer(root.toString(), new String[0])
        .analyze(List.of(root.resolve("Foo.java").toString(), root.resolve("Bar.java").toString()));
    String json = new Gson().toJson(r.get(0));
    assertTrue(json.contains("\"type\":\"file\""));
    assertTrue(json.contains("\"symbols\""));
    assertTrue(json.contains("\"edges\""));
    assertTrue(json.contains("\"complexity\":[]"));
    long calls = r.stream().flatMap(x -> x.edges.stream()).filter(e -> e.kind.equals("calls")).count();
    assertTrue(calls >= 1, "JDT must emit resolved call edges");
  }

  @Test
  void annotationsSerializeAsNameArgsNamedAndAreOmittedWhenEmpty() throws Exception {
    Path root = Paths.get("src/test/resources/lending").toAbsolutePath();
    List<Dtos.FileResult> r = new Analyzer(root.toString(), new String[0])
        .analyze(Main.discoverJavaFiles(root.toString()));
    Gson gson = new GsonBuilder().disableHtmlEscaping().create(); // as Main serializes
    String loan = gson.toJson(fileResult(r, "src/main/java/lending/domain/Loan.java"));
    String limits = gson.toJson(fileResult(r, "src/main/java/lending/domain/Limits.java"));
    assertTrue(loan.contains("\"symbolId\":\"src/main/java/lending/domain/Loan.java::Loan::class\""), loan);
    assertTrue(loan.contains("\"annotations\":[{\"name\":\"Entity\"},"), loan);
    assertTrue(limits.contains("\"symbolId\":\"src/main/java/lending/domain/Limits.java::Limits::class\""), limits);
    assertFalse(limits.contains("\"annotations\""), limits);
    assertFalse(limits.contains("null"), limits);
  }

  @Test
  void jsonLinesAreAsciiSoNonAsciiValuesSurviveAnyStdoutEncoding() {
    Dtos.Sym sym = new Dtos.Sym("A.java::café::method", "café", "method", 0, 0, 0, 1);
    sym.annotations = List.of(new Dtos.Ann("DisplayName", List.of("üye ş 📚"), null));
    String line = Main.json(sym);
    assertTrue(line.chars().allMatch(c -> c < 0x80), line);
    JsonObject back = JsonParser.parseString(line).getAsJsonObject();
    assertEquals("café", back.get("name").getAsString());
    assertEquals("üye ş 📚",
        back.getAsJsonArray("annotations").get(0).getAsJsonObject().getAsJsonArray("args").get(0).getAsString());
    assertEquals(new GsonBuilder().disableHtmlEscaping().create().toJson(new Dtos.Edge("a", "b<c>", "uses")),
        Main.json(new Dtos.Edge("a", "b<c>", "uses")), "ASCII output is unchanged");
  }

  @Test
  void sqlCallSitesSerializeWithSymbolIdLineTextKind() throws Exception {
    Path root = Paths.get("src/test/resources/lending").toAbsolutePath();
    String repository = "src/main/java/lending/data/LoanRepository.java";
    List<String> source = Files.readAllLines(root.resolve(repository), StandardCharsets.UTF_8);
    int findActive = indexOf(source, "jdbc.query(ACTIVE_SQL");
    int close = indexOf(source, "{call dbo.usp_CloseLoan");

    List<Dtos.FileResult> r = new Analyzer(root.toString(), new String[0], true)
        .analyze(Main.discoverJavaFiles(root.toString()));
    String line = Main.json(fileResult(r, repository));
    assertTrue(line.contains("\"sqlCallSites\":[{\"symbolId\":\"" + repository + "::findActive::method\",\"line\":"
        + findActive + ",\"text\":\"SELECT l.Id FROM dbo.Loans l JOIN [dbo].[Members] m ON m.Id = l.MemberId\","
        + "\"kind\":\"statement\"},{\"symbolId\":\"" + repository + "::close::method\",\"line\":" + close
        + ",\"text\":\"dbo.usp_CloseLoan\",\"kind\":\"procedureName\"},"), line);
    assertFalse(Main.json(fileResult(r, "src/main/java/lending/domain/Loan.java")).contains("sqlCallSites"));

    List<Dtos.FileResult> off = new Analyzer(root.toString(), new String[0])
        .analyze(Main.discoverJavaFiles(root.toString()));
    assertFalse(Main.json(fileResult(off, repository)).contains("sqlCallSites"));

    // QR21: a non-ASCII SQL text goes through the ASCII line too.
    String sql = "UPDATE dbo.Üyeler SET Flag = 1";
    String site = Main.json(new Dtos.SqlSite("A.java::rename::method", 3, sql, "statement"));
    assertTrue(site.chars().allMatch(c -> c < 0x80), site);
    assertEquals(sql, JsonParser.parseString(site).getAsJsonObject().get("text").getAsString());
  }

  @Test
  void doneLineCarriesSqlStatsOnlyWithTheFlag() {
    String root = Paths.get("src/test/resources/lending").toAbsolutePath().toString();
    List<JsonObject> on = batchLines(root, new Analyzer(root, new String[0], true));
    JsonObject done = on.get(on.size() - 1);
    assertEquals("done", done.get("type").getAsString());
    assertEquals("{\"constant\":13,\"nonConstant\":1}", done.get("sql").toString());
    assertTrue(on.stream().anyMatch(o -> o.has("sqlCallSites")));

    List<JsonObject> off = batchLines(root, new Analyzer(root, new String[0]));
    JsonObject plainDone = off.get(off.size() - 1);
    assertEquals("done", plainDone.get("type").getAsString());
    assertFalse(plainDone.has("sql"), plainDone.toString());
    assertTrue(off.stream().noneMatch(o -> o.has("sqlCallSites")));
  }

  @Test
  void keepAliveReadsUtf8RequestsAndReportsSqlCallSites(@TempDir Path tmp) throws Exception {
    // The plugin writes UTF-8 requests: a non-ASCII path and SQL text survive the round trip.
    String rel = "src/main/java/lending/Üye.java";
    String sql = "UPDATE dbo.Üyeler SET Flag = 1";
    Path file = tmp.resolve(rel);
    Files.createDirectories(file.getParent());
    Files.write(file, String.join("\n",
        "package lending;",
        "import org.springframework.jdbc.core.JdbcTemplate;",
        "class Üye {",
        "  void flag(JdbcTemplate jdbc) { jdbc.update(\"" + sql + "\"); }",
        "}", "").getBytes(StandardCharsets.UTF_8));
    byte[] request = ("{\"file\":\"" + rel + "\"}\n").getBytes(StandardCharsets.UTF_8);
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    Main.runKeepAlive(tmp.toString(), new Analyzer(tmp.toString(), new String[0], true),
        new ByteArrayInputStream(request), new PrintStream(bytes, true, "UTF-8"));

    String output = bytes.toString("UTF-8");
    assertTrue(output.chars().allMatch(c -> c < 0x80), output);
    JsonObject result = lines(output).stream().filter(o -> o.get("type").getAsString().equals("file"))
        .findFirst().orElseThrow(() -> new AssertionError(output));
    assertEquals(rel, result.get("file").getAsString());
    assertTrue(result.getAsJsonArray("symbols").size() > 0, output);
    JsonObject site = result.getAsJsonArray("sqlCallSites").get(0).getAsJsonObject();
    assertEquals(rel + "::flag::method", site.get("symbolId").getAsString());
    assertEquals(3, site.get("line").getAsInt());
    assertEquals(sql, site.get("text").getAsString());
    assertEquals("statement", site.get("kind").getAsString());
  }

  private static List<JsonObject> batchLines(String root, Analyzer analyzer) {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    Main.runBatch(root, analyzer, new PrintStream(bytes, true));
    return lines(bytes.toString());
  }

  private static List<JsonObject> lines(String output) {
    List<JsonObject> out = new ArrayList<>();
    for (String line : output.split("\\r?\\n")) {
      if (!line.isBlank()) out.add(JsonParser.parseString(line).getAsJsonObject());
    }
    return out;
  }

  private static int indexOf(List<String> lines, String needle) {
    for (int i = 0; i < lines.size(); i++) if (lines.get(i).contains(needle)) return i;
    throw new AssertionError("no line holds " + needle);
  }

  private static Dtos.FileResult fileResult(List<Dtos.FileResult> results, String file) {
    return results.stream().filter(fr -> fr.file.equals(file)).findFirst()
        .orElseThrow(() -> new AssertionError("no file result " + file));
  }
}
