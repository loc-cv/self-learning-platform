// Flag parsing against what the real kubectl v1.37.2 printed for the same arguments on this
// workstation (2026-11-16): the error texts are pflag's, wrapped by kubectl's FlagErrorFunc.

import { describe, expect, test } from 'vitest';
import { flagSet, parseFlags, parseGoInt, readAsCSV, type FlagDef } from './flagset.ts';
import { parseGoDuration } from './goduration.ts';

const DEFS: FlagDef[] = [
  { name: 'all-namespaces', shorthand: 'A', kind: 'bool', default: false },
  { name: 'watch', shorthand: 'w', kind: 'bool', default: false },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'namespace', shorthand: 'n', kind: 'string', default: '' },
  { name: 'chunk-size', kind: 'int64', default: 500 },
  { name: 'label-columns', shorthand: 'L', kind: 'stringSlice', default: [] },
  { name: 'timeout', kind: 'duration', default: '0s' },
];
const fs = flagSet(DEFS);
const parse = (...args: string[]) => parseFlags(fs, args);

describe('pflag parsing', () => {
  test('long and short forms, = or space, booleans, flags after arguments', () => {
    const r = parse('pods', '-n', 'dev', '--output=yaml', '-A', 'web', '--watch');
    expect(r).toMatchObject({ args: ['pods', 'web'], values: { namespace: 'dev', output: 'yaml', 'all-namespaces': true, watch: true }, changed: ['namespace', 'output', 'all-namespaces', 'watch'] });
  });
  test('-ojson, -n=dev, grouped shorthands, -Aw=false', () => {
    expect(parse('-ojson')).toMatchObject({ values: { output: 'json' } });
    expect(parse('-n=dev')).toMatchObject({ values: { namespace: 'dev' } });
    expect(parse('-Aw')).toMatchObject({ values: { 'all-namespaces': true, watch: true } });
    expect(parse('-Aw=false')).toMatchObject({ values: { 'all-namespaces': true, watch: false } });
    expect(parse('-An', 'dev')).toMatchObject({ values: { 'all-namespaces': true, namespace: 'dev' } });
  });
  test('a bool does not take the next argument; --flag=false does', () => {
    expect(parse('--watch', 'false')).toMatchObject({ args: ['false'], values: { watch: true } });
    expect(parse('--watch=false')).toMatchObject({ args: [], values: { watch: false } });
  });
  test('repeats: the last string wins, slices append and split commas', () => {
    expect(parse('-o', 'yaml', '-o', 'json')).toMatchObject({ values: { output: 'json' } });
    expect(parse('-L', 'app', '-L', 'tier,env')).toMatchObject({ values: { 'label-columns': ['app', 'tier', 'env'] } });
  });
  test('-- ends the flags', () => {
    expect(parse('a', '--', '-n', 'x')).toMatchObject({ args: ['a', '-n', 'x'], argsLenAtDash: 1 });
  });
  test('underscores read as dashes', () => {
    expect(parse('--all_namespaces')).toMatchObject({ values: { 'all-namespaces': true } });
  });
  test('the real error texts', () => {
    expect(parse('--nosuch')).toEqual({ error: 'unknown flag: --nosuch' });
    expect(parse('-Z')).toEqual({ error: "unknown shorthand flag: 'Z' in -Z" });
    expect(parse('-n')).toEqual({ error: "flag needs an argument: 'n' in -n" });
    expect(parse('--namespace')).toEqual({ error: 'flag needs an argument: --namespace' });
    expect(parse('--watch=maybe')).toEqual({ error: 'invalid argument "maybe" for "-w, --watch" flag: strconv.ParseBool: parsing "maybe": invalid syntax' });
    expect(parse('--chunk-size=abc')).toEqual({ error: 'invalid argument "abc" for "--chunk-size" flag: strconv.ParseInt: parsing "abc": invalid syntax' });
    expect(parse('-Aw=x')).toEqual({ error: 'invalid argument "x" for "-w, --watch" flag: strconv.ParseBool: parsing "x": invalid syntax' });
    expect(parse('-o')).toEqual({ error: "flag needs an argument: 'o' in -o" });
    expect(parse('--=x')).toEqual({ error: 'bad flag syntax: --=x' });
  });
  test('--help and -h when not defined', () => {
    expect(parse('--help')).toEqual({ error: 'help', help: true });
    expect(parse('-h')).toEqual({ error: 'help', help: true });
  });
});

describe('Go value parsers', () => {
  test('strconv.ParseInt with base 0', () => {
    expect(parseGoInt('0x1f', 64)).toEqual({ value: 31 });
    expect(parseGoInt('017', 64)).toEqual({ value: 15 });
    expect(parseGoInt('1_000', 64)).toEqual({ value: 1000 });
    expect(parseGoInt('_1', 64)).toEqual({ error: 'strconv.ParseInt: parsing "_1": invalid syntax' });
    expect(parseGoInt('9223372036854775808', 64)).toEqual({ error: 'strconv.ParseInt: parsing "9223372036854775808": value out of range' });
    expect(parseGoInt('-5', 64)).toEqual({ value: -5 });
  });
  test('time.ParseDuration', () => {
    expect(parseGoDuration('30s')).toEqual({ ns: 30_000_000_000n });
    expect(parseGoDuration('1.5h')).toEqual({ ns: 5_400_000_000_000n });
    expect(parseGoDuration('0')).toEqual({ ns: 0n });
    expect(parseGoDuration('5')).toEqual({ error: 'time: missing unit in duration "5"' });
    expect(parseGoDuration('5x')).toEqual({ error: 'time: unknown unit "x" in duration "5x"' });
    expect(parseGoDuration('abc')).toEqual({ error: 'time: invalid duration "abc"' });
  });
  test('csv fields of a string slice', () => {
    expect(readAsCSV('a,b')).toEqual({ value: ['a', 'b'] });
    expect(readAsCSV('"a,b",c')).toEqual({ value: ['a,b', 'c'] });
    expect(readAsCSV('')).toEqual({ value: [] });
  });
});
