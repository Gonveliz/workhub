// Bug-catching rules only: the recommended sets without type-checked rules, no stylistic rules and no
// formatter. Rules that were noisy are switched off below, each with the reason.
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/.stage/**',
      '**/.dev-data/**',
      '**/.demo-data/**',
      'packages/relay/web-client/**',
      'spike/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Some old disables guard rules that are off here (control characters in regexes).
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Hooks called conditionally break at runtime. exhaustive-deps stays off: it finds 27 effects that
      // list a subset of their inputs, and the code already opts out of it line by line elsewhere.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
      // A leading underscore is the repo's way to say "unused on purpose" (ignored arguments, the rest of
      // a destructuring that drops a field).
      // A warning, not an error: a few dead imports predate the linter and are not worth a sweep here.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }
      ],
      // Noisy and not bugs: `any` appears at JSON and test-double boundaries, and the repo relies on
      // `catch {}` for best-effort cleanup.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Terminal output handling matches ESC and BEL on purpose.
      'no-control-regex': 'off',
      // Style, not bugs: redundant escapes in regular expressions, and error causes on rethrow.
      'no-useless-escape': 'off',
      'preserve-caught-error': 'off',
      // Style and intent, not bugs: defensive initialisers, `let` in test setup, and a prompt stream that
      // deliberately never yields.
      'no-useless-assignment': 'off',
      'prefer-const': 'off',
      'require-yield': 'off'
    }
  }
)
