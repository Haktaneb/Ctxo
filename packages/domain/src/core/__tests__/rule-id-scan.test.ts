import { describe, expect, it } from 'vitest';
import type { FileIndex } from '@ctxo/cli/internal';
import { annotationRefs, resolveRuleRefs, scanTestText, type ScanOptions } from '../rule-id-scan.js';

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
        startLine: 4,
        endLine: 9,
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
      { symbolId: 'outer', name: 'outer', kind: 'class', startLine: 1, endLine: 10 },
      { symbolId: 'inner', name: 'inner', kind: 'method', startLine: 3, endLine: 5 },
    ]);
    const text = ['', '// LEND-03 in outer', '// LEND-04 in inner', '', '', '', '', '', '', '', '', '// LEND-03 outside'].join('\n');
    const refs = scanTestText(index.file, text, index, options());
    expect(refs.map((r) => [r.line, r.symbolId])).toEqual([
      [2, 'outer'],
      [3, 'inner'],
      [12, undefined],
    ]);
  });

  it('a long file with CRLF line endings keeps line numbers', () => {
    const refs = scanTestText(FILE, 'a\r\nb\r\n// rule: LEND-03\r\n', undefined, options());
    expect(refs[0]?.line).toBe(3);
  });
});
