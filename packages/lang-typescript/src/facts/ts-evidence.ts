// TypeScript fact evidence from ts-morph nodes (PR 4, issue #156, FC-3 to FC-5, FC-8 and G8). The collector
// reports evidence; the shared `finishFacts` decides which evidence becomes a fact.
import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { FactEvidence, FactOptions, LiteralKind } from './fact-types.js';
import { hasRetryTimeoutFragment, matchesNormalizationPattern } from './fact-rules.js';
import { findTestBlocks } from '../test-blocks.js';
import type { ModuleResolver } from '../sql/module-resolver.js';
import { receiverModule } from '../sql/provenance.js';

/** The packages a route call's receiver must trace to (G7). */
export const ROUTE_MODULES: ReadonlySet<string> = new Set(['express', 'fastify']);

/** Express and Fastify route members and their verbs; `all` is `ANY`. */
const ROUTE_VERBS: Readonly<Record<string, string>> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
  head: 'HEAD',
  options: 'OPTIONS',
  all: 'ANY',
};

const COMPARISON_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.GreaterThanEqualsToken,
]);

/** Global receivers of `setTimeout`. */
const TIMER_GLOBALS: ReadonlySet<string> = new Set(['window', 'globalThis']);

/** A declaration that owns the evidence inside it, minus the `exclude` sub-scopes (nested test blocks). */
interface Scope {
  readonly symbolId: string;
  readonly node: Node;
  readonly exclude: readonly Node[];
}

/**
 * G8 owners, with the adapter's symbol IDs: top-level named functions and classes and the methods of those
 * classes (exported or not: a non-exported one gets the ID the adapter would give it if exported), exported
 * variable declarations, and test blocks (the callback minus nested blocks' callbacks).
 */
function scopesOf(sourceFile: SourceFile, filePath: string): Scope[] {
  const scopes: Scope[] = [];
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name) scopes.push({ symbolId: `${filePath}::${name}::function`, node: fn, exclude: [] });
  }
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    scopes.push({ symbolId: `${filePath}::${name}::class`, node: cls, exclude: [] });
    for (const method of cls.getMethods()) {
      scopes.push({ symbolId: `${filePath}::${name}.${method.getName()}::method`, node: method, exclude: [] });
    }
  }
  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const declaration of statement.getDeclarations()) {
      scopes.push({ symbolId: `${filePath}::${declaration.getName()}::variable`, node: declaration, exclude: [] });
    }
  }
  for (const block of findTestBlocks(sourceFile, filePath)) {
    scopes.push({ symbolId: block.symbolId, node: block.body, exclude: block.nested });
  }
  return scopes;
}

const within = (node: Node, outer: Node): boolean => node.getStart() >= outer.getStart() && node.getEnd() <= outer.getEnd();

/** The smallest scope holding `node` outside its excluded sub-scopes (ties: the lower symbol ID); undefined: the module. */
function ownerOf(node: Node, scopes: readonly Scope[]): string | undefined {
  let best: Scope | undefined;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (const scope of scopes) {
    if (!within(node, scope.node) || scope.exclude.some((x) => within(node, x))) continue;
    const width = scope.node.getEnd() - scope.node.getStart();
    if (width < bestWidth || (width === bestWidth && best !== undefined && scope.symbolId < best.symbolId)) {
      best = scope;
      bestWidth = width;
    }
  }
  return best?.symbolId;
}

function isNumeric(node: Node): boolean {
  return Node.isNumericLiteral(node) || Node.isBigIntLiteral(node);
}

/** The literal kind of an operand: numbers (optionally signed), strings, templates without substitutions, `true`, `false`, `null`. */
function literalKindOf(node: Node): LiteralKind | undefined {
  if (isNumeric(node)) return 'number';
  if (Node.isPrefixUnaryExpression(node)) {
    const op = node.getOperatorToken();
    return (op === SyntaxKind.MinusToken || op === SyntaxKind.PlusToken) && isNumeric(node.getOperand()) ? 'number' : undefined;
  }
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return 'string';
  const kind = node.getKind();
  if (kind === SyntaxKind.TrueKeyword || kind === SyntaxKind.FalseKeyword) return 'boolean';
  if (kind === SyntaxKind.NullKeyword) return 'null';
  return undefined;
}

