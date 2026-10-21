import { makeGlobMatcher } from '../config/load-config.js';

/** Globs that mark a repo-relative path as a test file, in spec 7.1 order. */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/*_test.go',
  '**/src/test/**',
  '**/*.Tests/**',
  '**/*.Test/**',
  '**/*Tests.cs',
  '**/*Test.cs',
  '**/test_*.py',
  '**/*_test.py',
];

/** Takes a repo-relative path with either separator. */
export type TestFileClassifier = (path: string) => boolean;

/** Classifies test files by the default globs plus any extra (`index.tests`) globs. */
export function createTestFileClassifier(extraGlobs: readonly string[] = []): TestFileClassifier {
  return makeGlobMatcher([...DEFAULT_TEST_GLOBS, ...extraGlobs]);
}
