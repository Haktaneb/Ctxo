import { Node, type CallExpression, type ObjectLiteralExpression, type SourceFile, type TaggedTemplateExpression } from 'ts-morph';
import type { TestBlock } from '../test-blocks.js';
import { KNOWN_SQL_MEMBERS, knownSqlApiFor, type KnownSqlApi } from './known-sql-apis.js';
import type { ModuleResolver } from './module-resolver.js';
import { receiverModule } from './provenance.js';
import { constantText, taggedTemplateText } from './constant-text.js';
import type { SqlCallSite } from './sql-edges.js';

/** Call sites with a constant text and without one (counted, never guessed). */
export interface SqlStats {
  constant: number;
  nonConstant: number;
}

/** A symbol whose body owns the SQL call sites inside it, minus the `exclude` sub-scopes. */
export interface SymbolScope {
  readonly symbolId: string;
  readonly node: Node;
  readonly exclude: readonly Node[];
}

function isExported(node: Node): boolean {
  return Node.isExportable(node) && node.isExported();
}

/**
 * The scopes SQL edges start from, with the adapter's symbol IDs: exported functions, methods of exported
 * classes, exported variable declarations and test blocks (the callback minus nested blocks' callbacks).
 */
export function symbolScopes(sourceFile: SourceFile, filePath: string, blocks: readonly TestBlock[]): SymbolScope[] {
  const scopes: SymbolScope[] = [];
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name && isExported(fn)) scopes.push({ symbolId: `${filePath}::${name}::function`, node: fn, exclude: [] });
  }
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (!name || !isExported(cls)) continue;
    for (const method of cls.getMethods()) {
      scopes.push({ symbolId: `${filePath}::${name}.${method.getName()}::method`, node: method, exclude: [] });
    }
  }
  for (const statement of sourceFile.getVariableStatements()) {
    if (!isExported(statement)) continue;
    for (const declaration of statement.getDeclarations()) {
      scopes.push({ symbolId: `${filePath}::${declaration.getName()}::variable`, node: declaration, exclude: [] });
    }
  }
  for (const block of blocks) scopes.push({ symbolId: block.symbolId, node: block.body, exclude: block.nested });
  return scopes;
}

const within = (node: Node, outer: Node): boolean => node.getStart() >= outer.getStart() && node.getEnd() <= outer.getEnd();

/** The smallest scope holding `node` outside its excluded sub-scopes; ties go to the lower symbol ID. */
function innermostScope(node: Node, scopes: readonly SymbolScope[]): SymbolScope | undefined {
  let best: SymbolScope | undefined;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (const scope of scopes) {
    if (!within(node, scope.node) || scope.exclude.some((x) => within(node, x))) continue;
    const width = scope.node.getEnd() - scope.node.getStart();
    if (width < bestWidth || (width === bestWidth && best !== undefined && scope.symbolId < best.symbolId)) {
      best = scope;
      bestWidth = width;
    }
  }
  return best;
}

/** The constant `key` property of an object literal (the last occurrence wins, as at run time). */
function propertyText(object: ObjectLiteralExpression, key: string, resolver: ModuleResolver): string | undefined {
  let value: Node | undefined;
  for (const property of object.getProperties()) {
    if (Node.isPropertyAssignment(property)) {
      const name = property.getNameNode();
      const text = Node.isIdentifier(name) ? name.getText() : Node.isStringLiteral(name) ? name.getLiteralValue() : undefined;
      if (text === key) value = property.getInitializer();
    } else if (Node.isShorthandPropertyAssignment(property) && property.getName() === key) {
      value = property.getNameNode();
    } else if (Node.isSpreadAssignment(property)) {
      value = undefined;
    }
  }
  return value ? constantText(value, resolver) : undefined;
}

/** The SQL text of a matched call site by the row's sources, in order, or undefined when none is constant. */
function siteText(site: CallExpression | TaggedTemplateExpression, api: KnownSqlApi, resolver: ModuleResolver): string | undefined {
  for (const source of api.sql) {
    if (Node.isTaggedTemplateExpression(site)) {
      if (source === 'taggedTemplate') return taggedTemplateText(site);
      continue;
    }
    const first = site.getArguments()[0];
    if (!first) return undefined;
    if (source === 'firstArgument') {
      const text =
        api.objectKey !== undefined && Node.isObjectLiteralExpression(first)
          ? propertyText(first, api.objectKey, resolver)
          : constantText(first, resolver);
      if (text !== undefined) return text;
    } else if (Node.isTaggedTemplateExpression(first)) {
      return taggedTemplateText(first);
    }
  }
  return undefined;
}

/**
 * SQL call sites of a file, in source order: a call `<receiver>.<member>(...)` (also `?.`), or a tagged
 * template `` <receiver>.<member>`...` ``, inside a scope, whose receiver traces to a row's module listing the
 * member. A constant text adds a site and counts `constant`; any other matched site counts `nonConstant`.
 */
export function collectSqlCallSites(
  sourceFile: SourceFile,
  scopes: readonly SymbolScope[],
  resolver: ModuleResolver,
  stats: SqlStats,
): SqlCallSite[] {
  const sites: SqlCallSite[] = [];
  if (scopes.length === 0) return sites;

  const consider = (site: CallExpression | TaggedTemplateExpression, callee: Node): void => {
    if (!Node.isPropertyAccessExpression(callee)) return;
    const member = callee.getName();
    if (!KNOWN_SQL_MEMBERS.has(member)) return;
    const scope = innermostScope(site, scopes);
    if (!scope) return;
    const module = receiverModule(callee.getExpression(), resolver);
    const api = module === undefined ? undefined : knownSqlApiFor(module, member);
    if (!api) return;

    const text = siteText(site, api, resolver);
    if (text === undefined) {
      stats.nonConstant++;
      return;
    }
    stats.constant++;
    sites.push({ symbolId: scope.symbolId, line: site.getStartLineNumber() - 1, text, kind: api.kind });
  };

  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) consider(node, node.getExpression());
    else if (Node.isTaggedTemplateExpression(node)) consider(node, node.getTag());
  });
  return sites;
}
