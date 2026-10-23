/**
 * Minimal line parser for per-context domain cards. Pure: no I/O, no markdown library. It reads only what the
 * domain checks and the domain graph need: ATX headings, H2 sections, rule headings with their rule lines and bodies,
 * list items (terms, decisions, open questions), link targets and heading anchors. Lines are 1-based; nothing inside
 * a fence is structure; extracted text keeps its markdown.
 */

export const CARD_H2_TEMPLATE = ['Language', 'Rules and invariants', 'Boundary contracts', 'Decisions', 'Open questions'] as const;

export interface MdHeading {
  readonly level: number;
  readonly text: string;
  /** 1-based. */
  readonly line: number;
}

export interface CardRule {
  readonly id: string;
  readonly title: string;
  readonly line: number;
  readonly tests: readonly string[];
  readonly code: readonly string[];
  readonly untested?: string;
  /** The body after the rule lines up to the next H1, H2 or H3, trimmed, markdown kept. */
  readonly text: string;
  /** 1-based: the last line before the next H1, H2 or H3 (or the last line of the file). */
  readonly endLine: number;
  /** 1-based line of the first `Tests:` rule line. */
  readonly testsLine?: number;
  /** 1-based line of the first `Code:` rule line. */
  readonly codeLine?: number;
}

/** Inline links, images and reference definitions. */
export interface CardLink {
  readonly target: string;
  readonly line: number;
}

export interface CardItem {
  readonly text: string;
  /** 1-based. */
  readonly line: number;
}

export interface CardSection {
  readonly heading: string;
  /** 1-based line of the H2. */
  readonly line: number;
  /** 1-based: the last line before the next H2 (or the last line of the file). */
  readonly endLine: number;
  /** The trimmed body, H3 headings and fences included as written. */
  readonly text: string;
}

export interface CardTerm {
  readonly term: string;
  readonly definition: string;
  readonly line: number;
}

export interface CardDecisionLink {
  readonly label: string;
  readonly target: string;
}

export interface CardDecision {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly text: string;
  readonly line: number;
  readonly links: readonly CardDecisionLink[];
  /** Bare URLs and `#123` references, in text order. */
  readonly externalRefs: readonly string[];
}

export interface ParsedCard {
  readonly headings: readonly MdHeading[];
  readonly rules: readonly CardRule[];
  readonly links: readonly CardLink[];
  /** The first H1. */
  readonly title?: string;
  /** The trimmed text between the first H1 and the first H2 after it; `line` is the H1's. */
  readonly intro?: CardItem;
  readonly sections: readonly CardSection[];
  readonly terms: readonly CardTerm[];
  readonly decisions: readonly CardDecision[];
  readonly openQuestions: readonly CardItem[];
  readonly contractRefs: readonly string[];
}

export interface GlossaryItem {
  readonly term: string;
  readonly context?: string;
  readonly definition: string;
  readonly line: number;
}

