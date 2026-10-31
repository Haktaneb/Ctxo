import { describe, expect, it } from 'vitest';
import { decodeTypescriptStringLiteral } from '../typescript-string-literal.js';

describe('decodeTypescriptStringLiteral', () => {
  it('decodes single-quoted strings with the common escapes', () => {
    expect(decodeTypescriptStringLiteral("''")).toBe('');
    expect(decodeTypescriptStringLiteral("'gold'")).toBe('gold');
    expect(decodeTypescriptStringLiteral("'it\\'s'")).toBe("it's");
    expect(decodeTypescriptStringLiteral("'a\"b'")).toBe('a"b');
    expect(decodeTypescriptStringLiteral("'a\\tb\\\\'")).toBe('a\tb\\');
    expect(decodeTypescriptStringLiteral(" 'x' ")).toBe('x');
  });

  it('decodes templates without substitutions', () => {
    expect(decodeTypescriptStringLiteral('``')).toBe('');
    expect(decodeTypescriptStringLiteral('`gold`')).toBe('gold');
    expect(decodeTypescriptStringLiteral('`a\\`b`')).toBe('a`b');
    expect(decodeTypescriptStringLiteral('`\\${x}`')).toBe('${x}');
    expect(decodeTypescriptStringLiteral('`$x {y} $`')).toBe('$x {y} $');
    expect(decodeTypescriptStringLiteral('`a\nb`')).toBe('a\nb');
    expect(decodeTypescriptStringLiteral('`a\r\nb`')).toBe('a\nb');
    expect(decodeTypescriptStringLiteral("`it's \"q\"`")).toBe('it\'s "q"');
  });

  it('a template with a substitution is not a constant', () => {
    expect(decodeTypescriptStringLiteral('`${x}`')).toBeUndefined();
    expect(decodeTypescriptStringLiteral('`a${x}b`')).toBeUndefined();
    expect(decodeTypescriptStringLiteral('`\\\\${x}`')).toBeUndefined();
  });

  it('other escapes and malformed literals are not constants', () => {
    expect(decodeTypescriptStringLiteral("'\\u0041'")).toBeUndefined();
    expect(decodeTypescriptStringLiteral("'\\x41'")).toBeUndefined();
    expect(decodeTypescriptStringLiteral('`\\u0041`')).toBeUndefined();
    expect(decodeTypescriptStringLiteral("'a\nb'")).toBeUndefined();
    expect(decodeTypescriptStringLiteral("'a'b'")).toBeUndefined();
    expect(decodeTypescriptStringLiteral("'a")).toBeUndefined();
    expect(decodeTypescriptStringLiteral('`a`b`')).toBeUndefined();
    expect(decodeTypescriptStringLiteral('tag`a`')).toBeUndefined();
    expect(decodeTypescriptStringLiteral('@"a"')).toBeUndefined();
    expect(decodeTypescriptStringLiteral('abc')).toBeUndefined();
  });
});
