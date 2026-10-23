import JavaLanguage from 'tree-sitter-java';
import type { SyntaxNode } from 'tree-sitter';
import { TreeSitterAdapter } from './tree-sitter-adapter.js';
import { createLogger } from './logger.js';
import { annotationsFromModifiers } from './tree-sitter-annotations.js';
import type { SymbolNode, GraphEdge, ComplexityMetrics, SymbolKind, CodeFact } from '@ctxo/plugin-api';
import type { FactOptions } from './facts/fact-types.js';
import { finishFacts } from './facts/finish-facts.js';
import { decodeJavaStringLiteral } from './facts/java-string-literal.js';
import { collectTreeSitterEvidence } from './facts/tree-sitter-evidence.js';

const log = createLogger('ctxo:lang-java');

/** Java declaration node type -> Ctxo SymbolKind. */
const TYPE_DECL_KIND: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'type',
  record_declaration: 'class',
  annotation_type_declaration: 'interface',
};

/** Member node types that are `::method` symbols in both tiers. */
const METHOD_MEMBERS: ReadonlySet<string> = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);

/** Parents of a `class_body` that is not a named type's body (enum constants, anonymous classes). */
const ANONYMOUS_BODY_PARENTS: ReadonlySet<string> = new Set(['enum_constant', 'object_creation_expression']);

/**
 * Branch node types for cyclomatic complexity per the tree-sitter-java 0.23.x grammar.
 * Spike-verified names:
 *   - switch uses `switch_expression` (not switch_statement); `switch_label` inside switch_block_statement_group
 *   - enhanced_for_statement confirmed
 */
const JAVA_BRANCH_TYPES = [
  'if_statement',
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
  'switch_label',
  'catch_clause',
  'ternary_expression',
];

export class JavaAdapter extends TreeSitterAdapter {
  readonly extensions = ['.java'] as const;

  /** Fact detector options: set when the host requests facts; without them `extractFacts` returns `[]`. */
  readonly facts: FactOptions | undefined;

  constructor(options: { readonly facts?: FactOptions } = {}) {
    super(JavaLanguage);
    this.facts = options.facts;
  }

  // ── Task 4: extractSymbols ──────────────────────────────────

  async extractSymbols(filePath: string, source: string): Promise<SymbolNode[]> {
    try {
      return this.symbolsOf(this.parse(source).rootNode, filePath);
    } catch (err) {
      log.error(`Symbol extraction failed for ${filePath}: ${(err as Error).message}`);
      return [];
    }
  }

  private symbolsOf(root: SyntaxNode, filePath: string): SymbolNode[] {
    const symbols: SymbolNode[] = [];
    this.walkTypeDecls(root, filePath, symbols);
    return symbols;
  }

  // ── PR 4 (#156): extractFacts ───────────────────────────────

  /**
   * Code facts of the syntax tier: the CST evidence of `collectTreeSitterEvidence` (the JDT tier's
   * rules, from the literals alone) and the annotation routes, finished by the shared rules with the
   * Java string decoder. `[]` without the `facts` option.
   */
  async extractFacts(filePath: string, source: string): Promise<CodeFact[]> {
    if (!this.facts) return [];
    try {
      const root = this.parse(source).rootNode;
      const symbols = this.symbolsOf(root, filePath);
      const evidence = collectTreeSitterEvidence(root, filePath, symbols, this.facts);
      return finishFacts(filePath, evidence, symbols, this.facts, decodeJavaStringLiteral);
    } catch (err) {
      log.error(`Fact extraction failed for ${filePath}: ${(err as Error).message}`);
      return [];
    }
  }

