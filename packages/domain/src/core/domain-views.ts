import type { DecisionNode, RuleNode, TermNode } from './domain-graph.js';
import { codeRefs, decisionView, testRefs, type DomainSnapshot, type ProvenanceView } from './domain-graph-query.js';
import { ADDITIVE_CAP } from './limits.js';

/**
 * The payloads of `get_domain_context` and `get_rule` (spec 11.4, designer call F14). Pure views over a loaded
 * snapshot: no I/O, every order is document or codepoint order. Lists the response envelope may truncate sit at the
 * top level (`contexts`, `terms`, `rules`, `openQuestions`, `tests`, `symbols`, `provenance`, `unresolved`);
 * `decisions` is not truncatable there, so it is capped here at `ADDITIVE_CAP` with `decisionsTotal`.
 */

export const VIEW_CAPS = { identifiers: 15, testsPerRule: 10, codePerRule: 10 } as const;

export type ContextLookup = { readonly context: string } | { readonly hint: string };

type Payload = Record<string, unknown>;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The context a repo-relative path selects: a context's card path selects that context (the owner of the card's
 * rules when several contexts share it); any other path selects the one context whose paths match it.
 */
export function contextForPath(snapshot: DomainSnapshot, path: string): ContextLookup {
  const byCard = snapshot.registry.contexts.filter((context) => context.card === path).map((context) => context.id);
  if (byCard.length > 0) return { context: snapshot.index.ruleContextByCard.get(path) ?? [...byCard].sort(compare)[0]! };
  const owners = snapshot.ownership.owners(path);
  if (owners.length === 0) return { hint: `No named context owns ${path}.` };
  if (owners.length > 1) {
    return { hint: `${path} belongs to ${owners.length} contexts (${owners.join(', ')}); fix the registry, see "ctxo verify-domain".` };
  }
  return { context: owners[0]! };
}

/** At most `ADDITIVE_CAP` decision views, with `decisionsTotal` only when entries were cut. */
function cappedDecisions(snapshot: DomainSnapshot, decisions: readonly DecisionNode[]): Payload {
  const views = decisions.slice(0, ADDITIVE_CAP).map((decision) => decisionView(snapshot.index, decision));
  return decisions.length > ADDITIVE_CAP ? { decisions: views, decisionsTotal: decisions.length } : { decisions: views };
}

function termView(snapshot: DomainSnapshot, term: TermNode): Payload {
  return {
    term: term.term,
    key: term.key,
    definitions: term.definitions.map((d) => ({ text: d.text, file: d.at.file, line: d.at.line, origin: d.origin })),
    identifiers: (snapshot.index.termIdentifiers.get(term.id) ?? []).slice(0, VIEW_CAPS.identifiers),
    identifierCount: term.identifierCount,
  };
}

function ruleEntry(snapshot: DomainSnapshot, rule: RuleNode): Payload {
  const tests = testRefs(snapshot.index, rule.ruleId);
  const code = codeRefs(snapshot.index, rule.ruleId);
  return {
    ruleId: rule.ruleId,
    title: rule.title,
    line: rule.line,
    ...(rule.untested === undefined ? {} : { untested: rule.untested }),
    tests: tests.slice(0, VIEW_CAPS.testsPerRule),
    testCount: tests.length,
    code: code.slice(0, VIEW_CAPS.codePerRule),
    codeCount: code.length,
  };
}

function hasTest(snapshot: DomainSnapshot, ruleId: string): boolean {
  return (snapshot.index.codeLinksByRule.get(ruleId) ?? []).some((link) => link.kind === 'rule-test');
}

