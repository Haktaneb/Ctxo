import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CoreToolName, CtxoHost, ResponseEnricher } from '@ctxo/cli/internal';
import { DomainArtifactStore, type BoundariesArtifact, type ContextsArtifact } from '../adapters/artifact-store.js';
import { readRegistry } from '../adapters/registry-reader.js';
import type { BoundaryViolationRecord } from '../core/boundaries.js';
import { contextDrift, type ContextHistoryEntry } from '../core/context-metrics.js';
import { resolveDomainConfig } from '../core/domain-config.js';
import { ADDITIVE_CAP } from '../core/limits.js';
import { registryHash } from '../core/registry.js';
import type { DomainState } from './domain-state.js';
import { blastRadiusDomainFields, taskContextDomainFields, whyContextDomainFields } from './graph-enrichers.js';
import { prImpactDomainFields } from './pr-impact-fields.js';

type Payload = Record<string, unknown>;

/**
 * The longest an asynchronous domain enricher may take before its tool answers without the domain fields: well
 * under the MCP clients' tool timeouts (tens of seconds), and far above the few milliseconds the graph lookups take.
 */
export const ENRICHER_TIMEOUT_MS = 5_000;

/** Whether `value` has a callable `then`: a Promise or any other thenable. */
function isThenable(value: unknown): value is PromiseLike<Payload> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

/**
 * `enricher`, bounded in time. It works on a copy of the payload; a synchronous result is returned as is. A Promise
 * result that has not settled after `timeoutMs` gives the payload exactly as it came in (none of the domain fields)
 * and one warning; its late result or rejection is ignored. A rejection in time is passed on to the caller (the core
 * guard keeps the payload and warns).
 */
