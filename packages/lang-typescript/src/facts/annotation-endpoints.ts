// Nest decorator routes (PR 4, issue #156, FC-8 and the TypeScript row of the language mapping). Built
// from symbol annotations, which the adapter emits for exported classes and their methods.
import type { SymbolAnnotation, SymbolNode } from '@ctxo/plugin-api';
import type { FactEvidence } from './fact-types.js';
import { joinRoute } from './fact-rules.js';

const NEST_VERBS: Readonly<Record<string, string>> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Delete: 'DELETE',
  Patch: 'PATCH',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ANY',
};

/** The class's own `Controller` decorator; property decorators (they carry `named.member`) do not count. */
function controllerOf(cls: SymbolNode): SymbolAnnotation | undefined {
  return cls.annotations?.find((a) => a.name === 'Controller' && a.named?.['member'] === undefined);
}

/**
 * `route` evidence for Nest controllers: one per verb decorator (`Get`, `Post`, `Put`, `Delete`, `Patch`,
 * `Head`, `Options`, `All` as `ANY`) of a method whose class is decorated `Controller`. The path is the
 * controller prefix (`args[0]`, else `named.path`) joined with the decorator's `args[0]`; Nest always
 * concatenates the two. The line is the method's `startLine` (its first decorator).
 */
export function annotationRouteEvidence(symbols: readonly SymbolNode[]): FactEvidence[] {
  const controllers = new Map<string, SymbolAnnotation>();
  for (const symbol of symbols) {
    if (symbol.kind !== 'class') continue;
    const controller = controllerOf(symbol);
    if (controller) controllers.set(symbol.name, controller);
  }
  if (controllers.size === 0) return [];

  const evidence: FactEvidence[] = [];
  for (const method of symbols) {
    if (method.kind !== 'method' || !method.annotations) continue;
    const dot = method.name.lastIndexOf('.');
    const controller = dot > 0 ? controllers.get(method.name.slice(0, dot)) : undefined;
    if (!controller) continue;
    const prefix = controller.args?.[0] ?? controller.named?.['path'];
    for (const annotation of method.annotations) {
      const verb = NEST_VERBS[annotation.name];
      if (verb === undefined) continue;
      evidence.push({
        kind: 'route',
        symbolId: method.symbolId,
        line: method.startLine,
        verb,
        route: joinRoute(prefix, annotation.args?.[0]),
      });
    }
  }
  return evidence;
}
