// Spring and JAX-RS annotation routes (PR 4, issue #156, FC-8 and the Java row of the language mapping).
// Built from symbol annotations, which the JDT and tree-sitter tiers both emit.
import type { SymbolAnnotation, SymbolNode } from '@ctxo/plugin-api';
import type { FactEvidence } from './fact-types.js';
import { joinRoute } from './fact-rules.js';

/** Spring's verb-specific mapping annotations. */
const SPRING_VERBS: Readonly<Record<string, string>> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

/** JAX-RS (`jakarta.ws.rs`, `javax.ws.rs`) verb annotations. */
const JAX_RS_VERBS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

const REQUEST_MAPPING = 'RequestMapping';
const PATH = 'Path';

/** Comma-separated values (the analyzers join array members of `named` with `,`), empty ones dropped. */
function split(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

/** Spring paths: each `args` value, else `named.path`, else `named.value`; none gives one empty path. */
function springPaths(annotation: SymbolAnnotation): string[] {
  if (annotation.args && annotation.args.length > 0) return [...annotation.args];
  const named = split(annotation.named?.['path']);
  if (named.length > 0) return named;
  const value = split(annotation.named?.['value']);
  return value.length > 0 ? value : [''];
}

/** A JAX-RS `Path` value: `args[0]`, else `named.value` (`@Path(value = "/x")` when a tier reports the member by name). */
function jaxRsPath(annotation: SymbolAnnotation | undefined): string | undefined {
  return annotation?.args?.[0] ?? annotation?.named?.['value'];
}

/** `RequestMethod.POST` (or `POST`) gives `POST`. */
function verbOf(value: string): string {
  return value.slice(value.lastIndexOf('.') + 1).toUpperCase();
}

/** The innermost class or interface whose span holds the method: the later start, then the smaller span, then index order. */
function enclosingType(method: SymbolNode, symbols: readonly SymbolNode[]): SymbolNode | undefined {
  let best: SymbolNode | undefined;
  for (const symbol of symbols) {
    if (symbol.kind !== 'class' && symbol.kind !== 'interface') continue;
    if (symbol.startLine > method.startLine || symbol.endLine < method.endLine) continue;
    if (
      !best
      || symbol.startLine > best.startLine
      || (symbol.startLine === best.startLine && symbol.endLine - symbol.startLine < best.endLine - best.startLine)
    ) {
      best = symbol;
    }
  }
  return best;
}

/**
 * `route` evidence for Spring and JAX-RS methods. Spring: one route per verb and path of each
 * `GetMapping`, `PostMapping`, `PutMapping`, `DeleteMapping`, `PatchMapping` and `RequestMapping`
 * of a method (paths from `args`, else `named.path`, else `named.value`); `RequestMapping` verbs come
 * from `named.method` (`RequestMethod.GET` gives `GET`, comma-separated values one route each; both
 * tiers keep the enum text there), else `ANY`. The innermost enclosing type's `RequestMapping` paths
 * are the prefixes. JAX-RS: one route per `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD` or
 * `OPTIONS` annotation, the type's `Path` joined with the method's `Path`. Class and method paths are
 * always concatenated. The line is the method's `startLine` (its first annotation).
 */
export function annotationRouteEvidence(symbols: readonly SymbolNode[]): FactEvidence[] {
  const evidence: FactEvidence[] = [];
  for (const method of symbols) {
    if (method.kind !== 'method' || !method.annotations) continue;
    const annotations = method.annotations;
    const routed = annotations.some((a) => SPRING_VERBS[a.name] !== undefined || a.name === REQUEST_MAPPING || JAX_RS_VERBS.has(a.name));
    if (!routed) continue;

    const owner = enclosingType(method, symbols);
    const classMapping = owner?.annotations?.find((a) => a.name === REQUEST_MAPPING);
    const prefixes = classMapping ? springPaths(classMapping) : [''];
    const classPath = jaxRsPath(owner?.annotations?.find((a) => a.name === PATH));
    const methodPath = jaxRsPath(annotations.find((a) => a.name === PATH));

    const push = (verb: string, route: string): void => {
      evidence.push({ kind: 'route', symbolId: method.symbolId, line: method.startLine, verb, route });
    };

    for (const annotation of annotations) {
      const fixed = SPRING_VERBS[annotation.name];
      if (fixed !== undefined || annotation.name === REQUEST_MAPPING) {
        const declared = split(annotation.named?.['method']).map(verbOf);
        const verbs = fixed !== undefined
          ? [fixed]
          : declared.length > 0 ? declared : ['ANY'];
        for (const verb of verbs) {
          for (const prefix of prefixes) {
            for (const path of springPaths(annotation)) push(verb, joinRoute(prefix, path));
          }
        }
      } else if (JAX_RS_VERBS.has(annotation.name)) {
        push(annotation.name, joinRoute(classPath, methodPath));
      }
    }
  }
  return evidence;
}
