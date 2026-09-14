import { describe, it, expect } from 'vitest';
import { evaluateGuardError, EVAL_MAX_LENGTH } from '../src/shared/guards.js';

describe('evaluateGuardError (single-source eval-safety guard)', () => {
  it('returns null for a short, benign script', () => {
    expect(evaluateGuardError('document.title')).toBe(null);
  });

  it('returns null at exactly the max length', () => {
    const js = 'a'.repeat(EVAL_MAX_LENGTH);
    expect(evaluateGuardError(js)).toBe(null);
  });

  it('rejects a script one char over the max length', () => {
    const js = 'a'.repeat(EVAL_MAX_LENGTH + 1);
    expect(evaluateGuardError(js)).toContain('char limit');
  });

  it('rejects non-string input', () => {
    expect(evaluateGuardError(undefined)).toMatch(/must be a string/);
    expect(evaluateGuardError(null)).toMatch(/must be a string/);
  });

  it.each([
    'process.env',
    'globalThis.process',
    'require("fs")',
    'require( "os" )', // whitespace-tolerant regex: \brequire\s*\(
    'child_process',
  ])('rejects Node-exfil pattern: %s', (script) => {
    expect(evaluateGuardError(script)).toMatch(/disallowed Node-specific identifier/);
  });

  it('allows scripts that merely contain the word "process" as a safe substring? no — only blocks bad forms', () => {
    // A plain string like "process" alone is not blocked (no `process.` / globalThis.process);
    // the blocklist targets member-access / require / child_process.
    expect(evaluateGuardError('1 + 1')).toBe(null);
    // Literal "process" without a following dot/globalThis is allowed by the guard.
    expect(evaluateGuardError('const x = process')).toBe(null);
  });
});