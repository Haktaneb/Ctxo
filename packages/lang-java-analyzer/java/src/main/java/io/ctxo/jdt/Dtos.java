package io.ctxo.jdt;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Plain data carriers serialized to JSONL by Gson. Field names ARE the JSON keys. */
public final class Dtos {
  private Dtos() {}

  public static final class Sym {
    public String symbolId;
    public String name;
    public String kind;
    public int startLine;
    public int endLine;
    public Integer startOffset;
    public Integer endOffset;
    /** Annotations in source order; null when there are none, so Gson omits the key. */
    public List<Ann> annotations;
    public Sym(String symbolId, String name, String kind, int startLine, int endLine, int startOffset, int endOffset) {
      this.symbolId = symbolId; this.name = name; this.kind = kind;
      this.startLine = startLine; this.endLine = endLine;
      this.startOffset = startOffset; this.endOffset = endOffset;
    }
  }

  /**
   * One Java annotation (protocol v2 {@code SymbolAnnotation}): the simple name, the {@code value}
   * member in {@code args}, the other members in {@code named} (a LinkedHashMap in source order).
   * {@code args} and {@code named} are null when empty, so Gson omits them.
   */
  public static final class Ann {
    public String name;
    public List<String> args;
    public Map<String, String> named;
    public Ann(String name, List<String> args, Map<String, String> named) {
      this.name = name; this.args = args; this.named = named;
    }
  }

  public static final class Edge {
    public String from;
    public String to;
    public String kind;
    public Edge(String from, String to, String kind) { this.from = from; this.to = to; this.kind = kind; }
  }

  /**
   * Raw SQL text at a known call site or on a known annotation ({@code --sql-call-sites}). The
   * plugin turns it into data edges with {@code @ctxo/sql-extract}. {@code line} is 0-based and
   * points at the text; {@code kind} is {@code statement}, or {@code procedureName} when the text
   * is a JDBC call escape ({@code text} is then the procedure name).
   */
  public static final class SqlSite {
    public String symbolId;
    public int line;
    public String text;
    public String kind;
    public SqlSite(String symbolId, int line, String text, String kind) {
      this.symbolId = symbolId; this.line = line; this.text = text; this.kind = kind;
    }
  }

  /** SQL texts found at known call sites in one analysis run, as the batch {@code done} line reports them. */
  public static final class SqlStats {
    /** Texts that are compile-time constants (each has a {@link SqlSite}). */
    public int constant;
    /** Texts that are not (built at runtime, a parameter, a non-final field). */
    public int nonConstant;
  }

  public static final class FileResult {
    public String type = "file";
    public String file;
    public List<Sym> symbols = new ArrayList<>();
    public List<Edge> edges = new ArrayList<>();
    public List<Object> complexity = new ArrayList<>();
    /**
     * Sorted by line, then text; null when the file has none or without {@code --sql-call-sites},
     * so Gson omits the key.
     */
    public List<SqlSite> sqlCallSites;
    public FileResult(String file) { this.file = file; }
  }
}
