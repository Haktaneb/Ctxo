import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CoreToolName, CtxoHost, ResponseEnricher } from '@ctxo/cli/internal';
import { DomainArtifactStore, type BoundariesArtifact, type ContextsArtifact } from '../adapters/artifact-store.js';
import { readRegistry } from '../adapters/registry-reader.js';
import type { BoundaryViolationRecord } from '../core/boundaries.js';
import { contextDrift, type ContextHistoryEntry } from '../core/context-metrics.js';
import { resolveDomainConfig } from '../core/domain-config.js';
import { registryHash } from '../core/registry.js';

/** The most entries an additive array carries on an existing tool; a `<name>Total` count says when more existed. */
const ADDITIVE_CAP = 50;

type Payload = Record<string, unknown>;

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
 * The response enrichers (spec 10.5 to 10.7). Registry hash, artifacts and history are cached by file mtime
 * and size. Without a registry, or when `contexts.json` was built from another registry text, every enricher
 * returns the payload unchanged (E3).
 */
export function createEnrichers(host: CtxoHost): Partial<Record<CoreToolName, ResponseEnricher>> {
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

  return {
    search_symbols: withDomain((payload, _args, domain) => tagAll(payload['results'], domain)),

    get_blast_radius: withDomain((payload, _args, domain) => tagAll(payload['impactedSymbols'], domain)),

    find_importers: withDomain((payload, _args, domain) => tagAll(payload['importers'], domain)),

    get_logic_slice: withDomain((payload, _args, domain) => {
      if (Array.isArray(payload['results'])) {
        for (const result of payload['results']) if (isRecord(result)) tag(result['root'], domain);
      } else {
        tag(payload['root'], domain);
      }
    }),

    get_pr_impact: withDomain((payload, _args, domain) => {
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

    get_why_context: withDomain((payload, args, domain) => {
      const symbolId = args['symbolId'];
      if (typeof symbolId !== 'string') return;
      const file = fileOfSymbolId(symbolId) ?? (symbolId.includes('::') ? undefined : symbolId);
      const context = file === undefined ? undefined : domain.contextOf(file);
      if (context === undefined) return;
      const drift = contextDrift(context, domain.history(), domain.contexts.movedFiles, domain.hash);
      if (drift !== undefined) payload['contextDrift'] = drift;
    }),
  };
}
