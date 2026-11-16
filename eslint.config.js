// Lint rules that catch real bugs (undefined names, unreachable code, bad comparisons), not style.
// Run: npm run lint
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'bench/tasks/**', 'bench/results/**', 'tests/fixtures/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off', // ANSI and NUL handling on purpose
      'no-useless-escape': 'off',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    // The window's scripts are classic scripts that share top-level names with each other.
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, marked: 'readonly', DOMPurify: 'readonly', hljs: 'readonly', monaco: 'readonly', require: 'readonly', api: 'readonly' },
    },
    rules: { 'no-undef': 'off', 'no-unused-vars': 'off', 'no-redeclare': 'off' },
  },
  {
    // These pass functions to a web page (page.evaluate), where browser names exist.
    files: ['src/main/preload.js', 'src/main/browser.js', 'tests/ui.test.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // The UI test calls the window's own functions inside the page.
    files: ['tests/ui.test.js'],
    rules: { 'no-undef': 'off' },
  },
];
