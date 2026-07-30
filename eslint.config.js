// Flat config, ESM — this package is `"type": "module"`, so there is no
// `require` here and `sourceType` is `module` everywhere.
//
// Formatting rules are deliberately ABSENT. Prettier owns layout (see
// .prettierrc); duplicating `indent`/`quotes`/`semi` here would give two tools
// an opinion on the same bytes and the loser shows up as a CI failure nobody
// can fix locally. ESLint here is only about correctness.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'secrets/**', 'public/**', 'CHANGELOG.md'],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Node 24: `fetch`, `AbortController`, `URL`, `structuredClone` and
      // friends are all globals, so nodeBuiltin covers them without a
      // hand-maintained list going stale.
      globals: {
        ...globals.nodeBuiltin,
        ...globals.node,
      },
    },
    rules: {
      // `_`-prefixed args are the convention for "required by the signature,
      // deliberately unused" (Hono middleware `next`, error handlers).
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // This is a server and a CLI; stdout is a real output channel.
      'no-console': 'off',
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-caller': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-global-assign': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
