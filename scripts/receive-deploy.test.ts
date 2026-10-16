import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { extractArchive, validateArchive } from './receive-deploy';

type Entry = { name: string; body?: string; type?: number };

function tar(entries: Entry[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write((entry.type ?? 0) === 5 ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(' ', 148, 156);
    header[156] = entry.type ?? 0;
    header.write('ustar\0', 257, 6, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (body.length > 0)
      blocks.push(Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

describe('scripts/receive-deploy archive boundary', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a regular-file archive and extracts only its contents', () => {
    const archive = tar([
      { name: './assets', type: 5 },
      { name: './assets/app.js', body: 'bundle' },
    ]);
    expect(validateArchive(archive)).toHaveLength(2);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solux-receive-test-'));
    extractArchive(archive, tmpDir);
    expect(fs.readFileSync(path.join(tmpDir, 'assets/app.js'), 'utf8')).toBe('bundle');
  });

  it.each(['../../outside.txt', '/etc/passwd', 'assets/../outside.txt'])(
    'rejects unsafe path %s',
    (name) => {
      expect(() => validateArchive(tar([{ name, body: 'not safe' }]))).toThrow(/unsafe path/i);
    },
  );

  it('rejects symlink entries rather than following them', () => {
    expect(() => validateArchive(tar([{ name: 'escape', type: 2 }]))).toThrow(
      /disallowed entry type/i,
    );
  });

  it('rejects duplicate paths and malformed gzip input', () => {
    expect(() =>
      validateArchive(
        tar([
          { name: 'index.html', body: 'a' },
          { name: 'index.html', body: 'b' },
        ]),
      ),
    ).toThrow(/duplicate path/i);
    expect(() => validateArchive(Buffer.from('not an archive'))).toThrow(/valid gzip/i);
  });
});
