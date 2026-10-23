import { existsSync, readFileSync } from 'node:fs';
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
