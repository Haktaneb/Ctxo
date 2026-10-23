package io.ctxo.jdt;

import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.dom.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

/** Runs JDT batch analysis over a set of source files and emits FileResults. */
public final class Analyzer {
  private static final String SOURCE_ENCODING = "UTF-8";

  /** The fact evidence collector of one compilation unit ({@link FactEvidence#collect}). */
  @FunctionalInterface
  interface FactCollector {
    void collect(CompilationUnit cu, String source, String file, Dtos.FactOptions options, List<Dtos.Evidence> out);
  }

  /** {@link FactEvidence#collect}; a test seam, so a collector failure can be simulated. */
  static volatile FactCollector factCollector = FactEvidence::collect;
  private final String rootDir;
  private final String[] classpath;
  private final boolean sqlCallSites;
  private final Dtos.FactOptions facts;
  private Dtos.SqlStats sqlStats;

  public Analyzer(String rootDir, String[] classpath) {
    this(rootDir, classpath, false);
  }

  /** With {@code sqlCallSites}, file results carry the SQL text at known call sites ({@link SqlCallSites}). */
  public Analyzer(String rootDir, String[] classpath, boolean sqlCallSites) {
    this(rootDir, classpath, sqlCallSites, null);
  }

  /**
   * With {@code facts} (the {@code --facts=} options), file results also carry fact evidence
   * ({@link FactEvidence}); null leaves the output exactly as without facts.
   */
  public Analyzer(String rootDir, String[] classpath, boolean sqlCallSites, Dtos.FactOptions facts) {
    this.rootDir = rootDir;
    this.classpath = classpath;
    this.sqlCallSites = sqlCallSites;
    this.sqlStats = sqlCallSites ? new Dtos.SqlStats() : null;
    this.facts = facts;
  }

  /**
   * The SQL texts of the last {@link #analyze} run (each run starts from zero, so a keep-alive
   * tick that re-analyzes every file does not add up); null without {@code sqlCallSites}.
   */
  public Dtos.SqlStats sqlStats() {
    return sqlStats;
  }

  /** True when the analyzer collects fact evidence ({@code --facts=} was parsed). */
  public boolean factsEnabled() {
    return facts != null;
  }

