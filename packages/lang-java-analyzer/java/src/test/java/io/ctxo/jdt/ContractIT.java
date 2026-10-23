package io.ctxo.jdt;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
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

  private static Dtos.FileResult fileResult(List<Dtos.FileResult> results, String file) {
    return results.stream().filter(fr -> fr.file.equals(file)).findFirst()
        .orElseThrow(() -> new AssertionError("no file result " + file));
  }
}
