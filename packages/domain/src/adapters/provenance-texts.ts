import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { ProvenanceText } from '../core/domain-documents.js';
import { leavesProject, readRepoTexts } from './repo-files.js';

/** Provenance files above this size are not searched (256 KiB). */
export const PROVENANCE_MAX_BYTES = 262_144;

/** An ATX H1: up to three spaces, `#`, a space, the text, optional closing hashes. */
const ATX_H1 = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * The real absolute path of a repo-relative path when its real path (symlinks resolved) lies inside the
 * repository's real path; undefined otherwise, or when it does not exist.
 */
function realInside(projectRoot: string, repoPath: string): string | undefined {
  if (repoPath === '' || isAbsolute(repoPath)) return undefined;
  try {
    const root = realpathSync(resolve(projectRoot));
    const real = realpathSync(resolve(root, repoPath));
    const rel = relative(root, real);
    return rel === '' || leavesProject(rel) ? undefined : real;
  } catch {
    return undefined;
  }
}

/** The first ATX H1 of a text, else undefined. */
function firstH1(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = ATX_H1.exec(line);
    if (match && match[1]!.trim() !== '') return match[1]!.trim();
  }
  return undefined;
}

/**
 * The cache stamp of a provenance file: `<mtimeMs>:<size>` for a regular file inside the repository, `none` for
 * anything else (missing, a directory, outside the repository). Never throws.
 */
export function provenanceStamp(projectRoot: string, repoPath: string): string {
  const real = realInside(projectRoot, repoPath);
  if (real === undefined) return 'none';
  try {
    const stat = statSync(real);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : 'none';
  } catch {
    return 'none';
  }
}

/**
 * The texts of provenance files, in codepoint order of path, each path once: regular files whose real path lies
 * inside the repository, up to `PROVENANCE_MAX_BYTES`, without a NUL byte in their first 8 KiB (BOM stripped).
 * `title` is the first ATX H1, else the file name. Anything else is skipped (warn-and-continue: never throws).
 */
export function readProvenanceTexts(projectRoot: string, paths: readonly string[]): ProvenanceText[] {
  const safe = paths.filter((path) => realInside(projectRoot, path) !== undefined);
  return readRepoTexts(projectRoot, safe, PROVENANCE_MAX_BYTES).map(({ file, text }) => ({
    path: file,
    title: firstH1(text) ?? basename(file),
    text,
  }));
}
