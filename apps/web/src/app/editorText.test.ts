import { expect, test } from 'vitest';
import { exArgs, toBuffer, toFile } from './editorText.ts';

test('a file round-trips through the overlay as vim writes it', () => {
  expect(toFile(toBuffer('a: 1\nb: 2\n'))).toBe('a: 1\nb: 2\n');
  expect(toFile(toBuffer(''))).toBe('');
  // No final newline: vim adds one on write ('fixendofline').
  expect(toFile(toBuffer('a\nb'))).toBe('a\nb\n');
});

test('Ex arguments: the bang and a file name', () => {
  expect(exArgs('quit', '!')).toEqual({ name: 'quit', bang: true, arg: '' });
  expect(exArgs('write', ' other.yaml')).toEqual({ name: 'write', bang: false, arg: 'other.yaml' });
  expect(exArgs('write', undefined)).toEqual({ name: 'write', bang: false, arg: '' });
});
