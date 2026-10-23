/**
 * Test conventions (spec 12.3, K13a): how a test is recognised as a characterization or a contract test,
 * by annotation, by path or by a marker in its name. This module reads the annotation matchers; the
 * classification itself builds on them.
 */

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
