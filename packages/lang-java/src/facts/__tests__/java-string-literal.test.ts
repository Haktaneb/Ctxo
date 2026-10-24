import { describe, expect, it } from 'vitest';
import { decodeJavaStringLiteral } from '../java-string-literal.js';

describe('decodeJavaStringLiteral', () => {
  it('a closing delimiter on its own line keeps the final newline and counts toward the indentation', () => {
    expect(decodeJavaStringLiteral('"""\n    raw\n    """')).toBe('raw\n');
    expect(decodeJavaStringLiteral('"""\n    raw\n  """')).toBe('  raw\n');
    expect(decodeJavaStringLiteral('"""\n    raw\n"""')).toBe('    raw\n');
    expect(decodeJavaStringLiteral('"""\n    raw\n        """')).toBe('raw\n');
    expect(decodeJavaStringLiteral('"""\n    raw"""')).toBe('raw');
  });

  it('strips the common indentation and trailing whitespace; blank lines become empty', () => {
    expect(decodeJavaStringLiteral('"""\n  SELECT *\n    FROM loans   \n\n  """')).toBe('SELECT *\n  FROM loans\n\n');
    expect(decodeJavaStringLiteral('"""\n\ta\n    """')).toBe('a\n');
    expect(decodeJavaStringLiteral('"""\n  a\n \n  b"""')).toBe('a\n\nb');
  });

  it('normalizes CR and CRLF line breaks to LF before stripping', () => {
    expect(decodeJavaStringLiteral('"""\r\n    a\r\n    b\r\n    """')).toBe('a\nb\n');
    expect(decodeJavaStringLiteral('"""\r    a\r    """')).toBe('a\n');
  });

  it('translates escapes after stripping', () => {
    expect(decodeJavaStringLiteral('"""\n  a\\tb\\s\n  """')).toBe('a\tb \n');
    expect(decodeJavaStringLiteral('"""\n  one \\\n  two"""')).toBe('one two');
    expect(decodeJavaStringLiteral('"""\n\\101\\60\\0"""')).toBe('A0\u0000');
    expect(decodeJavaStringLiteral('"""\n\\\\u0041"""')).toBe('\\u0041');
    expect(decodeJavaStringLiteral('"""\n  \\"""x\n  """')).toBe('"""x\n');
    expect(decodeJavaStringLiteral('"""\n  say "hi" and ""twice""\n  """')).toBe('say "hi" and ""twice""\n');
  });

  it('the empty text block and an opening line with trailing blanks', () => {
    expect(decodeJavaStringLiteral('"""\n"""')).toBe('');
    expect(decodeJavaStringLiteral('"""  \t\n  gold"""')).toBe('gold');
    expect(decodeJavaStringLiteral('  """\n  x"""  ')).toBe('x');
  });

  it('forms that do not compile, Unicode escapes and other escapes are not constants', () => {
    expect(decodeJavaStringLiteral('"""abc"""')).toBeUndefined();
    expect(decodeJavaStringLiteral('""""""')).toBeUndefined();
    expect(decodeJavaStringLiteral('"""\nab""""')).toBeUndefined();
    expect(decodeJavaStringLiteral('"""\nab\\"""')).toBeUndefined();
    expect(decodeJavaStringLiteral('"""\na"""b\n"""')).toBeUndefined();
    expect(decodeJavaStringLiteral('"""\n\\u0041"""')).toBeUndefined();
    expect(decodeJavaStringLiteral('"""\n\\q"""')).toBeUndefined();
    expect(decodeJavaStringLiteral('"""\n"')).toBeUndefined();
    expect(decodeJavaStringLiteral('"plain"')).toBeUndefined();
    expect(decodeJavaStringLiteral("'c'")).toBeUndefined();
  });
});
