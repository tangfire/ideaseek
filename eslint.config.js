import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.research/**',
      'worker/python/.venv/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['worker/python/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  // ---- Layer boundaries: application / domain / adapter (hardened) ----
  // Domain layers receive ports as arguments and never import the
  // application (command) layer; DSH SDK surfaces are confined to the
  // adapter/sanctioned modules; workflow/sqlite is restricted to the
  // workflow package plus documented adapter-export consumers.
  // Exceptions below are deliberate and documented in
  // docs/BUILD_VS_REUSE_REVIEW.md (分层硬化 section).
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/commands/**', // application layer: wires everything (composition)
      'src/dsh/**', // adapter boundary (HarnessAdapter impls)
      'src/dsh-plugins/**', // DSH plugin surfaces (cordis/dsh-tools)
      'src/agent/**', // sanctioned DSH session surface (agent mode)
      'src/cli.ts', // composition entry: registers every command
      'src/cli/**', // TUI/session surfaces (sanctioned DSH consumers)
      'src/models/setup.ts', // DSH provider credential-shape authority
      'src/index.ts', // public export surface (re-exports the port)
      'src/workflow/**', // owns the sqlite adapter
      'src/runtime/backup.ts', // documented adapter exports (vacuum/rebind)
      'src/artifact/store.ts', // relPathForHash must match db layout byte-for-byte
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/commands/*'],
              message:
                'domain layers never import the application (command) layer — move the call into a command, or pass the port down from one',
            },
            {
              group: ['**/workflow/sqlite.js'],
              message:
                'use the WorkflowDb port (runtime.db); direct sqlite adapter access stays inside workflow + documented adapter exports',
            },
            {
              group: ['@deepseek-ai/*'],
              message:
                'DSH SDK imports are confined to sanctioned surfaces (src/dsh, src/dsh-plugins, src/agent, src/cli, models/setup)',
            },
          ],
        },
      ],
    },
  },
);
