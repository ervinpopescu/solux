import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { extractArchive, receiveArchive, validateArchive } from './receive-deploy';

type Entry = { name: string; body?: string; type?: number };

function createCompleteDist(distDir: string) {
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  for (const file of [
    'index.html',
    'manifest.webmanifest',
    'sw.js',
    'registerSW.js',
    'favicon.ico',
    'favicon.svg',
    'apple-touch-icon.png',
    'pwa-192x192.png',
    'pwa-512x512.png',
  ]) {
    fs.writeFileSync(path.join(distDir, file), file);
  }
  fs.writeFileSync(path.join(distDir, 'assets', 'index-hash.js'), 'bundle');
  fs.writeFileSync(path.join(distDir, 'assets', 'index-hash.css'), 'style');
}

function workflowArchive(baseDir: string, metadata: object) {
  const distDir = path.join(baseDir, 'dist');
  const payload = path.join(baseDir, 'payload.tar.gz');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, '.solux-deploy.json'), `${JSON.stringify(metadata)}\n`);
  execFileSync('tar', [
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    payload,
    '-C',
    baseDir,
    '.solux-deploy.json',
    '-C',
    distDir,
    '.',
  ]);
  return payload;
}

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

  it('deploys the exact workflow tar command, then rejects replayed runs', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solux-receive-integration-'));
    const distDir = path.join(tmpDir, 'dist');
    createCompleteDist(distDir);
    const payload = workflowArchive(tmpDir, {
      repository: 'ervinpopescu/solux',
      sha: 'a'.repeat(40),
      runId: 101,
    });
    const targetDir = path.join(tmpDir, 'target');
    const stagingRoot = path.join(tmpDir, 'staging');
    const stateDir = path.join(tmpDir, 'state-dir');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const statePath = path.join(stateDir, 'state.json');
    receiveArchive(fs.readFileSync(payload), { targetDir, stagingRoot, statePath });
    expect(fs.readFileSync(path.join(targetDir, 'assets', 'index-hash.js'), 'utf8')).toBe('bundle');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).runId).toBe(101);
    expect(() =>
      receiveArchive(fs.readFileSync(payload), { targetDir, stagingRoot, statePath }),
    ).toThrow(/stale/i);
  });

  it('rejects invalid metadata and missing required artifacts before target changes', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solux-receive-invalid-'));
    const distDir = path.join(tmpDir, 'dist');
    createCompleteDist(distDir);
    const invalidPayload = workflowArchive(tmpDir, {
      repository: 'attacker/example',
      sha: 'b'.repeat(40),
      runId: 102,
    });
    expect(() =>
      receiveArchive(fs.readFileSync(invalidPayload), {
        targetDir: path.join(tmpDir, 'invalid-target'),
        stagingRoot: path.join(tmpDir, 'invalid-staging'),
        statePath: path.join(tmpDir, 'invalid-state'),
      }),
    ).toThrow(/metadata/i);

    fs.rmSync(path.join(tmpDir, '.solux-deploy.json'));
    fs.rmSync(path.join(distDir, 'favicon.ico'));
    const missingPayload = workflowArchive(tmpDir, {
      repository: 'ervinpopescu/solux',
      sha: 'c'.repeat(40),
      runId: 103,
    });
    const missingTarget = path.join(tmpDir, 'missing-target');
    expect(() =>
      receiveArchive(fs.readFileSync(missingPayload), {
        targetDir: missingTarget,
        stagingRoot: path.join(tmpDir, 'missing-staging'),
        statePath: path.join(tmpDir, 'missing-state'),
      }),
    ).toThrow(/Missing required PWA file/);
    expect(fs.existsSync(missingTarget)).toBe(false);
  });

  it('rejects target and assets symlinks before modifying either destination', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solux-receive-target-'));
    const distDir = path.join(tmpDir, 'dist');
    createCompleteDist(distDir);
    const payload = workflowArchive(tmpDir, {
      repository: 'ervinpopescu/solux',
      sha: 'd'.repeat(40),
      runId: 104,
    });
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    const targetLink = path.join(tmpDir, 'target-link');
    fs.symlinkSync(outside, targetLink);
    expect(() =>
      receiveArchive(fs.readFileSync(payload), {
        targetDir: targetLink,
        stagingRoot: path.join(tmpDir, 'staging-link'),
        statePath: path.join(tmpDir, 'state-link'),
      }),
    ).toThrow(/target path ancestor|unsafe existing target/i);
    expect(fs.readdirSync(outside)).toHaveLength(0);

    const target = path.join(tmpDir, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(outside, path.join(target, 'assets'));
    expect(() =>
      receiveArchive(fs.readFileSync(payload), {
        targetDir: target,
        stagingRoot: path.join(tmpDir, 'staging-assets-link'),
        statePath: path.join(tmpDir, 'state-assets-link'),
      }),
    ).toThrow(/unsafe existing target/i);
    expect(fs.readdirSync(outside)).toHaveLength(0);
  });
});
