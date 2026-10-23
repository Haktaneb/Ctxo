package io.ctxo.jdt;

import org.eclipse.jdt.core.dom.*;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds the SQL text at the {@link KnownSqlApis} call sites and annotations of one method or
 * constructor body ({@code --sql-call-sites}).
 *
 * <p>A call matches when a row lists its member for the receiver's static type, the method
 * binding's declaring class or any of their supertypes. Without a binding (the dependency is not
 * on the classpath) the receiver's declared type is read from its field, local variable or
 * parameter declaration in the same compilation unit and resolved through the single-type
 * imports or the same package; annotation types resolve through the binding, else the same way.
 *
 * <p>The text is the first argument, and every argument of an all-String {@code batchUpdate}.
 * With a method binding, a member whose first parameter is not {@code java.lang.String} is no
 * call site and is not counted; without one, the argument's own type decides. Only
 * compile-time constants (JDT constant evaluation: literals, {@code static final} fields,
 * concatenation, text blocks) give a {@link Dtos.SqlSite}; every other text counts as
 * non-constant. A JDBC call escape ({@code {call name(...)}} or {@code {? = call name(...)}})
 * gives a {@code procedureName} site with the procedure name.
 */
final class SqlCallSites {
  static final String STATEMENT = "statement";
  static final String PROCEDURE_NAME = "procedureName";
  private static final String STRING = "java.lang.String";
  private static final String VALUE = "value";
  private static final String NATIVE_QUERY = "nativeQuery";
  private static final Pattern CALL_ESCAPE = Pattern.compile(
      "^\\s*\\{\\s*(?:\\?\\s*=\\s*)?call\\s+([^\\s(}]+)\\s*(?:\\(.*\\))?\\s*\\}\\s*$",
      Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

  private SqlCallSites() {}

  /** Adds the site (or sites) of one invocation inside the body of {@code symbolId}. */
  static void fromInvocation(
      MethodInvocation node, String symbolId, CompilationUnit cu, Dtos.SqlStats stats, List<Dtos.SqlSite> out) {
    String member = node.getName().getIdentifier();
    if (!KnownSqlApis.anyCallMember(member)) return;
    List<Expression> texts;
    try {
      texts = texts(node, member, cu);
    } catch (RuntimeException e) {
      return; // malformed or half-recovered code: no site
    }
    for (Expression text : texts) add(constantText(text), text.getStartPosition(), symbolId, cu, stats, out);
  }

  /** Adds the sites of the SQL annotations on one method ({@code @Query} with nativeQuery, MyBatis). */
  static void fromAnnotations(
      MethodDeclaration node, String symbolId, CompilationUnit cu, Dtos.SqlStats stats, List<Dtos.SqlSite> out) {
    for (Object modifier : node.modifiers()) {
      if (!(modifier instanceof Annotation)) continue;
      Annotation annotation = (Annotation) modifier;
      Name typeName = annotation.getTypeName();
      String simple = typeName.isQualifiedName()
          ? ((QualifiedName) typeName).getName().getIdentifier()
          : ((SimpleName) typeName).getIdentifier();
      if (!KnownSqlApis.anyAnnotation(simple)) continue;
      try {
        KnownSqlApis.AnnotationApi api = KnownSqlApis.findAnnotation(annotationType(annotation, cu));
        if (api == null) continue;
        Map<String, Expression> members = Annotations.syntaxMembers(annotation);
        if (api.nativeQueryOnly && !isTrue(members.get(NATIVE_QUERY))) continue;
        Expression value = members.get(VALUE);
        if (value == null) continue;
        if (value instanceof ArrayInitializer && ((ArrayInitializer) value).expressions().isEmpty()) continue;
        add(annotationText(value), value.getStartPosition(), symbolId, cu, stats, out);
      } catch (RuntimeException e) {
        // malformed or half-recovered code: no site
      }
    }
  }

  // ── Calls ──

  /** The argument expressions that hold SQL text; empty when the call is no known call site. */
  private static List<Expression> texts(MethodInvocation node, String member, CompilationUnit cu) {
    @SuppressWarnings("unchecked")
    List<Expression> args = node.arguments();
    if (args.isEmpty()) return List.of();
    Expression receiver = node.getExpression();
    IMethodBinding method = node.resolveMethodBinding();
    if (method != null && method.getDeclaringClass() != null && !method.getDeclaringClass().isRecovered()) {
      Set<String> owners = new HashSet<>();
      addTypeAndSupertypes(method.getDeclaringClass(), owners);
      if (receiver != null) addTypeAndSupertypes(receiver.resolveTypeBinding(), owners);
      if (KnownSqlApis.findCall(member, owners) == null) return List.of();
      return textsWithBinding(method, member, args);
    }
    if (KnownSqlApis.findCall(member, receiverTypes(receiver, cu)) == null) return List.of();
    return textsWithoutBinding(member, args);
  }

  private static List<Expression> textsWithBinding(IMethodBinding method, String member, List<Expression> args) {
    ITypeBinding[] parameters = method.getParameterTypes();
    if (parameters.length == 0) return List.of();
    if (member.equals(KnownSqlApis.ALL_STRING_ARGUMENTS) && method.isVarargs() && parameters.length == 1
        && parameters[0].isArray() && isString(parameters[0].getElementType())) {
      List<Expression> texts = new ArrayList<>();
      for (Expression arg : args) {
        ArrayInitializer elements = arg instanceof ArrayCreation ? ((ArrayCreation) arg).getInitializer() : null;
        if (elements == null) texts.add(arg);
        else for (Object element : elements.expressions()) texts.add((Expression) element);
      }
      return texts;
    }
    return isString(parameters[0]) ? List.of(args.get(0)) : List.of();
  }

  private static List<Expression> textsWithoutBinding(String member, List<Expression> args) {
    if (member.equals(KnownSqlApis.ALL_STRING_ARGUMENTS) && args.stream().allMatch(SqlCallSites::isStringTyped)) {
      return args;
    }
    return isStringTyped(args.get(0)) ? List.of(args.get(0)) : List.of();
  }

  /** True when the expression is a String: its type binding, or a String constant. */
  private static boolean isStringTyped(Expression expression) {
    if (expression.resolveConstantExpressionValue() instanceof String) return true;
    ITypeBinding type = expression.resolveTypeBinding();
    return type != null && !type.isRecovered() && isString(type);
  }

  private static boolean isString(ITypeBinding type) {
    return type != null && STRING.equals(type.getErasure().getQualifiedName());
  }

  /** Every type the receiver may be, by qualified name; empty when nothing is known. */
  private static Set<String> receiverTypes(Expression receiver, CompilationUnit cu) {
    Set<String> owners = new HashSet<>();
    if (receiver == null) return owners;
    ITypeBinding type = receiver.resolveTypeBinding();
    if (type != null && !type.isRecovered()) {
      addTypeAndSupertypes(type, owners);
      return owners;
    }
    String declared = qualifiedName(declaredType(receiver, cu), cu);
    if (declared != null) owners.add(declared);
    return owners;
  }

  private static void addTypeAndSupertypes(ITypeBinding type, Set<String> out) {
    if (type == null || type.isRecovered()) return;
    ITypeBinding erasure = type.getErasure();
    if (!out.add(erasure.getQualifiedName())) return;
    addTypeAndSupertypes(erasure.getSuperclass(), out);
    for (ITypeBinding superInterface : erasure.getInterfaces()) addTypeAndSupertypes(superInterface, out);
  }

  /** The declared type of a variable receiver ({@code name} or {@code this.name}); null otherwise. */
  private static Type declaredType(Expression receiver, CompilationUnit cu) {
    while (receiver instanceof ParenthesizedExpression) receiver = ((ParenthesizedExpression) receiver).getExpression();
    SimpleName name = null;
    if (receiver instanceof SimpleName) name = (SimpleName) receiver;
    else if (receiver instanceof FieldAccess && ((FieldAccess) receiver).getExpression() instanceof ThisExpression) {
      name = ((FieldAccess) receiver).getName();
    }
    if (name == null) return null;
    IBinding binding = name.resolveBinding();
    if (!(binding instanceof IVariableBinding)) return null;
    ASTNode declaration = cu.findDeclaringNode(binding);
    if (declaration instanceof SingleVariableDeclaration) {
      SingleVariableDeclaration parameter = (SingleVariableDeclaration) declaration;
      return parameter.isVarargs() || parameter.getExtraDimensions() > 0 ? null : parameter.getType();
    }
    if (!(declaration instanceof VariableDeclarationFragment)) return null;
    if (((VariableDeclarationFragment) declaration).getExtraDimensions() > 0) return null;
    ASTNode parent = declaration.getParent();
    if (parent instanceof FieldDeclaration) return ((FieldDeclaration) parent).getType();
    if (parent instanceof VariableDeclarationStatement) return ((VariableDeclarationStatement) parent).getType();
    if (parent instanceof VariableDeclarationExpression) return ((VariableDeclarationExpression) parent).getType();
    return null;
  }

  // ── Annotations ──

  /** The qualified name of an annotation type: the binding, else the imports or the same package. */
  private static String annotationType(Annotation annotation, CompilationUnit cu) {
    IAnnotationBinding binding = annotation.resolveAnnotationBinding();
    ITypeBinding type = binding == null ? null : binding.getAnnotationType();
    if (type != null && !type.isRecovered()) return type.getErasure().getQualifiedName();
    return resolve(annotation.getTypeName().getFullyQualifiedName(), cu);
  }

  private static boolean isTrue(Expression expression) {
    if (expression == null) return false;
    if (Boolean.TRUE.equals(expression.resolveConstantExpressionValue())) return true;
    return expression instanceof BooleanLiteral && ((BooleanLiteral) expression).booleanValue();
  }

  /** A constant value, or the constant elements of an array joined with one space; null otherwise. */
  private static String annotationText(Expression value) {
    if (!(value instanceof ArrayInitializer)) return constantText(value);
    StringJoiner joined = new StringJoiner(" ");
    for (Object element : ((ArrayInitializer) value).expressions()) {
      String text = constantText((Expression) element);
      if (text == null) return null;
      joined.add(text);
    }
    return joined.toString();
  }

  // ── Names ──

  /** The written name of a class or interface type, resolved to a qualified name; null for other types. */
  private static String qualifiedName(Type type, CompilationUnit cu) {
    if (type == null) return null;
    if (type.isParameterizedType()) return qualifiedName(((ParameterizedType) type).getType(), cu);
    if (type.isSimpleType()) return resolve(((SimpleType) type).getName().getFullyQualifiedName(), cu);
    if (type.isQualifiedType() || type.isNameQualifiedType()) return resolve(type.toString(), cu);
    return null;
  }

  /**
   * A written type name as a qualified name: its first segment through the single-type imports,
   * else a simple name in the compilation unit's package; a dotted name that matches no import is
   * taken as already qualified.
   */
  private static String resolve(String written, CompilationUnit cu) {
    int dot = written.indexOf('.');
    String first = dot < 0 ? written : written.substring(0, dot);
    for (Object o : cu.imports()) {
      ImportDeclaration imp = (ImportDeclaration) o;
      if (imp.isStatic() || imp.isOnDemand()) continue;
      String imported = imp.getName().getFullyQualifiedName();
      String last = imported.substring(imported.lastIndexOf('.') + 1);
      if (last.equals(first)) return imported + (dot < 0 ? "" : written.substring(dot));
    }
    if (dot >= 0) return written;
    PackageDeclaration pkg = cu.getPackage();
    return pkg == null ? written : pkg.getName().getFullyQualifiedName() + "." + written;
  }

  // ── Text ──

  /** The constant String value of an expression (JDT constant evaluation); null when it has none. */
  private static String constantText(Expression expression) {
    Object value = expression.resolveConstantExpressionValue();
    return value instanceof String ? (String) value : null;
  }

  private static void add(
      String text, int position, String symbolId, CompilationUnit cu, Dtos.SqlStats stats, List<Dtos.SqlSite> out) {
    if (text == null) {
      stats.nonConstant++;
      return;
    }
    stats.constant++;
    int line = Math.max(0, cu.getLineNumber(position) - 1);
    Matcher call = CALL_ESCAPE.matcher(text);
    out.add(call.matches()
        ? new Dtos.SqlSite(symbolId, line, call.group(1), PROCEDURE_NAME)
        : new Dtos.SqlSite(symbolId, line, text, STATEMENT));
  }
}
