import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * True when a path relative to the project root points outside it (`..`, `../x`, `..\x`, or an absolute path
 * on another drive). A name that merely starts with two dots (`..docs/x`) stays inside.
 */
export function leavesProject(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel);
}

/** The absolute path of a repo-relative path, or undefined when it would leave the project. */
function inside(projectRoot: string, repoPath: string): string | undefined {
  if (repoPath === '' || isAbsolute(repoPath)) return undefined;
  const root = resolve(projectRoot);
  const absolute = resolve(root, repoPath);
  const rel = relative(root, absolute);
  if (rel === '' || leavesProject(rel)) return undefined;
  return absolute;
}

/** True when a file or directory exists at the repo-relative path (never outside the project). */
export function repoFileExists(projectRoot: string, repoPath: string): boolean {
  const absolute = inside(projectRoot, repoPath);
  if (absolute === undefined) return false;
  try {
    return existsSync(absolute);
  } catch {
    return false;
  }
}

/** True when a regular file (not a directory) exists at the repo-relative path (never outside the project). */
export function repoIsFile(projectRoot: string, repoPath: string): boolean {
  const absolute = inside(projectRoot, repoPath);
  if (absolute === undefined) return false;
  try {
    return statSync(absolute, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** Source files above this size are not scanned for `rule:` comments (1 MiB). */
export const SOURCE_SCAN_MAX_BYTES = 1_048_576;
/** A NUL byte in this many leading bytes marks a file as binary. */
const BINARY_PROBE_BYTES = 8192;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Why a file's text was not read. `unreadable` carries the error code (`EACCES`). */
export type TextSkip =
  | { readonly reason: 'missing' | 'not-a-file' | 'too-large' | 'binary' | 'changed' }
  | { readonly reason: 'unreadable'; readonly code: string };

export type TextRead = { readonly text: string } | { readonly skip: TextSkip };

/** `O_NOFOLLOW` where the platform has it (not on Windows): an open of a symlink then fails instead of following it. */
const NO_FOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export interface ReadFileTextOptions {
  /** Runs on the open descriptor before the read; false skips the file as `changed`. */
  readonly verify?: (fd: number) => boolean;
  /** Do not follow a symlink in the last path component (where the platform can refuse it). */
  readonly noFollow?: boolean;
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * One file's UTF-8 text (BOM stripped) by absolute path, or why it was skipped: not a regular file, over `maxBytes`,
 * a NUL byte in the first 8 KiB, or unreadable. A caller that checked the path first passes `verify` to re-check that
 * it opened the same file, and `noFollow`. Never throws.
 */
export function readFileText(absolute: string, maxBytes: number, options: ReadFileTextOptions = {}): TextRead {
  const { verify, noFollow = false } = options;
  let fd: number | undefined;
  try {
    // Size and type come from the open descriptor, so the checks and the read see the same file.
    fd = openSync(absolute, noFollow ? NO_FOLLOW_FLAGS : 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { skip: { reason: 'not-a-file' } };
    if (verify !== undefined && !verify(fd)) return { skip: { reason: 'changed' } };
    if (stat.size > maxBytes) return { skip: { reason: 'too-large' } };
    const buffer = readFileSync(fd);
    if (buffer.length > maxBytes) return { skip: { reason: 'too-large' } };
    if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { skip: { reason: 'binary' } };
    const text = buffer.toString('utf-8');
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { skip: { reason: 'missing' } };
    if (code === 'EISDIR') return { skip: { reason: 'not-a-file' } };
    // O_NOFOLLOW met a symlink where a regular file was checked.
    if (code === 'ELOOP') return { skip: { reason: 'changed' } };
    return { skip: { reason: 'unreadable', code } };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** A repo-relative path resolved to its real path, or why there is none (`skip` undefined: it does not exist). */
export type LocatedRepoPath = { readonly real: string; readonly root: string } | { readonly skip: string | undefined };

/** The real path of a repo-relative path when it lies inside the real path of the repository. Never throws. */
export function locateRepoPath(projectRoot: string, repoPath: string): LocatedRepoPath {
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

/** The reason text of a skip; undefined for a missing file. */
function skipText(skip: TextSkip, maxBytes: number): string | undefined {
  switch (skip.reason) {
    case 'missing':
      return undefined;
    case 'not-a-file':
      return 'not a regular file';
    case 'too-large':
      return `larger than ${maxBytes} bytes`;
    case 'binary':
      return 'binary (a NUL byte in the first 8 KiB)';
    case 'changed':
      return 'changed while it was read';
    case 'unreadable':
      return `unreadable (${skip.code})`;
  }
}

export interface CheckedReadOptions {
  /** Test seam: runs between the path check and the open, with the real path the check returned. */
  readonly afterCheck?: (real: string) => void;
}

/**
 * One repo-relative file's text, read only when its real path lies inside the repository: the checked real path is
 * opened without following a symlink (where the OS can refuse one), the open descriptor is checked to be that file,
 * and the file is skipped when it is over `maxBytes` or binary. `skip` carries the reason, undefined when the file
 * is simply missing. Never throws.
 */
export function readCheckedRepoText(
  projectRoot: string,
  repoPath: string,
  maxBytes: number,
  options: CheckedReadOptions = {},
): { readonly text: string } | { readonly skip: string | undefined } {
  const located = locateRepoPath(projectRoot, repoPath);
  if (!('real' in located)) return { skip: located.skip };
  options.afterCheck?.(located.real);
  const read = readFileText(located.real, maxBytes, { noFollow: true, verify: (fd) => sameFile(located.root, located.real, fd) });
  return 'text' in read ? { text: read.text } : { skip: skipText(read.skip, maxBytes) };
}

/** Cards and the glossary above this size are not read (1 MiB). */
export const CARD_MAX_BYTES = 1_048_576;

/**
 * The text of a card or of the glossary, read like a provenance file (`readCheckedRepoText`, `CARD_MAX_BYTES`):
 * undefined when it is missing or skipped, so a skipped file counts as a missing one. A skip that is not simply a
 * missing file is passed to `warn` with its reason.
 */
export function readCardText(projectRoot: string, repoPath: string, warn?: (message: string) => void): string | undefined {
  const read = readCheckedRepoText(projectRoot, repoPath, CARD_MAX_BYTES);
  if ('text' in read) return read.text;
  if (read.skip !== undefined) warn?.(`domain file ${repoPath} is not read: ${read.skip}`);
  return undefined;
}

/** One file's text, or undefined when it is not a regular file, too large, binary or unreadable. */
function readSourceText(absolute: string, maxBytes: number): string | undefined {
  const read = readFileText(absolute, maxBytes);
  return 'text' in read ? read.text : undefined;
}

/**
 * The UTF-8 texts (BOM stripped) of repo-relative files, in codepoint order of path, each path once. Missing files,
 * directories, paths outside the project, files over `maxBytes` and files with a NUL byte in their first 8 KiB
 * are skipped.
 */
export function readRepoTexts(
  projectRoot: string,
  files: readonly string[],
  maxBytes: number = SOURCE_SCAN_MAX_BYTES,
): { readonly file: string; readonly text: string }[] {
  const out: { readonly file: string; readonly text: string }[] = [];
  for (const file of [...new Set(files)].sort(compare)) {
    const absolute = inside(projectRoot, file);
    if (absolute === undefined) continue;
    const text = readSourceText(absolute, maxBytes);
    if (text !== undefined) out.push({ file, text });
  }
  return out;
}

/** The UTF-8 text of a repo-relative file; undefined when it is missing, unreadable or outside the project. */
export function readRepoText(projectRoot: string, repoPath: string): string | undefined {
  const absolute = inside(projectRoot, repoPath);
  if (absolute === undefined) return undefined;
  try {
    return readFileSync(absolute, 'utf-8');
  } catch {
    return undefined;
  }
}
