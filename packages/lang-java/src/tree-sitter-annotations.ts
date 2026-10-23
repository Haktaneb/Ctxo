import type { SyntaxNode } from 'tree-sitter';
import type { SymbolAnnotation } from '@ctxo/plugin-api';

/**
 * Annotations of one declaration for the tree-sitter (syntax) tier.
 *
 * Shape and caps agree with the JDT full tier (Annotations.java): 20 annotations per symbol, 10 args,
 * 10 named entries, 200 characters per value; `value` (shorthand or explicit) goes to `args`, every
 * other member to `named`; arrays flatten in `args` and join with `,` in `named`; `type` is reserved
 * and dropped (never counts toward the 10 entries); `member` is kept; the first of two same-named
 * members wins. The syntax tier keeps string literals only: text blocks, numbers, booleans, enum
 * constants, class literals, nested annotations and constant expressions are skipped.
 */
const MAX_ANNOTATIONS = 20;
const MAX_ENTRIES = 10;
const MAX_VALUE_LENGTH = 200;
const VALUE = 'value';
const RESERVED_TYPE = 'type';

const SIMPLE_ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  s: ' ',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

export function annotationsFromModifiers(declaration: SyntaxNode): SymbolAnnotation[] | undefined {
  const modifiers = declaration.children.find((c) => c.type === 'modifiers');
  if (!modifiers) return undefined;
  const out: SymbolAnnotation[] = [];
  for (const child of modifiers.children) {
    if (child.type !== 'marker_annotation' && child.type !== 'annotation') continue;
    if (out.length === MAX_ANNOTATIONS) break;
    const annotation = toAnnotation(child);
    if (annotation) out.push(annotation);
  }
  return out.length > 0 ? out : undefined;
}

function toAnnotation(node: SyntaxNode): SymbolAnnotation | undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const name = nameNode.text.slice(nameNode.text.lastIndexOf('.') + 1).trim();
  if (!name) return undefined;

  const args: string[] = [];
  const named: Record<string, string> = {};
  let namedCount = 0;

  const route = (member: string, values: string[]): void => {
    if (member === VALUE) {
      args.push(...values);
      return;
    }
    if (values.length === 0 || member === RESERVED_TYPE || member in named) return;
    if (namedCount === MAX_ENTRIES) return;
    named[member] = cut(values.join(','));
    namedCount++;
  };

  const list = node.childForFieldName('arguments');
  if (list) {
    const seen = new Set<string>();
    for (const arg of list.namedChildren) {
      if (arg.type === 'element_value_pair') {
        const key = arg.childForFieldName('key')?.text;
        const valueNode = arg.childForFieldName('value');
        if (!key || !valueNode || seen.has(key)) continue;
        seen.add(key);
        route(key, stringValues(valueNode));
      } else if (!seen.has(VALUE)) {
        seen.add(VALUE);
        route(VALUE, stringValues(arg));
      }
    }
  }

  return {
    name,
    ...(args.length > 0 ? { args: args.slice(0, MAX_ENTRIES).map(cut) } : {}),
    ...(namedCount > 0 ? { named } : {}),
  };
}

/** The string literals under an element value, in source order; everything else is skipped. */
function stringValues(node: SyntaxNode): string[] {
  if (node.type === 'string_literal') {
    const text = node.text;
    if (text.startsWith('"""')) return [];
    return [decode(text.slice(1, -1))];
  }
  if (node.type === 'element_value_array_initializer') {
    return node.namedChildren.flatMap(stringValues);
  }
  return [];
}

function decode(raw: string): string {
  // Unicode escapes (one or more `u`), octal escapes (\0 to \377) and the simple escapes, as javac reads them.
  return raw.replace(
    /\\(?:u+([0-9a-fA-F]{4})|([0-3][0-7]{2}|[0-7]{1,2})|(.))/gs,
    (all, hex: string | undefined, octal: string | undefined, c: string | undefined) => {
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
      if (octal !== undefined) return String.fromCharCode(parseInt(octal, 8));
      return SIMPLE_ESCAPES[c!] ?? all;
    },
  );
}

function cut(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) : value;
}
