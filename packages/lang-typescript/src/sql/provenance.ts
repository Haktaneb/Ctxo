import { Node, SyntaxKind } from 'ts-morph';
import { packageOfSpecifier, tableModuleOf } from './known-sql-apis.js';
import { isRelativeSpecifier, type ModuleResolver } from './module-resolver.js';
import { WalkState, declarationOf, exportOf, importBindingOf, unwrapExpression } from './declarations.js';

/**
 * Receiver provenance: the known-API module an expression traces to, or undefined.
 *
 * A step is one hop from an identifier to its declaration or from an import binding to the export it names;
 * unwrapping parentheses, `await`, assertions and `!`, and following a call chain's receiver inside one
 * expression are free. At most 8 steps, never the same declaration twice.
 *
 * - identifier: its declaration. An import of a table module gives that module; a relative import continues
 *   at the same-named export of the resolved file, following re-exports. A variable or property gives its
 *   type annotation, else its initializer; a binding element the destructured initializer; a parameter
 *   (also a constructor parameter property) its type annotation; a class its extends expression; a function
 *   with a return type annotation that type.
 * - `this.x`: member x of the enclosing class (a property or a constructor parameter property); `this`
 *   alone: the enclosing class, so a subclass of a client traces through its extends clause.
 * - `a.b` and `a?.b`: the receiver `a`. A call: the `require` or dynamic `import` of a table module gives that
 *   module, any other call its callee. `new X(...)`: `X`.
 * - type reference: its leftmost identifier; `import` type of a table module: that module.
 * - anything else: undefined.
 *
 * `modules` is the set of packages the walk stops at (a specifier's package, as `packageOfSpecifier` gives it);
 * without it, the SQL table modules. The fact detectors pass the route modules.
 */
export function receiverModule(expr: Node, resolver: ModuleResolver, modules?: ReadonlySet<string>): string | undefined {
  const lookup: ModuleLookup = modules
    ? (specifier) => {
        const pkg = packageOfSpecifier(specifier);
        return modules.has(pkg) ? pkg : undefined;
      }
    : tableModuleOf;
  return moduleOfExpression(expr, resolver, new WalkState(), lookup);
}

/** The listed module a non-relative specifier belongs to, or undefined. */
type ModuleLookup = (specifier: string) => string | undefined;

function moduleOfExpression(node: Node, resolver: ModuleResolver, state: WalkState, lookup: ModuleLookup): string | undefined {
  const expr = unwrapExpression(node, true);

  if (Node.isIdentifier(expr)) return moduleOfDeclaration(declarationOf(expr), resolver, state, lookup);
  if (Node.isThisExpression(expr)) return moduleOfDeclaration(enclosingClass(expr), resolver, state, lookup);

  if (Node.isPropertyAccessExpression(expr)) {
    const target = expr.getExpression();
    if (Node.isThisExpression(target)) return moduleOfDeclaration(thisMember(target, expr.getName()), resolver, state, lookup);
    return moduleOfExpression(target, resolver, state, lookup);
  }

  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    const specifier = loadedSpecifier(callee, expr.getArguments()[0]);
    if (specifier !== undefined) return isRelativeSpecifier(specifier) ? undefined : lookup(specifier);
    return moduleOfExpression(callee, resolver, state, lookup);
  }

  if (Node.isNewExpression(expr)) return moduleOfExpression(expr.getExpression(), resolver, state, lookup);
  if (Node.isExpressionWithTypeArguments(expr)) return moduleOfExpression(expr.getExpression(), resolver, state, lookup);

  if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
    const returnType = expr.getReturnTypeNode();
    return returnType ? moduleOfType(returnType, resolver, state, lookup) : undefined;
  }
  return undefined;
}

/** The module specifier a `require` or dynamic `import` call with a string argument loads, else undefined. */
function loadedSpecifier(callee: Node, firstArgument: Node | undefined): string | undefined {
  const loads = (Node.isIdentifier(callee) && callee.getText() === 'require') || callee.getKind() === SyntaxKind.ImportKeyword;
  if (!loads || !firstArgument) return undefined;
  return Node.isStringLiteral(firstArgument) || Node.isNoSubstitutionTemplateLiteral(firstArgument)
    ? firstArgument.getLiteralValue()
    : undefined;
}

