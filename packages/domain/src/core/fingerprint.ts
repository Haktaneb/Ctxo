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

/**
 * H4: the last two `.` segments of `<file basename>.<symbol name without a trailing (...)>`, where the basename has
 * no directory and no last extension (W26). `src/Lending/LoanPolicy.cs::LibraryLending.Lending.LoanPolicy.CanBorrow::method`
 * gives `LoanPolicy.CanBorrow`, `src/lending/loan-policy.ts::canBorrow::function` gives `loan-policy.canBorrow`,
 * `src/app.ts::app::variable` gives `app.app`. An ID without a file part (`dbo.loans::table`) uses its name alone.
 */
export function fingerprintSymbolPart(symbolId: string): string {
  const first = symbolId.indexOf('::');
  const last = symbolId.lastIndexOf('::');
  let joined: string;
  if (first < 0) joined = withoutParameterSuffix(symbolId);
  else if (first === last) joined = withoutParameterSuffix(symbolId.slice(0, first));
  else joined = `${baseName(symbolId.slice(0, first))}.${withoutParameterSuffix(symbolId.slice(first + 2, last))}`;
  const segments = joined.split('.').filter((segment) => segment !== '');
  return collapse(segments.slice(-2).join('.'));
}

/** `${kind} | ${symbolPart} | ${normalizeFactText(text)}`; kind and symbol part are whitespace-collapsed. */
export function fingerprint(kind: string, symbolPart: string, text: string): string {
  return [collapse(kind), collapse(symbolPart), normalizeFactText(text)].join(SEPARATOR);
}

/**
 * A fingerprint as written by hand (`shadow-specs.yaml`): split at the first two `|`, each part trimmed and
 * whitespace-collapsed, joined with ` | `. Later `|` belong to the text. Undefined for fewer than three parts or an
 * empty part.
 */
export function normalizeFingerprint(raw: string): string | undefined {
  const first = raw.indexOf('|');
  if (first < 0) return undefined;
  const second = raw.indexOf('|', first + 1);
  if (second < 0) return undefined;
  const parts = [raw.slice(0, first), raw.slice(first + 1, second), raw.slice(second + 1)].map(collapse);
  return parts.some((part) => part === '') ? undefined : parts.join(SEPARATOR);
}
