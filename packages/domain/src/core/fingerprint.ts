/**
 * Line-independent fingerprints of shadow-spec candidates (spec 12.2, H4): `kind | symbol | normalized text`. A
 * changed literal changes the fingerprint; a moved line does not.
 */

import { normalizeFactText } from './facts/fact-rules.js';

const SEPARATOR = ' | ';

/** Whitespace runs become one space, trimmed. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The name without one trailing balanced `(...)` (the C# parameter suffix, `CanBorrow(1)`). */
function withoutParameterSuffix(name: string): string {
  const trimmed = name.trimEnd();
  if (!trimmed.endsWith(')')) return trimmed;
  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) return trimmed.slice(0, i);
    }
  }
  return trimmed;
}

/** The file name without its directory and without its last extension (`src/app.ts` gives `app`; W26). */
function baseName(file: string): string {
  const slashed = file.replace(/\\/g, '/');
  const name = slashed.slice(slashed.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

const OPEN_BRACKETS = new Map<string, string>([
  ['<', '>'],
  ['[', ']'],
  ['(', ')'],
]);
const QUOTES = new Set<string>(["'", '"', '`']);

/**
 * Offsets of the `.` that separate name segments: never inside `<...>` (`IComparable<Lending.Member>`), `[...]`
 * (`[Symbol.iterator]`), `(...)` or a quoted segment (`'a.b'`).
 * - Brackets nest by kind; a closer that does not match the innermost opener is text, and an unclosed opener runs
 *   to the end.
 * - A quote opens only at the start of a segment (the start of the name or right after a separating `.`), so an
 *   apostrophe inside a segment (`o'brien.loans`, `[o'brien].loans`) is text. Inside a quoted segment a backslash
 *   escapes the next character (`'a\'.b'`); an unclosed quote runs to the end.
 */
export function segmentDots(name: string): number[] {
  const out: number[] = [];
  const closers: string[] = [];
  let quote: string | undefined;
  let segmentStart = true;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    const atStart = segmentStart;
    segmentStart = false;
    if (quote !== undefined) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
    } else if (atStart && QUOTES.has(ch)) quote = ch;
    else if (OPEN_BRACKETS.has(ch)) closers.push(OPEN_BRACKETS.get(ch)!);
    else if (closers.length > 0 && ch === closers[closers.length - 1]) closers.pop();
    else if (ch === '.' && closers.length === 0) {
      out.push(i);
      segmentStart = true;
    }
  }
  return out;
}

/** `.` segments split at `segmentDots`; empty ones dropped. */
export function nameSegments(name: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const dot of segmentDots(name)) {
    out.push(name.slice(start, dot));
    start = dot + 1;
  }
  out.push(name.slice(start));
  return out.filter((segment) => segment !== '');
}

/**
 * H4: the last two `.` segments of `<file basename>.<symbol name without a trailing (...)>`, where the basename has
 * no directory and no last extension (W26). `src/Lending/LoanPolicy.cs::LibraryLending.Lending.LoanPolicy.CanBorrow::method`
 * gives `LoanPolicy.CanBorrow`, `src/lending/loan-policy.ts::canBorrow::function` gives `loan-policy.canBorrow`,
 * `src/app.ts::app::variable` gives `app.app`. An ID without a file part (`dbo.loans::table`) uses its name alone.
 * A `.` inside `<...>`, `[...]`, `(...)` or quotes does not split a segment (`segmentDots`).
 *
 * Amended H4 (fix rounds 1 and 2): a member whose name holds a `.` keeps its containing type. Without a container
 * this follows from the segment rule (`Foo.[Symbol.iterator]`, `Foo.'a.b'`). `container` is the name of the type
 * that declares the symbol (the longest class, interface or type symbol of the file whose name prefixes the
 * symbol's name); when the name after it still has more than one segment, as for a C# explicit interface
 * implementation (`NS.Loan.System.IComparable<Lending.Loan>.CompareTo`), the part is the type's last segment plus
 * the last two segments of that rest: `Loan.IComparable<Lending.Loan>.CompareTo`.
 */
export function fingerprintSymbolPart(symbolId: string, container?: string): string {
  const first = symbolId.indexOf('::');
  const last = symbolId.lastIndexOf('::');
  if (first >= 0 && first !== last && container !== undefined) {
    const name = withoutParameterSuffix(symbolId.slice(first + 2, last));
    if (container !== '' && name.startsWith(`${container}.`)) {
      const rest = nameSegments(name.slice(container.length + 1));
      const type = nameSegments(container).at(-1);
      if (rest.length > 1 && type !== undefined) return collapse([type, ...rest.slice(-2)].join('.'));
    }
  }
  let segments: string[];
  if (first < 0) segments = nameSegments(withoutParameterSuffix(symbolId));
  else if (first === last) segments = nameSegments(withoutParameterSuffix(symbolId.slice(0, first)));
  else {
    // The basename splits at every `.`, so a quote in a file name never joins it with the symbol name.
    const base = baseName(symbolId.slice(0, first)).split('.').filter((segment) => segment !== '');
    segments = [...base, ...nameSegments(withoutParameterSuffix(symbolId.slice(first + 2, last)))];
  }
  return collapse(segments.slice(-2).join('.'));
}

/** Percent-encodes `%` (first) and `|` in a kind or symbol part, so the part never holds a separator (I1). */
function encodePart(part: string): string {
  return part.replace(/%/g, '%25').replace(/\|/g, '%7C');
}

/** The inverse of the encoding of a kind or symbol part: `%7C` gives `|`, `%25` gives `%` (any hex case). */
export function decodeFingerprintPart(part: string): string {
  return part.replace(/%(7C|25)/gi, (match) => (match.toUpperCase() === '%7C' ? '|' : '%'));
}

/**
 * `${kind} | ${symbolPart} | ${normalizeFactText(text)}`. Kind and symbol part are whitespace-collapsed and
 * percent-encoded (`%` as `%25`, `|` as `%7C`), so `normalizeFingerprint` gives the same string back. The text part
 * keeps `|`: it is the last part.
 */
export function fingerprint(kind: string, symbolPart: string, text: string): string {
  return [encodePart(collapse(kind)), encodePart(collapse(symbolPart)), normalizeFactText(text)].join(SEPARATOR);
}

/**
 * A fingerprint as written by hand (`shadow-specs.yaml`): split at the first two `|`, each part trimmed and
 * whitespace-collapsed, joined with ` | `. Later `|` belong to the text. The first two parts are decoded and
 * encoded again, so `%7c` becomes `%7C` and a raw `%` becomes `%25`, as `fingerprint` writes them. Undefined for
 * fewer than three parts or an empty part.
 */
export function normalizeFingerprint(raw: string): string | undefined {
  const first = raw.indexOf('|');
  if (first < 0) return undefined;
  const second = raw.indexOf('|', first + 1);
  if (second < 0) return undefined;
  const parts = [raw.slice(0, first), raw.slice(first + 1, second), raw.slice(second + 1)].map(collapse);
  if (parts.some((part) => part === '')) return undefined;
  return [encodePart(decodeFingerprintPart(parts[0]!)), encodePart(decodeFingerprintPart(parts[1]!)), parts[2]!].join(SEPARATOR);
}