/** A string-literal or no-substitution-template value, else undefined. */
function stringValueOf(node: Node | undefined): string | undefined {
  return node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) ? node.getLiteralValue() : undefined;
}

/** A property or member name written as an identifier or a string literal. */
function nameOf(node: Node): string | undefined {
  if (Node.isIdentifier(node) || Node.isPrivateIdentifier(node)) return node.getText();
  return Node.isStringLiteral(node) ? node.getLiteralValue() : undefined;
}

const lineOf = (node: Node): number => node.getStartLineNumber() - 1;

class Collector {
  readonly evidence: FactEvidence[] = [];
  private readonly scopes: Scope[];

  constructor(
    sourceFile: SourceFile,
    filePath: string,
    private readonly resolver: ModuleResolver,
    private readonly options: FactOptions,
  ) {
    this.scopes = scopesOf(sourceFile, filePath);
  }

  private push(node: Node, item: FactEvidence): void {
    const symbolId = ownerOf(node, this.scopes);
    this.evidence.push(symbolId !== undefined ? { ...item, symbolId } : item);
  }

  visit(node: Node): void {
    if (Node.isIfStatement(node) || Node.isWhileStatement(node) || Node.isDoStatement(node)) {
      this.condition(node.getExpression());
    } else if (Node.isForStatement(node)) {
      const condition = node.getCondition();
      if (condition) this.condition(condition);
    } else if (Node.isConditionalExpression(node)) {
      this.condition(node.getCondition());
    } else if (Node.isSwitchStatement(node)) {
      this.caseLabels(node.getExpression().getText(), node.getCaseBlock().getClauses());
    } else if (Node.isCallExpression(node)) {
      this.call(node);
    } else if (Node.isVariableDeclaration(node) || Node.isPropertyDeclaration(node) || Node.isPropertyAssignment(node)) {
      const initializer = node.getInitializer();
      const name = nameOf(node.getNameNode());
      if (initializer && name !== undefined) this.binding(node, name, initializer);
    } else if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      const left = node.getLeft();
      const name = Node.isIdentifier(left) ? left.getText() : Node.isPropertyAccessExpression(left) ? left.getName() : undefined;
      if (name !== undefined) this.binding(node, name, node.getRight());
    }
  }

  /** FC-3: comparisons inside a condition, through `&&`, `||`, `!` and parentheses. */
  private condition(expr: Node): void {
    if (Node.isParenthesizedExpression(expr)) {
      this.condition(expr.getExpression());
    } else if (Node.isPrefixUnaryExpression(expr) && expr.getOperatorToken() === SyntaxKind.ExclamationToken) {
      this.condition(expr.getOperand());
    } else if (Node.isBinaryExpression(expr)) {
      const operator = expr.getOperatorToken();
      const kind = operator.getKind();
      if (kind === SyntaxKind.AmpersandAmpersandToken || kind === SyntaxKind.BarBarToken) {
        this.condition(expr.getLeft());
        this.condition(expr.getRight());
      } else if (COMPARISON_OPERATORS.has(kind)) {
        const leftKind = literalKindOf(expr.getLeft());
        const rightKind = literalKindOf(expr.getRight());
        if ((leftKind === undefined) === (rightKind === undefined)) return;
        const literal = leftKind !== undefined ? expr.getLeft() : expr.getRight();
        this.push(expr, {
          kind: 'comparison',
          line: lineOf(expr),
          text: expr.getText(),
          operator: operator.getText(),
          literal: literal.getText(),
          literalKind: (leftKind ?? rightKind)!,
        });
      }
    }
  }

  /** FC-3: `case` clauses with a literal label give `<subject> case <label>`. */
  private caseLabels(subject: string, clauses: readonly Node[]): void {
    for (const clause of clauses) {
      if (!Node.isCaseClause(clause)) continue;
      const label = clause.getExpression();
      const literalKind = literalKindOf(label);
      if (literalKind === undefined) continue;
      this.push(clause, {
        kind: 'comparison',
        line: lineOf(clause),
        text: `${subject} case ${label.getText()}`,
        operator: 'case',
        literal: label.getText(),
        literalKind,
      });
    }
  }

  /** FC-5: a binding whose name has a retry or timeout fragment; the finisher checks the value. */
  private binding(node: Node, name: string, value: Node): void {
    if (!hasRetryTimeoutFragment(name)) return;
    this.push(node, { kind: 'binding', line: lineOf(node), name, value: value.getText() });
  }

  private call(call: CallExpression): void {
    const callee = call.getExpression();
    const args = call.getArguments();

    // setTimeout(fn, n), window.setTimeout and globalThis.setTimeout: a duration in milliseconds.
    const timer = Node.isIdentifier(callee)
      ? callee.getText() === 'setTimeout'
      : Node.isPropertyAccessExpression(callee) && callee.getName() === 'setTimeout' && TIMER_GLOBALS.has(callee.getExpression().getText());
    if (timer && args.length >= 2) {
      this.push(call, { kind: 'duration', line: lineOf(call), constructor: callee.getText(), unit: 'ms', amount: args[1]!.getText() });
    }

    if (!Node.isPropertyAccessExpression(callee)) return;
    const method = callee.getName();
    const receiver = callee.getExpression();

    // FC-4: x.m(...) whose simple name matches a normalization pattern.
    if (matchesNormalizationPattern(method, receiver.getText(), this.options.normalizationMethods)) {
      this.push(call, { kind: 'call', line: lineOf(call), text: call.getText(), method, qualifier: receiver.getText() });
    }

    // G7: Express and Fastify routes: a literal path and a handler (Express `app.get('env')` reads a setting);
    // the receiver must trace to a route module.
    const verb = ROUTE_VERBS[method];
    const path = stringValueOf(args[0]);
    if (verb !== undefined && path !== undefined) {
      if (args.length < 2) return;
      if (receiverModule(receiver, this.resolver, ROUTE_MODULES) !== undefined) {
        this.push(call, { kind: 'route', line: lineOf(call), verb, route: path });
      }
    } else if (method === 'route' && args[0] && Node.isObjectLiteralExpression(args[0])) {
      this.fastifyRoute(call, receiver, args[0]);
    }
  }

  /** Fastify `route({ method, url })`: one route per method (a string or an array of strings). */
  private fastifyRoute(call: CallExpression, receiver: Node, options: Node): void {
    if (!Node.isObjectLiteralExpression(options)) return;
    let url: string | undefined;
    let methods: string[] | undefined;
    for (const property of options.getProperties()) {
      if (!Node.isPropertyAssignment(property)) continue;
      const key = nameOf(property.getNameNode());
      const value = property.getInitializer();
      if (key === 'url') {
        url = stringValueOf(value);
      } else if (key === 'method') {
        const single = stringValueOf(value);
        if (single !== undefined) {
          methods = [single];
        } else if (value && Node.isArrayLiteralExpression(value)) {
          const all = value.getElements().map((element) => stringValueOf(element));
          methods = all.every((m) => m !== undefined) ? (all as string[]) : undefined;
        } else {
          methods = undefined;
        }
      }
    }
    if (url === undefined || methods === undefined || methods.length === 0) return;
    if (receiverModule(receiver, this.resolver, ROUTE_MODULES) !== 'fastify') return;
    for (const method of methods) this.push(call, { kind: 'route', line: lineOf(call), verb: method, route: url });
  }
}

/**
 * Fact evidence of one TypeScript or JavaScript file: comparisons in conditions and `case` labels, `x.m(...)`
 * calls matching a normalization pattern, retry and timeout bindings (variables, class properties,
 * object-literal properties, assignments), `setTimeout` durations and Express or Fastify routes. Each record's
 * `symbolId` is its G8 owner, or unset for code outside every owner (the finisher uses the module symbol).
 * Route receivers are traced through `resolver`, which may add files to the project until its `release()`.
 */
export function collectTsEvidence(sourceFile: SourceFile, filePath: string, resolver: ModuleResolver, options: FactOptions): FactEvidence[] {
  const collector = new Collector(sourceFile, filePath, resolver, options);
  sourceFile.forEachDescendant((node) => collector.visit(node));
  return collector.evidence;
}
