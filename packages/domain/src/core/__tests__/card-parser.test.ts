import { describe, it, expect } from 'vitest';
import {
  CARD_H2_TEMPLATE,
  githubSlugs,
  headingOrderProblems,
  parseCard,
  parseMarkdownHeadings,
} from '../card-parser.js';

const SPEC_CARD = [
  '# Lending',
  '',
  '## Language',
  '- **Loan**: ...',
  '- **Hold**: ...',
  '',
  '## Rules and invariants',
  '### LEND-03 A member holds at most five loans',
  'Tests: `src/Lending.Tests/LoanLimitTests.cs`',
  'Code: `src/Lending/LoanPolicy.cs`, `src/Lending/LoanPolicy.cs::LoanPolicy.CanBorrow::method`',
  '',
  'Free text written by people.',
  '',
  '### LEND-04 A hold expires after seven days',
  'Untested: covered by manual QA until the scheduler migration lands',
  '',
  '## Boundary contracts',
  'Free text; references to contract files.',
  '',
  '## Decisions',
  '- 2026-09-12: Loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)',
  '',
  '## Open questions',
  '- ...',
  '',
].join('\n');

describe('card parser', () => {
  it('parses the spec card example', () => {
    const card = parseCard(SPEC_CARD);
    expect(card.rules.map((r) => r.id)).toEqual(['LEND-03', 'LEND-04']);
    expect(card.rules[0]).toMatchObject({
      title: 'A member holds at most five loans',
      line: 8,
      tests: ['src/Lending.Tests/LoanLimitTests.cs'],
      code: ['src/Lending/LoanPolicy.cs', 'src/Lending/LoanPolicy.cs::LoanPolicy.CanBorrow::method'],
    });
    expect(card.rules[0]!.untested).toBeUndefined();
    expect(card.rules[1]).toMatchObject({
      tests: [],
      code: [],
      untested: 'covered by manual QA until the scheduler migration lands',
    });
    expect(card.links.map((l) => l.target)).toEqual(['../../specs/loan-limit.md', '../../adr/adr-007-loan-limit.md']);
    expect(headingOrderProblems(card.headings)).toEqual([]);
    expect(CARD_H2_TEMPLATE).toHaveLength(5);
  });

  it('ignores headings and links inside code', () => {
    const text = [
      '## Rules and invariants',
      '```md',
      '### LEND-99 fake',
      '[x](missing.md)',
      '```',
      '~~~~',
      '## Not a heading',
      '~~~',
      '~~~~',
      'Inline `[y](gone.md)` span and [real](kept.md).',
      '### LEND-01 Real rule',
    ].join('\n');
    const card = parseCard(text);
    expect(card.rules.map((r) => r.id)).toEqual(['LEND-01']);
    expect(card.headings.map((h) => h.text)).toEqual(['Rules and invariants', 'LEND-01 Real rule']);
    expect(card.links.map((l) => l.target)).toEqual(['kept.md']);
  });

  it('collects images, angle-bracket targets, titles and reference definitions', () => {
    const text = ['![alt](img/a.png "t")', '[a](<with space.md>)', '[ref]: ./ref.md', '   [r2]: other.md "T"'].join('\n');
    expect(parseCard(text).links).toEqual([
      { target: 'img/a.png', line: 1 },
      { target: 'with space.md', line: 2 },
      { target: './ref.md', line: 3 },
      { target: 'other.md', line: 4 },
    ]);
  });

  it('CRLF and a BOM parse like LF', () => {
    const lf = parseCard(SPEC_CARD);
    const crlf = parseCard('﻿' + SPEC_CARD.replace(/\n/g, '\r\n'));
    expect(crlf).toEqual(lf);
    expect(crlf.headings[0]).toEqual({ level: 1, text: 'Lending', line: 1 });
  });

  it('closing hashes are stripped and setext headings ignored', () => {
    const text = ['## Language ##', 'Title', '=====', 'Other', '-----', '   ### Indented ###  ', '    #### code block'].join('\n');
    expect(parseMarkdownHeadings(text)).toEqual([
      { level: 2, text: 'Language', line: 1 },
      { level: 3, text: 'Indented', line: 6 },
    ]);
  });

  it('rule lines stop at the first prose line', () => {
    const text = [
      '## Rules and invariants',
      '### LEND-01 First',
      '',
      'Tests: `a.cs`',
      'Prose line',
      'Code: `b.cs`',
      '### LEND-02 Second',
      'Code: `c.cs`',
      'Tests: `d.cs`, `e.cs`',
      '## Decisions',
      '### LEND-03 Outside rules section',
      'Code: `z.cs`',
    ].join('\n');
    const { rules } = parseCard(text);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ id: 'LEND-01', tests: ['a.cs'], code: [] });
    expect(rules[1]).toMatchObject({ id: 'LEND-02', tests: ['d.cs', 'e.cs'], code: ['c.cs'] });
  });

  it('headingOrderProblems reports a missing or out-of-order heading and allows extra H2s', () => {
    const h = (...names: string[]) => names.map((text, i) => ({ level: 2, text, line: i + 1 }));
    expect(headingOrderProblems(h(...CARD_H2_TEMPLATE))).toEqual([]);
    expect(
      headingOrderProblems(h('Language', 'Extra', 'Rules and invariants', 'Boundary contracts', 'More', 'Decisions', 'Open questions')),
    ).toEqual([]);
    const missing = headingOrderProblems(h('Language', 'Rules and invariants', 'Decisions', 'Open questions'));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('Boundary contracts');
    const swapped = headingOrderProblems(h('Language', 'Decisions', 'Rules and invariants', 'Boundary contracts', 'Open questions'));
    expect(swapped).toHaveLength(1);
    expect(swapped[0]).toContain('"## Decisions" must come after');
  });

  it('githubSlugs follows GitHub rules', () => {
    const heads = ['Rules and invariants', 'LEND-03 A member holds at most five loans', 'Decisions!', 'FAQ', 'FAQ', 'Şube Kaydı'].map(
      (text, i) => ({ level: 2, text, line: i + 1 }),
    );
    const slugs = githubSlugs(heads);
    for (const s of ['rules-and-invariants', 'lend-03-a-member-holds-at-most-five-loans', 'decisions', 'faq', 'faq-1', 'şube-kaydı']) {
      expect(slugs.has(s)).toBe(true);
    }
    expect(slugs.size).toBe(6);
  });
});