  public List<Dtos.FileResult> analyze(List<String> sourceFiles) {
    if (sqlCallSites) sqlStats = new Dtos.SqlStats();
    Map<String, Dtos.FileResult> byPath = new LinkedHashMap<>();
    ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
    parser.setKind(ASTParser.K_COMPILATION_UNIT);
    parser.setResolveBindings(true);
    parser.setBindingsRecovery(true);
    parser.setStatementsRecovery(true);
    Map<String, String> options = JavaCore.getOptions();
    JavaCore.setComplianceOptions(JavaCore.VERSION_17, options);
    parser.setCompilerOptions(options);
    // Sources are read as UTF-8: without an encoding JDT uses the platform default (Cp1252, Cp1254
    // and the like on JRE 11-17 on Windows) and misreads non-ASCII literals such as SQL table names.
    parser.setEnvironment(classpath, new String[] { rootDir }, new String[] { SOURCE_ENCODING }, true);

    String[] files = sourceFiles.toArray(new String[0]);
    String[] encodings = new String[files.length];
    Arrays.fill(encodings, SOURCE_ENCODING);
    FileASTRequestor requestor = new FileASTRequestor() {
      @Override public void acceptAST(String sourceFilePath, CompilationUnit cu) {
        String rel = relativize(sourceFilePath);
        Dtos.FileResult fr = new Dtos.FileResult(rel);
        List<Dtos.SqlSite> sites = sqlCallSites ? new ArrayList<>() : null;
        cu.accept(new EmitVisitor(cu, rel, fr, sites));
        if (sites != null && !sites.isEmpty()) {
          sites.sort(SQL_SITE_ORDER);
          fr.sqlCallSites = sites;
        }
        if (facts != null) {
          String source = sourceOf(sourceFilePath, cu);
          List<Dtos.Evidence> evidence = new ArrayList<>();
          try {
            if (source != null) factCollector.collect(cu, source, rel, facts, evidence);
          } catch (RuntimeException | StackOverflowError e) {
            // The file keeps its symbols and edges; only its (possibly partial) evidence is dropped.
            evidence.clear();
            System.err.println("[ctxo-jdt-analyzer] fact evidence skipped for " + rel + ": " + e.getClass().getName());
          }
          if (!evidence.isEmpty()) fr.factEvidence = evidence;
        }
        // imports: anchor on the first top-level type symbol (JDT visits imports before types,
        // so this must run after the visitor has populated symbols).
        String anchor = null;
        for (Dtos.Sym s : fr.symbols) {
          if (s.kind.equals("class") || s.kind.equals("interface") || s.kind.equals("type")) { anchor = s.symbolId; break; }
        }
        if (anchor != null) {
          for (Object o : cu.imports()) {
            org.eclipse.jdt.core.dom.ImportDeclaration imp = (org.eclipse.jdt.core.dom.ImportDeclaration) o;
            String fq = imp.getName().getFullyQualifiedName();
            if (imp.isStatic()) {
              // For static imports the FQN is either:
              //   import static a.b.C.member  (isOnDemand==false) -> owner = a.b.C
              //   import static a.b.C.*       (isOnDemand==true)  -> fq is already a.b.C
              String ownerFq = (!imp.isOnDemand() && fq.contains("."))
                  ? fq.substring(0, fq.lastIndexOf('.'))
                  : fq;
              String ownerSimple = ownerFq.contains(".") ? ownerFq.substring(ownerFq.lastIndexOf('.') + 1) : ownerFq;
              fr.edges.add(new Dtos.Edge(anchor, ownerFq + "::" + ownerSimple + "::class", "imports"));
            } else if (!imp.isOnDemand()) {
              // Regular single-type import: import a.b.C -> a.b.C::C::class
              String last = fq.contains(".") ? fq.substring(fq.lastIndexOf('.') + 1) : fq;
              fr.edges.add(new Dtos.Edge(anchor, fq + "::" + last + "::class", "imports"));
            }
            // Regular on-demand import (import a.b.*): fq is a package, not a type — skip.
          }
        }
        byPath.put(rel, fr);
      }
    };
    parser.createASTs(files, encodings, new String[0], requestor, null);
    return new ArrayList<>(byPath.values());
  }

  /**
   * The text JDT parsed (UTF-8, as {@code setEnvironment} reads it), so node offsets index into it;
   * a byte order mark JDT skipped is dropped. Null when unreadable or when the offsets do not fit.
   */
  private static String sourceOf(String path, CompilationUnit cu) {
    try {
      String source = new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
      int end = cu.getStartPosition() + cu.getLength();
      if (source.startsWith("\uFEFF") && end < source.length()) source = source.substring(1);
      return end <= source.length() ? source : null;
    } catch (IOException | RuntimeException e) {
      return null;
    }
  }

  private String relativize(String absSourcePath) {
    try {
      Path root = Paths.get(rootDir).toAbsolutePath().normalize();
      Path p = Paths.get(absSourcePath).toAbsolutePath().normalize();
      return root.relativize(p).toString().replace('\\', '/');
    } catch (Exception e) { return absSourcePath.replace('\\', '/'); }
  }

  /** By line, then text (symbol and kind break the remaining ties, so the order never depends on the walk). */
  private static final Comparator<Dtos.SqlSite> SQL_SITE_ORDER = Comparator
      .comparingInt((Dtos.SqlSite s) -> s.line)
      .thenComparing(s -> s.text)
      .thenComparing(s -> s.symbolId)
      .thenComparing(s -> s.kind);

  private final class EmitVisitor extends ASTVisitor {
    private final CompilationUnit cu;
    private final String file;
    private final Dtos.FileResult out;
    /** The SQL call sites of the file; null without {@code sqlCallSites}. */
    private final List<Dtos.SqlSite> sqlSites;
    private String enclosingTypeId;
    /**
     * The method or constructor whose body is being visited (lambdas inside it included); null in
     * field initializers, initializer blocks and outside any member. Saved per body declaration.
     */
    private String enclosingMethodId;
    private final List<String> savedMethodIds = new ArrayList<>();

