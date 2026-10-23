import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LiteralKind, TrivialLiteral } from '../fact-types.js';
import { DEFAULT_FACT_OPTIONS } from '../fact-options.js';
import {
  canonicalNumber,
  hasRetryTimeoutFragment,
  isTrivialLiteral,
  joinRoute,
  matchesNormalizationPattern,
  normalizeFactText,
} from '../fact-rules.js';

// The shared conformance vectors; every plugin copy of the rules runs all of them.
const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../../plugin-api/conformance/fact-vectors.json');

interface Vector<I, E> { readonly input: I; readonly expected: E }
type Repeat = { readonly repeat: string; readonly count: number };
type Segments = readonly (string | Repeat)[];

interface Vectors {
  readonly $comment: string;
  readonly defaults: { trivialLiterals: TrivialLiteral[]; normalizationMethods: string[] };
  readonly canonicalNumber: Vector<string, string | null>[];
  readonly isTrivialLiteral: Vector<{ literal: string; kind: LiteralKind }, boolean>[];
  readonly isTrivialLiteralCustom: Vector<{ literal: string; kind: LiteralKind; trivialLiterals: TrivialLiteral[] }, boolean>[];
  readonly hasRetryTimeoutFragment: Vector<string, boolean>[];
  readonly matchesNormalizationPattern: Vector<{ method: string; qualifier?: string }, boolean>[];
  readonly matchesNormalizationPatternCustom: Vector<{ method: string; qualifier?: string; patterns: string[] }, boolean>[];
  readonly normalizeFactText: Vector<Segments, Segments>[];
  readonly joinRoute: Vector<string[], string>[];
}

const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors;

function expand(segments: Segments): string {
  return segments.map(segment => (typeof segment === 'string' ? segment : segment.repeat.repeat(segment.count))).join('');
}

describe('fact conformance vectors', () => {
  it('the vectors file has every category', () => {
    expect(Object.keys(vectors).sort()).toEqual([
      '$comment',
      'canonicalNumber',
      'defaults',
      'hasRetryTimeoutFragment',
      'isTrivialLiteral',
      'isTrivialLiteralCustom',
      'joinRoute',
      'matchesNormalizationPattern',
      'matchesNormalizationPatternCustom',
      'normalizeFactText',
    ]);
  });

  it('the vectors defaults block equals DEFAULT_FACT_OPTIONS', () => {
    expect(vectors.defaults).toEqual(DEFAULT_FACT_OPTIONS);
  });

  it('every normalizeFactText vector is a segment array', () => {
    for (const { input, expected } of vectors.normalizeFactText) {
      expect(Array.isArray(input) && Array.isArray(expected)).toBe(true);
    }
  });

  it.each(vectors.canonicalNumber)('canonicalNumber($input) is $expected', ({ input, expected }) => {
    expect(canonicalNumber(input)).toBe(expected ?? undefined);
  });

  it.each(vectors.isTrivialLiteral)('isTrivialLiteral($input.literal, $input.kind) with defaults is $expected', ({ input, expected }) => {
    expect(isTrivialLiteral(input.literal, input.kind, DEFAULT_FACT_OPTIONS.trivialLiterals)).toBe(expected);
  });

  it.each(vectors.isTrivialLiteralCustom)('isTrivialLiteral($input.literal, $input.kind) with a custom list is $expected', ({ input, expected }) => {
    expect(isTrivialLiteral(input.literal, input.kind, input.trivialLiterals)).toBe(expected);
  });

  it.each(vectors.hasRetryTimeoutFragment)('hasRetryTimeoutFragment($input) is $expected', ({ input, expected }) => {
    expect(hasRetryTimeoutFragment(input)).toBe(expected);
  });

  it.each(vectors.matchesNormalizationPattern)('matchesNormalizationPattern($input.method, $input.qualifier) with defaults is $expected', ({ input, expected }) => {
    expect(matchesNormalizationPattern(input.method, input.qualifier, DEFAULT_FACT_OPTIONS.normalizationMethods)).toBe(expected);
  });

  it.each(vectors.matchesNormalizationPatternCustom)('matchesNormalizationPattern($input.method, $input.qualifier) with a custom list is $expected', ({ input, expected }) => {
    expect(matchesNormalizationPattern(input.method, input.qualifier, input.patterns)).toBe(expected);
  });

  it.each(vectors.normalizeFactText.map((v, i) => ({ ...v, i })))('normalizeFactText vector $i', ({ input, expected }) => {
    expect(normalizeFactText(expand(input))).toBe(expand(expected));
  });

  it.each(vectors.joinRoute)('joinRoute($input) is $expected', ({ input, expected }) => {
    expect(joinRoute(...input)).toBe(expected);
  });
});
