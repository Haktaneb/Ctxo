import { describe, expect, it } from 'vitest';
import { decodeCsharpRawString, decodeCsharpStringLiteral } from '../csharp-string-literal.js';

describe('decodeCsharpRawString', () => {
  it('decodes single-line, multi-line, indented, CRLF, empty-line and four-quote raw strings', () => {
    expect(decodeCsharpRawString('"""abc"""')).toBe('abc');
    expect(decodeCsharpRawString('"""\nraw\n"""')).toBe('raw');
    expect(decodeCsharpRawString('"""\n    raw\n\n      more\n    """')).toBe('raw\n\n  more');
    expect(decodeCsharpRawString('"""\r\n  raw\r\n  """')).toBe('raw');
    expect(decodeCsharpRawString('""""\n"""inner"""\n""""')).toBe('"""inner"""');
    expect(decodeCsharpRawString('"""\n\n"""')).toBe('');
    expect(decodeCsharpRawString('"""\n    a\n  \n    """')).toBe('a\n');
    expect(decodeCsharpRawString('""""a"""b""""')).toBe('a"""b');
  });

  it('gives undefined for anything that is not a well-formed raw string', () => {
    expect(decodeCsharpRawString('"raw"')).toBeUndefined();
    expect(decodeCsharpRawString('""')).toBeUndefined();
    expect(decodeCsharpRawString('""""abc"""')).toBeUndefined();
    expect(decodeCsharpRawString('"""x\nraw\n"""')).toBeUndefined();
    expect(decodeCsharpRawString('"""\nraw\nx"""')).toBeUndefined();
  });

  it('gives undefined for raw strings that do not compile', () => {
    // CS9002: a multi-line raw string needs a content line.
    expect(decodeCsharpRawString('"""\n"""')).toBeUndefined();
    expect(decodeCsharpRawString('"""\r\n  """')).toBeUndefined();
    // CS8999: a content line must start with the closing line's whitespace.
    expect(decodeCsharpRawString('"""\n  a\n b\n  """')).toBeUndefined();
    expect(decodeCsharpRawString('"""\n\ta\n    """')).toBeUndefined();
    // A quote run as long as the delimiter inside the content, or a quote right before the closing delimiter.
    expect(decodeCsharpRawString('"""a""" b"""')).toBeUndefined();
    expect(decodeCsharpRawString('"""\na""" b\n"""')).toBeUndefined();
    expect(decodeCsharpRawString('"""a""""')).toBeUndefined();
  });
});

describe('decodeCsharpStringLiteral', () => {
  it('decodes regular, verbatim, interpolated, u8 and raw literals', () => {
    expect(decodeCsharpStringLiteral('"a\\tb"')).toBe('a\tb');
    expect(decodeCsharpStringLiteral('@""')).toBe('');
    expect(decodeCsharpStringLiteral('@"a""b"')).toBe('a"b');
    expect(decodeCsharpStringLiteral('@"c:\\temp"')).toBe('c:\\temp');
    expect(decodeCsharpStringLiteral('$""')).toBe('');
    expect(decodeCsharpStringLiteral('"abc"u8')).toBe('abc');
    expect(decodeCsharpStringLiteral('@"abc"u8')).toBe('abc');
    expect(decodeCsharpStringLiteral('$"a{{b}}"')).toBe('a{b}');
    expect(decodeCsharpStringLiteral('$@"q""{{"')).toBe('q"{');
    expect(decodeCsharpStringLiteral('@$"q""}}"')).toBe('q"}');
    expect(decodeCsharpStringLiteral('"""\n  x\n  """')).toBe('x');
    expect(decodeCsharpStringLiteral('$"""\n  x\n  """')).toBe('x');
    expect(decodeCsharpStringLiteral('$$"""{x}"""')).toBe('{x}');
  });

  it('gives undefined for interpolation holes and malformed literals', () => {
    expect(decodeCsharpStringLiteral('$"{x}"')).toBeUndefined();
    expect(decodeCsharpStringLiteral('$"a}b"')).toBeUndefined();
    expect(decodeCsharpStringLiteral('$@"{x}"')).toBeUndefined();
    expect(decodeCsharpStringLiteral('$"""{x}"""')).toBeUndefined();
    expect(decodeCsharpStringLiteral('$"""\n  {x}\n  """')).toBeUndefined();
    expect(decodeCsharpStringLiteral('$$"""{{x}}"""')).toBeUndefined();
    expect(decodeCsharpStringLiteral('$"abc"u8')).toBeUndefined();
    expect(decodeCsharpStringLiteral('@@"a"')).toBeUndefined();
    expect(decodeCsharpStringLiteral('@"a"b"')).toBeUndefined();
    expect(decodeCsharpStringLiteral('"\\u0041"')).toBeUndefined();
    expect(decodeCsharpStringLiteral("'a'")).toBeUndefined();
    expect(decodeCsharpStringLiteral('abc')).toBeUndefined();
  });
});