const RULES_H2 = 'Rules and invariants';
const LANGUAGE_H2 = 'Language';
const CONTRACTS_H2 = 'Boundary contracts';
const DECISIONS_H2 = 'Decisions';
const OPEN_QUESTIONS_H2 = 'Open questions';
// A list marker line at any indent; a bare marker (`-`) opens an empty item that continuation lines can fill.
const LIST_MARKER = /^[ \t]*[-*+](?:[ \t]+(.*))?$/;
const TERM_ITEM = /^\*\*(.+?)\*\*(.*)$/;
const CONTEXT_PREFIX = /^\(context:[ \t]*([^\s()]+)[ \t]*\)/;
const DECISION_ITEM = /^(\d{4})-(\d{2})-(\d{2})[ \t]*:[ \t]*(.*)$/;
// `[label](target "title")`; the target follows INLINE_LINK's shape. Images (`![alt](src)`) are not links here.
const LABELLED_LINK = /(!?)\[([^\[\]]*)\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
const BARE_URL = /https?:\/\/[^\s<>()\[\]]+/g;
const ISSUE_REF = /(?<![\p{L}\p{N}_#&/])#\d+/gu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const REF_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/;
// Scans for `](` so a link wrapping an image (`[![alt](img)](target)`) yields both targets; an unbracketed
// target may hold one level of balanced parentheses (`a_(b).md`).
const INLINE_LINK = /\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)/g;
const CODE_SPAN = /(`+)[\s\S]*?\1/g;

interface Line {
  readonly text: string;
  readonly number: number;
  /** True for fence delimiters and everything between them. */
  readonly fenced: boolean;
}

function splitLines(text: string): Line[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines: Line[] = [];
  let fence: { char: string; length: number } | undefined;
  source.split(/\r?\n/).forEach((raw, index) => {
    const open = FENCE.exec(raw);
    let fenced = false;
    if (fence) {
      fenced = true;
      const marker = open?.[1];
      if (marker && marker[0] === fence.char && marker.length >= fence.length && raw.trim() === marker) {
        fence = undefined;
      }
    } else if (open) {
      const marker = open[1]!;
      // A backtick fence cannot carry a backtick in its info string.
      if (!(marker[0] === '`' && raw.slice(raw.indexOf(marker) + marker.length).includes('`'))) {
        fence = { char: marker[0]!, length: marker.length };
        fenced = true;
      }
    }
    lines.push({ text: raw, number: index + 1, fenced });
  });
  return lines;
}

function headingOf(line: Line): MdHeading | undefined {
  if (line.fenced) return undefined;
  const match = ATX_HEADING.exec(line.text);
  if (!match) return undefined;
  return { level: match[1]!.length, text: (match[2] ?? '').trim(), line: line.number };
}

export function parseMarkdownHeadings(text: string): MdHeading[] {
  const headings: MdHeading[] = [];
  for (const line of splitLines(text)) {
    const heading = headingOf(line);
    if (heading) headings.push(heading);
  }
  return headings;
}

function backticked(value: string): string[] {
  const items: string[] = [];
  for (const match of value.matchAll(/`([^`]+)`/g)) {
    const item = match[1]!.trim();
    if (item) items.push(item);
  }
  return items;
}

function unwrapTarget(raw: string): string {
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
}

function collectLinks(lines: readonly Line[]): CardLink[] {
  const links: CardLink[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    const stripped = line.text.replace(CODE_SPAN, (span) => ' '.repeat(span.length));
    const definition = REF_DEFINITION.exec(stripped);
    if (definition) {
      links.push({ target: unwrapTarget(definition[1]!), line: line.number });
      continue;
    }
    for (const match of stripped.matchAll(INLINE_LINK)) {
      const target = unwrapTarget(match[1]!);
      if (target) links.push({ target, line: line.number });
    }
  }
  return links;
}

/** The lines `[start, end)` (0-based indices) joined with `\n` and trimmed. */
function sliceText(lines: readonly Line[], start: number, end: number): string {
  return lines
    .slice(start, end)
    .map((line) => line.text)
    .join('\n')
    .trim();
}

/** Index of the first line at or after `start` that is a heading of level `maxLevel` or less, else `lines.length`. */
function nextHeading(lines: readonly Line[], start: number, maxLevel: number): number {
  for (let k = start; k < lines.length; k++) {
    const heading = headingOf(lines[k]!);
    if (heading && heading.level <= maxLevel) return k;
  }
  return lines.length;
}

function collectRules(lines: readonly Line[]): CardRule[] {
  const rules: CardRule[] = [];
  let inRules = false;
  for (let i = 0; i < lines.length; i++) {
    const heading = headingOf(lines[i]!);
    if (!heading) continue;
    // Any H1 or H2 ends the rules section, so a rule never sits after a stray H1.
    if (heading.level <= 2) {
      inRules = heading.level === 2 && heading.text === RULES_H2;
      continue;
    }
    if (!inRules || heading.level !== 3) continue;

    const space = heading.text.search(/\s/);
    const id = space === -1 ? heading.text : heading.text.slice(0, space);
    const title = space === -1 ? '' : heading.text.slice(space).trim();
    const tests: string[] = [];
    const code: string[] = [];
    let untested: string | undefined;
    let testsLine: number | undefined;
    let codeLine: number | undefined;

    let j = i + 1;
    while (j < lines.length && !lines[j]!.fenced && lines[j]!.text.trim() === '') j++;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.fenced) break;
      if (line.text.startsWith('Tests:')) {
        tests.push(...backticked(line.text.slice('Tests:'.length)));
        testsLine ??= line.number;
      } else if (line.text.startsWith('Code:')) {
        code.push(...backticked(line.text.slice('Code:'.length)));
        codeLine ??= line.number;
      } else if (line.text.startsWith('Untested:')) untested = line.text.slice('Untested:'.length).trim();
      else break;
    }

    // Line numbers are index + 1, so the index of the ending heading is the 1-based number of the line before it.
    const end = nextHeading(lines, j, 3);
    rules.push({
      id,
      title,
      line: heading.line,
      tests,
      code,
      ...(untested === undefined ? {} : { untested }),
      text: sliceText(lines, j, end),
      endLine: end,
      ...(testsLine === undefined ? {} : { testsLine }),
      ...(codeLine === undefined ? {} : { codeLine }),
    });
  }
  return rules;
}

interface SectionRange extends CardSection {
  /** 0-based index of the first body line. */
  readonly start: number;
  /** 0-based exclusive end index. */
  readonly end: number;
}

