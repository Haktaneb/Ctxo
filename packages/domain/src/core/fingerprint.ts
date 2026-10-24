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

/** `.` segments, never splitting inside generic arguments (`IComparable<Lending.Member>` is one segment); empty ones dropped. */
export function nameSegments(name: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === '.' && depth === 0) {
      out.push(name.slice(start, i));
      start = i + 1;
    }
  }
  out.push(name.slice(start));
  return out.filter((segment) => segment !== '');
}

/**
 * H4: the last two `.` segments of `<file basename>.<symbol name without a trailing (...)>`, where the basename has
 * no directory and no last extension (W26). `src/Lending/LoanPolicy.cs::LibraryLending.Lending.LoanPolicy.CanBorrow::method`
 * gives `LoanPolicy.CanBorrow`, `src/lending/loan-policy.ts::canBorrow::function` gives `loan-policy.canBorrow`,
 * `src/app.ts::app::variable` gives `app.app`. An ID without a file part (`dbo.loans::table`) uses its name alone.
 * A `.` inside `<...>` does not split a segment.
 *
 * `container` is the name of the type that declares the symbol (the longest class, interface or type symbol of the
 * file whose name prefixes the symbol's name). When the rest of the name after it has more than one segment, as for
 * a C# explicit interface implementation (`NS.Loan.System.IComparable<Lending.Loan>.CompareTo`), the part keeps the
 * containing type: `Loan.IComparable<Lending.Loan>.CompareTo` (amends H4, fix round 1 M3).
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
  let joined: string;
  if (first < 0) joined = withoutParameterSuffix(symbolId);
  else if (first === last) joined = withoutParameterSuffix(symbolId.slice(0, first));
  else joined = `${baseName(symbolId.slice(0, first))}.${withoutParameterSuffix(symbolId.slice(first + 2, last))}`;
  return collapse(nameSegments(joined).slice(-2).join('.'));
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
