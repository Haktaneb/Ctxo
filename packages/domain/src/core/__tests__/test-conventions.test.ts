import { describe, it, expect } from 'vitest';
import { createModuleHost, type FileIndex, type SymbolNode } from '@ctxo/cli/internal';
import { DEFAULT_DOMAIN_CONFIG } from '../domain-config.js';
import type { TestTitle } from '../rule-id-scan.js';
import { classifyTests, parseAnnotationMatcher } from '../test-conventions.js';

const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });
const isTestFile = (p: string): boolean => p.startsWith('tests/');
const { characterization, contract } = DEFAULT_DOMAIN_CONFIG.tests;

function sym(
  file: string,
  name: string,
  kind: SymbolNode['kind'],
  startLine: number,
  endLine: number,
  annotations?: SymbolNode['annotations'],
): SymbolNode {
  const node: SymbolNode = { symbolId: `${file}::${name}::${kind}`, name, kind, startLine, endLine };
  return annotations === undefined ? node : { ...node, annotations };
}

function fileIndex(file: string, symbols: SymbolNode[]): FileIndex {
  return { file, lastModified: 1, symbols, edges: [], intent: [], antiPatterns: [] };
}

function classify(indices: FileIndex[], titles: TestTitle[] = []) {
  return classifyTests({ indices, isTestFile, titles, characterization, contract, makeMatcher: host.services.makeGlobMatcher });
}

describe('parseAnnotationMatcher', () => {
  it('parseAnnotationMatcher reads the three forms', () => {
    expect(parseAnnotationMatcher('Tag')).toEqual({ name: 'Tag' });
    expect(parseAnnotationMatcher('Tag:characterization')).toEqual({ name: 'Tag', value: 'characterization' });
    expect(parseAnnotationMatcher('Trait:Kind=Characterization')).toEqual({ name: 'Trait', key: 'Kind', value: 'Characterization' });
  });

  it('rejects malformed matchers', () => {
    for (const spec of ['', ':x', 'Trait:', 'Trait:=x', 'Trait:a=b=c']) {
      expect(parseAnnotationMatcher(spec), spec).toBeUndefined();
    }
  });
});

