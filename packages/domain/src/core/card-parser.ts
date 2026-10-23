/**
 * Minimal line parser for per-context domain cards. Pure: no I/O, no markdown library. It reads only what the
 * domain checks need: ATX headings, rule headings with their optional rule lines, link targets and heading anchors.
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
}

/** Inline links, images and reference definitions. */
export interface CardLink {
  readonly target: string;
  readonly line: number;
}

export interface ParsedCard {
  readonly headings: readonly MdHeading[];
  readonly rules: readonly CardRule[];
  readonly links: readonly CardLink[];
}

const RULES_H2 = 'Rules and invariants';
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const REF_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/;
const INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]*)/g;
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

function collectRules(lines: readonly Line[]): CardRule[] {
  const rules: CardRule[] = [];
  let inRules = false;
  for (let i = 0; i < lines.length; i++) {
    const heading = headingOf(lines[i]!);
    if (!heading) continue;
    if (heading.level === 2) {
      inRules = heading.text === RULES_H2;
      continue;
    }
    if (!inRules || heading.level !== 3) continue;

    const space = heading.text.search(/\s/);
    const id = space === -1 ? heading.text : heading.text.slice(0, space);
    const title = space === -1 ? '' : heading.text.slice(space).trim();
    const tests: string[] = [];
    const code: string[] = [];
    let untested: string | undefined;

    let j = i + 1;
    while (j < lines.length && !lines[j]!.fenced && lines[j]!.text.trim() === '') j++;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.fenced) break;
      if (line.text.startsWith('Tests:')) tests.push(...backticked(line.text.slice('Tests:'.length)));
      else if (line.text.startsWith('Code:')) code.push(...backticked(line.text.slice('Code:'.length)));
      else if (line.text.startsWith('Untested:')) untested = line.text.slice('Untested:'.length).trim();
      else break;
    }

    rules.push(untested === undefined ? { id, title, line: heading.line, tests, code } : { id, title, line: heading.line, tests, code, untested });
  }
  return rules;
}

export function parseCard(text: string): ParsedCard {
  const lines = splitLines(text);
  const headings: MdHeading[] = [];
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) headings.push(heading);
  }
  return { headings, rules: collectRules(lines), links: collectLinks(lines) };
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
