import type { FileIndex, TestFileCheck } from '@ctxo/cli/internal';
import { readRepoTexts, SOURCE_SCAN_MAX_BYTES } from './repo-files.js';

export interface TestFileText {
  readonly file: string;
  readonly text: string;
  readonly index?: FileIndex;
}

/**
 * Reads the tracked files `isTestFile` accepts (by path or by annotation: the host check holds both),
 * in codepoint order. Each file is read once through `readRepoTexts`, so test files get the same limits as the
 * production `rule:` scan (R18): a file that is missing, unreadable, over `maxBytes` or binary is skipped
 * (warn-and-continue; the caller has no logger here, and a missing test file only means fewer links).
 */
export function readTestFiles(
  projectRoot: string,
  tracked: readonly string[],
  isTestFile: TestFileCheck,
  indices: readonly FileIndex[],
  maxBytes: number = SOURCE_SCAN_MAX_BYTES,
): TestFileText[] {
  const byFile = new Map<string, FileIndex>();
  for (const index of indices) byFile.set(index.file.replace(/\\/g, '/'), index);
  const files = tracked.map((f) => f.replace(/\\/g, '/')).filter((f) => isTestFile(f));
  return readRepoTexts(projectRoot, files, maxBytes).map(({ file, text }) => {
    const index = byFile.get(file);
    return index === undefined ? { file, text } : { file, text, index };
  });
}
