import tseslint from 'typescript-eslint';

// ADR-018: @ctxo/domain reaches the CLI through types only. A flat config replaces a rule's options per
// matching block, so the src/core/** block carries the core/ restrictions and the type-only rule together.
const CLI_TYPES_ONLY = {
  group: ['@ctxo/cli', '@ctxo/cli/internal'],
  allowTypeImports: true,
  message: '@ctxo/domain imports the CLI internal API as types only (ADR-018)',
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '**/__tests__/**'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { patterns: [CLI_TYPES_ONLY] }],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/**'],
              message: 'core/ must not import from adapters/ (hexagonal boundary)',
            },
            CLI_TYPES_ONLY,
          ],
        },
      ],
    },
  },
);