export function withTimeout(
  tool: CoreToolName,
  enricher: ResponseEnricher,
  warn: (message: string) => void,
  timeoutMs: number = ENRICHER_TIMEOUT_MS,
): ResponseEnricher {
  return (payload, args) => {
    const result = enricher(structuredClone(payload), args);
    if (!isThenable(result)) return result;
    return new Promise<Payload>((resolvePromise, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        warn(`The ${tool} domain fields did not settle within ${timeoutMs} ms; they are left out of this response`);
        resolvePromise(payload);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      result.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  };
}

/**
 * The links in order on one payload: each adds its fields and returns the payload. Synchronous until a link returns
 * a thenable; the remaining links then run on its resolved value.
 */
function compose(...links: ResponseEnricher[]): ResponseEnricher {
  return (payload, args) => {
    let current: Payload = payload;
    for (let i = 0; i < links.length; i++) {
      const result = links[i]!(current, args);
      if (isThenable(result)) {
        const rest = links.slice(i + 1);
        return Promise.resolve(result).then(async (value) => {
          let next = value;
          for (const link of rest) next = await link(next, args);
          return next;
        });
      }
      current = result;
    }
    return current;
  };
}

function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The file of a canonical `<file>::<name>::<kind>` symbol id. Ids with fewer parts, such as the 2-part data
 * reference `dbo.loans::table`, name no file and give undefined.
 */
function fileOfSymbolId(id: string): string | undefined {
  const parts = id.split('::');
  return parts.length >= 3 && parts[0] !== '' ? parts[0] : undefined;
}

/** A cheap change stamp for a file or folder: mtime and size, or 'missing'. */
function stampOf(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

/** A value reloaded only when its stamp changes. */
class Cached<T> {
  private stamp: string | undefined;
  private value: T | undefined;

  get(stamp: string, load: () => T): T {
    if (this.stamp !== stamp) {
      this.value = load();
      this.stamp = stamp;
    }
    return this.value as T;
  }
}

/** The domain data a response is enriched from; exists only when the registry and the artifacts agree. */
interface DomainView {
  readonly hash: string;
  readonly contexts: ContextsArtifact;
  /** The context of a repo-relative file when exactly one context owns it. */
  contextOf(file: string): string | undefined;
  boundaries(): BoundariesArtifact | undefined;
  history(): readonly ContextHistoryEntry[];
}

/**
 * The response enrichers: PR 2B's context fields (spec 10.5 to 10.7) composed with the domain graph fields of
 * `state` (spec 11.3). Registry hash, artifacts and history are cached by file mtime and size. Without a registry,
 * or when `contexts.json` was built from another registry text, PR 2B's enrichers return the payload unchanged
 * (E3); the graph fields follow `state.load()` the same way. The enrichers of the asynchronous tools are bounded by
 * `ENRICHER_TIMEOUT_MS` (`withTimeout`).
 */
export function createEnrichers(host: CtxoHost, state: DomainState): Partial<Record<CoreToolName, ResponseEnricher>> {
  const store = new DomainArtifactStore(host.ctxoRoot);
  const domainDir = join(host.ctxoRoot, 'index', 'domain');

  const configCache = new Cached<ReturnType<typeof resolveDomainConfig>>();
  const hashCache = new Cached<string | undefined>();
  const contextsCache = new Cached<{ contexts: ContextsArtifact; owners: Map<string, string[]> } | undefined>();
  const boundariesCache = new Cached<BoundariesArtifact | undefined>();
  const historyCache = new Cached<readonly ContextHistoryEntry[]>();

  function currentHash(): string | undefined {
    const { config } = configCache.get(stampOf(join(host.ctxoRoot, 'config.yaml')), () => {
      const loaded = host.services.loadConfig(host.ctxoRoot);
      return resolveDomainConfig((loaded.config as unknown as Record<string, unknown>)['domain']);
    });
    const path = resolve(host.projectRoot, config.registry);
    return hashCache.get(`${path}|${stampOf(path)}`, () => {
      const registry = readRegistry(host.projectRoot, config.registry);
      return registry === undefined ? undefined : registryHash(registry.text);
    });
  }

  function view(): DomainView | undefined {
    const hash = currentHash();
    if (hash === undefined) return undefined;
    const loaded = contextsCache.get(stampOf(join(domainDir, 'contexts.json')), () => {
      const contexts = store.readContexts();
      if (contexts === undefined) return undefined;
      const owners = new Map<string, string[]>();
      for (const context of contexts.contexts) {
        for (const file of context.files) {
          const list = owners.get(file);
          if (list === undefined) owners.set(file, [context.id]);
          else if (!list.includes(context.id)) list.push(context.id);
        }
      }
      for (const shared of contexts.multiplyOwned) {
        const list = owners.get(shared.file) ?? [];
        for (const id of shared.contexts) if (!list.includes(id)) list.push(id);
        owners.set(shared.file, list);
      }
      return { contexts, owners };
    });
    if (loaded === undefined || loaded.contexts.registryHash !== hash) return undefined;
    return {
      hash,
      contexts: loaded.contexts,
      contextOf: (file) => {
        const list = loaded.owners.get(file.replace(/\\/g, '/'));
        return list !== undefined && list.length === 1 ? list[0] : undefined;
      },
      boundaries: () => {
        const artifact = boundariesCache.get(stampOf(join(domainDir, 'boundaries.json')), () => store.readBoundaries());
        return artifact !== undefined && artifact.registryHash === hash ? artifact : undefined;
      },
      history: () => historyCache.get(stampOf(join(domainDir, 'history')), () => store.readHistory()),
    };
  }

  /** The file of a payload entry: its `file` when present, else the part of its symbol id before `::`. */
  function fileOf(entry: Payload): string | undefined {
    if (typeof entry['file'] === 'string') return entry['file'];
    const id = entry['symbolId'];
    return typeof id === 'string' ? fileOfSymbolId(id) : undefined;
  }

  function tag(entry: unknown, domain: DomainView): void {
    if (!isRecord(entry)) return;
    const file = fileOf(entry);
    if (file === undefined) return;
    const context = domain.contextOf(file);
    if (context !== undefined) entry['context'] = context;
  }

  function tagAll(list: unknown, domain: DomainView): void {
    if (Array.isArray(list)) for (const entry of list) tag(entry, domain);
  }

  const withDomain =
    (apply: (payload: Payload, args: Readonly<Payload>, domain: DomainView) => void): ResponseEnricher =>
    (payload, args) => {
      const domain = view();
      if (domain !== undefined) apply(payload, args, domain);
      return payload;
    };

  function changedSymbolIds(payload: Payload): Set<string> {
    const ids = new Set<string>();
    if (Array.isArray(payload['files'])) {
      for (const file of payload['files']) {
        if (!isRecord(file) || !Array.isArray(file['symbols'])) continue;
        for (const symbol of file['symbols']) if (isRecord(symbol) && typeof symbol['symbolId'] === 'string') ids.add(symbol['symbolId']);
      }
    }
    return ids;
  }

  const log = host.services.createLogger('ctxo:domain');
  const bounded = (tool: CoreToolName, enricher: ResponseEnricher): ResponseEnricher =>
    withTimeout(tool, enricher, (message) => log.warn(message));

  return {
    search_symbols: withDomain((payload, _args, domain) => tagAll(payload['results'], domain)),

    get_blast_radius: bounded(
      'get_blast_radius',
      compose(
        withDomain((payload, _args, domain) => tagAll(payload['impactedSymbols'], domain)),
        blastRadiusDomainFields(state),
      ),
    ),

    find_importers: withDomain((payload, _args, domain) => tagAll(payload['importers'], domain)),

    get_logic_slice: withDomain((payload, _args, domain) => {
      if (Array.isArray(payload['results'])) {
        for (const result of payload['results']) if (isRecord(result)) tag(result['root'], domain);
      } else {
        tag(payload['root'], domain);
      }
    }),

    // The git reads of the domain fields keep running when the bound fires; only their fields are dropped.
    get_pr_impact: bounded(
      'get_pr_impact',
      compose(
        withDomain((payload, _args, domain) => {
          if (Array.isArray(payload['files'])) {
            for (const file of payload['files']) if (isRecord(file)) tagAll(file['symbols'], domain);
          }
          const artifact = domain.boundaries();
          if (artifact === undefined) return;
          const changed = changedSymbolIds(payload);
          const touching: BoundaryViolationRecord[] = artifact.violations.filter(
            (v) => changed.has(v.from.symbolId) || changed.has(v.to.symbolId),
          );
          if (touching.length === 0) return;
          payload['contextBoundaryViolations'] = touching.slice(0, ADDITIVE_CAP);
          if (touching.length > ADDITIVE_CAP) payload['contextBoundaryViolationsTotal'] = touching.length;
        }),
        prImpactDomainFields(host, state),
      ),
    ),

    get_why_context: bounded(
      'get_why_context',
      compose(
        withDomain((payload, args, domain) => {
          const symbolId = args['symbolId'];
          if (typeof symbolId !== 'string') return;
          const file = fileOfSymbolId(symbolId) ?? (symbolId.includes('::') ? undefined : symbolId);
          const context = file === undefined ? undefined : domain.contextOf(file);
          if (context === undefined) return;
          const drift = contextDrift(context, domain.history(), domain.contexts.movedFiles, domain.hash);
          if (drift !== undefined) payload['contextDrift'] = drift;
        }),
        whyContextDomainFields(state),
      ),
    ),

    get_context_for_task: taskContextDomainFields(state),
  };
}
