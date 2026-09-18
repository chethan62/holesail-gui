// ESLint config for holesail-gui — matches the existing hand-written style
// (no semicolons, 2-space indent, single quotes, trailing commas) so the
// first run doesn't churn the whole codebase. Browsers/Node globals are
// scoped per-directory in `overrides`.

export default [
  {
    ignores: [
      'node_modules/**',
      'dist-resources*/**',
      'src-tauri/**',
      'packaging/**',
      'renderer/vendor/**'
    ]
  },
  {
    files: ['renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        Event: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        getComputedStyle: 'readonly',
        crypto: 'readonly',
        __TAURI__: 'readonly',
        qrcode: 'readonly' // renderer/vendor/qrcode.js (loaded via <script>)
      }
    }
  },
  {
    // NO `process` global here on purpose: a packaged build runs the worker
    // under the bare runtime, which has no global process — declaring it (as
    // this file used to) lets `process.env` pass lint and then kill the worker
    // on load, i.e. the app never starts. Take it from worker/runtime.js.
    // Tests run under Node and declare it below.
    files: ['service-worker.js', 'worker/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        Buffer: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        globalThis: 'readonly',
        setImmediate: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly'
      }
    }
  },
  {
    // Node-only files (the suite + scripts): these DO get the global process.
    files: ['test/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        globalThis: 'readonly',
        setImmediate: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly'
      }
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        globalThis: 'readonly'
      }
    }
  },
  {
    rules: {
      // matches the existing style
      semi: ['error', 'never'],
      quotes: [
        'error',
        'single',
        { avoidEscape: true, allowTemplateLiterals: true }
      ],
      'comma-dangle': ['error', 'only-multiline'],
      // Indentation is owned by Prettier (npm run format). ESLint's AST
      // indent rule conflicts with Prettier's output on continuations
      // (chained ternaries etc.) — keep formatting in ONE place.
      indent: 'off',
      // `({ hs, ...s }) => s` destructures to OMIT hs — legit idiom
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true }
      ],
      'no-undef': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error'
    }
  }
]
