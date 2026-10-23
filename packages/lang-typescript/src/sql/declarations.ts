import { Node, type SourceFile } from 'ts-morph';
import { isRelativeSpecifier, type ModuleResolver } from './module-resolver.js';

/**
 * Syntactic name resolution for the SQL call-site walks. The in-memory project has no library types, so these
 * helpers look declarations up by name in the enclosing scopes and in the exports of relative modules, without
 * the type checker.
 */

/** The walk budget: at most `MAX_STEPS` declaration hops (QR8). */
export const MAX_STEPS = 8;

export class WalkState {
  private steps = 0;
  private readonly visited = new Set<Node>();

  /** Receiver provenance: one step onto `node`; false when the budget is spent or `node` was seen before. */
  enter(node: Node): boolean {
    if (this.visited.has(node) || this.steps >= MAX_STEPS) return false;
    this.visited.add(node);
    this.steps++;
    return true;
  }

  /**
   * Constant evaluation and module hops: the first visit of `node` costs a step, a revisit is free (the same
   * constant twice in one expression). False only when a first visit finds the budget spent; callers guard
   * against cycles themselves.
   */
  charge(node: Node): boolean {
    if (this.visited.has(node)) return true;
    if (this.steps >= MAX_STEPS) return false;
    this.visited.add(node);
    this.steps++;
    return true;
  }
}

/** Parentheses, `as`, `satisfies`, `<T>` assertions and `!` (and `await` when asked) around an expression. */
export function unwrapExpression(node: Node, awaits: boolean): Node {
  let current = node;
  for (;;) {
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isTypeAssertion(current) ||
      Node.isNonNullExpression(current) ||
      (awaits && Node.isAwaitExpression(current))
    ) {
      current = current.getExpression();
      continue;
    }
    return current;
  }
}

/** The binding element or identifier named `name` in a declaration name (identifier or binding pattern). */
function bindingNamed(nameNode: Node, name: string): Node | undefined {
  if (Node.isIdentifier(nameNode)) return nameNode.getText() === name ? nameNode : undefined;
  if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.getElements()) {
      if (!Node.isBindingElement(element)) continue;
      const inner = element.getNameNode();
      if (Node.isIdentifier(inner)) {
        if (inner.getText() === name) return element;
      } else {
        const found = bindingNamed(inner, name);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/** A variable declaration (or a binding element inside one) named `name`. */
function variableNamed(declarations: readonly Node[], name: string): Node | undefined {
  for (const declaration of declarations) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const found = bindingNamed(declaration.getNameNode(), name);
    if (found) return Node.isIdentifier(found) ? declaration : found;
  }
  return undefined;
}

/** A declaration named `name` among a statement list (block, source file or case clause). */
function statementDeclaration(statements: readonly Node[], name: string): Node | undefined {
  for (const statement of statements) {
    if (Node.isVariableStatement(statement)) {
      const found = variableNamed(statement.getDeclarations(), name);
      if (found) return found;
    } else if (
      Node.isFunctionDeclaration(statement) ||
      Node.isClassDeclaration(statement) ||
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement)
    ) {
      if (statement.getName() === name) return statement;
    } else if (Node.isImportDeclaration(statement)) {
      const defaultImport = statement.getDefaultImport();
      if (defaultImport?.getText() === name) return statement.getImportClause();
      const namespaceImport = statement.getNamespaceImport();
      if (namespaceImport?.getText() === name) return namespaceImport.getParent();
      for (const named of statement.getNamedImports()) {
        if ((named.getAliasNode()?.getText() ?? named.getName()) === name) return named;
      }
    } else if (Node.isImportEqualsDeclaration(statement)) {
      if (statement.getName() === name) return statement;
    }
  }
  return undefined;
}

/** A declaration named `name` that `scope` itself introduces. */
function declarationIn(scope: Node, name: string): Node | undefined {
  if (Node.isSourceFile(scope) || Node.isBlock(scope) || Node.isModuleBlock(scope) || Node.isCaseClause(scope) || Node.isDefaultClause(scope)) {
    return statementDeclaration(scope.getStatements(), name);
  }
  if (
    Node.isFunctionDeclaration(scope) ||
    Node.isFunctionExpression(scope) ||
    Node.isArrowFunction(scope) ||
    Node.isMethodDeclaration(scope) ||
    Node.isConstructorDeclaration(scope) ||
    Node.isGetAccessorDeclaration(scope) ||
    Node.isSetAccessorDeclaration(scope)
  ) {
    for (const parameter of scope.getParameters()) {
      const found = bindingNamed(parameter.getNameNode(), name);
      if (found) return Node.isIdentifier(found) ? parameter : found;
    }
    if (Node.isFunctionExpression(scope) && scope.getName() === name) return scope;
    return undefined;
  }
  if (Node.isClassExpression(scope)) return scope.getName() === name ? scope : undefined;
  if (Node.isForStatement(scope) || Node.isForOfStatement(scope) || Node.isForInStatement(scope)) {
    const initializer = scope.getInitializer();
    return initializer && Node.isVariableDeclarationList(initializer)
      ? variableNamed(initializer.getDeclarations(), name)
      : undefined;
  }
  if (Node.isCatchClause(scope)) {
    const variable = scope.getVariableDeclaration();
    return variable ? variableNamed([variable], name) : undefined;
  }
  return undefined;
}

