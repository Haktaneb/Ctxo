import { describe, it, expect } from 'vitest';
import { Node, Project } from 'ts-morph';
import { SYMBOL_KINDS, type GraphEdge, type SymbolNode } from '@ctxo/plugin-api';
import { TsMorphAdapter } from '../ts-morph-adapter.js';
import { findTestBlocks, isTestFilePath, testBlockSymbol } from '../test-blocks.js';

const TEST_FILE = 'src/__tests__/loan-policy.test.ts';

function isTestSymbol(symbol: SymbolNode): boolean {
  return symbol.annotations?.some((annotation) => annotation.name === 'test') === true;
}

async function testSymbols(source: string, file = TEST_FILE): Promise<SymbolNode[]> {
  const symbols = await new TsMorphAdapter().extractSymbols(file, source);
  return symbols.filter(isTestSymbol);
}

function blockId(name: string, file = TEST_FILE): string {
  return `${file}::${name}::function`;
}

/** The three-part form the core SymbolIdSchema accepts. */
function isValidSymbolId(id: string): boolean {
  const parts = id.split('::');
  if (parts.length !== 3) return false;
  const [file, name, kind] = parts;
  return Boolean(file) && Boolean(name) && (SYMBOL_KINDS as readonly string[]).includes(kind ?? '');
}

describe('isTestFilePath', () => {
  it.each([
    'src/__tests__/a.ts',
    'src/a.test.ts',
    'web/a.spec.js',
    'test/a.ts',
    'tests/e2e/a.ts',
    'src\\şube kaydı\\__tests__\\a.ts',
    'src/şube kaydı/b.test.tsx',
  ])('isTestFilePath follows the TypeScript defaults of the shared classifier: %s is a test file', (path) => {
    expect(isTestFilePath(path)).toBe(true);
  });

  it.each([
    'src/latest.ts',
    'src/contest/a.ts',
    'src/testing.ts',
    'src/a.tests.ts',
    'src/attest.spec-helper.ts',
  ])('isTestFilePath follows the TypeScript defaults of the shared classifier: %s is not a test file', (path) => {
    expect(isTestFilePath(path)).toBe(false);
  });
});

