import { describe, it, expect } from 'vitest';
import { createTestFileClassifier, DEFAULT_TEST_GLOBS } from '../test-file-classifier.js';

describe('createTestFileClassifier', () => {
  const isTest = createTestFileClassifier();

  it('exposes the 13 default globs', () => {
    expect(DEFAULT_TEST_GLOBS).toHaveLength(13);
  });

  it.each([
    'src/__tests__/a.ts',
    'src/a.test.ts',
    'web/a.spec.js',
    'test/a.ts',
    'tests/e2e/a.ts',
    'pkg/store_test.go',
    'src/test/java/AT.java',
    'src/Billing.Tests/A.cs',
    'src/Billing.Test/A.cs',
    'src/LoanTests.cs',
    'src/LoanTest.cs',
    'app/test_models.py',
    'app/models_test.py',
  ])('classifies a path matched by each default glob as a test file: %s', (p) => {
    expect(isTest(p)).toBe(true);
  });

  it.each([
    'src/latest.ts',
    'src/contest/a.ts',
    'src/Testing.cs',
    'src/attestation.go',
    'src/testing_utils.py',
  ])('leaves look-alike production paths alone: %s', (p) => {
    expect(isTest(p)).toBe(false);
  });

  it('matches backslash paths and paths with spaces or non-ASCII characters', () => {
    expect(isTest('src\\şube kaydı\\__tests__\\a.ts')).toBe(true);
    expect(isTest('src/şube kaydı/b.test.ts')).toBe(true);
  });

  it('adds index.tests globs to the defaults', () => {
    const custom = createTestFileClassifier(['**/Characterization/**']);
    expect(custom('src/Characterization/A.cs')).toBe(true);
    expect(custom('src/a.test.ts')).toBe(true);
    expect(isTest('src/Characterization/A.cs')).toBe(false);
  });
});
