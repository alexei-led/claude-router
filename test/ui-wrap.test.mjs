// The terminal's word wrapping and cell clipping, row by row.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clip, dimLines, pack } from '../lib/ui/terminal/wrap.mjs';

const ui = { dim: (text) => `dim:${text}` };
const words = (text) => text.split(' ').map((word) => /** @type {[string, string]} */ ([word, ' ']));

test('pack fills a line to its width and starts the next with the word that would pass it', () => {
  for (const [text, width, indent, expected] of [
    ['aa bb cc', 8, '', ['aa bb cc']],
    ['aa bb cc', 7, '', ['aa bb', 'cc']],
    ['aa bb cc', 5, '', ['aa bb', 'cc']],
    ['aa bb cc', 4, '', ['aa', 'bb', 'cc']],
    ['aa bb cc', 6, '  ', ['  aa', '  bb', '  cc']],
    ['aa bb cc', 7, '  ', ['  aa bb', '  cc']],
    ['aa bb cc', 10, '  ', ['  aa bb cc']],
  ])
    assert.deepEqual(pack(words(text), width, indent), expected, `${text} / ${width} / "${indent}"`);
});

test('pack keeps a word wider than the line whole, alone on its line', () => {
  assert.deepEqual(pack(words('ab abcdefghij cd'), 6, ''), ['ab', 'abcdefghij', 'cd']);
  assert.deepEqual(pack(words('abcdefghij'), 4, '  '), ['  abcdefghij']);
});

test('pack joins pieces with the joiner that follows each', () => {
  assert.deepEqual(
    pack(
      [
        ['a', '-'],
        ['b', ' '],
        ['c', ''],
      ],
      9,
      '',
    ),
    ['a-b c'],
  );
});

test('pack of nothing is no line', () => {
  assert.deepEqual(pack([], 10, '  '), []);
  assert.deepEqual(pack([['', '']], 10, '  '), []);
});

test('dimLines wraps by words to the columns and dims each line, keeping the text’s indent', () => {
  for (const [text, columns, expected] of [
    ['aa bb cc', 5, ['dim:aa bb', 'dim:cc']],
    ['  aa bb cc', 7, ['dim:  aa bb', 'dim:  cc']],
    ['aa bb', 5, ['dim:aa bb']],
    ['abcdefghij kl', 4, ['dim:abcdefghij', 'dim:kl']],
    ['', 10, []],
  ])
    assert.deepEqual(dimLines(ui, text, columns), expected, `"${text}" / ${columns}`);
});

test('dimLines leaves the text on one line where the pane has no width', () => {
  for (const columns of [null, Number.NaN, Number.POSITIVE_INFINITY])
    assert.deepEqual(dimLines(ui, '  aa bb cc', columns), ['dim:  aa bb cc'], String(columns));
});

test('clip cuts to the width with an ellipsis and leaves what fits', () => {
  for (const [text, width, expected] of [
    ['abc', 3, 'abc'],
    ['abcd', 3, 'ab…'],
    ['abc', 10, 'abc'],
    ['', 3, ''],
    ['abcd', 1, '…'],
    ['abcd', 0, '…'],
  ])
    assert.equal(clip(text, width), expected, `"${text}" / ${width}`);
});
