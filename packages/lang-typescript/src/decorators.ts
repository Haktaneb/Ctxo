import { Node, type ClassDeclaration, type Decorator, type MethodDeclaration } from 'ts-morph';
import type { SymbolAnnotation } from '@ctxo/plugin-api';

export const ANNOTATION_CAPS = { perSymbol: 20, args: 10, named: 10, chars: 200 } as const;

/** Keys the host owns: `type` (fully qualified type name) and `member` (class property name). */
const RESERVED_KEYS = new Set(['type', 'member']);

function cut(value: string): string {
  return value.length > ANNOTATION_CAPS.chars ? value.slice(0, ANNOTATION_CAPS.chars) : value;
}

function stringValue(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return cut(node.getLiteralText());
  }
  return undefined;
}

function propertyKey(node: Node): string | undefined {
  if (Node.isIdentifier(node) || Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return Node.isIdentifier(node) ? node.getText() : node.getLiteralText();
  }
  return undefined;
}

function toAnnotation(decorator: Decorator, member?: string): SymbolAnnotation {
  const args: string[] = [];
  const named: Record<string, string> = {};
  let namedCount = 0;
  if (member !== undefined) named.member = cut(member);

  for (const arg of decorator.getArguments()) {
    const text = stringValue(arg);
    if (text !== undefined) {
      if (args.length < ANNOTATION_CAPS.args) args.push(text);
      continue;
    }
    if (!Node.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const nameNode = prop.getNameNode();
      const key = propertyKey(nameNode);
      if (key === undefined || RESERVED_KEYS.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(named, key)) continue;
      const value = stringValue(prop.getInitializer());
      if (value === undefined) continue;
      if (namedCount >= ANNOTATION_CAPS.named) continue;
      named[key] = value;
      namedCount++;
    }
  }

  return {
    name: decorator.getName(),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(named).length > 0 ? { named } : {}),
  };
}

/** Own decorators of the class, then its property decorators with `named.member`. */
export function classAnnotations(cls: ClassDeclaration): SymbolAnnotation[] | undefined {
  const out: SymbolAnnotation[] = [];
  for (const decorator of cls.getDecorators()) {
    out.push(toAnnotation(decorator));
  }
  for (const prop of cls.getProperties()) {
    for (const decorator of prop.getDecorators()) {
      out.push(toAnnotation(decorator, prop.getName()));
    }
  }
  return out.length > 0 ? out.slice(0, ANNOTATION_CAPS.perSymbol) : undefined;
}

export function methodAnnotations(method: MethodDeclaration): SymbolAnnotation[] | undefined {
  const out = method.getDecorators().map((d) => toAnnotation(d));
  return out.length > 0 ? out.slice(0, ANNOTATION_CAPS.perSymbol) : undefined;
}
