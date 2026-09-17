// CX-P2 tests for src/lib/names.ts: confusable stripping + duplicate/impersonation warnings.
// Build first: npx esbuild src/lib/names.ts --bundle --platform=node --format=cjs --outfile=.test-build/names.cjs
// Run: node lib.names.test.cjs
const assert = require('node:assert');
const { stripConfusables, coinNameWarning } = require('./.test-build/names.cjs');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// stripConfusables removes zero-width, bidi-override, soft-hyphen and control chars.
ok(stripConfusables('AB​C‮x­y') === 'ABCxy', 'strips zero-width/bidi/soft-hyphen');
ok(stripConfusables('Iron Man') === 'Iron Man', 'leaves normal text intact');

// Duplicate against an existing Census coin (by name and by ticker).
ok(coinNameWarning('Iron Man', 'IRON', [{ name: 'Iron Man', symbol: 'XYZ' }])?.kind === 'duplicate', 'duplicate by name');
ok(coinNameWarning('Fresh', 'IRON', [{ name: 'Other', symbol: 'IRON' }])?.kind === 'duplicate', 'duplicate by ticker');
// Confusable/format tricks still collapse to the same key.
ok(coinNameWarning('Iron​Man', 'ZZZ', [{ name: 'iron man', symbol: 'ABC' }])?.kind === 'duplicate', 'duplicate despite zero-width + case + spacing');

// Impersonation of a real company (anchor menu + stock catalogue).
ok(coinNameWarning('NVIDIA', 'FOO', [])?.kind === 'impersonation', 'impersonation by company name (NVIDIA)');
ok(coinNameWarning('Whatever', 'HOOD', [])?.kind === 'impersonation', 'impersonation by ticker (HOOD)');
ok(coinNameWarning('Robinhood', 'FOO', [])?.kind === 'impersonation', 'impersonation by anchor name (Robinhood)');

// Novel names are clean; empty is clean.
ok(coinNameWarning('Zephyr Widgets', 'ZEPH', [{ name: 'Iron Man', symbol: 'IRON' }]) === null, 'novel name is not flagged');
ok(coinNameWarning('', '', []) === null, 'empty is not flagged');

console.log(`lib.names.test.cjs: ${n} checks passed`);
