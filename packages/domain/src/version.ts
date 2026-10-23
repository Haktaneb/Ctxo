import { readFileSync } from 'node:fs';

export const DOMAIN_PACKAGE = '@ctxo/domain';

let cachedVersion: string | undefined;

/** The version field of this package's package.json (one level above both `src/` and `dist/`). */
export function domainVersion(): string {
  if (cachedVersion === undefined) {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    cachedVersion = (JSON.parse(raw) as { version: string }).version;
  }
  return cachedVersion;
}

/**
 * Whether two versions share a numeric major and minor. A module runs only against the CLI minor it was
 * built for (ADR-018 Decision 3). This is a copy of the CLI loader's rule, on purpose: `@ctxo/domain`
 * cannot import the CLI at runtime.
 */
export function sameMinor(a: string, b: string): boolean {
  const pa = /^(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return false;
  return Number(pa[1]) === Number(pb[1]) && Number(pa[2]) === Number(pb[2]);
}
