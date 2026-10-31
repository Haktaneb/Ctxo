import { describe, it, expect, vi } from 'vitest';
import { JavaAdapter } from '../java-adapter.js';
import { DEFAULT_FACT_OPTIONS } from '../facts/fact-options.js';

const FILE = 'src/main/java/com/example/Foo.java';

const SOURCE = `package com.example;

public class Foo extends Bar implements Baz {
  private int count;
  public Foo() {}
  public int add(int a, int b) { return a + b; }
}

interface Service { void run(); }
enum Color { RED, GREEN }
record Point(int x, int y) {}
@interface MyAnno {}
`;

describe('JavaAdapter.extractSymbols', () => {
  it('extracts class/interface/enum/record/annotation/method/constructor/field with mapped kinds', async () => {
    const adapter = new JavaAdapter();
    const symbols = await adapter.extractSymbols(FILE, SOURCE);
    const byName = (n: string) => symbols.find((s) => s.name === n);

    expect(byName('Foo')).toMatchObject({ kind: 'class', symbolId: `${FILE}::Foo::class` });
    expect(byName('Service')).toMatchObject({ kind: 'interface', symbolId: `${FILE}::Service::interface` });
    expect(byName('Color')).toMatchObject({ kind: 'type', symbolId: `${FILE}::Color::type` });
    expect(byName('Point')).toMatchObject({ kind: 'class', symbolId: `${FILE}::Point::class` });
    expect(byName('MyAnno')).toMatchObject({ kind: 'interface' });
    expect(byName('add')).toMatchObject({ kind: 'method' });
    const fooMethods = symbols.filter((s) => s.name === 'Foo' && s.kind === 'method');
    expect(fooMethods).toHaveLength(1); // the constructor
    expect(byName('count')).toMatchObject({ kind: 'variable' });
    expect(byName('run')).toMatchObject({ kind: 'method' });
  });

  it('indexes the members the JDT tier indexes: enum body declarations, interface constants, compact constructors, enum constant and anonymous class bodies', async () => {
    const source = [
      'interface Limits { int RETRY_LIMIT = 4, MAX = 5; void check(); }',
      '@interface Cfg { int DEFAULT_TTL = 9; }',
      'record Range(int a) { Range { } }',
      'enum Tier {',
      '  GOLD { void q() {} int bonus = 1; };',
      '  private final int rank = 0;',
      '  Tier() {}',
      '  int rank() { return rank; }',
      '}',
      'class Host {',
      '  Runnable r = new Runnable() { public void run() {} };',
      '  void m() { new Object() { int seen; void z() {} }; }',
      '}',
    ].join('\n');
    const symbols = await new JavaAdapter().extractSymbols(FILE, source);
    const ids = symbols.map((s) => s.symbolId.slice(FILE.length + 2)).sort();
    expect(ids).toEqual([
      'Cfg::interface', 'DEFAULT_TTL::variable', 'Host::class', 'Limits::interface', 'MAX::variable',
      'RETRY_LIMIT::variable', 'Range::class', 'Range::method', 'Tier::method', 'Tier::type', 'bonus::variable',
      'check::method', 'm::method', 'q::method', 'r::variable', 'rank::method', 'rank::variable', 'run::method',
      'seen::variable', 'z::method',
    ]);
    expect(symbols.find((s) => s.name === 'RETRY_LIMIT')).toMatchObject({ startLine: 0, endLine: 0 });
    expect(symbols.find((s) => s.name === 'q')).toMatchObject({ kind: 'method', startLine: 4, endLine: 4 });
  });

  it('returns [] on unparseable source without throwing', async () => {
    const adapter = new JavaAdapter();
    const symbols = await adapter.extractSymbols(FILE, 'class {{{ broken');
    expect(Array.isArray(symbols)).toBe(true);
  });
});

