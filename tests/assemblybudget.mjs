import assert from 'node:assert/strict';
import {
  DEFAULT_ASSEMBLY_BUDGET_MS,
  DEFAULT_ASSEMBLY_MAX_CHUNKS,
  canContinueAssembly,
} from '../src/assemblybudget.mjs';

assert.equal(DEFAULT_ASSEMBLY_MAX_CHUNKS, 1);
assert.equal(DEFAULT_ASSEMBLY_BUDGET_MS, 3);
assert.equal(canContinueAssembly({ assembled: 0, examined: 0, elapsedMs: 20 }), true,
  'the first result must always be inspected');
assert.equal(canContinueAssembly({ assembled: 1, examined: 1, elapsedMs: 0.5 }), false,
  'more than one chunk could assemble in one frame');
assert.equal(canContinueAssembly({ assembled: 0, examined: 1, elapsedMs: 3.1 }), false,
  'stale-result scanning escaped the millisecond budget');
assert.equal(canContinueAssembly({ assembled: 0, examined: 1, elapsedMs: 2.9 }), true);

console.log('assemblybudget PASS · one chunk · 3ms cross-result budget');
