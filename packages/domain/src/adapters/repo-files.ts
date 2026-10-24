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
  /** Only with `strictUtf8`: the bytes are not valid UTF-8; `line` (1-based) holds the first bad sequence. */
  | { readonly reason: 'not-utf8'; readonly line: number }
  | { readonly reason: 'unreadable'; readonly code: string };

export type TextRead = { readonly text: string } | { readonly skip: TextSkip };

/** `O_NOFOLLOW` where the platform has it (not on Windows): an open of a symlink then fails instead of following it. */
const NO_FOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export interface ReadFileTextOptions {
  /** Runs on the open descriptor before the read; false skips the file as `changed`. */
  readonly verify?: (fd: number) => boolean;
  /** Do not follow a symlink in the last path component (where the platform can refuse it). */
  readonly noFollow?: boolean;
  /** Skip a file whose bytes are not valid UTF-8 (`not-utf8`) instead of decoding it with U+FFFD replacements. */
  readonly strictUtf8?: boolean;
}

/** The 1-based line of the first invalid UTF-8 sequence, or undefined when the bytes are valid UTF-8. */
export function invalidUtf8Line(buffer: Uint8Array): number | undefined {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(buffer);
    return undefined;
  } catch {
    // A multi-byte sequence never holds 0x0A, so each line decodes on its own.
  }
  let line = 1;
  let start = 0;
  for (let i = 0; i <= buffer.length; i++) {
    if (i < buffer.length && buffer[i] !== 0x0a) continue;
    try {
      decoder.decode(buffer.subarray(start, i));
    } catch {
      return line;
    }
    line++;
    start = i + 1;
  }
  return 1;
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
  const { verify, noFollow = false, strictUtf8 = false } = options;
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
    if (strictUtf8) {
      const line = invalidUtf8Line(buffer);
      if (line !== undefined) return { skip: { reason: 'not-utf8', line } };
    }
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

/**
 * The OS realpath (`realpathSync.native`): one system call per path instead of an `lstat` per path component. Every
 * real path in this module comes from it, so a root and the paths under it are always compared in the same form.
 */
const realPath = (path: string): string => realpathSync.native(path);

function locateSkip(err: unknown): LocatedRepoPath {
  const code = errorCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR' ? { skip: undefined } : { skip: `unreadable (${code})` };
}

/** The real path of the project root, or the skip every path under it gets when the root cannot be resolved. */
function resolveRepoRoot(projectRoot: string): { readonly root: string } | { readonly skip: LocatedRepoPath } {
  try {
    return { root: realPath(resolve(projectRoot)) };
  } catch (err) {
    return { skip: locateSkip(err) };
  }
}

/** `locateRepoPath` against a root that is already a real path. */
function locateUnderRoot(root: string, repoPath: string): LocatedRepoPath {
  if (repoPath === '' || isAbsolute(repoPath)) return { skip: 'not a repo-relative path' };
  try {
    const real = realPath(resolve(root, repoPath));
    const rel = relative(root, real);
    return rel === '' || leavesProject(rel) ? { skip: 'outside the repository' } : { real, root };
  } catch (err) {
    return locateSkip(err);
  }
}

/** The real path of a repo-relative path when it lies inside the real path of the repository. Never throws. */
export function locateRepoPath(projectRoot: string, repoPath: string): LocatedRepoPath {
  if (repoPath === '' || isAbsolute(repoPath)) return { skip: 'not a repo-relative path' };
  const resolved = resolveRepoRoot(projectRoot);
  return 'root' in resolved ? locateUnderRoot(resolved.root, repoPath) : resolved.skip;
}

/**
 * True when the open descriptor is the file at `real` and `real` still resolves to itself: a symlink or another file
 * swapped in between the check and the open fails this. `real` was checked to lie inside the root when it was
 * located, so a path that still resolves to the same string is still inside; that check is not repeated.
 */
function sameFile(real: string, fd: number): boolean {
  try {
    const opened = fstatSync(fd);
    if (realPath(real) !== real) return false;
    const current = statSync(real);
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
    case 'not-utf8':
      return 'not valid UTF-8';
  }
}

export interface CheckedReadOptions {
  /** Test seam: runs between the path check and the open, with the real path the check returned. */
  readonly afterCheck?: (real: string) => void;
  /** Skip a file that is not valid UTF-8 (`not valid UTF-8`, with `line`) instead of decoding it with replacements. */
  readonly strictUtf8?: boolean;
}

/**
 * One repo-relative file's text, read only when its real path lies inside the repository: the checked real path is
 * opened without following a symlink (where the OS can refuse one), the open descriptor is checked to be that file,
 * and the file is skipped when it is over `maxBytes` or binary. `skip` carries the reason, undefined when the file
 * is simply missing. With `strictUtf8`, a skip for invalid UTF-8 also carries the 1-based `line` of the first bad
 * sequence. Never throws.
 */
export function readCheckedRepoText(
  projectRoot: string,
  repoPath: string,
  maxBytes: number,
  options: CheckedReadOptions = {},
): CheckedText {
  return readCheckedText(locateRepoPath(projectRoot, repoPath), maxBytes, options);
}

type CheckedText = { readonly text: string } | { readonly skip: string | undefined; readonly line?: number };

/** `readCheckedRepoText` of a path that is already located. */
function readCheckedText(located: LocatedRepoPath, maxBytes: number, options: CheckedReadOptions = {}): CheckedText {
  if (!('real' in located)) return { skip: located.skip };
  options.afterCheck?.(located.real);
  const read = readFileText(located.real, maxBytes, {
    noFollow: true,
    strictUtf8: options.strictUtf8 ?? false,
    verify: (fd) => sameFile(located.real, fd),
  });
  if ('text' in read) return { text: read.text };
  const skip = skipText(read.skip, maxBytes);
  return read.skip.reason === 'not-utf8' ? { skip, line: read.skip.line } : { skip };
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

/**
 * The UTF-8 texts (BOM stripped) of repo-relative files, in codepoint order of path, each path once. Each file is read
 * like a card (`readCheckedRepoText`): only when its real path lies inside the real path of the repository, so a
 * tracked symlink or junction that leaves the repository is skipped and one that stays inside is followed, opened
 * without following a final symlink and checked to be the file the path resolved to. Missing files, directories,
 * paths outside the project, files over `maxBytes` and files with a NUL byte in their first 8 KiB are skipped too.
 */
export function readRepoTexts(
  projectRoot: string,
  files: readonly string[],
  maxBytes: number = SOURCE_SCAN_MAX_BYTES,
): { readonly file: string; readonly text: string }[] {
  const out: { readonly file: string; readonly text: string }[] = [];
  // The root is resolved once per call; when it cannot be resolved every file is skipped, as each read would be.
  const resolved = resolveRepoRoot(projectRoot);
  if (!('root' in resolved)) return out;
  for (const file of [...new Set(files)].sort(compare)) {
    if (inside(projectRoot, file) === undefined) continue;
    const read = readCheckedText(locateUnderRoot(resolved.root, file), maxBytes);
    if ('text' in read) out.push({ file, text: read.text });
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
