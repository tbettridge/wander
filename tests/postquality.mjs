import assert from 'node:assert/strict';
import { msaaSamplesForTier, resolveMsaaSamples } from '../src/postquality.mjs';

assert.equal(msaaSamplesForTier('potato'), 0);
assert.equal(msaaSamplesForTier('low'), 0);
assert.equal(msaaSamplesForTier('medium'), 0);
assert.equal(msaaSamplesForTier('high'), 2);
assert.equal(msaaSamplesForTier('ultra'), 2);

assert.equal(resolveMsaaSamples('medium', 'auto'), 0);
assert.equal(resolveMsaaSamples('ultra', 'auto'), 2);
assert.equal(resolveMsaaSamples('medium', '4'), 4);
assert.equal(resolveMsaaSamples('ultra', 0), 0);
assert.equal(resolveMsaaSamples('high', 'invalid'), 2);

console.log('postquality PASS · 0x low/medium · 2x high/ultra · 4x baseline override');
