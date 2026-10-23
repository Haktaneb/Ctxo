import { isMap, isScalar, parseDocument, type Document, type YAMLMap } from 'yaml';
import { DEFAULT_DOMAIN_CONFIG, type BoundaryMode } from '../core/domain-config.js';

const BOM = String.fromCharCode(0xfeff);

/** The `domain:` block an absent section gets (D15); `<mode>` is the boundary mode. */
const DOMAIN_BLOCK = String.raw`domain:
  registry: docs/domain/contexts.yaml
  coverage:
    unowned: warn            # warn | error
  boundaries:
    enforce: <mode>          # by-rung | report
    blockingRungs: [bounded, boring]
  rules:
    idPattern: "^[A-Z][A-Z0-9]*-\\d+$"
    trackerPrefixes: []
  tests:
    ruleTraitKeys: [Rule]
  guard:
    enabled: true
    subagents: false
`;

/** The defaults as a plain tree, the order the block lists them in; `guard.base` has no default. */
function defaultTree(mode: BoundaryMode): Record<string, unknown> {
  const d = DEFAULT_DOMAIN_CONFIG;
  return {
    registry: d.registry,
    coverage: { unowned: d.coverage.unowned },
    boundaries: { enforce: mode, blockingRungs: [...d.boundaries.blockingRungs] },
    rules: { idPattern: d.rules.idPattern, trackerPrefixes: [...d.rules.trackerPrefixes] },
    tests: { ruleTraitKeys: [...d.tests.ruleTraitKeys] },
    guard: { enabled: d.guard.enabled, subagents: d.guard.subagents },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adds every key of `defaults` that `map` lacks, recursing into mappings on both sides; true when one was added. */
function addMissing(doc: Document, map: YAMLMap, defaults: Record<string, unknown>): boolean {
  let added = false;
  for (const [key, value] of Object.entries(defaults)) {
    const existing = map.get(key, true);
    if (existing === undefined) {
      map.set(key, doc.createNode(value, { flow: Array.isArray(value) }));
      added = true;
    } else if (isPlainRecord(value) && isMap(existing)) {
      added = addMissing(doc, existing, value) || added;
    }
  }
  return added;
}

/**
 * Adds the `domain:` defaults to the text of `.ctxo/config.yaml` (D15). An absent section is appended as
 * the commented block, with `mode` as `boundaries.enforce`, and the rest of the text is kept byte for byte.
 * Otherwise only missing keys are added through the `yaml` Document API (comments kept), and existing
 * values are never changed; a complete section returns the text unchanged. A UTF-8 BOM and CRLF line
 * endings are kept. Throws when the text is not valid YAML or `domain` is neither empty nor a mapping.
 */
export function mergeDomainDefaults(text: string, mode: BoundaryMode): { readonly text: string; readonly changed: boolean } {
  const bom = text.startsWith(BOM);
  const raw = bom ? text.slice(BOM.length) : text;
  const crlf = raw.includes('\r\n');
  const body = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  const restore = (out: string): string => (bom ? BOM : '') + (crlf ? out.replace(/\n/g, '\r\n') : out);

  const doc = parseDocument(body);
  if (doc.errors.length > 0) throw new Error(`not valid YAML: ${doc.errors[0]!.message}`);
  const root = doc.contents;
  if (root !== null && !isMap(root) && !(isScalar(root) && (root.value === null || root.value === ''))) {
    throw new Error('the config must be a mapping');
  }

  const section = isMap(root) ? root.get('domain', true) : undefined;
  if (section === undefined) {
    const block = DOMAIN_BLOCK.replace('<mode>', mode);
    const separator = body.trim() === '' ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    return { text: restore((body.trim() === '' ? '' : body) + separator + block), changed: true };
  }

  const defaults = defaultTree(mode);
  const sectionValue: unknown = isScalar(section) ? section.value : undefined;
  if (isScalar(section) && (sectionValue === null || sectionValue === '')) {
    (root as YAMLMap).set('domain', doc.createNode(defaults));
    return { text: restore(doc.toString({ lineWidth: 0 })), changed: true };
  }
  if (!isMap(section)) throw new Error('domain must be a mapping');
  if (!addMissing(doc, section, defaults)) return { text, changed: false };
  return { text: restore(doc.toString({ lineWidth: 0 })), changed: true };
}
