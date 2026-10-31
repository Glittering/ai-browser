// tests/test_download_unique.js — 同名下载必须唯一化（此前直接覆盖前一份）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uniquePath } from '../src/main/download_monitor.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-unique-'));

describe('uniquePath', () => {
  it('D1 目录是空的时候用原名（不给用户多加后缀）', () => {
    expect(uniquePath(dir, 'report.csv')).toBe(path.join(dir, 'report.csv'));
  });

  it('D2 已存在 → 追加 (1)，再存在 → (2)', () => {
    fs.writeFileSync(path.join(dir, 'report.csv'), 'a');
    expect(path.basename(uniquePath(dir, 'report.csv'))).toBe('report (1).csv');
    fs.writeFileSync(path.join(dir, 'report (1).csv'), 'b');
    expect(path.basename(uniquePath(dir, 'report.csv'))).toBe('report (2).csv');
  });

  it('D3 多个点号的文件名只在最后一个扩展名前插序号', () => {
    fs.writeFileSync(path.join(dir, 'a.b.c.tar.gz'), 'x');
    expect(path.basename(uniquePath(dir, 'a.b.c.tar.gz'))).toBe('a.b.c.tar (1).gz');
  });

  it('D4 没有扩展名也能唯一化', () => {
    fs.writeFileSync(path.join(dir, 'MAGIC'), 'x');
    expect(path.basename(uniquePath(dir, 'MAGIC'))).toBe('MAGIC (1)');
  });

  it('D5 名字里带空格/中文不破坏', () => {
    fs.writeFileSync(path.join(dir, '我的 报告.pdf'), 'x');
    expect(path.basename(uniquePath(dir, '我的 报告.pdf'))).toBe('我的 报告 (1).pdf');
  });

  it('D6 结果路径必须落在同一目录（不能写到别处）', () => {
    expect(path.dirname(uniquePath(dir, 'report.csv'))).toBe(dir);
  });
});
