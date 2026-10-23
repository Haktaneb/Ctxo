import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseRegistry, type LoadedRegistry } from '../core/registry.js';

/** Reads and parses the registry. Undefined when the file does not exist; any other failure is a problem. */
export function readRegistry(projectRoot: string, registryPath: string): LoadedRegistry | undefined {
  const absolute = resolve(projectRoot, registryPath);
  const rel = relative(resolve(projectRoot), absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { path: registryPath, text: '', problems: [{ path: '', message: 'the registry path must stay inside the project' }] };
  }
  let text: string;
  try {
    text = readFileSync(absolute, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { path: registryPath, text: '', problems: [{ path: '', message: `cannot read the registry: ${(err as Error).message}` }] };
  }
  const { registry, problems } = parseRegistry(text);
  return { path: registryPath, text, ...(registry ? { registry } : {}), problems };
}