/** The card of one context: terms, rules with their tests and code, contracts, decisions and open questions. */
export function contextView(snapshot: DomainSnapshot, context: string): Payload {
  const { index, registry } = snapshot;
  const entry = registry.contexts.find((c) => c.id === context);
  const node = index.contexts.get(context);
  if (entry === undefined || node === undefined) return { found: false, hint: `No context ${context} in the registry.` };

  const outbound = Object.keys(entry.contracts)
    .sort(compare)
    .map((target) => ({ target, files: [...entry.contracts[target]!] }));
  const inbound = registry.contexts
    .filter((c) => c.id !== context && c.contracts[context] !== undefined)
    .map((c) => ({ from: c.id, files: [...c.contracts[context]!] }));
  const section = (index.sectionsByContext.get(context) ?? []).find((s) => s.kind === 'contracts');

  const rules = index.rulesByContext.get(context) ?? [];
  const owner = node.card === undefined ? undefined : index.ruleContextByCard.get(node.card);
  const shared =
    rules.length === 0 && node.card !== undefined && owner !== undefined && owner !== context
      ? { hint: `The rules of ${node.card} belong to context ${owner}, which shares the card; use get_domain_context with path ${node.card} for them.` }
      : {};

  return {
    context: {
      id: node.context,
      name: node.name,
      rung: node.rung,
      ...(node.card === undefined ? {} : { card: node.card }),
      ...(node.rulePrefix === undefined ? {} : { rulePrefix: node.rulePrefix }),
      paths: [...entry.paths],
    },
    terms: (index.termsByContext.get(context) ?? []).map((term) => termView(snapshot, term)),
    rules: rules.map((rule) => ruleEntry(snapshot, rule)),
    contracts: {
      outbound,
      inbound,
      ...(section === undefined ? {} : { text: section.text }),
      references: [...(section?.references ?? [])],
    },
    ...cappedDecisions(snapshot, index.decisionsByContext.get(context) ?? []),
    openQuestions: (index.openQuestionsByContext.get(context) ?? []).map((q) => ({ text: q.text, line: q.line })),
    ...shared,
  };
}

/** Every context of the registry, in registry order, with its counts. */
export function contextsOverview(snapshot: DomainSnapshot): Payload {
  const { index } = snapshot;
  return {
    contexts: snapshot.registry.contexts.map((entry) => {
      const node = index.contexts.get(entry.id);
      const rules = index.rulesByContext.get(entry.id) ?? [];
      const card = node?.card ?? entry.card;
      return {
        id: entry.id,
        name: entry.name,
        rung: entry.rung,
        ...(card === undefined ? {} : { card }),
        ruleCount: rules.length,
        rulesWithTests: rules.filter((rule) => hasTest(snapshot, rule.ruleId)).length,
        termCount: (index.termsByContext.get(entry.id) ?? []).length,
        decisionCount: (index.decisionsByContext.get(entry.id) ?? []).length,
      };
    }),
  };
}

/** Date descending, then context, then `n`: one order across contexts. */
function byNewest(a: DecisionNode, b: DecisionNode): number {
  return compare(b.date, a.date) || compare(a.context, b.context) || a.n - b.n;
}

/** One rule (a canonical rule ID): text, context, tests with their sources, symbols, decisions and provenance. */
export function ruleView(snapshot: DomainSnapshot, ruleId: string): Payload {
  const { index } = snapshot;
  const rule = index.rules.get(ruleId);
  if (rule === undefined) return { found: false, hint: `No rule ${ruleId} in any card.` };
  const node = index.contexts.get(rule.context);

  // A card shared by several contexts gives each of them the same decisions; on the rule's own card only the copy of
  // the context that owns the rule counts.
  const decisions = snapshot.graph.decisions
    .filter((decision) => (index.decisionRules.get(decision.id) ?? []).includes(ruleId))
    .filter((decision) => decision.card !== rule.card || decision.context === rule.context)
    .sort(byNewest);
  const capped = cappedDecisions(snapshot, decisions);

  // Only the listed decisions give provenance, so every `decision` reference resolves in the payload.
  const provenance: (ProvenanceView & { readonly decision: string })[] = [];
  const seen = new Set<string>();
  for (const decision of decisions.slice(0, ADDITIVE_CAP)) {
    for (const view of decisionView(index, decision).provenance) {
      const key = view.kind === 'file' ? `file\n${view.path}` : `external\n${view.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      provenance.push({ ...view, decision: decision.id });
    }
  }

  const unresolved = (index.unresolvedByRule.get(ruleId) ?? []).map((ref) => ({
    field: ref.field,
    value: ref.value,
    file: ref.at.file,
    line: ref.at.line,
    reason: ref.reason,
  }));

  return {
    rule: {
      ruleId: rule.ruleId,
      title: rule.title,
      text: rule.text,
      line: rule.line,
      ...(rule.untested === undefined ? {} : { untested: rule.untested }),
      context: { id: rule.context, name: node?.name ?? rule.context, rung: node?.rung },
      card: rule.card,
    },
    tests: testRefs(index, ruleId),
    symbols: codeRefs(index, ruleId),
    ...capped,
    provenance,
    ...(unresolved.length === 0 ? {} : { unresolved }),
  };
}
