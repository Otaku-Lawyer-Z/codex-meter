import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenScale } from '../src/renderer/chart-scale.mjs';
test('token scale covers daily values with four equal intervals', () => {
  for (const value of [0, 1, 7, 5700, 100000000, 123456789]) {
    const scale = tokenScale([value]);
    assert.ok(scale.max >= value);
    assert.equal(scale.ticks.at(-1), 0);
    assert.equal(scale.ticks[0], scale.max);
    assert.equal(scale.ticks[1], scale.max * .75);
  }
});
