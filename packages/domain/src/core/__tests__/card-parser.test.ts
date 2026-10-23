import { describe, it, expect } from 'vitest';
import {
  CARD_H2_TEMPLATE,
  githubSlugs,
  headingOrderProblems,
  parseCard,
  parseGlossary,
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

  it('collects both targets of a nested image link and keeps balanced parentheses', () => {
    const text = ['[![badge](img.svg)](target.md)', '[x](a_(b).md) and [y](plain.md)'].join('\n');
    expect(parseCard(text).links).toEqual([
      { target: 'img.svg', line: 1 },
      { target: 'target.md', line: 1 },
      { target: 'a_(b).md', line: 2 },
      { target: 'plain.md', line: 2 },
    ]);
  });

  it('CRLF and a BOM parse like LF', () => {
    const lf = parseCard(SPEC_CARD);
    const crlf = parseCard('﻿' + SPEC_CARD.replace(/\n/g, '\r\n'));
    expect(crlf).toEqual(lf);
    expect(crlf.headings[0]).toEqual({ level: 1, text: 'Lending', line: 1 });
    expect(crlf.sections.map((s) => s.text)).toEqual(lf.sections.map((s) => s.text));
    expect(crlf.sections[1]!.text).not.toContain('\r');
    expect(crlf.rules[0]!.text).toBe('Free text written by people.');
    const glossary = '- **Loan** (context: lending): one copy\n  lent to a member\n';
    expect(parseGlossary(String.fromCharCode(0xfeff) + glossary.replace(/\n/g, '\r\n'))).toEqual(parseGlossary(glossary));
    expect(parseGlossary(glossary)).toEqual([{ term: 'Loan', context: 'lending', definition: 'one copy lent to a member', line: 1 }]);
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

  it('parses the spec card example into sections, terms, rules, decisions and open questions', () => {
    const card = parseCard(SPEC_CARD);
    expect(card.title).toBe('Lending');
    expect(card.intro).toBeUndefined();
    expect(card.sections.map((s) => s.heading)).toEqual([...CARD_H2_TEMPLATE]);
    expect(card.terms).toEqual([
      { term: 'Loan', definition: '...', line: 4 },
      { term: 'Hold', definition: '...', line: 5 },
    ]);
    expect(card.rules[0]).toMatchObject({
      id: 'LEND-03',
      line: 8,
      testsLine: 9,
      codeLine: 10,
      text: 'Free text written by people.',
      endLine: 13,
    });
    expect(card.rules[1]).toMatchObject({
      id: 'LEND-04',
      untested: 'covered by manual QA until the scheduler migration lands',
      text: '',
      endLine: 16,
    });
    expect(card.rules[1]!.testsLine).toBeUndefined();
    expect(card.rules[1]!.codeLine).toBeUndefined();
    expect(card.decisions).toEqual([
      {
        date: '2026-09-12',
        line: 21,
        text: 'Loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)',
        links: [
          { label: 'spec', target: '../../specs/loan-limit.md' },
          { label: 'ADR-007', target: '../../adr/adr-007-loan-limit.md' },
        ],
        externalRefs: ['#123'],
      },
    ]);
    expect(card.openQuestions).toEqual([{ text: '...', line: 24 }]);
    expect(card.contractRefs).toEqual([]);
    expect(card.sections[2]).toEqual({
      heading: 'Boundary contracts',
      line: 17,
      endLine: 19,
      text: 'Free text; references to contract files.',
    });
    expect(card.sections[1]!.text.split('\n')[0]).toBe('### LEND-03 A member holds at most five loans');
  });

  it('glossary items carry an optional context', () => {
    const text = ['- **Loan** (context: lending): one copy lent to a member', '- **Member**: a registered patron'].join('\n');
    const items = parseGlossary(text);
    expect(items).toEqual([
      { term: 'Loan', context: 'lending', definition: 'one copy lent to a member', line: 1 },
      { term: 'Member', definition: 'a registered patron', line: 2 },
    ]);
    expect('context' in items[1]!).toBe(false);
  });

  it('glossary items are read anywhere outside fences, under any heading', () => {
    const text = ['# Glossary', '', '## Loan', '- **Loan** (context: lending): lent copy', '', '```', '- **Fake**: x', '```', '* **Fine**: money owed'];
    expect(parseGlossary(text.join('\n')).map((i) => [i.term, i.line])).toEqual([
      ['Loan', 4],
      ['Fine', 9],
    ]);
  });

  it('term items accept a colon inside the bold text and continuation lines', () => {
    const text = ['## Language', '- **Loan:** first line', '  second line', '- plain item', '- **Hold** (context: x): kept as written'].join('\n');
    expect(parseCard(text).terms).toEqual([
      { term: 'Loan', definition: 'first line second line', line: 2 },
      { term: 'Hold', definition: '(context: x): kept as written', line: 5 },
    ]);
  });

  it('list items end at a blank line, another item or a heading', () => {
    const text = ['## Language', '- **A**: one', 'not indented', '- **B**: two', '', '  after blank', '- **C**: three', '### Sub', '  indented after heading'];
    expect(parseCard(text.join('\n')).terms.map((t) => t.definition)).toEqual(['one', 'two', 'three']);
  });

  it('decision items need a valid ISO date and a colon', () => {
    const decisions = (item: string) => parseCard(['## Decisions', item].join('\n')).decisions;
    expect(decisions('- Sometime: x')).toEqual([]);
    expect(decisions('- 2026-13-01: x')).toEqual([]);
    expect(decisions('- 2026-09-32: x')).toEqual([]);
    expect(decisions('- 2026-00-10: x')).toEqual([]);
    expect(decisions('- 2026-09-12 no colon')).toEqual([]);
    expect(decisions('- 2026-09-12: x')).toEqual([{ date: '2026-09-12', text: 'x', line: 2, links: [], externalRefs: [] }]);
    expect(decisions('+ 2026-09-12 :x')).toHaveLength(1);
  });

  it('external refs are bare URLs without trailing punctuation and #digits outside words and link targets', () => {
    const text = ['## Decisions', '- 2026-09-12: See https://example.com/a/b. and #12, not x#13, [y](#14) or [z](https://example.com/c)'].join('\n');
    const [decision] = parseCard(text).decisions;
    expect(decision!.externalRefs).toEqual(['https://example.com/a/b', '#12']);
    expect(decision!.links).toEqual([
      { label: 'y', target: '#14' },
      { label: 'z', target: 'https://example.com/c' },
    ]);
  });

  it('external refs skip code spans, & and / prefixes, and keep text order across continuation lines', () => {
    const text = ['## Decisions', '- 2026-09-12: `#1` and `[c](c.md)` &#2 a/#3 _#4 ##5', '  then #6 and http://x.test/p?q=1;'].join('\n');
    const [decision] = parseCard(text).decisions;
    expect(decision!.externalRefs).toEqual(['#6', 'http://x.test/p?q=1']);
    expect(decision!.links).toEqual([]);
    expect(decision!.text).toBe('`#1` and `[c](c.md)` &#2 a/#3 _#4 ##5 then #6 and http://x.test/p?q=1;');
  });

  it('rule bodies stop at the next heading and exclude the rule lines', () => {
    const text = [
      '## Rules and invariants',
      '### R-01 First',
      '',
      'Tests: `a.cs`',
      'Code: `b.cs`',
      'Body **one**.',
      '',
      '#### Detail',
      '```',
      '### not a heading',
      '```',
      'More.',
      '',
      '### R-02 Second',
      'Code: `c.cs`',
      'Tests: `d.cs`',
      'Second body.',
      '## Boundary contracts',
    ].join('\n');
    const { rules } = parseCard(text);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      id: 'R-01',
      line: 2,
      testsLine: 4,
      codeLine: 5,
      endLine: 13,
      text: ['Body **one**.', '', '#### Detail', '```', '### not a heading', '```', 'More.'].join('\n'),
    });
    expect(rules[1]).toMatchObject({ id: 'R-02', line: 14, codeLine: 15, testsLine: 16, endLine: 17, text: 'Second body.' });
  });

  it('an H1 ends the rules section and the rule body', () => {
    const text = ['## Rules and invariants', '### R-01 First', 'Body.', '# Stray', '### R-02 After the stray H1', 'Other.'].join('\n');
    const { rules } = parseCard(text);
    expect(rules.map((r) => r.id)).toEqual(['R-01']);
    expect(rules[0]).toMatchObject({ text: 'Body.', endLine: 3 });
  });

  it('a rule at the end of the file runs to the last line', () => {
    const { rules } = parseCard(['## Rules and invariants', '### R-01 Last', 'Untested: later', 'Tail.'].join('\n'));
    expect(rules[0]).toMatchObject({ text: 'Tail.', endLine: 4, untested: 'later' });
  });

  it('the intro is the text between the H1 and the first H2', () => {
    const text = ['Preamble', '# Lending', '', 'Lends **copies** to members.', '', 'Second paragraph.', '', '## Language', '# Second H1'].join('\n');
    const card = parseCard(text);
    expect(card.title).toBe('Lending');
    expect(card.intro).toEqual({ text: 'Lends **copies** to members.\n\nSecond paragraph.', line: 2 });
    expect(parseCard('## Language').title).toBeUndefined();
    expect(parseCard('## Language').intro).toBeUndefined();
    expect(parseCard('# Only title\n\n').intro).toBeUndefined();
    expect(parseCard('# T\nbody without H2').intro).toEqual({ text: 'body without H2', line: 1 });
  });

  it('contract references are the backticked values of Boundary contracts', () => {
    const text = [
      '## Language',
      'Uses `not-a-contract.md`.',
      '## Boundary contracts',
      'Publishes `contracts/loan-created.json` and `contracts/loan-closed.json`.',
      '- Consumes `contracts/member.json`, again `contracts/loan-created.json`',
      '```',
      '`fenced.json`',
      '```',
      '## Decisions',
      'See `later.md`.',
    ].join('\n');
    expect(parseCard(text).contractRefs).toEqual(['contracts/loan-created.json', 'contracts/loan-closed.json', 'contracts/member.json']);
  });

  it('open questions without a list are one item holding the section text', () => {
    const text = ['## Open questions', '', 'Should holds expire', 'after a week?', '', '## Extra'].join('\n');
    expect(parseCard(text).openQuestions).toEqual([{ text: 'Should holds expire\nafter a week?', line: 3 }]);
    expect(parseCard('## Open questions\n\n').openQuestions).toEqual([]);
    expect(parseCard('## Open questions\n- one\n- two\n  more').openQuestions).toEqual([
      { text: 'one', line: 2 },
      { text: 'two more', line: 3 },
    ]);
  });

  it('structure inside fenced code is ignored', () => {
    const text = [
      '## Language',
      '```',
      '- **Fake**: x',
      '```',
      '## Decisions',
      '~~~',
      '- 2026-01-01: fake',
      '~~~',
      '## Open questions',
      '```',
      '- fenced',
      '```',
    ].join('\n');
    const card = parseCard(text);
    expect(card.terms).toEqual([]);
    expect(card.decisions).toEqual([]);
    expect(card.sections.map((s) => s.heading)).toEqual(['Language', 'Decisions', 'Open questions']);
    expect(card.openQuestions).toEqual([{ text: '```\n- fenced\n```', line: 10 }]);
  });

  it('a nested decision item at 2 or 4 spaces folds into its parent with its links and refs', () => {
    for (const indent of ['  ', '    ']) {
      const text = ['## Decisions', '- 2026-09-12: Raised.', `${indent}- see [spec](a.md), #9`, '- 2026-10-01: Next.'].join('\n');
      expect(parseCard(text).decisions).toEqual([
        { date: '2026-09-12', text: 'Raised. - see [spec](a.md), #9', line: 2, links: [{ label: 'spec', target: 'a.md' }], externalRefs: ['#9'] },
        { date: '2026-10-01', text: 'Next.', line: 4, links: [], externalRefs: [] },
      ]);
    }
  });

  it('a nested open question at 2 or 4 spaces folds into its parent; a 1-space item is a sibling', () => {
    const text = ['## Open questions', '- one', '  - detail', '- two', '    - deeper', '- three', ' - sibling', '   - three deep'].join('\n');
    expect(parseCard(text).openQuestions).toEqual([
      { text: 'one - detail', line: 2 },
      { text: 'two - deeper', line: 4 },
      { text: 'three', line: 6 },
      { text: 'sibling - three deep', line: 7 },
    ]);
  });

  it('a nested glossary item folds into its parent term', () => {
    const text = ['- **Loan** (context: lending): lent', '  - **Sub**: x', '- **Fine**: owed'].join('\n');
    expect(parseGlossary(text)).toEqual([
      { term: 'Loan', context: 'lending', definition: 'lent - **Sub**: x', line: 1 },
      { term: 'Fine', definition: 'owed', line: 3 },
    ]);
  });

  it('a nested list in terms folds into the parent term', () => {
    const text = ['## Language', '- **Loan**: lent copy', '  - **Renewal**: extends a loan', '    - plain detail'].join('\n');
    expect(parseCard(text).terms).toEqual([{ term: 'Loan', definition: 'lent copy - **Renewal**: extends a loan - plain detail', line: 2 }]);
  });

  it('link labels give no external refs', () => {
    const text = ['## Decisions', '- 2026-09-12: [https://a.com/x](https://a.com/x) and [#12](https://b.com/y) but ![#13](i.png)'].join('\n');
    const [decision] = parseCard(text).decisions;
    expect(decision!.links).toEqual([
      { label: 'https://a.com/x', target: 'https://a.com/x' },
      { label: '#12', target: 'https://b.com/y' },
    ]);
    expect(decision!.externalRefs).toEqual(['#13']);
  });

  it('external refs keep only the first occurrence of each value', () => {
    const text = ['## Decisions', '- 2026-09-12: #5, https://a.com/p and #5 again, https://a.com/p.', '  #6 #5'].join('\n');
    expect(parseCard(text).decisions[0]!.externalRefs).toEqual(['#5', 'https://a.com/p', '#6']);
  });

  it('an unclosed fence swallows the rest of the card', () => {
    const text = ['## Decisions', '- 2026-01-01: a', '```', '- 2026-01-02: b', '## Open questions', '- q'].join('\n');
    const card = parseCard(text);
    expect(card.decisions.map((d) => d.text)).toEqual(['a']);
    expect(card.sections.map((s) => s.heading)).toEqual(['Decisions']);
    expect(card.openQuestions).toEqual([]);
  });

  it('an empty item gives no item and no section-text fallback', () => {
    expect(parseCard(['## Open questions', '- ', '- two'].join('\n')).openQuestions).toEqual([{ text: 'two', line: 3 }]);
    expect(parseCard(['## Open questions', '- '].join('\n')).openQuestions).toEqual([]);
    expect(parseGlossary('- ')).toEqual([]);
  });

  it('a bare marker followed by an indented line is one item', () => {
    expect(parseCard(['## Open questions', '-', '  foo', '*'].join('\n')).openQuestions).toEqual([{ text: 'foo', line: 2 }]);
  });

  it('a tab-indented line continues the item', () => {
    const text = ['## Language', '- **Loan**: first', '\tsecond', '\t- nested'].join('\n');
    expect(parseCard(text).terms).toEqual([{ term: 'Loan', definition: 'first second - nested', line: 2 }]);
  });

  it('sections keep H3 headings and fences as written and end at the next H2', () => {
    const text = ['# T', '## A', 'a1', '### Sub', '```', '## fenced', '```', '', '## B', '', 'b1', ''].join('\n');
    expect(parseCard(text).sections).toEqual([
      { heading: 'A', line: 2, endLine: 8, text: 'a1\n### Sub\n```\n## fenced\n```' },
      { heading: 'B', line: 9, endLine: 12, text: 'b1' },
    ]);
  });
});
