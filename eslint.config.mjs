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
    files: ['service-worker.js', 'worker/**/*.js', 'test/**/*.js'],
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
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      'comma-dangle': ['error', 'only-multiline'],
      indent: ['error', 2, { SwitchCase: 1 }],
      // `({ hs, ...s }) => s` destructures to OMIT hs — legit idiom
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error'
    }
  }
]
