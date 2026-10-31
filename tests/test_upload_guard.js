// tests/test_upload_guard.js — upload 的路径闸门（此前任意绝对路径直通 CDP）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import uploadGuard from '../src/shared/upload_guard.cjs';

const { checkUploadPath } = uploadGuard;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-guard-'));
const okFile = path.join(tmp, 'photo.png');
fs.writeFileSync(okFile, 'x');
const bigFile = path.join(tmp, 'big.bin');
fs.writeFileSync(bigFile, Buffer.alloc(2048));

describe('checkUploadPath：什么能传、什么不能传', () => {
  it('U1 普通文件放行，并返回真实路径与大小', () => {
    const r = checkUploadPath(okFile, { fs, env: {} });
    expect(r.ok).toBe(true);
    expect(r.path).toBe(fs.realpathSync(okFile));
    expect(r.size).toBe(1);
  });

  it('U2 相对路径拒（解析基准不可预期）', () => {
    const r = checkUploadPath('photo.png', { fs, env: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/absolute/i);
  });

  it('U3 空路径 / 非字符串拒', () => {
    expect(checkUploadPath('', { fs, env: {} }).ok).toBe(false);
    expect(checkUploadPath(null, { fs, env: {} }).ok).toBe(false);
    expect(checkUploadPath(123, { fs, env: {} }).ok).toBe(false);
  });

  it('U4 不存在的文件拒，且提示"什么都没传"', () => {
    const r = checkUploadPath(path.join(tmp, 'nope.png'), { fs, env: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
    expect(r.hint).toMatch(/nothing was uploaded/i);
  });

  it('U5 目录拒（不是普通文件）', () => {
    const r = checkUploadPath(tmp, { fs, env: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a regular file/i);
  });

  it('U6 超过大小上限拒，且说清上限', () => {
    const r = checkUploadPath(bigFile, { fs, env: { AI_BROWSER_UPLOAD_MAX_MB: '0.001' } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/over the 0MB limit|over the .*MB limit/);
  });

  it('U7 私钥 / 凭据目录一律拒（这是本地文件外传原语）', () => {
    const cases = [
      '/Users/me/.ssh/id_rsa',
      '/Users/me/.aws/credentials',
      '/Users/me/project/.env',
      '/Users/me/certs/server.pem',
      '/Users/me/Library/Application Support/Google/Chrome/Cookies',
    ];
    for (const f of cases) {
      // 用假 fs 让"文件存在"，专测敏感路径判据（真实路径大多不存在）
      const fakeFs = { statSync: () => ({ size: 10, isFile: () => true }) };
      const r = checkUploadPath(f, { fs: fakeFs, env: {} });
      expect(r.ok, `${f} 应该被拒`).toBe(false);
      expect(r.error, `${f} 的错误要说清是凭据/私钥`).toMatch(/credentials|private keys/i);
    }
  });

  it('U8 显式放开时放行，但回执里必须标 sensitive_override', () => {
    const fakeFs = { statSync: () => ({ size: 10, isFile: () => true }) };
    const r = checkUploadPath('/Users/me/.ssh/id_rsa', { fs: fakeFs, env: { AI_BROWSER_UPLOAD_ALLOW_SENSITIVE: '1' } });
    expect(r.ok).toBe(true);
    expect(r.sensitive_override).toBe(true);
  });

  it('U10 符号链接指向敏感文件同样被拒（一条 ln -s 不能绕过）', () => {
    const dir = path.join(tmp, '.ssh');
    fs.mkdirSync(dir, { recursive: true });
    const secret = path.join(dir, 'id_rsa');
    fs.writeFileSync(secret, 'PRIVATE');
    const link = path.join(tmp, 'innocent.png');
    try { fs.unlinkSync(link); } catch (_) {}
    fs.symlinkSync(secret, link);

    const r = checkUploadPath(link, { fs, env: {} });
    expect(r.ok, '符号链接必须被 realpath 后的判据拦住').toBe(false);
    expect(r.error).toMatch(/credentials|private keys/i);
  });

  it('U9 大小上限可由环境变量调整', () => {
    const r = checkUploadPath(bigFile, { fs, env: { AI_BROWSER_UPLOAD_MAX_MB: '1' } });
    expect(r.ok).toBe(true);
  });
});
