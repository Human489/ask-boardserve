import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

// There was no linter at all. `npm run lint` ran `next lint`, which is
// deprecated in Next 15 and was never configured, so it prompted to scaffold
// one and gated nothing. The build's "Linting and checking validity of types"
// step was only ever checking types.
//
// The rules below are the ones that would have caught defects this project has
// actually shipped: an unused binding kept alive to look like an assertion, and
// promises left unawaited around a store whose writes decide what a reader
// sees. Stylistic rules are deliberately absent — this codebase has a voice,
// and a linter is a poor editor of prose.

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // The rules of hooks, and the dependency check that would have caught a
    // stale closure in the pins and datasets hooks before a reader did.
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Type-aware rules need the TypeScript program, so they are scoped to the
    // files that are in it. A .mjs script is not, and asking the project
    // service for one is a parse error rather than a lint finding.
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dead binding is how "assert typeof rate === 'function'" survived as
      // an assertion that could never fail.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // KV writes decide what the dashboard shows. A dropped await there is the
      // difference between a pin being saved and appearing to be saved.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // The codebase is strict TypeScript with no `any` in src/lib; keep it so.
      '@typescript-eslint/no-explicit-any': 'error',
      // A stray non-breaking space in code is a bug; inside a regex or a
      // template it can be the point. The announcer appends one deliberately,
      // because an ordinary trailing space can be collapsed and the live region
      // then does not mutate, so nothing is announced.
      'no-irregular-whitespace': ['error', { skipRegExps: true, skipTemplates: true }],
    },
  },
  {
    // Tests reach into internals and build deliberately malformed fixtures.
    files: ['tests/**', 'scripts/**'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // node:test's `test()` returns a promise by design; every call site would
      // otherwise need a `void`, which says nothing and reads as noise.
      '@typescript-eslint/no-floating-promises': 'off',
      // tests/sources.test.ts exists to FIND control characters, so its regex
      // contains them on purpose. This project has shipped a mangled escape
      // four times; that guard is not the thing to silence.
      'no-control-regex': 'off',
      // Fixtures assert on values the compiler has already narrowed; the
      // redundant assertion is documentation of what is being checked.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // Plain .mjs scripts are outside the TypeScript project, so type-aware
    // rules cannot run on them. They still get the syntax and correctness
    // rules, which is what matters for a script.
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
)
