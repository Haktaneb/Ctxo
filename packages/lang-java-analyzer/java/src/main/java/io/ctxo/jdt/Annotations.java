package io.ctxo.jdt;

import org.eclipse.jdt.core.dom.*;

import java.util.*;

/**
 * Turns the annotations written on one declaration into protocol v2 annotations.
 *
 * <p>A resolved annotation type gives its declared member values (no defaults) in source order;
 * otherwise the syntax is read, with JDT constant evaluation and then the literal nodes as
 * written, so annotations survive a missing classpath. The {@code value} member (shorthand or
 * explicit) goes to {@code args}, every other member to {@code named}. Strings stay as they are,
 * numbers go through {@code String.valueOf}, booleans become {@code true} or {@code false}, enum
 * constants {@code Type.MEMBER} and class literals the qualified name (as written when
 * unresolved). Arrays are flattened in {@code args} and joined with {@code ,} in {@code named};
 * nested annotations and nulls are skipped.
 *
 * <p>Caps, as in C#: 20 annotations per symbol, 10 {@code args}, 10 {@code named} entries and
 * 200 characters per value. {@code named.type} is reserved in every language, so a member named
 * {@code type} is dropped and never counts toward the 10 entries.
 */
final class Annotations {
  static final int MAX_ANNOTATIONS = 20;
  static final int MAX_ENTRIES = 10;
  static final int MAX_VALUE_LENGTH = 200;
  private static final String VALUE = "value";
  private static final String RESERVED_TYPE = "type";

  private Annotations() {}

  /** The annotations among a {@code BodyDeclaration}'s {@code modifiers()}; null when there are none. */
  static List<Dtos.Ann> of(List<?> modifiers) {
    if (modifiers == null || modifiers.isEmpty()) return null;
    List<Dtos.Ann> out = new ArrayList<>();
    for (Object modifier : modifiers) {
      if (!(modifier instanceof Annotation)) continue;
      if (out.size() == MAX_ANNOTATIONS) break;
      out.add(toAnn((Annotation) modifier));
    }
    return out.isEmpty() ? null : out;
  }

  private static Dtos.Ann toAnn(Annotation annotation) {
    String name = simpleName(annotation.getTypeName());
    List<String> args = new ArrayList<>();
    Map<String, String> named = new LinkedHashMap<>();
    try {
      IAnnotationBinding binding = resolvedBinding(annotation);
      if (binding != null) fromBinding(binding, annotation, args, named);
      else fromSyntax(annotation, args, named);
    } catch (RuntimeException e) {
      // Malformed or half-recovered code: keep the name, drop the values.
      args.clear();
      named.clear();
    }
    List<String> cappedArgs = args.size() > MAX_ENTRIES ? new ArrayList<>(args.subList(0, MAX_ENTRIES)) : args;
    return new Dtos.Ann(name, cappedArgs.isEmpty() ? null : cappedArgs, named.isEmpty() ? null : named);
  }

  private static String simpleName(Name name) {
    return name.isQualifiedName() ? ((QualifiedName) name).getName().getIdentifier() : ((SimpleName) name).getIdentifier();
  }

  /** The binding when the annotation type resolves to a real annotation type; null otherwise. */
  private static IAnnotationBinding resolvedBinding(Annotation annotation) {
    IAnnotationBinding binding = annotation.resolveAnnotationBinding();
    if (binding == null) return null;
    ITypeBinding type = binding.getAnnotationType();
    if (type == null || type.isRecovered() || !type.isAnnotation()) return null;
    return binding;
  }

  private static void route(String member, List<String> values, List<String> args, Map<String, String> named) {
    if (VALUE.equals(member)) {
      args.addAll(values);
      return;
    }
    if (values.isEmpty() || RESERVED_TYPE.equals(member) || named.containsKey(member)) return;
    if (named.size() == MAX_ENTRIES) return;
    named.put(member, cut(String.join(",", values)));
  }

  // ── Resolved annotation type ──

  private static void fromBinding(
      IAnnotationBinding binding, Annotation annotation, List<String> args, Map<String, String> named) {
    Map<String, Expression> syntax = syntaxMembers(annotation);
    for (IMemberValuePairBinding pair : binding.getDeclaredMemberValuePairs()) {
      String member = pair.getName();
      List<String> values = new ArrayList<>();
      if (!addBindingValue(pair.getValue(), values) && syntax.containsKey(member)) {
        // A value the binding cannot name (a missing class literal type, say) is read as written.
        values.clear();
        addSyntaxValue(syntax.get(member), values);
      }
      route(member, values, args, named);
    }
  }

  /** Adds the formatted value; false when some part has no usable binding. */
  private static boolean addBindingValue(Object value, List<String> out) {
    if (value == null) return false;
    if (value instanceof Object[]) {
      boolean complete = true;
      for (Object element : (Object[]) value) complete &= addBindingValue(element, out);
      return complete;
    }
    if (value instanceof IAnnotationBinding) return true; // nested annotations are skipped
    if (value instanceof ITypeBinding) {
      ITypeBinding type = (ITypeBinding) value;
      if (type.isRecovered()) return false;
      out.add(cut(typeName(type)));
      return true;
    }
    if (value instanceof IVariableBinding) {
      IVariableBinding constant = (IVariableBinding) value;
      ITypeBinding owner = constant.getDeclaringClass();
      if (owner == null || owner.isRecovered()) return false;
      out.add(cut(owner.getName() + "." + constant.getName()));
      return true;
    }
    String scalar = scalar(value);
    if (scalar == null) return false;
    out.add(cut(scalar));
    return true;
  }

