import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Light path helpers shared by the CLI router, the commands and the module host. This file imports
 * nothing but `node:` modules, so a route that must stay fast (the domain guard hook) can use it
 * without loading the router or the MCP stack.
 */

/**
 * The nearest `package.json` at or above this module (capped at 10 levels): the CLI's own manifest,
 * whether the code runs bundled from `dist/` or from `src/cli/` in development.
 */
function findCliPackageJson(): string | undefined {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) return pkg;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** The running CLI's version from its `package.json`, or 'unknown' when it cannot be read. */
export function getVersion(): string {
  const pkg = findCliPackageJson();
  if (pkg === undefined) return 'unknown';
  try {
    const json = JSON.parse(readFileSync(pkg, 'utf-8'));
    return json.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The directory of the running CLI's `package.json` (the package root). When no manifest is found,
 * the parent of this module's directory, which is the package root of the bundled `dist/` layout.
 */
export function getCliPackageRoot(): string {
  const pkg = findCliPackageJson();
  return pkg !== undefined ? dirname(pkg) : dirname(import.meta.dirname);
}

/**
 * Walk up from `startDir` (capped at 12 levels) looking for a directory that
 * contains `.git`. First hit wins. Matches how git itself resolves the working
 * tree and keeps every subcommand consistent when the user runs ctxo from a
 * subdirectory or when pnpm --filter sets cwd to a monorepo package.
 */
export function locateGitRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
