// Server lint (root JS, scripts/, test/) reusing the ESLint already installed in client/.
const js = require('../client/node_modules/@eslint/js');

const globals = Object.fromEntries(['require', 'module', 'exports', 'process', 'console', 'Buffer', '__dirname', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'fetch', 'AbortController', 'URL', 'performance', 'structuredClone'].map(k => [k, 'readonly']));

module.exports = [
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.cjs'],
        languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023, globals },
        rules: {
            // We look for NUL bytes and control characters on purpose.
            'no-control-regex': 'off',
        },
    },
];
