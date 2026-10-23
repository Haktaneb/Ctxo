import { describe, expect, it } from 'vitest';
import { DEFAULT_FACT_OPTIONS, encodeFactOptions, readFactOptions } from '../fact-options.js';

const SPEC_METHODS = [
  'ToLower*',
  'ToUpper*',
  'Trim*',
  'Normalize',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'strings.ToLower',
  'strings.TrimSpace',
  'equalsIgnoreCase',
];

describe('readFactOptions', () => {
  it('readFactOptions returns the spec defaults without config.facts', () => {
    expect(DEFAULT_FACT_OPTIONS).toEqual({ trivialLiterals: [0, 1, -1, null, true, false, ''], normalizationMethods: SPEC_METHODS });
    expect(readFactOptions(undefined)).toEqual(DEFAULT_FACT_OPTIONS);
    expect(readFactOptions({})).toEqual(DEFAULT_FACT_OPTIONS);
    expect(readFactOptions({ facts: 'yes' })).toEqual(DEFAULT_FACT_OPTIONS);
    expect(readFactOptions({ facts: null })).toEqual(DEFAULT_FACT_OPTIONS);
    expect(readFactOptions({ facts: [] })).toEqual(DEFAULT_FACT_OPTIONS);
  });

  it('readFactOptions keeps typed trivial literals and falls back per field', () => {
    expect(readFactOptions({ facts: { trivialLiterals: [0, 100, 'N/A', null], normalizationMethods: 'x' } })).toEqual({
      trivialLiterals: [0, 100, 'N/A', null],
      normalizationMethods: SPEC_METHODS,
    });
    expect(readFactOptions({ facts: { trivialLiterals: [0, { a: 1 }], normalizationMethods: ['strings.ToLower', 'Trim*'] } })).toEqual({
      trivialLiterals: DEFAULT_FACT_OPTIONS.trivialLiterals,
      normalizationMethods: ['strings.ToLower', 'Trim*'],
    });
    expect(readFactOptions({ facts: { normalizationMethods: ['a.b.c'] } }).normalizationMethods).toEqual(SPEC_METHODS);
    expect(readFactOptions({ facts: { normalizationMethods: ['*Trim'] } }).normalizationMethods).toEqual(SPEC_METHODS);
    expect(readFactOptions({ facts: { normalizationMethods: [1] } }).normalizationMethods).toEqual(SPEC_METHODS);
    expect(readFactOptions({ facts: { trivialLiterals: [true, false, ''] } }).trivialLiterals).toEqual([true, false, '']);
  });

  it('encodeFactOptions round-trips the normalization list', () => {
    const options = { trivialLiterals: [100], normalizationMethods: ['strings.ToLower', 'Trim*', 'é'] };
    const encoded = encodeFactOptions(options);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual({ normalizationMethods: ['strings.ToLower', 'Trim*', 'é'] });
  });
});
