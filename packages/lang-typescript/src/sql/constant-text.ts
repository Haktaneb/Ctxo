import { Node, SyntaxKind, VariableDeclarationKind, type TaggedTemplateExpression } from 'ts-morph';
import { isRelativeSpecifier, type ModuleResolver } from './module-resolver.js';
import { WalkState, declarationOf, exportOf, importBindingOf, unwrapExpression } from './declarations.js';

/**
 * The compile-time constant string an expression evaluates to, or undefined (spec 8A.2, designer call 7).
 * At most 8 declaration steps, never the same declaration twice.
 *
 * - string literal, template without substitutions: its value
 * - template with substitutions: every substitution constant, joined with the literal parts
 * - `a + b`: both sides constant
 * - parentheses, `as`, `satisfies`, `<T>` assertions and `!`: the inner expression
 * - identifier of a `const` declaration with an initializer, in the same file or behind a relative import
 *   (resolved through the resolver, following re-exports): the initializer's constant
 * - anything else: undefined
 */
export function constantText(expr: Node, resolver: ModuleResolver): string | undefined {
  return textOf(expr, resolver, new WalkState());
}

/** A tagged template's text with each `${...}` replaced by `@p0`, `@p1`, ... in order. */
export function taggedTemplateText(template: TaggedTemplateExpression): string {
  const literal = template.getTemplate();
  if (Node.isNoSubstitutionTemplateLiteral(literal)) return literal.getLiteralValue();
  let text = literal.getHead().getLiteralText();
  literal.getTemplateSpans().forEach((span, i) => {
    text += `@p${i}${span.getLiteral().getLiteralText()}`;
  });
  return text;
}

function textOf(node: Node, resolver: ModuleResolver, state: WalkState): string | undefined {
  const expr = unwrapExpression(node, false);

  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) return expr.getLiteralValue();

  if (Node.isTemplateExpression(expr)) {
    let text = expr.getHead().getLiteralText();
    for (const span of expr.getTemplateSpans()) {
      const part = textOf(span.getExpression(), resolver, state);
      if (part === undefined) return undefined;
      text += part + span.getLiteral().getLiteralText();
    }
    return text;
  }

  if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const left = textOf(expr.getLeft(), resolver, state);
    if (left === undefined) return undefined;
    const right = textOf(expr.getRight(), resolver, state);
    return right === undefined ? undefined : left + right;
  }

  if (Node.isIdentifier(expr)) return textOfDeclaration(declarationOf(expr), resolver, state);
  return undefined;
}

function textOfDeclaration(declaration: Node | undefined, resolver: ModuleResolver, state: WalkState): string | undefined {
  if (!declaration || !state.enter(declaration)) return undefined;

  const binding = importBindingOf(declaration);
  if (binding) {
    if (!isRelativeSpecifier(binding.specifier) || binding.exportName === undefined) return undefined;
    const target = resolver.sourceFileFor(binding.file, binding.specifier);
    return target ? textOfDeclaration(exportOf(target, binding.exportName, resolver, state), resolver, state) : undefined;
  }

  if (Node.isVariableDeclaration(declaration)) {
    const list = declaration.getParent();
    if (!Node.isVariableDeclarationList(list) || list.getDeclarationKind() !== VariableDeclarationKind.Const) return undefined;
    if (!Node.isIdentifier(declaration.getNameNode())) return undefined;
    const initializer = declaration.getInitializer();
    return initializer ? textOf(initializer, resolver, state) : undefined;
  }

  if (Node.isExportAssignment(declaration)) return textOf(declaration.getExpression(), resolver, state);
  return undefined;
}
