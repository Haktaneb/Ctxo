import type { DomainRegistry } from './registry.js';

export type GlobMatcherFactory = (patterns: readonly string[]) => (path: string) => boolean;

export interface Ownership {
  /** Ids of every context whose paths match, in registry order. */
  owners(path: string): readonly string[];
  /** The one owning context, or undefined when the file has none or several. */
  ownerOf(path: string): string | undefined;
  isAllowedUnowned(path: string): boolean;
  /** True when targetFile matches `fromContext.contracts[ownerOf(targetFile)]`. */
  isContract(fromContext: string, targetFile: string): boolean;
}

type Matcher = (path: string) => boolean;

const NEVER: Matcher = () => false;

export function createOwnership(registry: DomainRegistry, makeMatcher: GlobMatcherFactory): Ownership {
  // The host matcher takes a mutable string[] (PF26): hand it a copy of the readonly list.
  const build = (patterns: readonly string[]): Matcher => (patterns.length === 0 ? NEVER : makeMatcher([...patterns]));
  const norm = (path: string): string => path.replace(/\\/g, '/');

  const pathMatchers = registry.contexts.map((c) => ({ id: c.id, match: build(c.paths) }));
  const allowMatcher = build(registry.unownedAllow);
  const contractMatchers = new Map<string, Map<string, Matcher>>();
  for (const c of registry.contexts) {
    const perTarget = new Map<string, Matcher>();
    for (const target of Object.keys(c.contracts)) perTarget.set(target, build(c.contracts[target]!));
    contractMatchers.set(c.id, perTarget);
  }

  const owners = (path: string): readonly string[] => {
    const p = norm(path);
    return pathMatchers.filter((m) => m.match(p)).map((m) => m.id);
  };
  const ownerOf = (path: string): string | undefined => {
    const found = owners(path);
    return found.length === 1 ? found[0] : undefined;
  };

  return {
    owners,
    ownerOf,
    isAllowedUnowned: (path) => allowMatcher(norm(path)),
    isContract(fromContext, targetFile) {
      const target = ownerOf(targetFile);
      if (target === undefined) return false;
      const match = contractMatchers.get(fromContext)?.get(target);
      return match !== undefined && match(norm(targetFile));
    },
  };
}
