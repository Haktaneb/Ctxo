/**
 * Test conventions (spec 12.3, K13a): how a test is recognised as a characterization or a contract test,
 * by annotation, by path or by a marker in its name. This module reads the annotation matchers and
 * classifies the test cases of the test files (H7).
 */

import type { FileIndex, SymbolNode, TestFileCheck } from '@ctxo/cli/internal';
import type { TestConvention } from './domain-config.js';
import type { GlobMatcherFactory } from './ownership.js';
import type { TestTitle } from './rule-id-scan.js';

/** One `annotations` entry: `Name`, `Name:value` (any argument equals `value`) or `Name:key=value`. */
export interface AnnotationMatcher {
  readonly name: string;
  readonly key?: string;
  readonly value?: string;
}

/** An annotation name, optionally qualified (`NUnit.Framework.Category`). */
const ANNOTATION_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Parses a matcher spec; undefined when it is malformed (empty parts, a second `=`, a bad name). */
export function parseAnnotationMatcher(spec: string): AnnotationMatcher | undefined {
  const text = spec.trim();
  const colon = text.indexOf(':');
  const name = colon < 0 ? text : text.slice(0, colon);
  if (!ANNOTATION_NAME.test(name)) return undefined;
  if (colon < 0) return { name };

  const rest = text.slice(colon + 1);
  const eq = rest.indexOf('=');
  if (eq < 0) {
    const value = rest.trim();
    return value.length > 0 ? { name, value } : undefined;
  }
  const key = rest.slice(0, eq).trim();
  const value = rest.slice(eq + 1).trim();
  if (key.length === 0 || value.length === 0 || value.includes('=')) return undefined;
  return { name, key, value };
}

/** Test cases and the two kinds among them (H7). Every list and set is in codepoint order of symbol IDs. */
export interface TestClassification {
  /** `function` and `method` symbols of test files that contain no other `function` or `method` of the file. */
  readonly testCases: readonly string[];
  readonly characterization: ReadonlySet<string>;
  readonly contract: ReadonlySet<string>;
}

export interface ClassifyTestsInput {
  readonly indices: readonly FileIndex[];
  readonly isTestFile: TestFileCheck;
  /** Declared titles of the test files (`scanTestTitles`), 1-based lines. */
  readonly titles: readonly TestTitle[];
  readonly characterization: TestConvention;
  readonly contract: TestConvention;
  readonly makeMatcher: GlobMatcherFactory;
}

type Annotation = NonNullable<SymbolNode['annotations']>[number];

interface CompiledConvention {
  readonly matchers: readonly AnnotationMatcher[];
  readonly path: (path: string) => boolean;
  readonly names: readonly string[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const norm = (path: string): string => path.replace(/\\/g, '/');

/** ASCII-only lower case: keys, values and name markers compare without ASCII case, nothing else is folded. */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

const sameAscii = (a: string, b: string): boolean => lowerAscii(a) === lowerAscii(b);

/** True when an annotation satisfies a matcher: the name exactly, then the value or the key and value (H7). */
export function annotationMatches(matcher: AnnotationMatcher, annotation: Annotation): boolean {
  if (annotation.name !== matcher.name) return false;
  if (matcher.value === undefined) return true;
  const args = annotation.args ?? [];
  const named = Object.entries(annotation.named ?? {});
  const value = matcher.value;
  if (matcher.key === undefined) {
    return args.some((a) => sameAscii(a, value)) || named.some(([, v]) => sameAscii(v, value));
  }
  const key = matcher.key;
  if (args[0] !== undefined && args[1] !== undefined && sameAscii(args[0], key) && sameAscii(args[1], value)) return true;
  return named.some(([k, v]) => sameAscii(k, key) && sameAscii(v, value));
}

function compile(convention: TestConvention, makeMatcher: GlobMatcherFactory): CompiledConvention {
  const matchers: AnnotationMatcher[] = [];
  for (const spec of convention.annotations) {
    const matcher = parseAnnotationMatcher(spec);
    if (matcher !== undefined) matchers.push(matcher);
  }
  // The host matcher takes a mutable string[] (PF26).
  const path = convention.paths.length === 0 ? () => false : makeMatcher([...convention.paths]);
  const names = convention.names.map(lowerAscii).filter((n) => n.length > 0);
  return { matchers, path, names };
}

/** Line span of `outer` includes the one of `inner` (both ends inclusive). */
function spans(outer: SymbolNode, inner: SymbolNode): boolean {
  return outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

/** `outer` contains `inner` and is not the same span (offsets decide when both symbols carry them). */
function strictlyContains(outer: SymbolNode, inner: SymbolNode): boolean {
  if (outer === inner || !spans(outer, inner)) return false;
  const { startOffset: os, endOffset: oe } = outer;
  const { startOffset: is, endOffset: ie } = inner;
  if (os !== undefined && oe !== undefined && is !== undefined && ie !== undefined) {
    if (os > is || oe < ie) return false;
    return os !== is || oe !== ie;
  }
  return outer.startLine !== inner.startLine || outer.endLine !== inner.endLine;
}

const isCallable = (symbol: SymbolNode): boolean => symbol.kind === 'function' || symbol.kind === 'method';

/**
 * H7: the test cases of the test files and which of them are characterization and contract tests. A case is of a
 * kind when its file matches a `paths` glob, when it or a symbol of its file spanning it carries an annotation a
 * matcher accepts, or when a `names` marker occurs in its name or in a declared title on a line it spans.
 */
export function classifyTests(input: ClassifyTestsInput): TestClassification {
  const characterization = compile(input.characterization, input.makeMatcher);
  const contract = compile(input.contract, input.makeMatcher);

  const titlesByFile = new Map<string, TestTitle[]>();
  for (const title of input.titles) {
    const file = norm(title.file);
    const list = titlesByFile.get(file);
    if (list === undefined) titlesByFile.set(file, [title]);
    else list.push(title);
  }

  const cases: string[] = [];
  const isCharacterization = new Set<string>();
  const isContract = new Set<string>();

  for (const index of input.indices) {
    if (!input.isTestFile(index.file)) continue;
    const file = norm(index.file);
    const titles = titlesByFile.get(file) ?? [];
    const callables = index.symbols.filter(isCallable);
    for (const symbol of callables) {
      if (callables.some((other) => strictlyContains(symbol, other))) continue;
      cases.push(symbol.symbolId);
      const annotations: Annotation[] = [];
      for (const holder of index.symbols) if (spans(holder, symbol)) annotations.push(...(holder.annotations ?? []));
      // W16: titles are 1-based, index lines 0-based.
      const texts = [symbol.name, ...titles.filter((t) => t.line >= symbol.startLine + 1 && t.line <= symbol.endLine + 1).map((t) => t.title)].map(
        lowerAscii,
      );
      const matches = (convention: CompiledConvention): boolean =>
        convention.path(file) ||
        annotations.some((a) => convention.matchers.some((m) => annotationMatches(m, a))) ||
        convention.names.some((marker) => texts.some((text) => text.includes(marker)));
      if (matches(characterization)) isCharacterization.add(symbol.symbolId);
      if (matches(contract)) isContract.add(symbol.symbolId);
    }
  }

  const testCases = [...new Set(cases)].sort(compare);
  return {
    testCases,
    characterization: new Set(testCases.filter((id) => isCharacterization.has(id))),
    contract: new Set(testCases.filter((id) => isContract.has(id))),
  };
}
