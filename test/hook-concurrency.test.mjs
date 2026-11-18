import assert from 'node:assert/strict';
import test from 'node:test';
import { controls, harness } from './harness.mjs';

const control = (tree, key) => {
  const found = controls(tree).find((node) => node.key === key);
  assert.ok(found, `no control ${key}`);
  return found;
};

test('two patches applied while the first view read is pending both stay in the view', async () => {
  const h = harness();
  const tree = await h.render();
  const tab = control(tree, 'tab-usage');
  const help = control(tree, 'help');
  const read = h.$.state.get;
  let releaseReads;
  const gate = new Promise((resolve) => {
    releaseReads = resolve;
  });
  let pending = 0;
  h.$.state.get = async (ref) => {
    pending += 1;
    await gate;
    return read(ref);
  };
  const first = tab.onPress();
  const second = help.onPress();
  while (pending < 2) await new Promise((resolve) => setImmediate(resolve));
  releaseReads();
  await Promise.all([first, second]);
  assert.equal(h.view().tab, 'usage');
  assert.equal(h.view().help, true);
});
