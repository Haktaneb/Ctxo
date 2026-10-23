package io.ctxo.jdt;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

public final class Main {
  private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
  private static final PrintStream OUT = System.out;
  private static final char[] HEX = "0123456789abcdef".toCharArray();

  public static void main(String[] args) {
    List<String> positional = new ArrayList<>();
    boolean keepAlive = false, allowBuildTools = false, sqlCallSites = false;
    String[] cpOverride = new String[0];
    for (int i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--keep-alive": keepAlive = true; break;
        case "--allow-build-tools": allowBuildTools = true; break;
        case "--sql-call-sites": sqlCallSites = true; break;
        case "--classpath": if (i + 1 < args.length) cpOverride = splitPath(args[++i]); break;
        default: positional.add(args[i]);
      }
    }
    if (positional.isEmpty()) { err("Usage: java -jar ctxo-jdt-analyzer.jar <projectRoot> [--keep-alive] [--classpath p1;p2] [--allow-build-tools] [--sql-call-sites]"); System.exit(1); return; }
    String root = Paths.get(positional.get(0)).toAbsolutePath().normalize().toString();
    String[] classpath = new ClasspathResolver(root, cpOverride, allowBuildTools).resolve();
    Analyzer analyzer = new Analyzer(root, classpath, sqlCallSites);
    if (keepAlive) runKeepAlive(root, analyzer, System.in, OUT); else runBatch(root, analyzer, OUT);
  }

  /**
   * One JSONL line per file, then the {@code done} line; with {@code --sql-call-sites} the
   * {@code done} line carries {@code "sql":{"constant":n,"nonConstant":m}}. Package-private for the tests.
   */
  static void runBatch(String root, Analyzer analyzer, PrintStream out) {
    long start = System.nanoTime();
    List<String> files = discoverJavaFiles(root);
    progress(out, "Analyzing " + files.size() + " files");
    List<Dtos.FileResult> results = analyzer.analyze(files);
    for (Dtos.FileResult fr : results) out.println(json(fr));
    JsonObject done = new JsonObject();
    done.addProperty("type", "done");
    done.addProperty("totalFiles", results.size());
    done.addProperty("elapsed", String.format("%.1fs", (System.nanoTime() - start) / 1e9));
    Dtos.SqlStats sql = analyzer.sqlStats();
    if (sql != null) done.add("sql", GSON.toJsonTree(sql));
    out.println(json(done));
  }

  /**
   * Reads one {@code {"file": "<relative path>"}} request per line and answers with that file's
   * JSONL result; no {@code done} line. Package-private for the tests.
   */
  static void runKeepAlive(String root, Analyzer analyzer, InputStream input, PrintStream out) {
    // PERF NOTE (known limitation): JDT's IMethodBinding resolution requires the declaring
    // class's CompilationUnit to be included in the ASTParser.createASTs() file list.
    // The sourcepath alone (setEnvironment's sourcepathEntries) resolves type-level references
    // (extends, implements, uses) but NOT method bindings — so "calls" edges are silently
    // dropped when the callee's file is absent from createASTs.
    //
    // Empirically verified: parsing only Foo.java with Bar.java on the sourcepath resolves
    // the "extends Bar" edge but loses the "calls Bar.helper" edge.
    //
    // Therefore each keep-alive request must analyze all project files to preserve "calls"
    // accuracy. This is O(project) JDT work per watch tick.
    //
    // Mitigation: the TS-side 30s per-request timeout already guards against hangs, falling
    // back to tree-sitter gracefully. For projects with 500+ Java files this will be slow;
    // the long-term fix is a persistent JDT environment (warm AST cache) that re-parses only
    // the changed file and merges binding results — left as a future optimisation.
    List<String> allFiles = discoverJavaFiles(root);
    JsonObject ready = new JsonObject();
    ready.addProperty("type", "ready");
    ready.addProperty("projectCount", 1);
    ready.addProperty("fileCount", allFiles.size());
    out.println(json(ready));
    // The plugin writes UTF-8; the platform charset (Cp1254 and the like on JRE 11-17) would garble non-ASCII paths.
    try (BufferedReader in = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
      String line;
      while ((line = in.readLine()) != null) {
        if (line.isBlank()) continue;
        try {
          JsonObject req = JsonParser.parseString(line).getAsJsonObject();
          String rel = req.get("file").getAsString();
          String abs = Paths.get(root).resolve(rel).toAbsolutePath().normalize().toString();
          // Re-discover project files on every tick so newly created files are included.
          // Also ensures the requested file is present even if it was just created.
          allFiles = discoverJavaFiles(root);
          List<String> filesToAnalyze = new ArrayList<>(allFiles);
          if (!filesToAnalyze.contains(abs)) filesToAnalyze.add(abs);
          // Emit a progress line so the caller can see that work is happening (and detect
          // stalls before the 30s timeout fires).
          progress(out, "reindex " + rel + " (analyzing " + filesToAnalyze.size() + " files; cross-file calls require full parse)");
          List<Dtos.FileResult> r = analyzer.analyze(filesToAnalyze);
          String normRel = rel.replace('\\', '/');
          Dtos.FileResult target = r.stream().filter(fr -> fr.file.equals(normRel)).findFirst()
              .orElse(new Dtos.FileResult(normRel));
          out.println(json(target));
        } catch (Exception e) { err("keep-alive error: " + e.getMessage()); }
      }
    } catch (IOException e) { err("stdin closed: " + e.getMessage()); }
  }

  /**
   * Every .java file under the project root, test sources such as src/test/java included;
   * build and tool folders are skipped. Package-private for the tests.
   */
  static List<String> discoverJavaFiles(String root) {
    Set<String> skip = Set.of("target", "build", ".git", "node_modules", ".gradle", "bin", "out");
    try (var s = Files.walk(Paths.get(root))) {
      return s.filter(p -> p.toString().endsWith(".java"))
              .filter(p -> { for (Path part : Paths.get(root).relativize(p)) if (skip.contains(part.toString())) return false; return true; })
              .map(Path::toString).collect(Collectors.toList());
    } catch (IOException e) { err("discover failed: " + e.getMessage()); return List.of(); }
  }

  /**
   * One JSONL line with every non-ASCII character as a JSON unicode escape (a backslash, {@code u}
   * and four hex digits; a surrogate pair takes two). stdout uses the
   * platform encoding (Cp1252, Cp1254 and the like on Windows) while the plugin reads UTF-8, so
   * annotation values, names and paths outside ASCII would otherwise reach the index garbled.
   * Gson writes non-ASCII characters only inside strings, so the escaped line is the same JSON.
   */
  static String json(Object value) {
    String text = GSON.toJson(value);
    StringBuilder out = null;
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (c < 0x80) {
        if (out != null) out.append(c);
        continue;
      }
      if (out == null) out = new StringBuilder(text.length() + 16).append(text, 0, i);
      out.append("\\u").append(HEX[(c >> 12) & 0xF]).append(HEX[(c >> 8) & 0xF])
          .append(HEX[(c >> 4) & 0xF]).append(HEX[c & 0xF]);
    }
    return out == null ? text : out.toString();
  }

  private static String[] splitPath(String v) {
    return Arrays.stream(v.split("[;" + File.pathSeparator + "]")).filter(s -> !s.isBlank()).toArray(String[]::new);
  }
  private static void progress(PrintStream out, String msg) {
    JsonObject o = new JsonObject(); o.addProperty("type", "progress"); o.addProperty("message", msg);
    out.println(json(o));
  }
  private static void err(String msg) { System.err.println("[ctxo-jdt-analyzer] " + msg); }
}
