import { describe, expect, it } from 'vitest';
import { decodeCsharpRawString } from '../csharp-raw-string.js';

describe('decodeCsharpRawString', () => {
  it('decodes single-line, multi-line, indented, CRLF and four-quote raw strings', () => {
    expect(decodeCsharpRawString('"""abc"""')).toBe('abc');
    expect(decodeCsharpRawString('"""\nraw\n"""')).toBe('raw');
    expect(decodeCsharpRawString('"""\n    raw\n\n      more\n    """')).toBe('raw\n\n  more');
    expect(decodeCsharpRawString('"""\r\n  raw\r\n  """')).toBe('raw');
    expect(decodeCsharpRawString('""""\n"""inner"""\n""""')).toBe('"""inner"""');
    expect(decodeCsharpRawString('"""\n"""')).toBe('');
  });

  it('gives undefined for anything that is not a well-formed raw string', () => {
    expect(decodeCsharpRawString('"raw"')).toBeUndefined();
    expect(decodeCsharpRawString('""')).toBeUndefined();
    expect(decodeCsharpRawString('""""abc"""')).toBeUndefined();
    expect(decodeCsharpRawString('"""x\nraw\n"""')).toBeUndefined();
    expect(decodeCsharpRawString('"""\nraw\nx"""')).toBeUndefined();
  });
});