    EmitVisitor(CompilationUnit cu, String file, Dtos.FileResult out, List<Dtos.SqlSite> sqlSites) {
      this.cu = cu; this.file = file; this.out = out; this.sqlSites = sqlSites;
    }

    private void enterMember(String methodId) {
      savedMethodIds.add(enclosingMethodId);
      enclosingMethodId = methodId;
    }

    private void leaveMember() {
      enclosingMethodId = savedMethodIds.remove(savedMethodIds.size() - 1);
    }

    private int line0(int pos) { return Math.max(0, cu.getLineNumber(pos) - 1); }
    private String symId(String name, String kind) { return file + "::" + name + "::" + kind; }
    private void addType(String name, String kind, AbstractTypeDeclaration node) {
      Dtos.Sym sym = new Dtos.Sym(symId(name, kind), name, kind,
          line0(node.getStartPosition()), line0(node.getStartPosition() + node.getLength()),
          node.getStartPosition(), node.getStartPosition() + node.getLength());
      sym.annotations = Annotations.of(node.modifiers());
      out.symbols.add(sym);
    }

    @Override public boolean visit(TypeDeclaration node) {
      String name = node.getName().getIdentifier();
      String kind = node.isInterface() ? "interface" : "class";
      addType(name, kind, node);
      String prev = enclosingTypeId; enclosingTypeId = symId(name, kind);
      Type sc = node.getSuperclassType();
      if (sc != null) out.edges.add(new Dtos.Edge(enclosingTypeId, typeId(sc, "class"), "extends"));
      for (Object o : node.superInterfaceTypes()) {
        String ek = kind.equals("interface") ? "extends" : "implements";
        out.edges.add(new Dtos.Edge(enclosingTypeId, typeId((Type) o, "interface"), ek));
      }
      node.bodyDeclarations().forEach(b -> ((ASTNode) b).accept(this));
      enclosingTypeId = prev;
      return false;
    }

    @Override public boolean visit(EnumDeclaration node) {
      String name = node.getName().getIdentifier();
      addType(name, "type", node);
      String prev = enclosingTypeId; enclosingTypeId = symId(name, "type");
      for (Object o : node.superInterfaceTypes())
        out.edges.add(new Dtos.Edge(enclosingTypeId, typeId((Type) o, "interface"), "implements"));
      node.bodyDeclarations().forEach(b -> ((ASTNode) b).accept(this));
      enclosingTypeId = prev;
      return false;
    }

    @Override public boolean visit(RecordDeclaration node) {
      String name = node.getName().getIdentifier();
      addType(name, "class", node);
      String prev = enclosingTypeId; enclosingTypeId = symId(name, "class");
      for (Object o : node.superInterfaceTypes())
        out.edges.add(new Dtos.Edge(enclosingTypeId, typeId((Type) o, "interface"), "implements"));
      node.bodyDeclarations().forEach(b -> ((ASTNode) b).accept(this));
      enclosingTypeId = prev;
      return false;
    }

    @Override public boolean visit(AnnotationTypeDeclaration node) {
      String name = node.getName().getIdentifier();
      addType(name, "interface", node);
      String prev = enclosingTypeId; enclosingTypeId = symId(name, "interface");
      node.bodyDeclarations().forEach(b -> ((ASTNode) b).accept(this));
      enclosingTypeId = prev;
      return false;
    }

    @Override public boolean visit(MethodDeclaration node) {
      String name = node.getName().getIdentifier();
      Dtos.Sym sym = new Dtos.Sym(symId(name, "method"), name, "method",
          line0(node.getStartPosition()), line0(node.getStartPosition() + node.getLength()),
          node.getStartPosition(), node.getStartPosition() + node.getLength());
      sym.annotations = Annotations.of(node.modifiers());
      out.symbols.add(sym);
      if (node.getReturnType2() != null) addUses(node.getReturnType2());
      enterMember(sym.symbolId);
      if (sqlSites != null) SqlCallSites.fromAnnotations(node, sym.symbolId, cu, sqlStats, sqlSites);
      return true;
    }

    @Override public void endVisit(MethodDeclaration node) {
      leaveMember();
    }

    @Override public boolean visit(Initializer node) {
      enterMember(null);
      return true;
    }

    @Override public void endVisit(Initializer node) {
      leaveMember();
    }

