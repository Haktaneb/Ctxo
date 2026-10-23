import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getVersion } from '../../cli-paths.js';

/** A version whose major.minor equals the running CLI's, so the module loader accepts the stub. */
export function matchingModuleVersion(): string {
  const match = /^(\d+)\.(\d+)/.exec(getVersion());
  return match ? `${match[1]}.${match[2]}.0` : '0.0.0';
}

/**
 * Writes a stub `@ctxo/domain` package into `<projectRoot>/node_modules`, with `body` as its ESM entry
 * (it must export `register`). The version matches the running CLI's major.minor unless one is given.
 */
export function writeStubDomainPackage(projectRoot: string, body: string, version = matchingModuleVersion()): void {
  const dir = join(projectRoot, 'node_modules', '@ctxo', 'domain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@ctxo/domain', version, type: 'module', exports: { '.': './index.js' } }),
  );
  writeFileSync(join(dir, 'index.js'), body);
}
