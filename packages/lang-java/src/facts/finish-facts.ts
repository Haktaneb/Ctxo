// Shared fact finisher (PR 4, issue #156, Fact contract FC-1 to FC-10). Copied unchanged into every
// official language plugin and @ctxo/domain; only import paths may differ.
import type { CodeFact, FactKind, SymbolNode } from '@ctxo/plugin-api';
import { FACT_KIND_ORDER } from './fact-types.js';
import type { FactEvidence, FactOptions, StringLiteralDecoder } from './fact-types.js';
import {
  MAX_FACTS_PER_FILE,
  canonicalNumber,
  capFactValue,
  hasRetryTimeoutFragment,
  isTrivialLiteral,
  joinRoute,
  matchesNormalizationPattern,
  normalizeFactText,
} from './fact-rules.js';

/** FC-9: `<file>::<basename without its last extension>::variable`, the owner of code outside every declaration. */
export function moduleSymbolId(file: string): string {
  const base = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return `${file}::${dot > 0 ? base.slice(0, dot) : base}::variable`;
}

interface DraftFact {
  readonly kind: FactKind;
  readonly symbolId?: string;
  readonly line: number;
  readonly text: string;
  readonly detail: Readonly<Record<string, string>>;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An unbound duration is named by the constructor's last two `.` segments; `setTimeout` is always `setTimeout`. */
function durationName(name: string | undefined, constructor: string): string {
  const segments = constructor.split('.');
  if (segments[segments.length - 1] === 'setTimeout') return 'setTimeout';
  return name ?? segments.slice(-2).join('.');
}

function draft(evidence: FactEvidence, options: FactOptions, decodeStringLiteral: StringLiteralDecoder | undefined): DraftFact | undefined {
  const base = { ...(evidence.symbolId !== undefined ? { symbolId: evidence.symbolId } : {}), line: evidence.line };
  switch (evidence.kind) {
    case 'comparison':
      if (isTrivialLiteral(evidence.literal, evidence.literalKind, options.trivialLiterals, decodeStringLiteral)) return undefined;
      // CRLF and CR become LF before the cap, so the committed index does not depend on a checkout's line endings.
      return { ...base, kind: 'literal-comparison', text: evidence.text, detail: { operator: evidence.operator, literal: capFactValue(evidence.literal.replace(/\r\n?/g, '\n')) } };
    case 'call':
      if (!matchesNormalizationPattern(evidence.method, evidence.qualifier, options.normalizationMethods)) return undefined;
      return { ...base, kind: 'normalization', text: evidence.text, detail: { method: evidence.method } };
    case 'binding': {
      if (!hasRetryTimeoutFragment(evidence.name)) return undefined;
      const value = canonicalNumber(evidence.value);
      if (value === undefined) return undefined;
      return { ...base, kind: 'retry-timeout', text: `${evidence.name} = ${value}`, detail: { name: evidence.name, value } };
    }
    case 'duration': {
      const amount = canonicalNumber(evidence.amount);
      if (amount === undefined) return undefined;
      const name = durationName(evidence.name, evidence.constructor);
      const value = `${amount}${evidence.unit}`;
      return { ...base, kind: 'retry-timeout', text: `${name} = ${value}`, detail: { name, value } };
    }
    case 'route': {
      const verb = evidence.verb.toUpperCase();
      const route = joinRoute(evidence.route);
      return { ...base, kind: 'endpoint', text: `${verb} ${route}`, detail: { verb, route } };
    }
    default:
      return undefined;
  }
}

/** The innermost symbol holding the line: the later start, then the smaller span, then index order. */
function attribute(line: number, symbols: readonly SymbolNode[], fallback: string): string {
  let best: SymbolNode | undefined;
  for (const symbol of symbols) {
    if (line < symbol.startLine || line > symbol.endLine) continue;
    if (
      !best
      || symbol.startLine > best.startLine
      || (symbol.startLine === best.startLine && symbol.endLine - symbol.startLine < best.endLine - best.startLine)
    ) {
      best = symbol;
    }
  }
  return best ? best.symbolId : fallback;
}

/**
 * Turns collector evidence into the file's facts: the trivial-literal list, normalization patterns,
 * retry/timeout names and numbers, routes (FC-3 to FC-8), FC-2 text, FC-9 attribution, then FC-10
 * order (line, kind, text, detail, symbol), duplicates dropped and at most 500 facts.
 * `decodeStringLiteral` is the language's string literal decoder for the trivial-literal check;
 * without it only a plain quoted literal can be trivial.
 */
export function finishFacts(
  file: string,
  evidence: readonly FactEvidence[],
  symbols: readonly SymbolNode[],
  options: FactOptions,
  decodeStringLiteral?: StringLiteralDecoder,
): CodeFact[] {
  const moduleId = moduleSymbolId(file);
  const keyed: { readonly fact: CodeFact; readonly detailKey: string }[] = [];
  for (const item of evidence) {
    const fact = draft(item, options, decodeStringLiteral);
    if (!fact) continue;
    const finished: CodeFact = {
      kind: fact.kind,
      symbolId: fact.symbolId ?? attribute(fact.line, symbols, moduleId),
      line: fact.line,
      text: normalizeFactText(fact.text),
      detail: fact.detail,
    };
    keyed.push({ fact: finished, detailKey: JSON.stringify(fact.detail) });
  }

  keyed.sort((a, b) =>
    a.fact.line - b.fact.line
    || FACT_KIND_ORDER.indexOf(a.fact.kind) - FACT_KIND_ORDER.indexOf(b.fact.kind)
    || compare(a.fact.text, b.fact.text)
    || compare(a.detailKey, b.detailKey)
    || compare(a.fact.symbolId, b.fact.symbolId));

  const facts: CodeFact[] = [];
  let previous: (typeof keyed)[number] | undefined;
  for (const entry of keyed) {
    if (
      previous
      && previous.fact.line === entry.fact.line
      && previous.fact.kind === entry.fact.kind
      && previous.fact.text === entry.fact.text
      && previous.detailKey === entry.detailKey
      && previous.fact.symbolId === entry.fact.symbolId
    ) {
      continue;
    }
    facts.push(entry.fact);
    previous = entry;
    if (facts.length === MAX_FACTS_PER_FILE) break;
  }
  return facts;
}
