// Loads a pure TypeScript module from client/src into the server tests, transpiled in memory
// with the TypeScript that client/ already has. No React, no DOM.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

let ts;
try { ts = require('../client/node_modules/typescript'); } catch {
    throw new Error('Install the client first: `cd client && npm ci` (tests for client/src modules need it).');
}

function load(file) {
    const filename = path.resolve(__dirname, '../client/src', file);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} }, req = createRequire(filename);
    const localRequire = name => name.startsWith('.') ? load(path.join(path.dirname(file), `${name}.ts`)) : req(name);
    vm.runInThisContext(`(function(require,module,exports){${code}
})`, { filename })(localRequire, mod, mod.exports);
    return mod.exports;
}

module.exports = { load };
