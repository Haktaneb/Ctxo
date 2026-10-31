import { describe, expect, it } from 'vitest';
import { decodeGoStringLiteral } from '../go-string-literal.js';

describe('decodeGoStringLiteral', () => {
  it('a raw string is its text as written', () => {
    expect(decodeGoStringLiteral('``')).toBe('');
    expect(decodeGoStringLiteral('`gold`')).toBe('gold');
    expect(decodeGoStringLiteral(' `gold` ')).toBe('gold');
    expect(decodeGoStringLiteral('`it\'s "q"`')).toBe('it\'s "q"');
    expect(decodeGoStringLiteral('`a\nb`')).toBe('a\nb');
  });

  it('a raw string has no escapes', () => {
    expect(decodeGoStringLiteral('`a\\nb`')).toBe('a\\nb');
    expect(decodeGoStringLiteral('`\\x41`')).toBe('\\x41');
    expect(decodeGoStringLiteral('`\\`')).toBe('\\');
  });

  it('carriage returns are removed from a raw string', () => {
    expect(decodeGoStringLiteral('`a\r\nb`')).toBe('a\nb');
    expect(decodeGoStringLiteral('`a\rb`')).toBe('ab');
    expect(decodeGoStringLiteral('`\r`')).toBe('');
  });

  it('anything else is not decoded', () => {
    expect(decodeGoStringLiteral('`a`b`')).toBeUndefined();
    expect(decodeGoStringLiteral('`a')).toBeUndefined();
    expect(decodeGoStringLiteral('"gold"')).toBeUndefined();
    expect(decodeGoStringLiteral("'a'")).toBeUndefined();
    expect(decodeGoStringLiteral('abc')).toBeUndefined();
  });
});
