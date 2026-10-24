import { describe, expect, it } from 'vitest';
import { commentStyleFor, lexSource, stringDecoderFor } from '../text-lexer.js';
import type { CommentStyle, TextToken } from '../text-lexer.js';

const words = (text: string, style: CommentStyle = 'c'): string[] => lexSource(text, style).filter((t) => t.kind === 'word').map((t) => t.text);
const strings = (text: string, style: CommentStyle): string[] => lexSource(text, style).filter((t) => t.kind === 'string').map((t) => t.text);

describe('commentStyleFor', () => {
  it('maps extensions to their comment style, case-insensitively, with c as the fallback', () => {
    for (const file of ['a.kt', 'a.kts', 'a.rs', 'a.scala', 'a.swift', 'src/A.KT']) expect(commentStyleFor(file), file).toBe('c-nested');
    for (const file of ['a.ex', 'a.exs', 'a.pl', 'a.py', 'a.r', 'a.rb', 'a.sh']) expect(commentStyleFor(file), file).toBe('hash');
    expect(commentStyleFor('web/index.php')).toBe('php');
    expect(commentStyleFor('db/x.sql')).toBe('sql');
    for (const file of ['a.dart', 'a.groovy', 'a.lend', 'Makefile', 'a.cs']) expect(commentStyleFor(file), file).toBe('c');
  });
});