    @Override public boolean visit(FieldDeclaration node) {
      enterMember(null);
      // Every fragment (`int a, b;`) gets the declaration's annotations.
      List<Dtos.Ann> annotations = Annotations.of(node.modifiers());
      for (Object o : node.fragments()) {
        VariableDeclarationFragment f = (VariableDeclarationFragment) o;
        String name = f.getName().getIdentifier();
        Dtos.Sym sym = new Dtos.Sym(symId(name, "variable"), name, "variable",
            line0(node.getStartPosition()), line0(node.getStartPosition() + node.getLength()),
            node.getStartPosition(), node.getStartPosition() + node.getLength());
        sym.annotations = annotations;
        out.symbols.add(sym);
      }
      addUses(node.getType());
      return true;
    }

    @Override public void endVisit(FieldDeclaration node) {
      leaveMember();
    }

    @Override public boolean visit(SingleVariableDeclaration node) {
      addUses(node.getType());
      return true;
    }

    private void addUses(Type t) {
      if (enclosingTypeId == null || t == null) return;
      collectTypeUses(t);
    }

    private void collectTypeUses(Type t) {
      if (t == null) return;
      if (t.isParameterizedType()) {
        ParameterizedType pt = (ParameterizedType) t;
        collectTypeUses(pt.getType());
        for (Object a : pt.typeArguments()) collectTypeUses((Type) a);
      } else if (t.isArrayType()) {
        collectTypeUses(((ArrayType) t).getElementType());
      } else if (t.isWildcardType()) {
        Type bound = ((WildcardType) t).getBound();
        if (bound != null) collectTypeUses(bound);
      } else if (t.isSimpleType() || t.isQualifiedType() || t.isNameQualifiedType()) {
        if (!isPrimitiveOrJavaLang(t)) out.edges.add(new Dtos.Edge(enclosingTypeId, typeId(t, "class"), "uses"));
      }
    }

    private boolean isPrimitiveOrJavaLang(Type t) {
      ITypeBinding b = t.resolveBinding();
      if (b == null) return false;
      if (b.isPrimitive()) return true;
      String pkg = b.getPackage() == null ? "" : b.getPackage().getName();
      return pkg.equals("java.lang");
    }

    @Override public boolean visit(MethodInvocation node) {
      if (sqlSites != null && enclosingMethodId != null) {
        SqlCallSites.fromInvocation(node, enclosingMethodId, cu, sqlStats, sqlSites);
      }
      if (enclosingTypeId == null) return true;
      IMethodBinding mb = node.resolveMethodBinding();
      if (mb != null && mb.getDeclaringClass() != null) {
        String decl = mb.getDeclaringClass().getQualifiedName();
        out.edges.add(new Dtos.Edge(enclosingTypeId, decl + "::" + mb.getName() + "::method", "calls"));
      }
      return true;
    }

    @Override public boolean visit(ClassInstanceCreation node) {
      if (enclosingTypeId == null) return true;
      IMethodBinding ctor = node.resolveConstructorBinding();
      if (ctor != null && ctor.getDeclaringClass() != null) {
        String decl = ctor.getDeclaringClass().getQualifiedName();
        String simple = decl.contains(".") ? decl.substring(decl.lastIndexOf('.') + 1) : decl;
        out.edges.add(new Dtos.Edge(enclosingTypeId, decl + "::" + simple + "::method", "calls"));
        out.edges.add(new Dtos.Edge(enclosingTypeId, simple + "::class", "uses"));
      }
      return true;
    }

    private String typeId(Type t, String fallbackKind) {
      ITypeBinding b = t.resolveBinding();
      if (b != null) {
        String qn = b.getQualifiedName();
        int lt = qn.indexOf('<'); if (lt >= 0) qn = qn.substring(0, lt);
        String last = qn.contains(".") ? qn.substring(qn.lastIndexOf('.') + 1) : qn;
        return last + "::" + fallbackKind;
      }
      String s = t.toString();
      int lt2 = s.indexOf('<'); if (lt2 >= 0) s = s.substring(0, lt2);
      String last = s.contains(".") ? s.substring(s.lastIndexOf('.') + 1) : s;
      return last + "::" + fallbackKind;
    }
  }
}
