import assert from 'node:assert/strict';
import test from 'node:test';
import { ELEMENTS, screen, unboxed } from './harness.mjs';

const REFUSED = [
  ['Box', { gap: 'huge' }, 'a spacing name the engine does not know'],
  ['Box', { paddingX: NaN }, 'a NaN spacing'],
  ['Box', { margin: Infinity }, 'an infinite spacing'],
  ['Box', { width: NaN }, 'a NaN width'],
  ['Box', { width: '50 percent' }, 'a width string that is not a percentage'],
  ['Box', { height: '50%' }, 'a percentage height'],
  ['Box', { flexGrow: '1' }, 'a flex factor that is a string'],
  ['Button', { onPress() {} }, 'a Button with no label or children'],
  ['Button', { label: 'Router', plain: false }, 'a Button whose plain is false rather than left out'],
  ['Select', { value: 'a', options: [] }, 'a Select with no onSelect'],
  ['Select', { value: 'a', onSelect() {} }, 'a Select with no options'],
  ['Box', { borderStyle: 'rounded' }, 'a border name the engine does not know, which draws no border'],
];
const ACCEPTED = [
  ['Box', { gap: 'xs', padding: 'md', paddingLeft: 2, width: '50%', height: 3, flexGrow: 0 }],
  ['Box', { gap: undefined, width: undefined }],
  ['Box', { borderStyle: 'single', borderColor: 'subtle', paddingX: 1 }],
  ['Button', { label: 'Save', onPress() {} }],
  ['Button', { children: [] }],
  ['Select', { value: 'a', options: [{ value: 'a', label: 'A' }], onSelect() {} }],
  ['Text', { children: 'hello' }],
];

for (const [type, props, why] of REFUSED)
  test(`the ${type} stub refuses ${why}, as the engine does`, () => {
    assert.throws(() => ELEMENTS[type](props), assert.AssertionError);
  });

for (const [type, props] of ACCEPTED)
  test(`the ${type} stub accepts ${Object.keys(props).join(', ') || 'no props'}`, () => {
    assert.deepEqual(ELEMENTS[type](props), { type, props });
  });

test('screen draws a bordered Box around its padding, and unboxed takes the border away again', () => {
  const { Box, Text } = ELEMENTS;
  const tree = Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'column',
        borderStyle: 'single',
        paddingX: 1,
        children: [Text({ children: 'HEAD' }), Text({ children: '  a longer line' })],
      }),
      Text({ children: 'after' }),
    ],
  });
  assert.deepEqual(screen(tree), [
    '┌─────────────────┐',
    '│ HEAD            │',
    '│   a longer line │',
    '└─────────────────┘',
    'after',
  ]);
  assert.deepEqual(unboxed(screen(tree)), ['HEAD', '  a longer line', '', 'after']);
});
