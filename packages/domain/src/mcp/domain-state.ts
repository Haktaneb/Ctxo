import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CtxoHost } from '@ctxo/cli/internal';
import { DomainArtifactStore } from '../adapters/artifact-store.js';
import { readRegistry } from '../adapters/registry-reader.js';
import { readRepoText } from '../adapters/repo-files.js';
import { resolveDomainConfig, type DomainConfig } from '../core/domain-config.js';
import { cardsHash } from '../core/domain-graph.js';
import { indexGraph, type DomainSnapshot } from '../core/domain-graph-query.js';
import { createOwnership } from '../core/ownership.js';
import { registryHash, type DomainRegistry } from '../core/registry.js';

export type DomainStateReason = 'no-registry' | 'invalid-registry' | 'no-graph' | 'stale-registry';

export type DomainStateResult =
  | { readonly ok: true; readonly snapshot: DomainSnapshot }
  | { readonly ok: false; readonly reason: DomainStateReason; readonly hint: string };

export interface DomainState {
  load(): DomainStateResult;
}

export const STALE_CARDS_HINT = 'Cards or the glossary changed since the last "ctxo index"; run it to refresh rule links.';

const NO_GRAPH_HINT = 'No domain graph yet; run "ctxo index".';
const STALE_REGISTRY_HINT = 'The domain registry changed since the last "ctxo index"; run it to rebuild the domain graph.';

/** A stamp whose mtime is this close to the moment it was taken is not trusted (the racy-git rule). */
const RACY_WINDOW_MS = 2_000;

/** The card paths of a registry (each once, registry order) and its glossary: the inputs of `cardsHash`. */
function cardFiles(registry: DomainRegistry): string[] {
  const paths: string[] = [];
  for (const context of registry.contexts) if (context.card !== undefined && !paths.includes(context.card)) paths.push(context.card);
  if (!paths.includes(registry.glossary)) paths.push(registry.glossary);
  return paths;
}

/** Joins the stamps of one cache key. */
const SEP = '\n';

export interface DomainStateOptions {
  /** The clock for the racy-stamp rule; `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * The loaded domain graph with the registry, config and ownership it was read against (spec 11.2, E3). One state
 * per `register`: creating it does no I/O (P19, the hook route runs `register` on a 1 s budget); `load()` reads,
 * and caches its result by the mtime and size of the config, the registry, `graph.json`, each card and the
 * glossary. A registry the graph was not built from gives `stale-registry`; cards or a glossary edited since give a
 * snapshot with `staleCards`. A file modified within 2 s of the moment its stamp is taken (or in the future) gets a
 * stamp that never matches, so an edit of the same size inside one coarse mtime tick is seen by the next load.
 */
export function createDomainState(host: CtxoHost, options: DomainStateOptions = {}): DomainState {
  const now = options.now ?? Date.now;
  let racyCount = 0;
  /** mtime and size, 'missing', or a one-off value for a racy file. */
  const stampOf = (path: string): string => {
    const taken = now();
    try {
      const stat = statSync(path);
      if (stat.mtimeMs > taken - RACY_WINDOW_MS) return `racy:${++racyCount}`;
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'missing';
    }
  };
  const configPath = join(host.ctxoRoot, 'config.yaml');
  const graphPath = join(host.ctxoRoot, 'index', 'domain', 'graph.json');
  const stampRepo = (path: string): string => `${path}|${stampOf(resolve(host.projectRoot, path))}`;

  let configStamp: string | undefined;
  let config: DomainConfig | undefined;
  /** The stamps the cached result was read at; the card part names the cards of the registry read then. */
  let cachedKey: string | undefined;
  let cachedCards: readonly string[] = [];
  let cached: DomainStateResult | undefined;
  let generation = 0;

  function currentConfig(): DomainConfig {
    const stamp = stampOf(configPath);
    if (config === undefined || stamp !== configStamp) {
      configStamp = stamp;
      const loaded = host.services.loadConfig(host.ctxoRoot);
      config = resolveDomainConfig((loaded.config as unknown as Record<string, unknown>)['domain']).config;
    }
    return config;
  }

  /**
   * One reload. Every stamp is taken before its file is read, so a write during a load is seen by the next one.
   * The card stamps join the key once the registry names the cards.
   */
  function read(cfg: DomainConfig, base: string): { result: DomainStateResult; key: string; cards: readonly string[] } {
    const fail = (reason: DomainStateReason, hint: string, cards: readonly string[] = []) => ({
      result: { ok: false as const, reason, hint },
      key: [base, ...cards.map(stampRepo)].join(SEP),
      cards,
    });

    const loaded = readRegistry(host.projectRoot, cfg.registry);
    if (loaded === undefined) {
      return fail('no-registry', `No domain registry at ${cfg.registry}. Create one with "ctxo init --domain".`);
    }
    if (loaded.registry === undefined || loaded.problems.length > 0) {
      return fail('invalid-registry', `The domain registry at ${loaded.path} has problems; run "ctxo verify-domain".`);
    }
    const registry = loaded.registry;
    const cards = cardFiles(registry);
    const key = [base, ...cards.map(stampRepo)].join(SEP);

    const graph = new DomainArtifactStore(host.ctxoRoot).readGraph();
    if (graph === undefined) return fail('no-graph', NO_GRAPH_HINT, cards);
    if (graph.registryHash !== registryHash(loaded.text)) return fail('stale-registry', STALE_REGISTRY_HINT, cards);

    const current = cardsHash(
      cards.map((path) => {
        const text = readRepoText(host.projectRoot, path);
        return text === undefined ? { path } : { path, text };
      }),
    );
    return {
      result: {
        ok: true,
        snapshot: {
          registry,
          registryPath: loaded.path,
          config: cfg,
          ownership: createOwnership(registry, host.services.makeGlobMatcher),
          graph,
          index: indexGraph(graph),
          staleCards: graph.cardsHash !== current,
          generation,
        },
      },
      key,
      cards,
    };
  }

  return {
    load() {
      const cfg = currentConfig();
      const registryPath = resolve(host.projectRoot, cfg.registry);
      const base = [configStamp, stampOf(graphPath), `${registryPath}|${stampOf(registryPath)}`].join(SEP);
      if (cached !== undefined && [base, ...cachedCards.map(stampRepo)].join(SEP) === cachedKey) return cached;
      generation += 1;
      const { result, key, cards } = read(cfg, base);
      cached = result;
      cachedKey = key;
      cachedCards = cards;
      return result;
    },
  };
}
