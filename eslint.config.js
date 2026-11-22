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
      // Git-ignored scratch dir for deployment measurements (SPIKE §10). Its
      // scripts are throwaway probes, not deliverables.
      '.local/**',
      'worker/python/.venv/**',
      // web/ is the console subproject: Deno edge runtime + browser globals,
      // checked by its own toolchain. Root rules here assume the Node CLI
      // (PLAN.md §2 隔离要求 3), so linting it with them would only produce
      // no-undef noise — or worse, push Node idioms into edge code.
      'web/**',
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
      'src/cli.ts', // composition entry: registers every command
      'src/cli/**', // TUI/session surfaces (sanctioned DSH consumers)
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