describe('lexSource', () => {
  it('comments are dropped and strings stay whole', () => {
    expect(words('// if (x > 5)\n/* timeout = 30 */\ns = "if (x > 5)"')).toEqual(['s']);
    expect(strings('s = "if (x > 5)"', 'c')).toEqual(['"if (x > 5)"']);
  });

  it('a URL inside a string is not a comment', () => {
    const tokens = lexSource('u = "http://x" + y', 'c');
    expect(tokens.map((t) => t.text)).toEqual(['u', '=', '"http://x"', '+', 'y']);
  });

  it('nested block comments in Kotlin', () => {
    expect(words('/* a /* b */ c */ if', commentStyleFor('src/A.kt'))).toEqual(['if']);
    // Not nested in the c style: the first */ ends the comment.
    expect(words('/* a /* b */ c */ if', 'c')).toEqual(['c', 'if']);
  });

  it('Python docstrings and # comments give no words', () => {
    expect(words('"""timeout = 30"""\n# retries = 3\nx = 1', 'hash')).toEqual(['x']);
    expect(words("'''timeout\n= 30'''\nx = 1", 'hash')).toEqual(['x']);
    expect(strings('"""timeout = 30"""', 'hash')).toEqual(['"""timeout = 30"""']);
  });

  it('SQL comments are dropped in .sql files', () => {
    expect(commentStyleFor('db/x.sql')).toBe('sql');
    const found = words('-- if x > 5\n/* timeout = 30 */\nSELECT 1', 'sql');
    expect(found).not.toContain('if');
    expect(found).not.toContain('timeout');
    expect(found).toEqual(['SELECT']);
    const tokens = lexSource("SELECT 'a -- b' -- c", 'sql');
    expect(tokens.map((t) => t.text)).toEqual(['SELECT', "'a -- b'"]);
  });

  it('a doubled quote escapes inside a SQL string', () => {
    expect(lexSource("x = 'it''s'", 'sql').map((t) => t.text)).toEqual(['x', '=', "'it''s'"]);
    expect(lexSource("x = 'C:\\' AND y = 1", 'sql').map((t) => t.text)).toEqual(['x', '=', "'C:\\'", 'AND', 'y', '=', '1']);
  });

  it('PHP has // and # comments, but #[ is an attribute', () => {
    expect(words('# a\n// b\n/* c */ x', 'php')).toEqual(['x']);
    expect(words('#[Route("/x")] f', 'php')).toEqual(['Route', 'f']);
  });

  it('unterminated strings and comments never throw', () => {
    for (const style of ['c', 'c-nested', 'hash', 'php', 'sql'] as const) {
      for (const text of ['"abc', "'abc", '`abc', '"""abc', "'''abc", '/* abc', '/* a /* b */', '\\', '"\\', "'it''", '', '\u{1F600}']) {
        expect(() => lexSource(text, style), `${style}: ${text}`).not.toThrow();
      }
    }
    expect(lexSource('/* never closed\nif x > 5', 'c')).toEqual([]);
  });

  it('a string ending in a backslash at the end of the text ends at the text length', () => {
    for (const style of ['c', 'c-nested', 'hash', 'php'] as const) {
      // Backticks are no string in the hash style.
      for (const text of ['x = "abc\\', "x = 'abc\\", ...(style === 'hash' ? [] : ['x = `abc\\']), 'x = """abc\\']) {
        const tokens = lexSource(text, style);
        const last = tokens[tokens.length - 1]!;
        expect(last.end, `${style}: ${text}`).toBe(text.length);
        expect(last.text).toBe(text.slice(4));
      }
    }
  });

  it("''' strings span lines in the c style (Dart, Groovy)", () => {
    const tokens = lexSource("def q = '''\nif retries > 5\n'''\nx", commentStyleFor('src/Billing/q.groovy'));
    expect(tokens.map((t) => [t.kind, t.text, t.line])).toEqual([
      ['word', 'def', 0], ['word', 'q', 0], ['op', '=', 0], ['string', "'''\nif retries > 5\n'''", 0], ['word', 'x', 3],
    ]);
    expect(stringDecoderFor('c')("''''''")).toBe('');
  });

  it('a lone quote does not swallow later lines', () => {
    // On one line two lifetimes pair up as a string; the next line is never swallowed.
    expect(words("fn f<'a>(x: &'a str)\nif y", 'c-nested')).toEqual(['fn', 'f', 'a', 'str', 'if', 'y']);
    expect(words("fn g<'a>(x: u8)\nif y", 'c-nested')).toEqual(['fn', 'g', 'if', 'y']);
    expect(words("c = 'x\nif y", 'c')).toEqual(['c', 'if', 'y']);
    expect(words('s = "open\nif y', 'php')).toEqual(['s', 'if', 'y']);
  });

  it('backticks and triple quotes span lines, single-line strings do not', () => {
    const tokens = lexSource('a = `x\ny`\nb = """p\nq"""\nc', 'c');
    expect(tokens.map((t) => [t.text, t.line])).toEqual([
      ['a', 0], ['=', 0], ['`x\ny`', 0], ['b', 2], ['=', 2], ['"""p\nq"""', 2], ['c', 4],
    ]);
  });

  it('lines are 0-based across CRLF', () => {
    const tokens = lexSource('a\r\nb\r\n\r\nc', 'c');
    expect(tokens.map((t) => [t.text, t.line])).toEqual([['a', 0], ['b', 1], ['c', 3]]);
  });

  it('tokens carry UTF-16 offsets into the text', () => {
    const tokens = lexSource('ab == 12', 'c');
    expect(tokens.map((t: TextToken) => [t.kind, t.start, t.end])).toEqual([['word', 0, 2], ['op', 3, 5], ['number', 6, 8]]);
    expect(lexSource('é\u{1F600} = 0x1F', 'c').map((t) => [t.kind, t.text, t.start, t.end])).toEqual([
      ['word', 'é', 0, 1], ['punct', '\u{1F600}', 1, 3], ['op', '=', 4, 5], ['number', '0x1F', 6, 10],
    ]);
  });

  it('words take Unicode letters, digits, _ and $; numbers take the FC-7 literal forms', () => {
    const tokens = lexSource('$ñame_1 = 1_000.5e-3f + 0b1010 + 0o17 + 0xFFL + 30m + .5', 'c');
    expect(tokens.filter((t) => t.kind === 'word').map((t) => t.text)).toEqual(['$ñame_1']);
    expect(tokens.filter((t) => t.kind === 'number').map((t) => t.text)).toEqual(['1_000.5e-3f', '0b1010', '0o17', '0xFFL', '30m', '.5']);
    // A number running into letters is not a number.
    expect(lexSource('5px', 'c').map((t) => t.kind)).toEqual(['word']);
  });

  it('multi-character operators are single tokens', () => {
    const ops = lexSource('a === b !== c == d != e <= f >= g => h -> i :: j && k || l := m ** n', 'c').filter((t) => t.kind === 'op').map((t) => t.text);
    expect(ops).toEqual(['===', '!==', '==', '!=', '<=', '>=', '=>', '->', '::', '&&', '||', ':=', '**']);
  });
});

describe('stringDecoderFor (W5)', () => {
  it('decodes the lexer string forms', () => {
    const c = stringDecoderFor('c');
    expect(c("''")).toBe('');
    expect(c("'a\\'b'")).toBe("a'b");
    expect(c('``')).toBe('');
    expect(c('`a${b}`')).toBeUndefined();
    expect(c('""""""')).toBe('');
    const hash = stringDecoderFor('hash');
    expect(hash("''''''")).toBe('');
    expect(hash("'x'")).toBe('x');
    expect(hash("f'x'")).toBeUndefined();
    const sql = stringDecoderFor('sql');
    expect(sql("''")).toBe('');
    expect(sql("'it''s'")).toBe("it's");
    expect(sql("'C:\\'")).toBe('C:\\');
  });

  it('an unterminated string is not a constant', () => {
    expect(stringDecoderFor('c')("'abc")).toBeUndefined();
    expect(stringDecoderFor('sql')("'abc")).toBeUndefined();
    expect(stringDecoderFor('hash')('"""abc')).toBeUndefined();
  });
});
