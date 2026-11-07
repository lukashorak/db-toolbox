import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const drivers = {
  group: ['pg', 'pg-*', 'mysql2', 'mysql2/*'],
  message: 'Database drivers are used only inside @workbench/core adapters.',
};
const deepCore = {
  group: ['@workbench/core/*', '**/core/src/**', '**/core/dist/**'],
  message: 'Import the public @workbench/core entry point only.',
};
const reference = {
  group: ['**/reference/**'],
  message: 'reference/ is read-only material; copy code deliberately instead of importing it.',
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'reference/**', 'coverage/**', 'data/**', 'exports/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.svelte'] } },
  },
  {
    files: ['packages/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            reference,
            {
              group: ['@workbench/api', '@workbench/mcp', '@workbench/web', 'fastify', '@fastify/*'],
              message: 'core must not depend on its interfaces (API, MCP, GUI).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/api/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [drivers, deepCore, reference] }] },
  },
  {
    files: ['packages/mcp/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            drivers,
            deepCore,
            reference,
            {
              group: ['@workbench/api', '@workbench/api/*'],
              message: 'The MCP adapter must not depend on the HTTP API.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/web/**'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            reference,
            {
              group: [
                '@workbench/core',
                '@workbench/core/*',
                '@workbench/api',
                '@workbench/mcp',
                'node:*',
                'pg',
                'mysql2',
              ],
              message: 'The browser app talks to the server over HTTP only.',
            },
          ],
        },
      ],
    },
  },
);