function enclosingClass(node: Node): Node | undefined {
  return node.getFirstAncestor((n) => Node.isClassDeclaration(n) || Node.isClassExpression(n));
}

/** Member `name` of the class enclosing `thisNode`: a property declaration or a constructor parameter property. */
function thisMember(thisNode: Node, name: string): Node | undefined {
  const cls = enclosingClass(thisNode);
  if (!cls || !(Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) return undefined;
  const property = cls.getProperty(name);
  if (property) return property;
  for (const ctor of cls.getConstructors()) {
    for (const parameter of ctor.getParameters()) {
      if (parameter.isParameterProperty() && parameter.getName() === name) return parameter;
    }
  }
  return undefined;
}

function moduleOfDeclaration(declaration: Node | undefined, resolver: ModuleResolver, state: WalkState, lookup: ModuleLookup): string | undefined {
  if (!declaration || !state.enter(declaration)) return undefined;

  const binding = importBindingOf(declaration);
  if (binding) {
    if (!isRelativeSpecifier(binding.specifier)) return lookup(binding.specifier);
    if (binding.exportName === undefined) return undefined;
    const target = resolver.sourceFileFor(binding.file, binding.specifier);
    return target ? moduleOfDeclaration(exportOf(target, binding.exportName, resolver, state), resolver, state, lookup) : undefined;
  }

  if (Node.isVariableDeclaration(declaration) || Node.isPropertyDeclaration(declaration)) {
    const type = declaration.getTypeNode();
    if (type) return moduleOfType(type, resolver, state, lookup);
    const initializer = declaration.getInitializer();
    return initializer ? moduleOfExpression(initializer, resolver, state, lookup) : undefined;
  }
  if (Node.isBindingElement(declaration)) {
    const outer = declaration.getFirstAncestor((n) => Node.isVariableDeclaration(n) || Node.isParameterDeclaration(n));
    if (!outer || !Node.isVariableDeclaration(outer)) return undefined;
    const initializer = outer.getInitializer();
    return initializer ? moduleOfExpression(initializer, resolver, state, lookup) : undefined;
  }
  if (Node.isParameterDeclaration(declaration)) {
    const type = declaration.getTypeNode();
    return type ? moduleOfType(type, resolver, state, lookup) : undefined;
  }
  if (Node.isClassDeclaration(declaration) || Node.isClassExpression(declaration)) {
    const base = declaration.getExtends();
    return base ? moduleOfExpression(base.getExpression(), resolver, state, lookup) : undefined;
  }
  if (Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration) || Node.isFunctionExpression(declaration)) {
    const returnType = declaration.getReturnTypeNode();
    return returnType ? moduleOfType(returnType, resolver, state, lookup) : undefined;
  }
  if (Node.isExportAssignment(declaration)) return moduleOfExpression(declaration.getExpression(), resolver, state, lookup);
  return undefined;
}

function moduleOfType(type: Node, resolver: ModuleResolver, state: WalkState, lookup: ModuleLookup): string | undefined {
  if (Node.isParenthesizedTypeNode(type)) return moduleOfType(type.getTypeNode(), resolver, state, lookup);
  if (Node.isTypeReference(type)) {
    let name: Node = type.getTypeName();
    while (Node.isQualifiedName(name)) name = name.getLeft();
    return moduleOfDeclaration(declarationOf(name), resolver, state, lookup);
  }
  if (Node.isImportTypeNode(type)) {
    const argument = type.getArgument();
    const literal = Node.isLiteralTypeNode(argument) ? argument.getLiteral() : undefined;
    if (!literal || !Node.isStringLiteral(literal)) return undefined;
    const specifier = literal.getLiteralValue();
    return isRelativeSpecifier(specifier) ? undefined : lookup(specifier);
  }
  return undefined;
}
