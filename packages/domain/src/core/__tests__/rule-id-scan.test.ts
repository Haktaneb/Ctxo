import { describe, expect, it } from 'vitest';
import type { FileIndex } from '@ctxo/cli/internal';
import { DEFAULT_DOMAIN_CONFIG, type DomainConfig } from '../domain-config.js';
import type { DomainRegistry } from '../registry.js';
import {
  annotationRefs,
  buildScanOptions,
  leadingSymbol,
  resolveRuleRefs,
  scanRuleComments,
  scanTestFiles,
  scanTestText,
  type ScanOptions,
} from '../rule-id-scan.js';

function options(over: Partial<ScanOptions> = {}): ScanOptions {
  return {
    rules: { ids: new Set(['LEND-03', 'LEND-04']), prefixes: new Set(['LEND']) },
    idPattern: /^[A-Z][A-Z0-9]*-\d+$/,
    trackerPrefixes: new Set(),
    ruleTraitKeys: new Set(['Rule']),
    ...over,
  };
}

function fileIndex(symbols: FileIndex['symbols']): FileIndex {
  return { file: 'tests/LoanTests.cs', lastModified: 1, symbols, edges: [], intent: [], antiPatterns: [] };
}

const FILE = 'tests/loans.test.ts';

describe('rule-id-scan', () => {
  it('matches LEND-03, LEND03, Lend03, lend_03 and Lend03RejectsSixthLoan', () => {
    const text = ['// LEND-03 a', '// LEND03 b', '// Lend03 c', '// lend_03 d', 'void Lend03RejectsSixthLoan() {}'].join('\n');
    const refs = scanTestText(FILE, text, undefined, options());
    expect(refs.map((r) => [r.line, r.id, r.kind])).toEqual([
      [1, 'LEND-03', 'mention'],
      [2, 'LEND-03', 'mention'],
      [3, 'LEND-03', 'mention'],
      [4, 'LEND-03', 'mention'],
      [5, 'LEND-03', 'mention'],
    ]);
  });

  it('rejects look-alikes', () => {
    const text = ['LEND-030', 'XLEND-03', 'LEND-03a', 'JIRA-12'].join('\n');
    const refs = scanTestText(FILE, text, undefined, options());
    expect(refs.filter((r) => r.id === 'LEND-03')).toEqual([]);
    const { links, unknown } = resolveRuleRefs(refs, options());
    expect(links.size).toBe(0);
    expect(unknown).toEqual([]);
  });

  it('a rule: comment is structured in //, #, -- and block comments', () => {
    const text = ['// rule: LEND-03', '# rule: LEND-04', '-- rule: LEND-03', '/* rule: LEND-04 */', ' * rule: LEND-03'].join('\n');
    const refs = scanTestText(FILE, text, undefined, options());
    expect(refs.map((r) => [r.line, r.id, r.kind])).toEqual([
      [1, 'LEND-03', 'rule-comment'],
      [2, 'LEND-04', 'rule-comment'],
      [3, 'LEND-03', 'rule-comment'],
      [4, 'LEND-04', 'rule-comment'],
      [5, 'LEND-03', 'rule-comment'],
    ]);
  });

  it('captures test titles from it(), test(), describe(), t.Run(), @DisplayName and [Fact(DisplayName = ...)]', () => {
    const text = [
      `it('LEND-03 rejects a sixth loan', () => {});`,
      `test("LEND-03 holds", () => {});`,
      'describe(`LEND-04 renewals`, () => {});',
      `t.Run("LEND-03 limit", func(t *testing.T) {})`,
      `@DisplayName("LEND-04 returns")`,
      `[Fact(DisplayName = "LEND-03 counts")]`,
      `it('does not start with an id', () => {});`,
    ].join('\n');
    const refs = scanTestText(FILE, text, undefined, options());
    expect(refs.filter((r) => r.kind === 'test-title').map((r) => [r.line, r.id])).toEqual([
      [1, 'LEND-03'],
      [2, 'LEND-03'],
      [3, 'LEND-04'],
      [4, 'LEND-03'],
      [5, 'LEND-04'],
      [6, 'LEND-03'],
    ]);
    expect(refs.find((r) => r.line === 1)?.testTitle).toBe('LEND-03 rejects a sixth loan');
    expect(refs.some((r) => r.line === 7)).toBe(false);
  });

  it('a rule: comment or a title ID followed by more id characters is a different ID, not LEND-03 (M5)', () => {
    const text = ['// rule: LEND-03a', `it('LEND-03a holds', () => {});`, '// rule: LEND-030', `it('LEND-030 holds', () => {});`].join('\n');
    const refs = scanTestText(FILE, text, undefined, options());
    const structured = refs.filter((r) => r.kind === 'rule-comment' || r.kind === 'test-title');
    expect(structured.map((r) => r.id)).not.toContain('LEND-03');
    const { links } = resolveRuleRefs(refs, options());
    expect(links.has('LEND-03')).toBe(false);

    const exact = scanTestText(FILE, ['// rule: LEND-03.', `it('LEND-03: holds', () => {});`].join('\n'), undefined, options());
    expect(exact.filter((r) => r.id === 'LEND-03').map((r) => r.kind).sort()).toEqual(['rule-comment', 'test-title']);
  });

  it('a title starting with an ID is structured, a title merely mentioning one is not', () => {
    const trackers = options({ trackerPrefixes: new Set(['LEND']) });
    const refs = scanTestText(FILE, [`it('LEND-03 holds', () => {});`, `it('see LEND-04', () => {});`].join('\n'), undefined, trackers);
    const { links } = resolveRuleRefs(refs, trackers);
    expect([...links.keys()]).toEqual(['LEND-03']);
  });

  it('[Trait("Rule", "LEND-03")] links through the annotation', () => {
    const index = fileIndex([
      {
        symbolId: 'tests/LoanTests.cs::RejectsSixth::method',
        name: 'RejectsSixth',
        kind: 'method',
        startLine: 3,
        endLine: 8,
        annotations: [{ name: 'Fact' }, { name: 'Trait', args: ['Rule', 'LEND-03'] }],
      },
    ]);
    const refs = annotationRefs(index, options());
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: 'LEND-03', kind: 'annotation', line: 4, symbolId: 'tests/LoanTests.cs::RejectsSixth::method' });
    const text = ['', '', '', '    [Trait("Rule", "LEND-03")]', '    public void RejectsSixth() {}'].join('\n');
    const scanned = scanTestText(index.file, text, index, options());
    expect(scanned.filter((r) => r.id === 'LEND-03').map((r) => r.kind)).toEqual(['annotation']);
    expect(resolveRuleRefs(scanned, options()).links.get('LEND-03')).toHaveLength(1);
  });

  it('other trait keys do not produce references; Category, TestCategory and Tag do', () => {
    const index = fileIndex([
      {
        symbolId: 'tests/LoanTests.cs::A::method',
        name: 'A',
        kind: 'method',
        startLine: 1,
        endLine: 2,
        annotations: [
          { name: 'Trait', args: ['Owner', 'LEND-03'] },
          { name: 'Category', args: ['LEND-03'] },
          { name: 'TestCategory', args: ['LEND-04'] },
          { name: 'Tag', args: ['lend_03'] },
        ],
      },
    ]);
    expect(annotationRefs(index, options()).map((r) => [r.id, r.kind])).toEqual([
      ['LEND-03', 'category'],
      ['LEND-04', 'category'],
      ['LEND-03', 'category'],
    ]);
  });

  it('links only to IDs that exist in cards', () => {
    const refs = scanTestText(FILE, ['// rule: LEND-03', '// rule: LEND-99'].join('\n'), undefined, options());
    const { links, unknown } = resolveRuleRefs(refs, options());
    expect([...links.keys()]).toEqual(['LEND-03']);
    expect(unknown.map((r) => r.id)).toEqual(['LEND-99']);
  });

  it('plain mentions never produce unknown IDs', () => {
    const refs = scanTestText(FILE, '// see LEND-99 and JIRA-12 and LEND-030\n', undefined, options());
    const { links, unknown } = resolveRuleRefs(refs, options());
    expect(links.size).toBe(0);
    expect(unknown).toEqual([]);
  });

  it('with LEND as a tracker prefix, a comment mentioning LEND-456 neither links nor counts as unknown, and a structured LEND-03 still links', () => {
    const o = options({ trackerPrefixes: new Set(['LEND']) });
    const text = ['// fixes LEND-456', '// covers LEND-03', '// rule: LEND-03'].join('\n');
    const { links, unknown } = resolveRuleRefs(scanTestText(FILE, text, undefined, o), o);
    expect([...links.keys()]).toEqual(['LEND-03']);
    expect(links.get('LEND-03')?.map((r) => r.kind)).toEqual(['rule-comment']);
    expect(unknown).toEqual([]);
  });

  it('an unknown ID in a rule-trait annotation or a rule: comment is unknown whatever its prefix', () => {
    const index = fileIndex([
      {
        symbolId: 'tests/LoanTests.cs::A::method',
        name: 'A',
        kind: 'method',
        startLine: 2,
        endLine: 3,
        annotations: [{ name: 'Trait', args: ['Rule', 'ZED-7'] }],
      },
    ]);
    const o = options({ trackerPrefixes: new Set(['ZED']) });
    const refs = scanTestText(index.file, '// rule: QUX-1\n[Trait("Rule", "ZED-7")]\n', index, o);
    expect(resolveRuleRefs(refs, o).unknown.map((r) => r.id).sort()).toEqual(['QUX-1', 'ZED-7']);
  });

  it('an unknown title ID counts only for rule prefixes, and an unknown category ID never counts (PF13)', () => {
    const text = [`it('LEND-99 is unknown', () => {});`, `it('ZED-5 is a ticket', () => {});`].join('\n');
    const index = fileIndex([
      {
        symbolId: 'tests/LoanTests.cs::A::method',
        name: 'A',
        kind: 'method',
        startLine: 5,
        endLine: 6,
        annotations: [{ name: 'Category', args: ['LEND-98'] }],
      },
    ]);
    const refs = scanTestText(index.file, text, index, options());
    expect(resolveRuleRefs(refs, options()).unknown.map((r) => r.id)).toEqual(['LEND-99']);
  });

  it('links to the innermost symbol spanning the line, else to the file', () => {
    const index = fileIndex([
      { symbolId: 'outer', name: 'outer', kind: 'class', startLine: 0, endLine: 9 },
      { symbolId: 'inner', name: 'inner', kind: 'method', startLine: 2, endLine: 4 },
    ]);
    const text = ['', '// LEND-03 in outer', '// LEND-04 in inner', '', '', '', '', '', '', '', '', '// LEND-03 outside'].join('\n');
    const refs = scanTestText(index.file, text, index, options());
    expect(refs.map((r) => [r.line, r.symbolId])).toEqual([
      [2, 'outer'],
      [3, 'inner'],
      [12, undefined],
    ]);
  });

  it('index lines are 0-based: the line above a symbol is not in it, its last line is', () => {
    const index = fileIndex([{ symbolId: 'sym', name: 'sym', kind: 'method', startLine: 3, endLine: 5 }]);
    // 1-based file lines 4..6 belong to the symbol.
    const text = ['', '', '// LEND-03 above', '// LEND-03 first', '', '// LEND-03 last', '// LEND-03 below'].join('\n');
    const refs = scanTestText(index.file, text, index, options());
    expect(refs.map((r) => [r.line, r.symbolId])).toEqual([
      [3, undefined],
      [4, 'sym'],
      [6, 'sym'],
      [7, undefined],
    ]);
  });

  it('a long file with CRLF line endings keeps line numbers', () => {
    const refs = scanTestText(FILE, 'a\r\nb\r\n// rule: LEND-03\r\n', undefined, options());
    expect(refs[0]?.line).toBe(3);
  });

  it.each([
    [{ name: 'Trait', args: ['Rule', 'LEND-03'] }, 'annotation', 'Trait'],
    [{ name: 'Category', args: ['LEND-03'] }, 'category', 'Category'],
    [{ name: 'TestCategory', args: ['LEND-03'] }, 'category', 'TestCategory'],
    [{ name: 'Tag', args: ['LEND-03'] }, 'category', 'Tag'],
  ])('annotation and category refs carry the annotation name (%o)', (annotation, kind, name) => {
    const index = fileIndex([
      { symbolId: 'tests/LoanTests.cs::A::method', name: 'A', kind: 'method', startLine: 1, endLine: 2, annotations: [annotation] },
    ]);
    const refs = annotationRefs(index, options());
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: 'LEND-03', kind, annotation: name });
  });

  it('leadingSymbol prefers a symbol starting within three lines after the comment, else the innermost spanning symbol', () => {
    // Index lines are 0-based and `line` is 1-based: the class covers file lines 1 to 21, the method file lines 6 to 10.
    const index = fileIndex([
      { symbolId: 'class', name: 'C', kind: 'class', startLine: 0, endLine: 20 },
      { symbolId: 'method', name: 'm', kind: 'method', startLine: 5, endLine: 9 },
    ]);
    expect(leadingSymbol(index, 3)).toBe('method');
    expect(leadingSymbol(index, 5)).toBe('method');
    expect(leadingSymbol(index, 2)).toBe('class'); // the method starts four lines later
    expect(leadingSymbol(index, 13)).toBe('class');
    expect(leadingSymbol(index, 31)).toBeUndefined();
    expect(leadingSymbol(undefined, 3)).toBeUndefined();
  });

  it('leadingSymbol takes the nearest start, then the smallest span, then index order', () => {
    const index = fileIndex([
      { symbolId: 'far', name: 'far', kind: 'method', startLine: 4, endLine: 5 },
      { symbolId: 'wide', name: 'wide', kind: 'class', startLine: 3, endLine: 9 },
      { symbolId: 'narrow', name: 'narrow', kind: 'method', startLine: 3, endLine: 4 },
      { symbolId: 'narrow2', name: 'narrow2', kind: 'method', startLine: 3, endLine: 4 },
    ]);
    expect(leadingSymbol(index, 2)).toBe('narrow');
  });

  it('a rule: comment inside a short method body links to its own method, not to the next one (I1)', () => {
    // File lines: 1 class, 2 canBorrow(a) {, 3 // rule: LEND-03, 4 return, 5 }, 6 other() {...}, 8 }.
    const index = fileIndex([
      { symbolId: 'class', name: 'C', kind: 'class', startLine: 0, endLine: 7 },
      { symbolId: 'canBorrow', name: 'canBorrow', kind: 'method', startLine: 1, endLine: 4 },
      { symbolId: 'other', name: 'other', kind: 'method', startLine: 5, endLine: 6 },
    ]);
    expect(leadingSymbol(index, 3)).toBe('canBorrow');
    const text = [
      'class C {',
      '  canBorrow(a) {',
      '    // rule: LEND-03',
      '    return a.activeLoans < 5;',
      '  }',
      '  other() {',
      '  }',
      '}',
    ].join('\n');
    expect(scanRuleComments('src/c.ts', text, index, options()).map((r) => r.symbolId)).toEqual(['canBorrow']);
  });

  it('a rule: comment on the last body line, followed by } and the next declaration, stays with its method (I1)', () => {
    const index = fileIndex([
      { symbolId: 'class', name: 'C', kind: 'class', startLine: 0, endLine: 8 },
      { symbolId: 'first', name: 'first', kind: 'method', startLine: 1, endLine: 4 },
      { symbolId: 'second', name: 'second', kind: 'method', startLine: 5, endLine: 7 },
    ]);
    // File line 4 is the last body line of `first`; `second` starts two lines later.
    expect(leadingSymbol(index, 4)).toBe('first');
    // Two adjacent methods with no blank line: a comment on `first`'s line 2 sees `second` three lines down.
    const tight = fileIndex([
      { symbolId: 'first', name: 'first', kind: 'method', startLine: 0, endLine: 2 },
      { symbolId: 'second', name: 'second', kind: 'method', startLine: 3, endLine: 5 },
    ]);
    expect(leadingSymbol(tight, 2)).toBe('first');
    // Between two top-level methods no symbol spans the comment, so the declaration below it wins.
    const gap = fileIndex([
      { symbolId: 'first', name: 'first', kind: 'method', startLine: 0, endLine: 1 },
      { symbolId: 'second', name: 'second', kind: 'method', startLine: 3, endLine: 5 },
    ]);
    expect(leadingSymbol(gap, 3)).toBe('second');
  });

  it('a rule: comment inside a test body links to its own test, not to the next one (I1)', () => {
    const index = fileIndex([
      { symbolId: 'tests/LoanTests.cs::LoanTests::class', name: 'LoanTests', kind: 'class', startLine: 0, endLine: 8 },
      { symbolId: 'tests/LoanTests.cs::LoanTests.A::method', name: 'A', kind: 'method', startLine: 1, endLine: 4 },
      { symbolId: 'tests/LoanTests.cs::LoanTests.B::method', name: 'B', kind: 'method', startLine: 5, endLine: 7 },
    ]);
    const text = ['class LoanTests {', '  void A() {', '    // rule: LEND-03', '    Assert();', '  }', '  void B() {', '  }', '  ', '}'].join('\n');
    expect(scanTestText(index.file, text, index, options()).filter((r) => r.kind === 'rule-comment').map((r) => r.symbolId)).toEqual([
      'tests/LoanTests.cs::LoanTests.A::method',
    ]);
  });

  it('a rule: comment above a test method links to the method', () => {
    const index = fileIndex([
      { symbolId: 'tests/LoanTests.cs::LoanTests::class', name: 'LoanTests', kind: 'class', startLine: 0, endLine: 6 },
      { symbolId: 'tests/LoanTests.cs::LoanTests.RejectsSixth::method', name: 'RejectsSixth', kind: 'method', startLine: 3, endLine: 5 },
    ]);
    const text = ['public class LoanTests', '{', '    // rule: LEND-03', '    [Fact]', '    public void RejectsSixth()', '    {}', '}'].join('\n');
    const refs = scanTestText(index.file, text, index, options());
    expect(refs.filter((r) => r.kind === 'rule-comment')).toEqual([
      { file: index.file, line: 3, raw: 'LEND-03', id: 'LEND-03', kind: 'rule-comment', symbolId: 'tests/LoanTests.cs::LoanTests.RejectsSixth::method' },
    ]);
  });

  it('a mention above a test method still links to the innermost spanning symbol', () => {
    const index = fileIndex([
      { symbolId: 'class', name: 'C', kind: 'class', startLine: 0, endLine: 6 },
      { symbolId: 'method', name: 'm', kind: 'method', startLine: 3, endLine: 5 },
    ]);
    const text = ['class C', '{', '    // covers LEND-03', '    void m()', '    {', '    }', '}'].join('\n');
    expect(scanTestText(index.file, text, index, options()).map((r) => [r.kind, r.symbolId])).toEqual([['mention', 'class']]);
  });

  it('buildScanOptions collects card prefixes and registry rule prefixes', () => {
    const config: DomainConfig = {
      ...DEFAULT_DOMAIN_CONFIG,
      rules: { idPattern: '^[A-Z]+-\\d+$', trackerPrefixes: ['JIRA'] },
      tests: { ...DEFAULT_DOMAIN_CONFIG.tests, ruleTraitKeys: ['Rule', 'Requirement'] },
    };
    const context = (id: string, rulePrefix?: string) => ({
      id,
      name: id,
      paths: [],
      rung: 'core' as const,
      contracts: {},
      ...(rulePrefix === undefined ? {} : { rulePrefix }),
    });
    const registry: DomainRegistry = {
      version: 1,
      contexts: [context('lending', 'LEND'), context('billing', 'BILL'), context('misc')],
      unownedAllow: [],
      glossary: 'docs/domain/glossary.md',
      contextMap: 'docs/domain/context-map.md',
    };
    const o = buildScanOptions(config, ['LEND-03', 'CAT-1', 'LEND-04'], registry);
    expect([...o.rules.ids].sort()).toEqual(['CAT-1', 'LEND-03', 'LEND-04']);
    expect([...o.rules.prefixes].sort()).toEqual(['BILL', 'CAT', 'LEND']);
    expect(o.idPattern.source).toBe('^[A-Z]+-\\d+$');
    expect([...o.trackerPrefixes]).toEqual(['JIRA']);
    expect([...o.ruleTraitKeys]).toEqual(['Rule', 'Requirement']);
  });

  it('buildScanOptions falls back to the default ID pattern when the configured one does not compile', () => {
    const config: DomainConfig = { ...DEFAULT_DOMAIN_CONFIG, rules: { idPattern: '([', trackerPrefixes: [] } };
    const o = buildScanOptions(config, [], undefined);
    expect(o.idPattern.source).toBe(new RegExp(DEFAULT_DOMAIN_CONFIG.rules.idPattern).source);
    expect(o.rules.prefixes.size).toBe(0);
  });

  it('scanTestFiles scans every test text and adds annotation refs only for indexed test files without a text (P15)', () => {
    const scanned = fileIndex([
      {
        symbolId: 'tests/LoanTests.cs::A::method',
        name: 'A',
        kind: 'method',
        startLine: 1,
        endLine: 2,
        annotations: [{ name: 'Trait', args: ['Rule', 'LEND-03'] }],
      },
    ]);
    const unread: FileIndex = {
      ...fileIndex([
        { symbolId: 'tests/Other.cs::B::method', name: 'B', kind: 'method', startLine: 0, endLine: 1, annotations: [{ name: 'Category', args: ['LEND-04'] }] },
      ]),
      file: 'tests\\Other.cs',
    };
    const production: FileIndex = {
      ...fileIndex([
        { symbolId: 'src/Loan.cs::C::method', name: 'C', kind: 'method', startLine: 0, endLine: 1, annotations: [{ name: 'Category', args: ['LEND-04'] }] },
      ]),
      file: 'src/Loan.cs',
    };
    const refs = scanTestFiles(
      [{ file: 'tests/LoanTests.cs', text: '// rule: LEND-04\n[Trait("Rule", "LEND-03")]\n', index: scanned }],
      [scanned, unread, production],
      (file) => file.startsWith('tests'),
      options(),
    );
    expect(refs.map((r) => [r.file, r.id, r.kind])).toEqual([
      ['tests/LoanTests.cs', 'LEND-04', 'rule-comment'],
      ['tests/LoanTests.cs', 'LEND-03', 'annotation'],
      ['tests\\Other.cs', 'LEND-04', 'category'],
    ]);
  });

  it('scanRuleComments finds rule: comments in //, #, --, block and * lines and ignores plain mentions', () => {
    const text = [
      '// rule: LEND-03',
      '# rule: LEND-04',
      '-- rule: LEND-03',
      '/* rule: LEND-04 */',
      ' * rule: LEND-03',
      '// covers LEND-03',
      "const title = 'LEND-04 holds';",
      'rule: LEND-03',
      '// rule: JIRA-12',
    ].join('\n');
    const refs = scanRuleComments('src/Loan.ts', text, undefined, options());
    expect(refs.map((r) => [r.line, r.id, r.kind])).toEqual([
      [1, 'LEND-03', 'rule-comment'],
      [2, 'LEND-04', 'rule-comment'],
      [3, 'LEND-03', 'rule-comment'],
      [4, 'LEND-04', 'rule-comment'],
      [5, 'LEND-03', 'rule-comment'],
      [9, 'JIRA-12', 'rule-comment'],
    ]);
    expect(refs.every((r) => r.file === 'src/Loan.ts')).toBe(true);
  });

  it('a single-line JSDoc /** rule: X */ and a block /* rule: X */ are rule: comments', () => {
    const text = ['/** rule: LEND-03 */', '/* rule: LEND-04 */', '/***rule: LEND-03*/', '/**', ' * rule: LEND-04', ' */'].join('\n');
    expect(scanRuleComments('src/Loan.ts', text, undefined, options()).map((r) => [r.line, r.id])).toEqual([
      [1, 'LEND-03'],
      [2, 'LEND-04'],
      [3, 'LEND-03'],
      [5, 'LEND-04'],
    ]);
    expect(scanTestText(FILE, '/** rule: LEND-03 */\n', undefined, options()).map((r) => r.kind)).toEqual(['rule-comment']);
  });

  it('a rule: comment with its ID on the next line links nothing (P16)', () => {
    const text = ['// rule:', 'LEND-03 is not here', '#  rule:\t', '\tLEND-04', '//', 'rule: LEND-03'].join('\n');
    expect(scanRuleComments('src/Loan.ts', text, undefined, options())).toEqual([]);
    expect(scanTestText(FILE, text, undefined, options()).filter((r) => r.kind === 'rule-comment')).toEqual([]);
  });

  it('a rule: comment above three or more stacked attributes links to the method whose span starts at the first attribute', () => {
    // Roslyn, tree-sitter and ts-morph report attribute-inclusive spans: the method starts at its first attribute.
    const index: FileIndex = {
      ...fileIndex([
        { symbolId: 'src/Loan.cs::LoanPolicy::class', name: 'LoanPolicy', kind: 'class', startLine: 0, endLine: 10 },
        { symbolId: 'src/Loan.cs::LoanPolicy.CanBorrow::method', name: 'CanBorrow', kind: 'method', startLine: 3, endLine: 8 },
      ]),
      file: 'src/Loan.cs',
    };
    const text = [
      'public class LoanPolicy',
      '{',
      '    // rule: LEND-03',
      '    [Obsolete]',
      '    [Pure]',
      '    [MethodImpl(MethodImplOptions.NoInlining)]',
      '    [DebuggerStepThrough]',
      '    public bool CanBorrow()',
      '    {}',
      '}',
    ].join('\n');
    expect(scanRuleComments(index.file, text, index, options()).map((r) => [r.line, r.symbolId])).toEqual([
      [3, 'src/Loan.cs::LoanPolicy.CanBorrow::method'],
    ]);
    expect(scanTestText(index.file, text, index, options()).filter((r) => r.kind === 'rule-comment').map((r) => r.symbolId)).toEqual([
      'src/Loan.cs::LoanPolicy.CanBorrow::method',
    ]);
  });
});