describe('JavaAdapter.extractEdges', () => {
  it('emits imports, extends, implements edges from the declaring type', async () => {
    const adapter = new JavaAdapter();
    const src = `package com.example;
import java.util.List;
public class Foo extends Bar implements Baz, Qux {}
`;
    const edges = await adapter.extractEdges(FILE, src);
    const kinds = edges.map((e) => e.kind);
    expect(kinds).toContain('imports');
    expect(kinds).toContain('extends');
    expect(kinds.filter((k) => k === 'implements').length).toBe(2);

    const ext = edges.find((e) => e.kind === 'extends');
    expect(ext!.from).toBe(`${FILE}::Foo::class`);
    expect(ext!.to).toBe('Bar::class');

    expect(edges.find((e) => e.kind === 'imports')!.to).toBe('java.util.List::List::class');
  });

  it('emits extends edge for interface extends-interfaces (incl. qualified)', async () => {
    const adapter = new JavaAdapter();
    const edges = await adapter.extractEdges(FILE, 'interface Sortable extends java.lang.Comparable {}');
    expect(edges.find((e) => e.kind === 'extends' && e.to.includes('Comparable'))).toBeDefined();
  });

  it('returns [] on broken source without throwing', async () => {
    const adapter = new JavaAdapter();
    expect(await adapter.extractEdges(FILE, '@@@ not java')).toEqual([]);
  });
});

describe('JavaAdapter.extractComplexity', () => {
  it('counts branches per method (base 1 + each branch)', async () => {
    const adapter = new JavaAdapter();
    const src = `class Foo {
  int f(int a) {
    if (a > 0) { return 1; }
    for (int i = 0; i < a; i++) {}
    return a > 1 ? 2 : 3;
  }
}`;
    const metrics = await adapter.extractComplexity(FILE, src);
    const f = metrics.find((m) => m.symbolId === `${FILE}::f::method`);
    expect(f).toBeDefined();
    expect(f!.cyclomatic).toBe(4);
  });

  it('counts && and || operators toward complexity', async () => {
    const adapter = new JavaAdapter();
    const src = `class Foo { int g(int a, int b) { if (a > 0 && b > 0 || a < 0) { return 1; } return 0; } }`;
    const metrics = await adapter.extractComplexity(FILE, src);
    const g = metrics.find((m) => m.symbolId === `${FILE}::g::method`);
    expect(g).toBeDefined();
    // base 1 + if 1 + && 1 + || 1 = 4
    expect(g!.cyclomatic).toBe(4);
  });
});

