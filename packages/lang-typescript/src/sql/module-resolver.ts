import { readFileSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { Project, SourceFile } from 'ts-morph';

/** Only script files are read from disk (never `./config.json` or a stylesheet). */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx']);

/** `./x`, `../x`, `.` and `..`: the specifiers the resolver serves. */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Project-relative candidates for a project-relative base path: the adapter's `resolveRelativeImport` rule first
 * (`.js` to `.ts`, `.jsx` to `.tsx`, `.ts` appended when there is no extension), then `.tsx`, `.js`, `.jsx`,
 * `/index.ts` and `/index.js`.
 */
function candidatesFor(base: string): string[] {
  const ext = posix.extname(base);
  if (ext === '.js') {
    const stem = base.slice(0, -3);
    return [`${stem}.ts`, `${stem}.tsx`, base, `${stem}.jsx`];
  }
  if (ext === '.jsx') return [`${base.slice(0, -4)}.tsx`, base];
  if (ext === '.ts' || ext === '.tsx') return [base];
  const appended = [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.js`];
  return ext ? [base, ...appended] : appended;
}

/**
 * Resolves relative module specifiers for the SQL call-site walk (designer call 7, Review Focus 1). A file the
 * in-memory project holds is served as is; otherwise, with a `projectRoot`, the candidate is read from disk and
 * added to the project until `release()`, so one re-extracted file resolves its imports as in a full run.
 * Paths stay inside `projectRoot`.
 */
export class ModuleResolver {
  private readonly added: SourceFile[] = [];
  private readonly misses = new Set<string>();

  constructor(
    private readonly project: Project,
    private readonly projectRoot?: string,
  ) {}

  /** The source file a relative `specifier` names from `from`: the project file, else a disk read under projectRoot. */
  sourceFileFor(from: SourceFile, specifier: string): SourceFile | undefined {
    // A backslash is a separator on Windows but not in the POSIX normalisation below, so `..\` could escape.
    if (!isRelativeSpecifier(specifier) || specifier.includes('\\')) return undefined;
    const fromPath = from.getFilePath().replace(/\\/g, '/').replace(/^\/+/, '');
    const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
    if (base === '..' || base.startsWith('../') || base.startsWith('/') || base === '.') return undefined;

    const candidates = candidatesFor(base);
    for (const candidate of candidates) {
      // Rooted paths: a bare file name would match any file of that name in the project.
      const existing = this.project.getSourceFile(`/${candidate}`);
      if (existing) return existing;
    }
    if (this.projectRoot === undefined) return undefined;

    const root = resolve(this.projectRoot);
    for (const candidate of candidates) {
      if (this.misses.has(candidate) || !SCRIPT_EXTENSIONS.has(posix.extname(candidate))) continue;
      // Path arithmetic only (no file-system check before the read): the platform's resolution must stay under the root.
      const full = resolve(root, candidate);
      const fromRoot = relative(root, full);
      if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) continue;
      let text: string;
      try {
        text = readFileSync(full, 'utf-8');
      } catch {
        this.misses.add(candidate);
        continue;
      }
      const sourceFile = this.project.createSourceFile(`/${candidate}`, text, { overwrite: true });
      this.added.push(sourceFile);
      return sourceFile;
    }
    return undefined;
  }

  /** Removes the files this resolver read from disk; files that were in the project before stay. */
  release(): void {
    for (const sourceFile of this.added) {
      if (!sourceFile.wasForgotten()) this.project.removeSourceFile(sourceFile);
    }
    this.added.length = 0;
    this.misses.clear();
  }
}
