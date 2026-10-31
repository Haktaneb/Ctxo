import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SAMPLE_DIR = join(import.meta.dirname, '..', 'fixtures', 'lending-sample');

function collect(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) collect(full, rel, out);
    else out.push(rel);
  }
}

/**
 * 'src/x.ts' -> content ('.fixture' stripped), sorted by path in codepoint order. Line endings are LF on every OS
 * (a Windows checkout with core.autocrlf gives CRLF), so offsets pinned by the goldens do not depend on the platform.
 */
export function readLendingSample(): Map<string, string> {
  const files: string[] = [];
  collect(SAMPLE_DIR, '', files);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result = new Map<string, string>();
  for (const rel of files) {
    const target = rel.endsWith('.fixture') ? rel.slice(0, -'.fixture'.length) : rel;
    result.set(target, readFileSync(join(SAMPLE_DIR, rel), 'utf-8').replace(/\r\n/g, '\n'));
  }
  return result;
}

/** The same files written under dir. */
export function writeLendingSample(dir: string): void {
  for (const [rel, content] of readLendingSample()) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
}
