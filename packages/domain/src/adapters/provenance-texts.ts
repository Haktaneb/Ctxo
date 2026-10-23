import { fstatSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { ProvenanceText } from '../core/domain-documents.js';
import { leavesProject, readFileText, type TextSkip } from './repo-files.js';

/** Provenance files above this size are not searched (256 KiB). */
export const PROVENANCE_MAX_BYTES = 262_144;

/** An ATX H1: up to three spaces, `#`, a space, the text, optional closing hashes. */
const ATX_H1 = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ReadProvenanceOptions {
  /** Called with `provenance file <path> is not searched: <reason>` for each skipped path that is not simply missing. */
  readonly warn?: (message: string) => void;
  /** Test seam: runs between the path check and the open, with the real path the check returned. */
  readonly afterCheck?: (real: string) => void;
}

type Located = { readonly real: string; readonly root: string } | { readonly skip: string | undefined };

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/** The real path of a repo-relative path, or why there is none (`skip` undefined: it does not exist). */
function locate(projectRoot: string, repoPath: string): Located {
  if (repoPath === '' || isAbsolute(repoPath)) return { skip: 'not a repo-relative path' };
  try {
    const root = realpathSync(resolve(projectRoot));
    const real = realpathSync(resolve(root, repoPath));
    const rel = relative(root, real);
    return rel === '' || leavesProject(rel) ? { skip: 'outside the repository' } : { real, root };
  } catch (err) {
    const code = errorCode(err);
    return code === 'ENOENT' || code === 'ENOTDIR' ? { skip: undefined } : { skip: `unreadable (${code})` };
  }
}

/**
 * True when the open descriptor is the file at `real` and `real` still resolves to itself inside the repository: a
 * symlink or another file swapped in between the check and the open fails this.
 */
function sameFile(root: string, real: string, fd: number): boolean {
  try {
    const opened = fstatSync(fd);
    const again = realpathSync(real);
    if (again !== real) return false;
    const rel = relative(root, again);
    if (rel === '' || leavesProject(rel)) return false;
    const current = statSync(again);
    return current.dev === opened.dev && current.ino === opened.ino;
  } catch {
    return false;
  }
}

function skipText(skip: TextSkip): string | undefined {
  switch (skip.reason) {
    case 'missing':
      return undefined;
    case 'not-a-file':
      return 'not a regular file';
    case 'too-large':
      return `larger than ${PROVENANCE_MAX_BYTES} bytes`;
    case 'binary':
      return 'binary (a NUL byte in the first 8 KiB)';
    case 'changed':
      return 'changed while it was read';
    case 'unreadable':
      return `unreadable (${skip.code})`;
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
 * The cache stamp of a provenance file: `stamp` of its real path when that lies inside the repository, `none`
 * otherwise (missing, outside the repository). Never throws.
 */
export function provenanceStamp(projectRoot: string, repoPath: string, stamp: (absolute: string) => string): string {
  const located = locate(projectRoot, repoPath);
  return 'real' in located ? stamp(located.real) : 'none';
}

/**
 * The texts of provenance files, in codepoint order of path, each path once: regular files whose real path lies
 * inside the repository, up to `PROVENANCE_MAX_BYTES`, without a NUL byte in their first 8 KiB (BOM stripped).
 * The checked real path is what is opened, and the open descriptor is checked to be that file. `title` is the first
 * ATX H1, else the file name. A skipped path that is not simply missing is passed to `warn` with its reason. Never
 * throws.
 */
export function readProvenanceTexts(projectRoot: string, paths: readonly string[], options: ReadProvenanceOptions = {}): ProvenanceText[] {
  const warn = (path: string, reason: string | undefined): void => {
    if (reason !== undefined) options.warn?.(`provenance file ${path} is not searched: ${reason}`);
  };
  const out: ProvenanceText[] = [];
  for (const path of [...new Set(paths)].sort(compare)) {
    const located = locate(projectRoot, path);
    if (!('real' in located)) {
      warn(path, located.skip);
      continue;
    }
    options.afterCheck?.(located.real);
    const read = readFileText(located.real, PROVENANCE_MAX_BYTES, {
      noFollow: true,
      verify: (fd) => sameFile(located.root, located.real, fd),
    });
    if ('skip' in read) {
      warn(path, skipText(read.skip));
      continue;
    }
    out.push({ path, title: firstH1(read.text) ?? basename(path), text: read.text });
  }
  return out;
}