function collectSections(lines: readonly Line[]): SectionRange[] {
  const sections: SectionRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = headingOf(lines[i]!);
    if (!heading || heading.level !== 2) continue;
    let end = i + 1;
    while (end < lines.length && headingOf(lines[end]!)?.level !== 2) end++;
    sections.push({ heading: heading.text, line: heading.line, endLine: end, text: sliceText(lines, i + 1, end), start: i + 1, end });
  }
  return sections;
}

/** Width of the leading whitespace; a tab advances to the next multiple of four columns. */
function indentOf(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === ' ') width++;
    else if (char === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

interface ListScan {
  readonly items: CardItem[];
  /** True when the range holds at least one item marker line, even one that stayed empty. */
  readonly sawMarker: boolean;
}

/**
 * List items in the lines `[start, end)`. An item starts at a `-`, `*` or `+` marker indented by at most three
 * columns. A following non-blank line continues the item (joined with one space, text as written) when it is
 * indented by at least two columns, except that a marker line less than two columns deeper than the item's own
 * marker starts a new item: a nested list (two or more columns deeper) folds into its parent, links and refs
 * included. A blank line, a heading, a fence or an unindented line ends the item. Items left empty are dropped.
 */
function scanList(lines: readonly Line[], start: number, end: number): ListScan {
  const items: CardItem[] = [];
  let sawMarker = false;
  let current: { parts: string[]; line: number; indent: number } | undefined;
  const flush = (): void => {
    if (current) {
      const text = current.parts.filter((part) => part !== '').join(' ');
      if (text) items.push({ text, line: current.line });
    }
    current = undefined;
  };
  for (let k = start; k < end; k++) {
    const line = lines[k]!;
    if (line.fenced || line.text.trim() === '' || headingOf(line)) {
      flush();
      continue;
    }
    const indent = indentOf(line.text);
    const marker = LIST_MARKER.exec(line.text);
    const startsItem = marker !== null && indent <= 3 && (!current || indent < current.indent + 2);
    if (startsItem) {
      flush();
      sawMarker = true;
      current = { parts: [(marker[1] ?? '').trim()], line: line.number, indent };
    } else if (current && indent >= 2) {
      current.parts.push(line.text.trim());
    } else {
      flush();
    }
  }
  flush();
  return { items, sawMarker };
}

function listItems(lines: readonly Line[], start: number, end: number): CardItem[] {
  return scanList(lines, start, end).items;
}

function parseTerm(item: CardItem, glossary: boolean): GlossaryItem | undefined {
  const match = TERM_ITEM.exec(item.text);
  if (!match) return undefined;
  const term = match[1]!.trim().replace(/:$/, '').trim();
  if (!term) return undefined;
  let rest = match[2]!.trimStart();
  let context: string | undefined;
  if (glossary) {
    const prefix = CONTEXT_PREFIX.exec(rest);
    if (prefix) {
      context = prefix[1]!;
      rest = rest.slice(prefix[0].length).trimStart();
    }
  }
  const definition = rest.replace(/^:\s*/, '').trim();
  return context === undefined ? { term, definition, line: item.line } : { term, context, definition, line: item.line };
}

function inside(position: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => position >= start && position < end);
}

/**
 * Inline links outside code spans, then bare URLs and `#123` references outside link targets and the labels of
 * non-image links, in text order, each value once.
 */
function decisionRefs(text: string): { links: CardDecisionLink[]; externalRefs: string[] } {
  const stripped = text.replace(CODE_SPAN, (span) => ' '.repeat(span.length));
  const links: CardDecisionLink[] = [];
  const targets: [number, number][] = [];
  for (const match of stripped.matchAll(LABELLED_LINK)) {
    const labelStart = match.index + match[1]!.length + 1;
    const labelEnd = labelStart + match[2]!.length;
    targets.push([labelEnd + 1, match.index + match[0].length]);
    if (match[1] === '!') continue;
    targets.push([labelStart, labelEnd]);
    const target = unwrapTarget(match[3]!);
    if (target) links.push({ label: text.slice(labelStart, labelEnd).trim(), target });
  }

  const found: { index: number; value: string }[] = [];
  const urls: [number, number][] = [];
  for (const match of stripped.matchAll(BARE_URL)) {
    if (inside(match.index, targets)) continue;
    urls.push([match.index, match.index + match[0].length]);
    const value = match[0].replace(TRAILING_PUNCTUATION, '');
    if (/^https?:\/\/./.test(value)) found.push({ index: match.index, value });
  }
  for (const match of stripped.matchAll(ISSUE_REF)) {
    if (inside(match.index, targets) || inside(match.index, urls)) continue;
    found.push({ index: match.index, value: match[0] });
  }
  found.sort((a, b) => a.index - b.index);
  return { links, externalRefs: [...new Set(found.map((ref) => ref.value))] };
}

