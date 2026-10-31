import { basename } from 'node:path';
import type { ProvenanceText } from '../core/domain-documents.js';
import { locateRepoPath, readCheckedRepoText } from './repo-files.js';

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
  const located = locateRepoPath(projectRoot, repoPath);
  return 'real' in located ? stamp(located.real) : 'none';
}

/**
 * The texts of provenance files, in codepoint order of path, each path once: regular files whose real path lies
 * inside the repository, up to `PROVENANCE_MAX_BYTES`, without a NUL byte in their first 8 KiB (BOM stripped).
 * The checked real path is what is opened, and the open descriptor is checked to be that file
 * (`readCheckedRepoText`). `title` is the first ATX H1, else the file name. A skipped path that is not simply
 * missing is passed to `warn` with its reason. Never throws.
 */
export function readProvenanceTexts(projectRoot: string, paths: readonly string[], options: ReadProvenanceOptions = {}): ProvenanceText[] {
  const out: ProvenanceText[] = [];
  for (const path of [...new Set(paths)].sort(compare)) {
    const read = readCheckedRepoText(
      projectRoot,
      path,
      PROVENANCE_MAX_BYTES,
      options.afterCheck === undefined ? {} : { afterCheck: options.afterCheck },
    );
    if ('skip' in read) {
      if (read.skip !== undefined) options.warn?.(`provenance file ${path} is not searched: ${read.skip}`);
      continue;
    }
    out.push({ path, title: firstH1(read.text) ?? basename(path), text: read.text });
  }
  return out;
}
