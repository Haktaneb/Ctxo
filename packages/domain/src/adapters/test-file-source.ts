import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileIndex, TestFileCheck } from '@ctxo/cli/internal';

export interface TestFileText {
  readonly file: string;
  readonly text: string;
  readonly index?: FileIndex;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reads the tracked files `isTestFile` accepts (by path or by annotation: the host check holds both),
 * in codepoint order. Each file is read once; an unreadable file is skipped (warn-and-continue; the
 * caller has no logger here, and a missing test file only means fewer links).
 */
export function readTestFiles(
  projectRoot: string,
  tracked: readonly string[],
  isTestFile: TestFileCheck,
  indices: readonly FileIndex[],
): TestFileText[] {
  const byFile = new Map<string, FileIndex>();
  for (const index of indices) byFile.set(index.file.replace(/\\/g, '/'), index);
  const files = [...new Set(tracked.map((f) => f.replace(/\\/g, '/')))].filter((f) => isTestFile(f)).sort(compare);
  const out: TestFileText[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(projectRoot, file), 'utf-8');
    } catch {
      continue;
    }
    const index = byFile.get(file);
    out.push(index === undefined ? { file, text } : { file, text, index });
  }
  return out;
}