describe('JavaAdapter annotations (syntax tier)', () => {
  const annotationsOf = async (source: string, id: string) => {
    const symbols = await new JavaAdapter().extractSymbols(FILE, source);
    return symbols.find((s) => s.symbolId === `${FILE}::${id}`)?.annotations;
  };

  it('reads marker and string annotations on classes, fields, constructors and methods', async () => {
    const source = `@Entity @Table(name = "Loans") public class Loan {
  @Column(name = "member_id", nullable = false) private long memberId;
  @Deprecated public Loan() {}
  @GetMapping("/loans/{id}") public Loan find() { return null; }
}`;
    const symbols = await new JavaAdapter().extractSymbols(FILE, source);
    const get = (id: string) => symbols.find((s) => s.symbolId === `${FILE}::${id}`);
    expect(get('Loan::class')?.annotations).toEqual([{ name: 'Entity' }, { name: 'Table', named: { name: 'Loans' } }]);
    expect(get('memberId::variable')?.annotations).toEqual([{ name: 'Column', named: { name: 'member_id' } }]);
    expect(get('Loan::method')?.annotations).toEqual([{ name: 'Deprecated' }]);
    expect(get('find::method')?.annotations).toEqual([{ name: 'GetMapping', args: ['/loans/{id}'] }]);
  });

  it('symbols without annotations have no annotations key', async () => {
    const symbols = await new JavaAdapter().extractSymbols(FILE, 'class A { int x; void f() {} }');
    for (const s of symbols) expect(s).not.toHaveProperty('annotations');
  });

  it('qualified names keep the simple name and string arrays flatten', async () => {
    const source = `class A {
  @org.junit.jupiter.api.Tag("LEND-03") void a() {}
  @SuppressWarnings({"unchecked", "rawtypes"}) void b() {}
  @Names(value = "x", list = {"p", "q"}) void c() {}
}`;
    expect(await annotationsOf(source, 'a::method')).toEqual([{ name: 'Tag', args: ['LEND-03'] }]);
    expect(await annotationsOf(source, 'b::method')).toEqual([{ name: 'SuppressWarnings', args: ['unchecked', 'rawtypes'] }]);
    expect(await annotationsOf(source, 'c::method')).toEqual([{ name: 'Names', args: ['x'], named: { list: 'p,q' } }]);
  });

  it('escapes are decoded; text blocks and non-string values are skipped', async () => {
    const source = `class A {
  @E("a\\tb\\nc\\"d\\\\e\\'f\\sg\\u0041\\0") void a() {}
  @T(name = """
      hi
      """, other = "kept") void b() {}
  @N(n = 1, flag = true, kind = Kind.X, cls = A.class, inner = @Other("z"), id = "k") void c() {}
}`;
    expect(await annotationsOf(source, 'a::method')).toEqual([
      { name: 'E', args: ['a\tb\nc"d\\e\'f gA\0'] },
    ]);
    expect(await annotationsOf(source, 'b::method')).toEqual([{ name: 'T', named: { other: 'kept' } }]);
    expect(await annotationsOf(source, 'c::method')).toEqual([{ name: 'N', named: { id: 'k' } }]);
  });

  it('unicode escapes (also with repeated u) and octal escapes are decoded like javac', async () => {
    const source = `class A {
  // tree-sitter-java 0.23.5 does not parse the repeated-u form (\\uu0041), so it cannot be asserted here
  @U("\\u0041\\u00e9") void a() {}
  @O("\\101\\12\\7\\1234\\400") void b() {}
  @K("\\\\u0041 \\q") void c() {}
}`;
    expect(await annotationsOf(source, 'a::method')).toEqual([{ name: 'U', args: ['Aé'] }]);
    // \101 = A, \12 = LF, \7 = BEL, \123 followed by 4 = "S4", \40 followed by 0 = " 0"
    expect(await annotationsOf(source, 'b::method')).toEqual([{ name: 'O', args: ['A\n\x07S4 0'] }]);
    // an escaped backslash before u0041 is not a unicode escape; an unknown escape stays as written
    expect(await annotationsOf(source, 'c::method')).toEqual([{ name: 'K', args: ['\\u0041 \\q'] }]);
  });

  it('a member named type is dropped, a member named member is kept; first duplicate wins', async () => {
    const source = `class A {
  @M(type = "t", member = "m", name = "first", name = "second") void a() {}
}`;
    expect(await annotationsOf(source, 'a::method')).toEqual([
      { name: 'M', named: { member: 'm', name: 'first' } },
    ]);
  });

  it('a member named like an Object.prototype property is kept', async () => {
    const source = `class A {
  @M(constructor = "c", toString = "t") void a() {}
}`;
    expect(await annotationsOf(source, 'a::method')).toEqual([
      { name: 'M', named: { constructor: 'c', toString: 't' } },
    ]);
  });

  it('caps apply as in the full tier', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `@A${i}`).join(' ');
    const args = Array.from({ length: 12 }, (_, i) => `"v${i}"`).join(', ');
    const pairs = Array.from({ length: 12 }, (_, i) => `k${i} = "v${i}"`).join(', ');
    const long = 'x'.repeat(250);
    const source = `class A {
  ${many} void a() {}
  @V({${args}}) void b() {}
  @P(type = "dropped", ${pairs}) void c() {}
  @L("${long}") @LN(note = "${long}") void d() {}
}`;
    const a = await annotationsOf(source, 'a::method');
    expect(a).toHaveLength(20);
    expect(a![19]).toEqual({ name: 'A19' });
    const b = await annotationsOf(source, 'b::method');
    expect(b![0]!.args).toEqual(Array.from({ length: 10 }, (_, i) => `v${i}`));
    const c = await annotationsOf(source, 'c::method');
    expect(Object.keys(c![0]!.named!)).toEqual(Array.from({ length: 10 }, (_, i) => `k${i}`));
    const d = await annotationsOf(source, 'd::method');
    expect(d![0]!.args![0]).toHaveLength(200);
    expect(d![1]!.named!.note).toHaveLength(200);
  });
});

describe('JavaAdapter.extractFacts failure (B-M1)', () => {
  it('an internal failure is warned on stderr and gives [] (warn-and-continue)', async () => {
    const adapter = new JavaAdapter({ facts: DEFAULT_FACT_OPTIONS });
    vi.spyOn(adapter as unknown as { parse(source: string): unknown }, 'parse').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(await adapter.extractFacts('src/A.java', 'class A {}')).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toContain('[ctxo:lang-java] fact extraction failed for src/A.java: Maximum call stack size exceeded');
  });
});