describe('classifyTests', () => {
  const plainFile = 'tests/Lending.Tests/LoanTests.cs';
  const folderFile = 'tests/Lending.Tests/Characterization/LoanTests.cs';
  it.each([
    { label: 'a Trait Kind annotation', file: plainFile, annotations: [{ name: 'Trait', args: ['Kind', 'Characterization'] }], titles: [] },
    { label: 'a Tag annotation', file: plainFile, annotations: [{ name: 'Tag', args: ['characterization'] }], titles: [] },
    { label: 'a Characterization folder', file: folderFile, annotations: undefined, titles: [] },
    { label: 'a title marker', file: plainFile, annotations: undefined, titles: [{ line: 4, title: '[characterization] borrow flow' }] },
  ])('the four default signals mark characterization tests: $label', ({ file, annotations, titles }) => {
    const index = fileIndex(file, [
      sym(file, 'LoanTests', 'class', 0, 10),
      sym(file, 'LoanTests.Borrows', 'method', 2, 5, annotations),
      sym(file, 'LoanTests.Plain', 'method', 6, 9),
    ]);
    const result = classify([index], titles.map((t) => ({ file, ...t })));
    expect(result.testCases).toEqual([`${file}::LoanTests.Borrows::method`, `${file}::LoanTests.Plain::method`]);
    const expected =
      file === folderFile
        ? [`${file}::LoanTests.Borrows::method`, `${file}::LoanTests.Plain::method`]
        : [`${file}::LoanTests.Borrows::method`];
    expect([...result.characterization].sort()).toEqual(expected);
    expect([...result.contract]).toEqual([]);
  });

  it('a class-level annotation marks its methods', () => {
    const file = 'tests/LoanTests.cs';
    const result = classify([
      fileIndex(file, [
        sym(file, 'LoanTests', 'class', 0, 10, [{ name: 'Trait', args: ['Kind', 'Characterization'] }]),
        sym(file, 'LoanTests.A', 'method', 1, 3),
        sym(file, 'LoanTests.B', 'method', 4, 6),
        sym(file, 'Other', 'class', 11, 20),
        sym(file, 'Other.C', 'method', 12, 14),
      ]),
    ]);
    expect(result.testCases).toEqual([`${file}::LoanTests.A::method`, `${file}::LoanTests.B::method`, `${file}::Other.C::method`]);
    expect([...result.characterization].sort()).toEqual([`${file}::LoanTests.A::method`, `${file}::LoanTests.B::method`]);
  });

  it('describe blocks are containers and only leaf blocks count', () => {
    const file = 'tests/loan.test.ts';
    const result = classify(
      [
        fileIndex(file, [
          sym(file, 'LoanPolicy', 'function', 0, 20),
          sym(file, 'LoanPolicy > renewal', 'function', 1, 10),
          sym(file, 'LoanPolicy > renewal > keeps the due date', 'function', 2, 4),
          sym(file, 'LoanPolicy > [characterization] borrow flow', 'function', 11, 13),
          sym(file, 'helperValue', 'variable', 14, 14),
        ]),
        fileIndex('src/loan.ts', [sym('src/loan.ts', 'notATest', 'function', 0, 3)]),
      ],
      // Line 2 (1-based) is the describe's first line; the leaf spans lines 3-5, so this title marks nothing.
      [{ file, line: 2, title: '[characterization] renewal' }],
    );
    expect(result.testCases).toEqual([
      `${file}::LoanPolicy > [characterization] borrow flow::function`,
      `${file}::LoanPolicy > renewal > keeps the due date::function`,
    ]);
    expect([...result.characterization]).toEqual([`${file}::LoanPolicy > [characterization] borrow flow::function`]);
  });

  it('values and keys compare without case', () => {
    const file = 'tests/LoanTests.cs';
    const result = classify([
      fileIndex(file, [
        sym(file, 'A', 'method', 0, 1, [{ name: 'Trait', args: ['kind', 'CHARACTERIZATION'] }]),
        sym(file, 'B', 'method', 2, 3, [{ name: 'Trait', named: { KIND: 'characterization' } }]),
        sym(file, 'C', 'method', 4, 5, [{ name: 'Tag', named: { value: 'Characterization' } }]),
        sym(file, 'D', 'method', 6, 7, [{ name: 'trait', args: ['Kind', 'Characterization'] }]),
        sym(file, 'E', 'method', 8, 9, [{ name: 'Trait', args: ['Category', 'Characterization'] }]),
      ]),
    ]);
    // D: annotation names compare exactly; E: the key must be Kind.
    expect([...result.characterization].sort()).toEqual([`${file}::A::method`, `${file}::B::method`, `${file}::C::method`]);
  });

  it('contract conventions work the same way', () => {
    const result = classify(
      [
        fileIndex('tests/Contracts.Tests/ChargeTests.cs', [sym('tests/Contracts.Tests/ChargeTests.cs', 'Charge', 'method', 0, 2)]),
        fileIndex('tests/x/Contract/FeeTests.cs', [sym('tests/x/Contract/FeeTests.cs', 'Fee', 'method', 0, 2)]),
        fileIndex('tests/LoanTests.cs', [
          sym('tests/LoanTests.cs', 'A', 'method', 0, 1, [{ name: 'Trait', args: ['Kind', 'Contract'] }]),
          sym('tests/LoanTests.cs', 'B', 'method', 2, 3, [{ name: 'Tag', args: ['CONTRACT'] }]),
          sym('tests/LoanTests.cs', 'C [Contract] shape', 'method', 4, 5),
          sym('tests/LoanTests.cs', 'D', 'method', 6, 7),
          sym('tests/LoanTests.cs', 'E', 'method', 8, 9),
        ]),
      ],
      [{ file: 'tests/LoanTests.cs', line: 8, title: '[contract] title' }],
    );
    expect([...result.contract].sort()).toEqual([
      'tests/Contracts.Tests/ChargeTests.cs::Charge::method',
      'tests/LoanTests.cs::A::method',
      'tests/LoanTests.cs::B::method',
      'tests/LoanTests.cs::C [Contract] shape::method',
      'tests/LoanTests.cs::D::method',
      'tests/x/Contract/FeeTests.cs::Fee::method',
    ]);
    expect([...result.characterization]).toEqual([]);
  });
});
