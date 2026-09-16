import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VERSION } from '../src/shared/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version: pkgVersion } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('version single-source consistency', () => {
  it('package.json "version" matches src/shared/version.js', () => {
    expect(pkgVersion).toBe(VERSION);
  });

  it('adheres to the v1.1.x semver scheme', () => {
    expect(VERSION).toMatch(/^1\.1\.\d+$/);
  });
});