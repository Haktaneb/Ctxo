import { Node, SyntaxKind, VariableDeclarationKind, type TaggedTemplateExpression } from 'ts-morph';
import { isRelativeSpecifier, type ModuleResolver } from './module-resolver.js';
import { WalkState, declarationOf, exportOf, importBindingOf, unwrapExpression } from './declarations.js';

/**
 * The compile-time constant string an expression evaluates to, or undefined (spec 8A.2, designer call 7).
 * At most 8 declaration steps; a declaration costs a step on its first visit only, so the same constant may
 * appear several times in one expression, and a declaration that depends on itself has no text.
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
  return textOf(expr, resolver, new ConstantWalk());
}

/** One evaluation: the step budget, each declaration's text once known, and the declarations being evaluated. */
class ConstantWalk {
  readonly state = new WalkState();
  readonly memo = new Map<Node, string | undefined>();
  readonly inProgress = new Set<Node>();
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

function textOf(node: Node, resolver: ModuleResolver, walk: ConstantWalk): string | undefined {
  const expr = unwrapExpression(node, false);

  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) return expr.getLiteralValue();

  if (Node.isTemplateExpression(expr)) {
    let text = expr.getHead().getLiteralText();
    for (const span of expr.getTemplateSpans()) {
      const part = textOf(span.getExpression(), resolver, walk);
      if (part === undefined) return undefined;
      text += part + span.getLiteral().getLiteralText();
    }
    return text;
  }

  if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const left = textOf(expr.getLeft(), resolver, walk);
    if (left === undefined) return undefined;
    const right = textOf(expr.getRight(), resolver, walk);
    return right === undefined ? undefined : left + right;
  }

  if (Node.isIdentifier(expr)) return textOfDeclaration(declarationOf(expr), resolver, walk);
  return undefined;
}

/** A declaration's text, computed once per walk; a declaration met again while it is evaluated has none. */
function textOfDeclaration(declaration: Node | undefined, resolver: ModuleResolver, walk: ConstantWalk): string | undefined {
  if (!declaration) return undefined;
  if (walk.memo.has(declaration)) return walk.memo.get(declaration);
  if (walk.inProgress.has(declaration) || !walk.state.charge(declaration)) return undefined;

  walk.inProgress.add(declaration);
  const text = evaluateDeclaration(declaration, resolver, walk);
  walk.inProgress.delete(declaration);
  walk.memo.set(declaration, text);
  return text;
}

function evaluateDeclaration(declaration: Node, resolver: ModuleResolver, walk: ConstantWalk): string | undefined {
  const binding = importBindingOf(declaration);
  if (binding) {
    if (!isRelativeSpecifier(binding.specifier) || binding.exportName === undefined) return undefined;
    const target = resolver.sourceFileFor(binding.file, binding.specifier);
    return target ? textOfDeclaration(exportOf(target, binding.exportName, resolver, walk.state), resolver, walk) : undefined;
  }

  if (Node.isVariableDeclaration(declaration)) {
    const list = declaration.getParent();
    if (!Node.isVariableDeclarationList(list) || list.getDeclarationKind() !== VariableDeclarationKind.Const) return undefined;
    if (!Node.isIdentifier(declaration.getNameNode())) return undefined;
    const initializer = declaration.getInitializer();
    return initializer ? textOf(initializer, resolver, walk) : undefined;
  }

  if (Node.isExportAssignment(declaration)) return textOf(declaration.getExpression(), resolver, walk);
  return undefined;
}
