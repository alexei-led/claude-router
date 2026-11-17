// A hairline separates another mod's row from the router's band on graphical surfaces only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ELEMENTS, harness, start } from './harness.mjs';

const LOWER = { type: 'Box', props: { key: 'other-mod', children: [] } };
const props = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, view: {} };

async function rows(surface, answer, elements) {
  const h = harness();
  if (elements) h.$.ui.resolve = () => elements;
  await start(h);
  const tree = await h.component('AbovePrompt', props, { next: async () => answer, surface });
  return tree.props.children.filter(Boolean);
}
const kinds = (children) => children.map((c) => c.props?.key ?? c.type);

test('on desktop and mobile a divider sits between the lower row and the band', async () => {
  for (const surface of ['desktop', 'mobile']) {
    const children = await rows(surface, LOWER);
    assert.deepEqual(kinds(children), ['other-mod', 'Box', 'router-band'], surface);
    const [clip] = children[1].props.children;
    const [divider] = clip.props.children;
    assert.equal(divider.type, 'Svg');
    assert.equal(divider.props.alt, 'Divider');
    assert.equal(divider.props.width, undefined);
    assert.equal(divider.props.height, 1);
    assert.equal(clip.props.overflow, 'hidden');
    assert.equal(children[1].props.marginTop, undefined);
    assert.equal(children[1].props.marginBottom, 'md');
    assert.match(divider.props.source, /width="4000" height="1" viewBox="0 0 4000 1"/);
    assert.match(divider.props.source, /preserveAspectRatio="none"/);
  }
});

test('with no row beneath there is no divider', async () => {
  for (const answer of [null, undefined, false, []]) {
    const children = await rows('desktop', answer);
    // Whatever empty answer stays where it was; no divider follows it.
    assert.equal(children.length, answer === null || answer === undefined || answer === false ? 1 : 2);
    assert.equal(children.at(-1).props.key, 'router-band');
    assert.ok(!children.some((c) => c.props?.children?.[0]?.type === 'Svg'), String(answer));
  }
});

test('the terminal never draws the divider', async () => {
  for (const surface of ['terminal', undefined])
    for (const answer of [LOWER, null])
      assert.ok(!(await rows(surface, answer)).some((c) => c.props.children?.[0]?.type === 'Svg'), String(surface));
  assert.deepEqual(kinds(await rows('terminal', LOWER)), ['other-mod', 'router-band']);
});

test('a surface without Svg draws no divider', async () => {
  const { Svg: _, ...noSvg } = ELEMENTS;
  assert.deepEqual(kinds(await rows('desktop', LOWER, noSvg)), ['other-mod', 'router-band']);
});