/**
 * The declaration an identifier names, looked up through the enclosing scopes of its own file: a variable
 * declaration, binding element, parameter, function, class, interface, type alias, enum or import binding
 * (import specifier, import clause, namespace import, import-equals declaration).
 */
export function declarationOf(identifier: Node): Node | undefined {
  const name = identifier.getText();
  for (let scope = identifier.getParent(); scope; scope = scope.getParent()) {
    const found = declarationIn(scope, name);
    if (found) return found;
  }
  return undefined;
}

/** An import binding: where it comes from and which export it names (`undefined`: the module object itself). */
export interface ImportBinding {
  readonly file: SourceFile;
  readonly specifier: string;
  readonly exportName: string | undefined;
}

/**
 * The import side of a declaration: an import specifier, an import clause (default import), a namespace import,
 * `import x = require(...)`, or an export specifier of an `export { x } from` re-export.
 */
export function importBindingOf(declaration: Node): ImportBinding | undefined {
  const file = declaration.getSourceFile();
  if (Node.isImportSpecifier(declaration)) {
    return { file, specifier: declaration.getImportDeclaration().getModuleSpecifierValue(), exportName: declaration.getName() };
  }
  if (Node.isImportClause(declaration)) {
    const importDeclaration = declaration.getParent();
    return Node.isImportDeclaration(importDeclaration)
      ? { file, specifier: importDeclaration.getModuleSpecifierValue(), exportName: 'default' }
      : undefined;
  }
  if (Node.isNamespaceImport(declaration)) {
    const importDeclaration = declaration.getFirstAncestor(Node.isImportDeclaration);
    return importDeclaration ? { file, specifier: importDeclaration.getModuleSpecifierValue(), exportName: undefined } : undefined;
  }
  if (Node.isImportEqualsDeclaration(declaration)) {
    const reference = declaration.getModuleReference();
    if (!Node.isExternalModuleReference(reference)) return undefined;
    const expression = reference.getExpression();
    return expression && Node.isStringLiteral(expression)
      ? { file, specifier: expression.getLiteralValue(), exportName: undefined }
      : undefined;
  }
  if (Node.isExportSpecifier(declaration)) {
    const specifier = declaration.getExportDeclaration().getModuleSpecifierValue();
    return specifier === undefined ? undefined : { file, specifier, exportName: declaration.getName() };
  }
  return undefined;
}

/**
 * The declaration behind the export `name` of `file`: an exported variable declaration or binding element,
 * function, class or enum; `export default <expression>` (the export assignment) or a default function or
 * class for `default`; a local `export { x as name }` resolves to the local declaration of `x`, and an
 * `export { x as name } from` re-export to its export specifier (an import binding). `export * from` relative
 * modules is searched last, each module costing one step on its first visit; a module already on the search
 * path is skipped, so `export *` cycles end.
 */
export function exportOf(file: SourceFile, name: string, resolver: ModuleResolver, state: WalkState): Node | undefined {
  return exportIn(file, name, resolver, state, new Set([file]));
}

function exportIn(
  file: SourceFile,
  name: string,
  resolver: ModuleResolver,
  state: WalkState,
  path: Set<SourceFile>,
): Node | undefined {
  const stars: string[] = [];
  for (const statement of file.getStatements()) {
    if (name === 'default') {
      if (Node.isExportAssignment(statement) && !statement.isExportEquals()) return statement;
      if ((Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement)) && statement.hasDefaultKeyword()) {
        return statement;
      }
    } else if (Node.isVariableStatement(statement)) {
      if (statement.hasExportKeyword()) {
        const found = variableNamed(statement.getDeclarations(), name);
        if (found) return found;
      }
    } else if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement) || Node.isEnumDeclaration(statement)) {
      if (statement.hasExportKeyword() && !statement.hasDefaultKeyword() && statement.getName() === name) return statement;
    }

    if (Node.isExportDeclaration(statement)) {
      const moduleSpecifier = statement.getModuleSpecifierValue();
      const named = statement.getNamedExports();
      if (named.length === 0 && moduleSpecifier !== undefined && !statement.getNamespaceExport()) {
        stars.push(moduleSpecifier);
        continue;
      }
      for (const specifier of named) {
        const exported = specifier.getAliasNode()?.getText() ?? specifier.getName();
        if (exported !== name) continue;
        return moduleSpecifier === undefined ? statementDeclaration(file.getStatements(), specifier.getName()) : specifier;
      }
    }
  }
  if (name === 'default') return undefined;
  for (const specifier of stars) {
    if (!isRelativeSpecifier(specifier)) continue;
    const target = resolver.sourceFileFor(file, specifier);
    if (!target || path.has(target) || !state.charge(target)) continue;
    path.add(target);
    const found = exportIn(target, name, resolver, state, path);
    path.delete(target);
    if (found) return found;
  }
  return undefined;
}
