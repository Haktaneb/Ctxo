import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InitFileResult } from '@ctxo/cli/internal';
import { LOADER_RULE_PREFIX, type LoaderPlatform, type LoaderRuleFile, type LoaderRulesDiff } from '../core/loader-rules.js';

const RULE_DIRS = ['.claude/rules', '.cursor/rules'] as const;

/** Claude Code always; Cursor only when the project has a .cursor/ directory (E10). */
export function loaderPlatforms(projectRoot: string): LoaderPlatform[] {
  const platforms: LoaderPlatform[] = ['claude-code'];
  try {
    if (statSync(join(projectRoot, '.cursor')).isDirectory()) platforms.push('cursor');
  } catch {
    // no .cursor/
  }
  return platforms;
}

/** Every ctxo-context-* file in .claude/rules and .cursor/rules, keyed by repo-relative path. Read once each. */
export function readExistingLoaderRules(projectRoot: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of RULE_DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(projectRoot, dir));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.startsWith(LOADER_RULE_PREFIX)) continue;
      try {
        found.set(`${dir}/${name}`, readFileSync(join(projectRoot, dir, name), 'utf-8'));
      } catch {
        // a directory or an unreadable file is not a rule file
      }
    }
  }
  return found;
}

function writeAtomic(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, content, { encoding: 'utf-8', flag: 'wx' });
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Writes the missing and outdated files (a `wx` temp file renamed over the target, PF27) and deletes the stale ones. */
export function applyLoaderRules(projectRoot: string, expected: readonly LoaderRuleFile[], diff: LoaderRulesDiff): InitFileResult[] {
  const results: InitFileResult[] = [];
  const byPath = new Map(expected.map((file) => [file.path, file.content]));
  const write = (path: string, action: 'created' | 'updated'): void => {
    try {
      writeAtomic(join(projectRoot, path), byPath.get(path) ?? '');
      results.push({ file: path, action });
    } catch (err) {
      results.push({ file: path, action: 'skipped', warning: `cannot write: ${(err as Error).message}` });
    }
  };
  for (const path of diff.missing) write(path, 'created');
  for (const path of diff.outdated) write(path, 'updated');
  for (const path of diff.stale) {
    try {
      rmSync(join(projectRoot, path), { force: true });
      results.push({ file: path, action: 'updated', warning: 'deleted (stale)' });
    } catch (err) {
      results.push({ file: path, action: 'skipped', warning: `cannot delete: ${(err as Error).message}` });
    }
  }
  return results;
}