  private walkTypeDecls(node: SyntaxNode, filePath: string, out: SymbolNode[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      const kind = TYPE_DECL_KIND[child.type];
      if (kind) {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          const annotations = annotationsFromModifiers(child);
          out.push({
            symbolId: this.buildSymbolId(filePath, name, kind),
            name,
            kind,
            ...this.nodeToLineRange(child),
            ...(annotations ? { annotations } : {}),
          });
        }
        // Extract members from the body field. Spike: body field names differ per type:
        //   class_declaration     -> body=class_body
        //   interface_declaration -> body=interface_body
        //   enum_declaration      -> body=enum_body
        //   record_declaration    -> body=class_body
        //   annotation_type_declaration -> body=annotation_type_body
        const body = child.childForFieldName('body');
        if (body) this.extractMembers(body, filePath, out);
      } else if (child.type === 'class_body' && ANONYMOUS_BODY_PARENTS.has(node.type)) {
        // The body of an enum constant or an anonymous class: JDT indexes its members too.
        this.extractMembers(child, filePath, out);
      }
      // Recurse to handle nested types
      this.walkTypeDecls(child, filePath, out);
    }
  }

  /**
   * Members of a type body, with the ids the JDT tier gives them: methods, constructors and compact
   * constructors (`::method`), fields and interface constants (`::variable`, one per declarator), and
   * the declarations after the constants of an enum.
   */
  private extractMembers(body: SyntaxNode, filePath: string, out: SymbolNode[]): void {
    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i)!;
      if (member.type === 'enum_body_declarations') {
        this.extractMembers(member, filePath, out);
      } else if (METHOD_MEMBERS.has(member.type)) {
        // Spike: all have field name=identifier (a compact constructor's name is its first identifier)
        const name = member.childForFieldName('name')?.text
          ?? member.namedChildren.find((c) => c.type === 'identifier')?.text;
        if (name) {
          const annotations = annotationsFromModifiers(member);
          out.push({
            symbolId: this.buildSymbolId(filePath, name, 'method'),
            name,
            kind: 'method',
            ...this.nodeToLineRange(member),
            ...(annotations ? { annotations } : {}),
          });
        }
      } else if (member.type === 'field_declaration' || member.type === 'constant_declaration') {
        // Spike: field_declaration has field declarator=variable_declarator
        // There can be multiple declarators (e.g. int a, b;) — iterate all children of that type
        for (let j = 0; j < member.childCount; j++) {
          const decl = member.child(j)!;
          if (decl.type === 'variable_declarator') {
            // Spike: variable_declarator has field name=identifier
            const name = decl.childForFieldName('name')?.text;
            if (name) {
              const annotations = annotationsFromModifiers(member);
              out.push({
                symbolId: this.buildSymbolId(filePath, name, 'variable'),
                name,
                kind: 'variable',
                ...this.nodeToLineRange(member),
                ...(annotations ? { annotations } : {}),
              });
            }
          }
        }
      }
    }
  }

  // ── Task 5: extractEdges ────────────────────────────────────

  async extractEdges(filePath: string, source: string): Promise<GraphEdge[]> {
    try {
      const tree = this.parse(source);
      const edges: GraphEdge[] = [];
      const imports = this.collectImports(tree.rootNode);
      const anchor = this.firstTypeSymbolId(tree.rootNode, filePath);
      if (anchor) {
        for (const path of imports) {
          const lastSegment = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : path;
          edges.push({ from: anchor, to: `${path}::${lastSegment}::class`, kind: 'imports' });
        }
      }
      this.walkTypeEdges(tree.rootNode, filePath, edges);
      return edges;
    } catch (err) {
      log.error(`Edge extraction failed for ${filePath}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Return the symbolId of the first top-level type declaration in the file, or undefined. */
  private firstTypeSymbolId(root: SyntaxNode, filePath: string): string | undefined {
    let found: string | undefined;
    const visit = (n: SyntaxNode) => {
      if (found) return;
      const kind = TYPE_DECL_KIND[n.type];
      if (kind) {
        const name = n.childForFieldName('name')?.text;
        if (name) { found = this.buildSymbolId(filePath, name, kind); return; }
      }
      for (let i = 0; i < n.childCount; i++) visit(n.child(i)!);
    };
    visit(root);
    return found;
  }

  /**
   * Resolve a potentially-dotted type name to a Ctxo symbolId.
   * Uses the symbolRegistry for known kinds; falls back to fallbackKind.
   */
  private resolveTypeId(name: string, fallbackKind: SymbolKind): string {
    const last = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    const kind = this.symbolRegistry.get(last) ?? fallbackKind;
    return `${last}::${kind}`;
  }

  /**
   * Collect import paths from top-level import_declaration nodes.
   * Spike: import_declaration children include scoped_identifier or identifier for the path.
   */
  private collectImports(root: SyntaxNode): string[] {
    const paths: string[] = [];
    for (let i = 0; i < root.childCount; i++) {
      const node = root.child(i)!;
      if (node.type === 'import_declaration') {
        // Named children of import_declaration: the path is a scoped_identifier or identifier
        const nameNode = node.namedChildren.find(
          (c) => c.type === 'scoped_identifier' || c.type === 'identifier',
        );
        if (nameNode) paths.push(nameNode.text);
      }
    }
    return paths;
  }

  private walkTypeEdges(
    node: SyntaxNode,
    filePath: string,
    out: GraphEdge[],
  ): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      const kind = TYPE_DECL_KIND[child.type];
      if (kind) {
        const name = child.childForFieldName('name')?.text;
        if (name) {
          const from = this.buildSymbolId(filePath, name, kind);

          if (child.type === 'class_declaration') {
            // Spike: class_declaration field superclass=superclass (child node of type "superclass")
            const superclassNode = child.childForFieldName('superclass');
            if (superclassNode) {
              for (const t of this.typeNames(superclassNode)) {
                out.push({ from, to: this.resolveTypeId(t, 'class'), kind: 'extends' });
              }
            }

            // Spike: class_declaration field interfaces=super_interfaces
            const implNode = child.childForFieldName('interfaces');
            if (implNode) {
              for (const t of this.typeNames(implNode)) {
                out.push({ from, to: this.resolveTypeId(t, 'interface'), kind: 'implements' });
              }
            }
          }

          if (child.type === 'interface_declaration') {
            // Spike: interface_declaration does NOT have an 'interfaces' field.
            // extends is via a CHILD NODE of type 'extends_interfaces' (not a named field).
            for (let j = 0; j < child.childCount; j++) {
              const c = child.child(j)!;
              if (c.type === 'extends_interfaces') {
                for (const t of this.typeNames(c)) {
                  out.push({ from, to: this.resolveTypeId(t, 'interface'), kind: 'extends' });
                }
              }
            }
          }
        }
      }
      // Recurse for nested types
      this.walkTypeEdges(child, filePath, out);
    }
  }

  /** Collect all type_identifier and scoped_type_identifier texts recursively under a node. */
  private typeNames(node: SyntaxNode): string[] {
    const names: string[] = [];
    const visit = (n: SyntaxNode) => {
      if (n.type === 'type_identifier' || n.type === 'scoped_type_identifier') {
        names.push(n.text);
      } else {
        for (let i = 0; i < n.childCount; i++) visit(n.child(i)!);
      }
    };
    visit(node);
    return names;
  }

  // ── Task 6: extractComplexity ───────────────────────────────

  async extractComplexity(filePath: string, source: string): Promise<ComplexityMetrics[]> {
    try {
      const tree = this.parse(source);
      const metrics: ComplexityMetrics[] = [];
      const visit = (node: SyntaxNode) => {
        if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
          const name = node.childForFieldName('name')?.text;
          if (name) {
            const cyclomatic =
              this.countCyclomaticComplexity(node, JAVA_BRANCH_TYPES) +
              this.countLogicalOperators(node);
            metrics.push({
              symbolId: this.buildSymbolId(filePath, name, 'method'),
              cyclomatic,
            });
          }
        }
        for (let i = 0; i < node.childCount; i++) visit(node.child(i)!);
      };
      visit(tree.rootNode);
      return metrics;
    } catch (err) {
      log.error(`Complexity extraction failed for ${filePath}: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Count && and || binary_expression operators for cyclomatic complexity.
   * Spike: binary_expression children include operator nodes with type '&&' or '||'.
   */
  private countLogicalOperators(node: SyntaxNode): number {
    let count = 0;
    const visit = (n: SyntaxNode) => {
      if (n.type === 'binary_expression') {
        const op = n.children.find((c) => c.type === '&&' || c.type === '||');
        if (op) count++;
      }
      for (let i = 0; i < n.childCount; i++) visit(n.child(i)!);
    };
    visit(node);
    return count;
  }
}
