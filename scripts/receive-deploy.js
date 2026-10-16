#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { deploy } from './deploy.js';

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
export const MAX_FILES = 10_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DEPLOY_METADATA = '.solux-deploy.json';
export const DEPLOY_REPOSITORY = 'ervinpopescu/solux';

function readOctal(header, start, length) {
  const value = header
    .toString('ascii', start, start + length)
    .replace(/\0.*$/, '')
    .trim();
  if (!/^[0-7]+$/.test(value)) {
    throw new Error('Archive contains an invalid tar numeric field.');
  }
  return Number.parseInt(value, 8);
}

function readName(header) {
  const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
  const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}

function safeArchivePath(name) {
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    path.posix.isAbsolute(name) ||
    name.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Archive contains an unsafe path: "${name}".`);
  }
  const normalized = path.posix.normalize(name).replace(/^\.\//, '');
  if (!normalized || normalized === '.') return '';
  return normalized;
}

function verifyChecksum(header) {
  const expected = readOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < 512; index++) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) {
    throw new Error('Archive contains an invalid tar header checksum.');
  }
}

/**
 * Parse and validate a gzip-compressed ustar archive without extracting it.
 * Only regular files and directories are accepted; links and special files are rejected.
 * @param {Buffer} archive
 * @returns {{name: string, type: 'file' | 'directory', size: number, dataOffset: number}[]}
 */
export function validateArchive(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive exceeds the ${MAX_ARCHIVE_BYTES} byte limit.`);
  }
  let tar;
  try {
    tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch {
    throw new Error('Archive is not a valid gzip stream or exceeds the uncompressed size limit.');
  }
  if (tar.length > MAX_UNCOMPRESSED_BYTES || tar.length < 1024) {
    throw new Error('Archive is empty or exceeds the uncompressed size limit.');
  }

  const entries = [];
  const names = new Set();
  let offset = 0;
  let totalBytes = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks++;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;
    verifyChecksum(header);
    const name = safeArchivePath(readName(header));
    if (names.has(name)) throw new Error(`Archive contains a duplicate path: "${name}".`);
    names.add(name);
    const typeflag = header[156];
    const isRegular = typeflag === 0 || typeflag === 48;
    const isDirectory = typeflag === 5 || typeflag === 53;
    const size = readOctal(header, 124, 12);
    if (size > MAX_FILE_BYTES || totalBytes + size > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('Archive contains files exceeding the size limit.');
    }
    if (!isRegular && !isDirectory) {
      throw new Error(`Archive contains a disallowed entry type for "${name}".`);
    }
    const dataOffset = offset;
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tar.length) throw new Error('Archive contains truncated file data.');
    if (isDirectory && size !== 0) throw new Error(`Directory "${name}" has file data.`);
    entries.push({ name, type: isDirectory ? 'directory' : 'file', size, dataOffset });
    offset += paddedSize;
    totalBytes += size;
    if (entries.length > MAX_FILES) throw new Error(`Archive exceeds the ${MAX_FILES} file limit.`);
  }
  if (zeroBlocks < 2) throw new Error('Archive is missing its tar end-of-archive marker.');
  return entries;
}

/** @param {Buffer} archive @param {string} stagingDir */
export function extractArchive(archive, stagingDir) {
  const entries = validateArchive(archive);
  const tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  for (const entry of entries) {
    const destination = path.join(stagingDir, entry.name);
    if (entry.type === 'directory') {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, tar.subarray(entry.dataOffset, entry.dataOffset + entry.size), {
        mode: 0o600,
        flag: 'wx',
      });
    }
  }
  return entries;
}

function readInput() {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      // sudo with use_pty can briefly expose its stdin as non-blocking.
      if (error?.code !== 'EAGAIN') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    if (bytesRead === 0) break;
    size += bytesRead;
    if (size > MAX_ARCHIVE_BYTES) throw new Error('Archive exceeds the input size limit.');
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, size);
}

function readMetadata(stagingDir) {
  const metadataPath = path.join(stagingDir, DEPLOY_METADATA);
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    throw new Error('Deployment metadata is missing or invalid.');
  }
  if (
    !metadata ||
    metadata.repository !== DEPLOY_REPOSITORY ||
    !/^[0-9a-f]{40}$/.test(metadata.sha) ||
    !Number.isSafeInteger(metadata.runId) ||
    metadata.runId < 1
  ) {
    throw new Error('Deployment metadata does not match the Solux repository.');
  }
  fs.unlinkSync(metadataPath);
  return metadata;
}

function readLastRun(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return Number.isSafeInteger(state.runId) ? state.runId : 0;
  } catch {
    return 0;
  }
}

export function receiveArchive(
  archive,
  {
    targetDir = '/var/www/solux',
    stagingRoot = '/var/lib/solux-deploy/staging',
    statePath = '/var/lib/solux-deploy/state.json',
  } = {},
) {
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const stagingDir = fs.mkdtempSync(path.join(stagingRoot, 'run-'));
  try {
    extractArchive(archive, stagingDir);
    const metadata = readMetadata(stagingDir);
    if (metadata.runId <= readLastRun(statePath)) {
      throw new Error(`Deployment run ${metadata.runId} is stale and was rejected.`);
    }
    const result = deploy({
      distDir: stagingDir,
      targetDir,
      logger: (message) => console.error(message),
    });
    const stateTemp = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(stateTemp, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    fs.renameSync(stateTemp, statePath);
    return result;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function receive(options = {}) {
  return receiveArchive(readInput(), options);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  process.umask(0o077);
  try {
    receive();
  } catch (error) {
    console.error(`Receive error: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
  }
}
