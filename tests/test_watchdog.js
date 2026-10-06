import { describe, it, expect } from 'vitest';
import {
  parseWatchdogTargets,
  isWatchdogEnabled,
  DEFAULT_WATCHDOG_TARGETS,
} from '../src/shared/watchdog.js';

describe('parseWatchdogTargets', () => {
  it('returns the default targets when env is unset', () => {
    expect(parseWatchdogTargets(undefined)).toEqual(DEFAULT_WATCHDOG_TARGETS);
    expect(parseWatchdogTargets(undefined)).toEqual(['https://example.com/', 'https://www.baidu.com/']);
  });

  it('returns the default targets for an empty / whitespace-only string', () => {
    expect(parseWatchdogTargets('')).toEqual(DEFAULT_WATCHDOG_TARGETS);
    expect(parseWatchdogTargets('   ')).toEqual(DEFAULT_WATCHDOG_TARGETS);
    expect(parseWatchdogTargets(',,,')).toEqual(DEFAULT_WATCHDOG_TARGETS);
  });

  it('returns a fresh array so callers cannot mutate the default', () => {
    const a = parseWatchdogTargets(undefined);
    const b = parseWatchdogTargets(undefined);
    expect(a).not.toBe(b);
    a.push('https://mutated/');
    expect(parseWatchdogTargets(undefined)).toEqual(DEFAULT_WATCHDOG_TARGETS);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseWatchdogTargets('https://a.example/, https://b.example/ ,https://c.example/')).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/',
    ]);
  });

  it('drops empty entries between repeated commas', () => {
    expect(parseWatchdogTargets('https://a.example/,,https://b.example/,')).toEqual([
      'https://a.example/',
      'https://b.example/',
    ]);
  });

  it('de-duplicates repeated targets', () => {
    expect(parseWatchdogTargets('https://a.example/,https://a.example/, https://a.example/ ')).toEqual([
      'https://a.example/',
    ]);
  });

  it('handles a single target with no comma', () => {
    expect(parseWatchdogTargets('https://www.baidu.com/')).toEqual(['https://www.baidu.com/']);
  });

  it('falls back to defaults for non-string junk input', () => {
    expect(parseWatchdogTargets(null)).toEqual(DEFAULT_WATCHDOG_TARGETS);
    expect(parseWatchdogTargets(12345)).toEqual(DEFAULT_WATCHDOG_TARGETS);
    expect(parseWatchdogTargets({})).toEqual(DEFAULT_WATCHDOG_TARGETS);
  });
});

describe('isWatchdogEnabled', () => {
  it('defaults to enabled when unset', () => {
    expect(isWatchdogEnabled(undefined)).toBe(true);
    expect(isWatchdogEnabled(null)).toBe(true);
    expect(isWatchdogEnabled(12345)).toBe(true);
  });

  it.each(['0', 'off', 'false', 'no'])('disables on %s', (v) => {
    expect(isWatchdogEnabled(v)).toBe(false);
  });

  it.each(['OFF', 'False', 'NO', '  off  ', '0 '])('disables case/whitespace-insensitively on %j', (v) => {
    expect(isWatchdogEnabled(v)).toBe(false);
  });

  it.each(['1', 'on', 'true', 'yes', '', 'nope', 'disable'])('stays enabled on %j', (v) => {
    expect(isWatchdogEnabled(v)).toBe(true);
  });
});
