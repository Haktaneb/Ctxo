import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseShadowSpecs, SHADOW_SPECS_FILE, shadowSpecsPath, type ParsedShadowSpecs } from '../core/shadow-specs-file.js';
import { locateRepoPath, readCheckedRepoText } from './repo-files.js';

/** `shadow-specs.yaml` files above this size are not read (1 MiB, as cards; W18). */
export const SHADOW_SPECS_MAX_BYTES = 1_048_576;

export interface LoadedShadowSpecs {
  readonly context: string;
  /** Repo-relative, posix. */
  readonly path: string;
  /** Absent: there is no file. A file that is not read (outside the repository, too large, binary) has one error at line 1. */
  readonly parsed?: ParsedShadowSpecs;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The `shadow-specs.yaml` of each context, in the given (registry) order, read through the checked repo reader
 * (real path inside the repository, no-follow open, `SHADOW_SPECS_MAX_BYTES`; W18). Never throws.
 */
export function readShadowSpecs(projectRoot: string, registryPath: string, contexts: readonly string[]): LoadedShadowSpecs[] {
  return contexts.map((context) => {
    const path = shadowSpecsPath(registryPath, context);
    const read = readCheckedRepoText(projectRoot, path, SHADOW_SPECS_MAX_BYTES, { strictUtf8: true });
    if ('text' in read) return { context, path, parsed: parseShadowSpecs(read.text) };
    if (read.skip === undefined) return { context, path };
    // Not read (outside the repository, too large, binary, not valid UTF-8): one error, at the first bad line when known.
    const line = 'line' in read && read.line !== undefined ? read.line : 1;
    return {
      context,
      path,
      parsed: { entries: [], problems: [{ line, severity: 'error', message: `${SHADOW_SPECS_FILE} is not read: ${read.skip}` }] },
    };
  });
}

/**
 * Repo paths of `<registry folder>/<folder>/shadow-specs.yaml` files whose folder is no context id, in codepoint
 * order. Folders follow the reader's policy (M3): a symlinked or junctioned folder is listed when its real path stays
 * inside the repository and skipped when it leads outside. Never throws.
 */
export function findOrphanShadowSpecs(projectRoot: string, registryPath: string, contexts: readonly string[]): string[] {
  const parentOf = posix.dirname(posix.dirname(shadowSpecsPath(registryPath, 'context')));
  const folder = parentOf === '.' ? '' : parentOf;
  const known = new Set(contexts);
  try {
    let base: string;
    if (folder === '') base = projectRoot;
    else {
      const located = locateRepoPath(projectRoot, folder);
      if (!('real' in located)) return [];
      base = located.real;
    }
    const out: string[] = [];
    for (const dirent of readdirSync(base, { withFileTypes: true })) {
      if (known.has(dirent.name) || !(dirent.isDirectory() || dirent.isSymbolicLink())) continue;
      const repoFolder = folder === '' ? dirent.name : `${folder}/${dirent.name}`;
      const located = locateRepoPath(projectRoot, repoFolder);
      if (!('real' in located)) continue;
      if (!(statSync(located.real, { throwIfNoEntry: false })?.isDirectory() ?? false)) continue;
      const stat = lstatSync(join(located.real, SHADOW_SPECS_FILE), { throwIfNoEntry: false });
      if (stat === undefined || stat.isDirectory()) continue;
      out.push(`${repoFolder}/${SHADOW_SPECS_FILE}`);
    }
    return out.sort(compare);
  } catch {
    return [];
  }
}