function parseDecision(item: CardItem): CardDecision | undefined {
  const match = DECISION_ITEM.exec(item.text);
  if (!match) return undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const text = match[4]!.trim();
  return { date: `${match[1]}-${match[2]}-${match[3]}`, text, line: item.line, ...decisionRefs(text) };
}

function itemsOf(lines: readonly Line[], sections: readonly SectionRange[], heading: string): CardItem[] {
  return sections.filter((s) => s.heading === heading).flatMap((s) => listItems(lines, s.start, s.end));
}

function openQuestionsOf(lines: readonly Line[], sections: readonly SectionRange[]): CardItem[] {
  const questions: CardItem[] = [];
  for (const section of sections) {
    if (section.heading !== OPEN_QUESTIONS_H2) continue;
    const { items, sawMarker } = scanList(lines, section.start, section.end);
    questions.push(...items);
    // The whole section is one question only when it has no list at all (an empty `- ` is still a list).
    if (sawMarker || !section.text) continue;
    let first = section.start;
    while (lines[first]!.text.trim() === '') first++;
    questions.push({ text: section.text, line: lines[first]!.number });
  }
  return questions;
}

function contractRefsOf(lines: readonly Line[], sections: readonly SectionRange[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    if (section.heading !== CONTRACTS_H2) continue;
    for (let k = section.start; k < section.end; k++) {
      const line = lines[k]!;
      if (line.fenced) continue;
      for (const ref of backticked(line.text)) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        refs.push(ref);
      }
    }
  }
  return refs;
}

function introOf(lines: readonly Line[]): { title?: string; intro?: CardItem } {
  const h1 = lines.findIndex((line) => headingOf(line)?.level === 1);
  if (h1 === -1) return {};
  const heading = headingOf(lines[h1]!)!;
  let end = h1 + 1;
  while (end < lines.length && headingOf(lines[end]!)?.level !== 2) end++;
  const text = sliceText(lines, h1 + 1, end);
  return text ? { title: heading.text, intro: { text, line: heading.line } } : { title: heading.text };
}

export function parseCard(text: string): ParsedCard {
  const lines = splitLines(text);
  const headings: MdHeading[] = [];
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) headings.push(heading);
  }
  const ranges = collectSections(lines);
  const sections: CardSection[] = ranges.map(({ heading, line, endLine, text: body }) => ({ heading, line, endLine, text: body }));
  const terms: CardTerm[] = [];
  for (const item of itemsOf(lines, ranges, LANGUAGE_H2)) {
    const term = parseTerm(item, false);
    if (term) terms.push({ term: term.term, definition: term.definition, line: term.line });
  }
  const decisions: CardDecision[] = [];
  for (const item of itemsOf(lines, ranges, DECISIONS_H2)) {
    const decision = parseDecision(item);
    if (decision) decisions.push(decision);
  }
  return {
    headings,
    rules: collectRules(lines),
    links: collectLinks(lines),
    ...introOf(lines),
    sections,
    terms,
    decisions,
    openQuestions: openQuestionsOf(lines, ranges),
    contractRefs: contractRefsOf(lines, ranges),
  };
}

/** Glossary term items anywhere outside fences; a leading `(context: <id>)` after the term sets `context`. */
export function parseGlossary(text: string): GlossaryItem[] {
  const lines = splitLines(text);
  const items: GlossaryItem[] = [];
  for (const item of listItems(lines, 0, lines.length)) {
    const term = parseTerm(item, true);
    if (term) items.push(term);
  }
  return items;
}

/** GitHub heading anchors: lowercase, drop punctuation, spaces to hyphens, repeats get -1, -2 in document order. */
export function githubSlugs(headings: readonly MdHeading[]): Set<string> {
  const slugs = new Set<string>();
  const used = new Map<string, number>();
  for (const heading of headings) {
    const base = heading.text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N} _-]/gu, '')
      .replace(/ /g, '-');
    let slug = base;
    let count = used.get(base) ?? 0;
    while (slugs.has(slug)) {
      count++;
      slug = `${base}-${count}`;
    }
    used.set(base, count);
    slugs.add(slug);
  }
  return slugs;
}

/** Check 5: every template H2 must be present and appear in template order; extra H2s are allowed anywhere. */
export function headingOrderProblems(headings: readonly MdHeading[]): string[] {
  const h2 = headings.filter((h) => h.level === 2).map((h) => h.text);
  const problems: string[] = [];
  let lastIndex = -1;
  let lastName = '';
  for (const name of CARD_H2_TEMPLATE) {
    const index = h2.indexOf(name);
    if (index === -1) {
      problems.push(`missing heading "## ${name}"`);
      continue;
    }
    if (index < lastIndex) {
      problems.push(`heading "## ${name}" must come after "## ${lastName}"`);
      continue;
    }
    lastIndex = index;
    lastName = name;
  }
  return problems;
}
