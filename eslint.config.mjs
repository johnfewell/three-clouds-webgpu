import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import noCommentSlop from 'eslint-plugin-no-comment-slop'
import tseslint from 'typescript-eslint'

// files outside the type-aware project. Only the type-aware block
// skips them, and the comment rules still apply
const TYPE_AWARE_IGNORES = [
  // benchmark evidence (raw JSON, and the one-off experiment
  // drivers that produced it), like parity/results; also in .prettierignore
  'perf/**',
  'examples/parity/scripts/**',
  'examples/parity/vite.config.ts',
  'examples/parity/vite-plugin-*.ts',
  'scripts/verify-results.mjs',
  // the shared asset provisioner, plain .mjs so both examples'
  // package scripts call one implementation (same arrangement as above)
  'scripts/setup-assets.mjs',
  // argv parsing is plain .mjs so capture.mjs and setup-assets.mjs
  // import one implementation under node with no transpile. The .ts tests are
  // collected, the module sits outside the type-aware project
  'scripts/cliArgs.mjs',
  'scripts/captureArgs.mjs',
  'scripts/setupAssetsArgs.mjs',
  // the receipt-key CLI is plain .mjs so it can import keyPaths.mjs
  // (the shared KEY_PATHS) and run under node, like verify-results.mjs. Its
  // .ts tests ARE collected, only the module is outside the project
  'scripts/receipt-key.mjs',
  'scripts/merge-check.mjs',
  // the emitter's CLIs, plain .mjs so node runs them and they start vite,
  // and the replay page, plain .js served to the browser as is
  'core/scripts/**',
  'core/emit/replay/**',
  // the pinned-digest gate, plain .mjs so merge-check can run it
  // under node with no transpile, like the CLIs above. Its test is collected
  'scripts/digest-parity.mjs',
  // the read-only worktree census, plain .mjs so it runs under node
  // with no transpile, like the CLIs above. Its .ts test IS collected
  'scripts/worktree-inventory.mjs',
  // the comment-only guard, plain .mjs like the CLIs above
  'scripts/comment-only-check.mjs',
  // The declaration-extension post-step, plain .mjs so it runs under node with
  // no transpile, like the CLIs above. Its .ts test IS collected
  'scripts/dts-extensions.mjs',
  // The offline jitter generator, plain .mjs like the CLIs above
  'scripts/generate-blue-noise.mjs',
  // Its fixture writer, plain .mjs for the same reason: setup-assets.mjs and
  // isolate.sh both reach it from node with no transpile
  'scripts/jitterFixture.mjs',
  // The pre-commit gate and its installer, plain .mjs so git and pnpm run them
  // with no transpile. The gate's .ts test is collected
  'scripts/precommit.mjs',
  'scripts/install-hooks.mjs',
  // The public snapshot exporter and its two plain .mjs modules, outside the
  // type-aware project like the CLIs above. Their .ts test is collected and
  // checks them through the .d.mts siblings
  'scripts/release/*.mjs',
  'scripts/docs/*.mjs',
  // the threshold schema is plain .mjs so the two node CLIs and
  // the TS evaluator share ONE implementation instead of a fourth copy of
  // the rule, the same arrangement as verify-results.mjs above
  'examples/parity/cases/*.mjs',
  // the shared evaluator is plain .mjs so browser TypeScript and
  // both Node CLIs execute one implementation. TypeScript imports are
  // checked through evaluator.d.mts, the runtime is exercised by Vitest
  'examples/parity/src/metrics/evaluator.mjs',
  // the Chromium flag merge is plain .mjs so
  // the Playwright config and the Node capture scripts share one
  // implementation, checked through chromeFlags.d.mts and its Vitest test
  'examples/parity/src/e2eSupport/chromeFlags.mjs',
  // the e2e key definition is plain .mjs for the same
  // reason: one implementation for the receipt writer, the CI verdict and
  // freshBuild. Outside the project service, while e2e/**/*.ts IS linted
  'examples/parity/e2e/*.mjs',
  'eslint.config.mjs',
  // The A/B capture script is plain .mjs outside the project service, like
  // the parity scripts above
  'examples/storybook/scripts/*.mjs',
  'examples/demo/scripts/*.mjs'
]

export default tseslint.config(
  {
    ignores: [
      // The site Worker's standalone tooling and the deploy output it generates
      'site/**',
      'reference/**',
      'coverage/**',
      // '**/' so nested scratchpads are covered too: probe scripts under
      // examples/parity/test-results/ have to live there for @playwright/test
      // to resolve, and a bare 'test-results/**' only matches the repo root
      '**/test-results/**',
      'build/**',
      'dist/**',
      '**/dist/**',
      // The generated API reference (pnpm docs:api). Its assets are plain JS
      // that the type-aware block below cannot place in the TS project, and it
      // is a build artifact like build/ and types/
      'api/',
      'types/**',
      'node_modules/**',
      'playground/dist/**',
      '.claude/**',
      '.opencode/**',
      'scripts/port-gates/fixtures/**',
      'scripts/port-gates/*.mjs',
      // upstream storybook-webgpu infrastructure,
      // copied verbatim with provenance headers. Not ours to lint, like
      // reference/**. The stories that consume it ARE linted
      'examples/storybook/src/vendor/**',
      'examples/storybook/src/clouds-webgl/vendor/**'
    ]
  },
  // short, plain comments. The three JSDoc rules stay off because
  // JSDoc is limited to the public surface
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    ignores: ['parity/results/**'],
    languageOptions: { parser: tseslint.parser },
    plugins: { 'no-comment-slop': noCommentSlop },
    rules: {
      'no-comment-slop/no-trailing-period': 'error',
      'no-comment-slop/no-em-dash': 'error',
      'no-comment-slop/max-comment-lines': 'error',
      'no-comment-slop/no-prose-semicolon': 'error',
      'no-comment-slop/no-trailing-comment': 'error',
      'no-comment-slop/no-banner-comment': 'error',
      'no-comment-slop/multiline-jsdoc-format': 'error',
      'no-comment-slop/no-jargon': 'error',
      'no-comment-slop/no-foreign-syntax': 'error'
    }
  },
  {
    ignores: TYPE_AWARE_IGNORES,
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      // Enforced repo-wide. The four no-unsafe-* rules below stay
      // off: they are a separate, larger decision about the TSL node surface
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowAny: true }
      ]
    }
  },
  {
    files: ['recipes/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './scripts/recipes/tsconfig.lint.json'
      }
    }
  },
  prettier
)