describe('test blocks as symbols', () => {
  it('describe, it and test blocks become function symbols named by their title path', async () => {
    const source = [
      "describe('LoanPolicy', () => {",
      "  it('LEND-03 a member holds at most five loans', () => {});",
      "  describe('renewal', () => { test('extends by seven days', () => {}); });",
      '});',
      '',
    ].join('\n');

    const symbols = await testSymbols(source);

    expect(symbols.map((s) => s.name)).toEqual([
      'LoanPolicy',
      'LoanPolicy > LEND-03 a member holds at most five loans',
      'LoanPolicy > renewal',
      'LoanPolicy > renewal > extends by seven days',
    ]);
    for (const symbol of symbols) {
      expect(symbol.symbolId).toBe(blockId(symbol.name));
      expect(symbol.kind).toBe('function');
      expect(symbol.annotations).toEqual([{ name: 'test' }]);
    }
    expect(symbols.map((s) => [s.startLine, s.endLine])).toEqual([[0, 3], [1, 1], [2, 2], [2, 2]]);
    const spans = symbols.map((s) => source.slice(s.startOffset, s.endOffset));
    expect(spans[0]!.startsWith("describe('LoanPolicy'")).toBe(true);
    expect(spans[0]!.endsWith('})')).toBe(true);
    expect(spans[1]).toBe("it('LEND-03 a member holds at most five loans', () => {})");
    expect(spans[2]).toBe("describe('renewal', () => { test('extends by seven days', () => {}); })");
    expect(spans[3]).toBe("test('extends by seven days', () => {})");
  });

  it('modifiers, tables and options objects are recognised', async () => {
    const source = [
      'const flag = false;',
      "it.only('a', () => {});",
      "describe.skip.each([1])('b %i', () => {});",
      "it.skipIf(flag)('c', () => {});",
      "test('d', { timeout: 5 }, () => {});",
      "it.todo('e');",
      '',
    ].join('\n');

    const symbols = await testSymbols(source);

    expect(symbols.map((s) => s.name)).toEqual(['a', 'b %i', 'c', 'd']);
  });

  it('every listed callee and member is recognised, and other calls are not', async () => {
    const source = [
      "suite('s1', () => {});",
      "context('s2', () => {});",
      "fdescribe('s3', () => {});",
      "xdescribe('s4', () => {});",
      "specify('t1', () => {});",
      "fit('t2', () => {});",
      "xit('t3', () => {});",
      "xtest('t4', function () {});",
      "test.concurrent.skip('t5', () => {});",
      "test.sequential('t6', () => {});",
      "describe.shuffle('t7', () => {});",
      "test.fails('t8', () => {});",
      "test.for([[1, 2]])('t9', () => {});",
      "it.runIf(true)('t10', () => {});",
      'describe.each`a | b`(\'t11\', () => {});',
      "it('t12', () => {}, 5000);",
      "it('no callback');",
      "it('identifier callback', handler);",
      "describe.each([1]);",
      "bus.describe('not a test', () => {});",
      "helper('not a test', () => {});",
      "it.unknown('not a test', () => {});",
      '',
    ].join('\n');

    const symbols = await testSymbols(source);

    expect(symbols.map((s) => s.name)).toEqual([
      's1', 's2', 's3', 's4', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12',
    ]);
  });

  it('titles become unique valid ids', async () => {
    const long = 'x'.repeat(300);
    const nearLimit = `${'y'.repeat(199)}::z`;
    const source = [
      "const cases = [{ name: 'one' }];",
      "const kind = 'hold';",
      "it('works', () => {});",
      "it('works', () => {});",
      'for (const c of cases) it(c.name, () => {});',
      "it('Foo::bar', () => {});",
      "it('', () => {});",
      'it(`first line',
      '    second line`, () => {});',
      'it(`handles ${kind}`, () => {});',
      `it('${long}', () => {});`,
      "it('ends with a colon:', () => {});",
      "it('a :: b ::', () => {});",
      "it(':::', () => {});",
      `it('${nearLimit}', () => {});`,
      "describe('Group:', () => { it('x:', () => {}); });",
      "it(':leading', () => {});",
      '',
    ].join('\n');

    const symbols = await testSymbols(source);

    expect(symbols.map((s) => s.name)).toEqual([
      'works',
      'works #2',
      'c.name',
      'Foo:bar',
      '(untitled)',
      'first line second line',
      'handles ${kind}',
      'x'.repeat(200),
      'ends with a colon',
      'a : b',
      '(untitled) #2',
      'y'.repeat(199),
      'Group',
      'Group > x',
      ':leading',
    ]);
    const ids = symbols.map((s) => s.symbolId);
    for (const id of ids) {
      expect(id.split('::')).toHaveLength(3);
      expect(isValidSymbolId(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a repeated path gets a suffix and its children use the final name', async () => {
    const source = [
      "describe('A', () => { it('x', () => {}); });",
      "describe('A', () => { it('x', () => {}); it('x', () => {}); });",
      "it('A #2', () => {});",
      '',
    ].join('\n');

    const symbols = await testSymbols(source);

    expect(symbols.map((s) => s.name)).toEqual(['A', 'A > x', 'A #2', 'A #2 > x', 'A #2 > x #2', 'A #2 #2']);
  });

  it('a block named like an exported function of the file gets a suffix', async () => {
    const source = [
      'export function setup(): void {}',
      "describe('setup', () => {});",
      '',
    ].join('\n');

    const symbols = await new TsMorphAdapter().extractSymbols(TEST_FILE, source);

    expect(symbols.map((s) => s.symbolId)).toEqual([blockId('setup'), blockId('setup #2')]);
    expect(symbols.filter(isTestSymbol).map((s) => s.name)).toEqual(['setup #2']);
  });

  it('blocks outside test files are ignored', async () => {
    const source = [
      "describe('LoanPolicy', () => {",
      "  it('LEND-03 a member holds at most five loans', () => {});",
      "  describe('renewal', () => { test('extends by seven days', () => {}); });",
      '});',
      '',
    ].join('\n');
    const adapter = new TsMorphAdapter();

    expect(await adapter.extractSymbols('src/loan-policy.ts', source)).toEqual([]);
    expect(await adapter.extractEdges('src/loan-policy.ts', source)).toEqual([]);
  });
});

describe('test block edges', () => {
  const FILE_ID = 'src/__tests__/loan-policy.test.ts::loan-policy.test::variable';
  const source = [
    "import { beforeEach, describe, expect, it } from 'vitest';",
    "import { canBorrow, MAX_LOANS } from '../loan-policy';",
    "import { reset } from './helpers';",
    '',
    "describe('LoanPolicy', () => {",
    '  beforeEach(() => reset());',
    "  it('allows four', () => { expect(canBorrow(4)).toBe(true); });",
    "  it('uses the limit', () => { expect(MAX_LOANS).toBe(5); });",
    '});',
    '',
  ].join('\n');

  it('each block owns the edges of its own body', async () => {
    const edges = await new TsMorphAdapter().extractEdges(TEST_FILE, source);

    const canBorrow = 'src/loan-policy.ts::canBorrow::function';
    const maxLoans = 'src/loan-policy.ts::MAX_LOANS::variable';
    const reset = 'src/__tests__/helpers.ts::reset::function';
    const group = blockId('LoanPolicy');
    const allowsFour = blockId('LoanPolicy > allows four');
    const usesLimit = blockId('LoanPolicy > uses the limit');

    expect(edges).toContainEqual({ from: allowsFour, to: canBorrow, kind: 'calls' });
    expect(edges).toContainEqual({ from: usesLimit, to: maxLoans, kind: 'uses' });
    expect(edges).toContainEqual({ from: group, to: reset, kind: 'calls' });
    expect(edges.filter((e) => e.from === group && e.to === canBorrow)).toEqual([]);

    const blockIds = new Set([group, allowsFour, usesLimit]);
    expect(edges.filter((e) => blockIds.has(e.from))).toEqual([
      { from: group, to: reset, kind: 'calls' },
      { from: group, to: reset, kind: 'uses' },
      { from: allowsFour, to: canBorrow, kind: 'calls' },
      { from: allowsFour, to: canBorrow, kind: 'uses' },
      { from: usesLimit, to: maxLoans, kind: 'uses' },
    ]);
    const targetNames = edges.map((e) => e.to.split('::')[1]);
    for (const name of ['expect', 'it', 'beforeEach']) {
      expect(targetNames).not.toContain(name);
    }
  });

  it('import edges of a test file keep their source', async () => {
    const edges = await new TsMorphAdapter().extractEdges(TEST_FILE, source);

    expect(edges.filter((e) => e.kind === 'imports')).toEqual([
      { from: FILE_ID, to: 'src/loan-policy.ts::canBorrow::function', kind: 'imports' },
      { from: FILE_ID, to: 'src/loan-policy.ts::MAX_LOANS::variable', kind: 'imports' },
      { from: FILE_ID, to: 'src/__tests__/helpers.ts::reset::function', kind: 'imports' },
    ]);
  });

  it('a block calls a function once however often its body calls it', async () => {
    const repeated = [
      "import { canBorrow } from '../loan-policy';",
      "it('limits', () => { canBorrow(1); canBorrow(2); new canBorrow(); });",
      '',
    ].join('\n');

    const edges = await new TsMorphAdapter().extractEdges(TEST_FILE, repeated);

    expect(edges.filter((e) => e.from === blockId('limits'))).toEqual([
      { from: blockId('limits'), to: 'src/loan-policy.ts::canBorrow::function', kind: 'calls' },
      { from: blockId('limits'), to: 'src/loan-policy.ts::canBorrow::function', kind: 'uses' },
    ]);
  });

  it('the same test file twice gives deep-equal symbols and edges', async () => {
    const adapter = new TsMorphAdapter();
    const run = async (a: TsMorphAdapter): Promise<[SymbolNode[], GraphEdge[]]> => [
      await a.extractSymbols(TEST_FILE, source),
      await a.extractEdges(TEST_FILE, source),
    ];

    const first = await run(adapter);
    const second = await run(adapter);
    const fresh = await run(new TsMorphAdapter());

    expect(first[0].filter(isTestSymbol)).toHaveLength(3);
    expect(second).toEqual(first);
    expect(fresh).toEqual(first);
  });
});

describe('findTestBlocks', () => {
  it('exposes each block with its callback and the callbacks nested inside it', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      TEST_FILE,
      [
        "describe('LoanPolicy', () => {",
        "  it('a', () => {});",
        "  describe('renewal', function () { test('b', () => {}); });",
        '});',
        '',
      ].join('\n'),
    );

    const blocks = findTestBlocks(sourceFile, TEST_FILE);

    expect(blocks.map((b) => b.name)).toEqual(['LoanPolicy', 'LoanPolicy > a', 'LoanPolicy > renewal', 'LoanPolicy > renewal > b']);
    expect(blocks.map((b) => b.symbolId)).toEqual(blocks.map((b) => blockId(b.name)));
    expect(blocks.map((b) => b.nested.length)).toEqual([3, 0, 1, 0]);
    expect(Node.isArrowFunction(blocks[0]!.body)).toBe(true);
    expect(Node.isFunctionExpression(blocks[2]!.body)).toBe(true);
    expect(blocks[2]!.nested[0]).toBe(blocks[3]!.body);
    expect(blocks[1]!.call.getText()).toBe("it('a', () => {})");
    expect(testBlockSymbol(blocks[1]!)).toEqual({
      symbolId: blockId('LoanPolicy > a'),
      name: 'LoanPolicy > a',
      kind: 'function',
      startLine: 1,
      endLine: 1,
      startOffset: blocks[1]!.call.getStart(),
      endOffset: blocks[1]!.call.getEnd(),
      annotations: [{ name: 'test' }],
    });
    expect(findTestBlocks(sourceFile, 'src/loan-policy.ts')).toEqual([]);
  });
});