  // ── Unresolved annotation type: the syntax ──

  private static void fromSyntax(Annotation annotation, List<String> args, Map<String, String> named) {
    for (Map.Entry<String, Expression> member : syntaxMembers(annotation).entrySet()) {
      List<String> values = new ArrayList<>();
      addSyntaxValue(member.getValue(), values);
      route(member.getKey(), values, args, named);
    }
  }

  /** Member name to value expression, in source order; the first of two same-named members wins. */
  private static Map<String, Expression> syntaxMembers(Annotation annotation) {
    Map<String, Expression> members = new LinkedHashMap<>();
    if (annotation.isSingleMemberAnnotation()) {
      members.put(VALUE, ((SingleMemberAnnotation) annotation).getValue());
    } else if (annotation.isNormalAnnotation()) {
      for (Object o : ((NormalAnnotation) annotation).values()) {
        MemberValuePair pair = (MemberValuePair) o;
        members.putIfAbsent(pair.getName().getIdentifier(), pair.getValue());
      }
    }
    return members;
  }

  private static void addSyntaxValue(Expression expression, List<String> out) {
    if (expression == null) return;
    try {
      addSyntaxValueUnchecked(expression, out);
    } catch (RuntimeException e) {
      // A literal JDT cannot decode is skipped, like a null.
    }
  }

  private static void addSyntaxValueUnchecked(Expression expression, List<String> out) {
    if (expression instanceof ParenthesizedExpression) {
      addSyntaxValue(((ParenthesizedExpression) expression).getExpression(), out);
      return;
    }
    if (expression instanceof ArrayInitializer) {
      for (Object element : ((ArrayInitializer) expression).expressions()) addSyntaxValue((Expression) element, out);
      return;
    }
    if (expression instanceof Annotation || expression instanceof NullLiteral) return;
    if (expression instanceof TypeLiteral) {
      Type type = ((TypeLiteral) expression).getType();
      ITypeBinding binding = type.resolveBinding();
      out.add(cut(binding != null && !binding.isRecovered() ? typeName(binding) : type.toString()));
      return;
    }

    boolean isName = expression instanceof Name || expression instanceof FieldAccess;
    IBinding nameBinding = isName ? resolveNameBinding(expression) : null;
    if (nameBinding instanceof IVariableBinding && !nameBinding.isRecovered()) {
      IVariableBinding variable = (IVariableBinding) nameBinding;
      ITypeBinding owner = variable.getDeclaringClass();
      if (variable.isEnumConstant() && owner != null && !owner.isRecovered()) {
        out.add(cut(owner.getName() + "." + variable.getName()));
        return;
      }
    }

    Object constant = expression.resolveConstantExpressionValue();
    if (constant != null) {
      String scalar = scalar(constant);
      if (scalar != null) out.add(cut(scalar));
      return;
    }

    // The literal nodes, as written.
    if (expression instanceof StringLiteral) {
      out.add(cut(((StringLiteral) expression).getLiteralValue()));
    } else if (expression instanceof TextBlock) {
      out.add(cut(((TextBlock) expression).getLiteralValue()));
    } else if (expression instanceof NumberLiteral) {
      out.add(cut(((NumberLiteral) expression).getToken()));
    } else if (expression instanceof BooleanLiteral) {
      out.add(((BooleanLiteral) expression).booleanValue() ? "true" : "false");
    } else if (expression instanceof CharacterLiteral) {
      out.add(String.valueOf(((CharacterLiteral) expression).charValue()));
    } else if (expression instanceof PrefixExpression) {
      PrefixExpression prefix = (PrefixExpression) expression;
      PrefixExpression.Operator op = prefix.getOperator();
      if (prefix.getOperand() instanceof NumberLiteral
          && (op == PrefixExpression.Operator.MINUS || op == PrefixExpression.Operator.PLUS)) {
        out.add(cut(op.toString() + ((NumberLiteral) prefix.getOperand()).getToken()));
      }
    } else if (isName && (nameBinding == null || nameBinding.isRecovered())) {
      // An enum constant (or constant) whose type does not resolve: the name as written.
      out.add(cut(expression.toString()));
    }
  }

  private static IBinding resolveNameBinding(Expression expression) {
    if (expression instanceof Name) return ((Name) expression).resolveBinding();
    return ((FieldAccess) expression).resolveFieldBinding();
  }

  // ── Formatting ──

  private static String typeName(ITypeBinding type) {
    String qualified = type.getErasure().getQualifiedName();
    return qualified.isEmpty() ? type.getName() : qualified;
  }

  private static String scalar(Object value) {
    if (value instanceof String) return (String) value;
    if (value instanceof Boolean) return ((Boolean) value) ? "true" : "false";
    if (value instanceof Character) return String.valueOf((char) (Character) value);
    if (value instanceof Number) return String.valueOf(value);
    return null;
  }

  private static String cut(String value) {
    return value.length() > MAX_VALUE_LENGTH ? value.substring(0, MAX_VALUE_LENGTH) : value;
  }
}
