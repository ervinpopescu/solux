#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TARGET_DIR = process.env.SOLUX_TARGET_DIR || '/var/www/solux';

export const REQUIRED_FILES = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'registerSW.js',
  'favicon.ico',
  'favicon.svg',
  'apple-touch-icon.png',
  'pwa-192x192.png',
  'pwa-512x512.png',
];

export const LIFECYCLE_FILES = ['manifest.webmanifest', 'registerSW.js', 'sw.js', 'index.html'];

const USAGE = `Solux Static Deployment Tool

Usage:
  node scripts/deploy.js [options] [target-directory]

Options:
  -t, --target <dir>     Target deployment directory (default: /var/www/solux or $SOLUX_TARGET_DIR)
  -d, --dist <dir>       Source dist directory (default: dist)
  -n, --dry-run          Simulate deployment without modifying target directory
  -h, --help             Show this help message

Environment Variables:
  SOLUX_TARGET_DIR       Default target directory if --target is not specified
`;

/**
 * Recursively inspects a directory for broken, absolute, or escaping symlinks.
 * Throws an Error if an unsafe symlink is found.
 *
 * @param {string} currentDir
 * @param {string} [rootDistDir]
 */
export function checkSymlinks(currentDir, rootDistDir = currentDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    let lstat;
    try {
      lstat = fs.lstatSync(fullPath);
    } catch {
      throw new Error(`Failed to stat path: "${fullPath}". Deployment rejected.`);
    }

    if (lstat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(fullPath);
      if (path.isAbsolute(linkTarget)) {
        throw new Error(
          `Unsafe absolute symlink detected: "${path.relative(rootDistDir, fullPath)}" -> "${linkTarget}". Deployment rejected.`,
        );
      }
      const resolvedPath = path.resolve(currentDir, linkTarget);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(
          `Broken symlink detected: "${path.relative(rootDistDir, fullPath)}" -> "${linkTarget}". Deployment rejected.`,
        );
      }
      const relToRoot = path.relative(rootDistDir, resolvedPath);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        throw new Error(
          `Unsafe symlink escaping dist directory: "${path.relative(rootDistDir, fullPath)}" -> "${linkTarget}". Deployment rejected.`,
        );
      }
    } else if (lstat.isDirectory()) {
      checkSymlinks(fullPath, rootDistDir);
    }
  }
}

/**
 * Validates that the distribution directory exists, contains all required PWA files,
 * has valid hashed asset bundles, and contains no unsafe symlinks.
 *
 * @param {string} distDir
 */
export function validateDist(distDir) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`Build directory "${distDir}" does not exist. Run "npm run build" first.`);
  }
  const stat = fs.statSync(distDir);
  if (!stat.isDirectory()) {
    throw new Error(`Build directory "${distDir}" is not a directory.`);
  }

  // 1. Check for unsafe symlinks
  checkSymlinks(distDir, distDir);

  // 2. Check required PWA files
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(distDir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing required PWA file: "${file}". Run "npm run build" first.`);
    }
    const fileStat = fs.statSync(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`Required PWA path "${file}" is not a regular file.`);
    }
  }

  // 3. Check assets directory
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir) || !fs.statSync(assetsDir).isDirectory()) {
    throw new Error(
      'Missing required "assets" directory in build output. Run "npm run build" first.',
    );
  }

  const assetFiles = fs.readdirSync(assetsDir);
  const hasJs = assetFiles.some((f) => f.endsWith('.js'));
  const hasCss = assetFiles.some((f) => f.endsWith('.css'));
  if (!hasJs || !hasCss) {
    throw new Error(
      'Required assets are incomplete: build must contain at least one .js and one .css bundle in assets/.',
    );
  }
}

/**
 * Deploys the built static distribution to the target root.
 *
 * Deployment guarantees:
 *  - Target directory is rejected if it resolves to the same path as dist
 *  - Dist validation runs before any disk modification
 *  - Hashed assets are copied first to target/assets/
 *  - Old hashed assets in target/assets/ are preserved for active browser sessions
 *  - Static files (icons, Workbox runtime) are copied next
 *  - Lifecycle files (manifest, service worker, registerSW, index.html) are atomically promoted
 *  - Dry-run mode validates and reports planned actions without writing to disk
 *
 * @param {Object} [options]
 * @param {string} [options.distDir]
 * @param {string} [options.targetDir]
 * @param {boolean} [options.dryRun]
 * @param {number} [options.fileMode]
 * @param {number} [options.dirMode]
 * @param {(msg: string) => void} [options.logger]
 */
export function deploy(options = {}) {
  const distDir = path.resolve(options.distDir || 'dist');
  const targetDir = path.resolve(options.targetDir || DEFAULT_TARGET_DIR);
  const dryRun = Boolean(options.dryRun);
  const log = options.logger || console.log;
  const fileMode = options.fileMode ?? 0o644;
  const dirMode = options.dirMode ?? 0o755;

  let canonicalDist = distDir;
  try {
    if (fs.existsSync(distDir)) {
      canonicalDist = fs.realpathSync(distDir);
    }
  } catch {
    // Best-effort canonicalization
  }

  let canonicalTarget = targetDir;
  try {
    if (fs.existsSync(targetDir)) {
      canonicalTarget = fs.realpathSync(targetDir);
    }
  } catch {
    // Best-effort canonicalization
  }

  if (distDir === targetDir || canonicalDist === canonicalTarget) {
    throw new Error(
      `Target directory "${targetDir}" resolves to the same path as build directory "${distDir}". Deployment rejected.`,
    );
  }

  validateDist(distDir);

  const modeStr = dryRun ? ' (DRY RUN)' : '';
  log(`Starting Solux static deployment${modeStr}:`);
  log(`  Source dist: ${distDir}`);
  log(`  Target root: ${targetDir}`);

  const targetAssetsDir = path.join(targetDir, 'assets');

  // Step 1: Ensure target directories exist
  if (!dryRun) {
    fs.mkdirSync(targetDir, { recursive: true, mode: dirMode });
    try {
      fs.chmodSync(targetDir, dirMode);
    } catch {
      // Best-effort permission update
    }
    fs.mkdirSync(targetAssetsDir, { recursive: true, mode: dirMode });
    try {
      fs.chmodSync(targetAssetsDir, dirMode);
    } catch {
      // Best-effort permission update
    }
  } else {
    log(`[dry-run] Would ensure target directories exist: ${targetDir}, ${targetAssetsDir}`);
  }

  // Step 2: Copy new hashed assets BEFORE atomic promotion
  // Note: Old hashed assets already in targetAssetsDir are preserved so active browser sessions never 404
  const distAssetsDir = path.join(distDir, 'assets');
  const assetFiles = fs.readdirSync(distAssetsDir);
  let assetsCopied = 0;

  for (const file of assetFiles) {
    const srcAsset = path.join(distAssetsDir, file);
    const destAsset = path.join(targetAssetsDir, file);
    if (!dryRun) {
      fs.copyFileSync(srcAsset, destAsset);
      fs.chmodSync(destAsset, fileMode);
    } else {
      log(`[dry-run] Would copy hashed asset: assets/${file} -> ${destAsset}`);
    }
    assetsCopied++;
  }
  log(`  Hashed assets staged: ${assetsCopied} files (existing assets preserved)`);

  // Step 3: Copy non-lifecycle static files (icons, Workbox runtime chunks, etc.)
  const rootEntries = fs.readdirSync(distDir);
  const lifecycleSet = new Set(LIFECYCLE_FILES);
  let staticFilesCopied = 0;

  for (const entry of rootEntries) {
    if (entry === 'assets' || lifecycleSet.has(entry)) {
      continue;
    }
    const srcPath = path.join(distDir, entry);
    const destPath = path.join(targetDir, entry);
    const stat = fs.statSync(srcPath);
    if (stat.isFile()) {
      if (!dryRun) {
        fs.copyFileSync(srcPath, destPath);
        fs.chmodSync(destPath, fileMode);
      } else {
        log(`[dry-run] Would copy static asset: ${entry} -> ${destPath}`);
      }
      staticFilesCopied++;
    }
  }
  log(`  Static root files staged: ${staticFilesCopied} files`);

  // Step 4: Atomic promotion of lifecycle files (manifest, registerSW, sw, index.html)
  // Each file is copied to a temporary file in targetDir, then renamed into place.
  let lifecyclePromoted = 0;
  for (const file of LIFECYCLE_FILES) {
    const srcPath = path.join(distDir, file);
    const destPath = path.join(targetDir, file);
    const tempPath = path.join(
      targetDir,
      `.${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );

    if (!dryRun) {
      try {
        fs.copyFileSync(srcPath, tempPath);
        fs.chmodSync(tempPath, fileMode);
        fs.renameSync(tempPath, destPath);
      } catch (err) {
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // ignore unlink error
          }
        }
        throw err;
      }
    } else {
      log(`[dry-run] Would atomically promote lifecycle file: ${file} -> ${destPath}`);
    }
    lifecyclePromoted++;
  }
  log(`  Lifecycle files atomically promoted: ${LIFECYCLE_FILES.join(', ')}`);

  log(`Deployment${modeStr} completed successfully.`);
  return {
    success: true,
    dryRun,
    validated: true,
    distDir,
    targetDir,
    assetsCopied,
    staticFilesCopied,
    lifecyclePromoted,
  };
}

/**
 * Parses command-line arguments for the deployment script.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    distDir: 'dist',
    targetDir: DEFAULT_TARGET_DIR,
    dryRun: false,
    help: false,
  };

  let targetSet = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target' || arg === '-t') {
      if (i + 1 >= argv.length) {
        throw new Error('Option --target requires a directory argument.');
      }
      options.targetDir = argv[++i];
      targetSet = true;
    } else if (arg.startsWith('--target=')) {
      options.targetDir = arg.slice('--target='.length);
      targetSet = true;
    } else if (arg === '--dist' || arg === '-d') {
      if (i + 1 >= argv.length) {
        throw new Error('Option --dist requires a directory argument.');
      }
      options.distDir = argv[++i];
    } else if (arg.startsWith('--dist=')) {
      options.distDir = arg.slice('--dist='.length);
    } else if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!arg.startsWith('-') && !targetSet) {
      options.targetDir = arg;
      targetSet = true;
    } else {
      throw new Error(`Unknown option: "${arg}". Use --help for usage.`);
    }
  }

  return options;
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const opts = parseArgs(process.argv);
    if (opts.help) {
      console.log(USAGE);
      process.exit(0);
    }
    deploy(opts);
    process.exit(0);
  } catch (err) {
    console.error(`Deploy error: ${err.message}`);
    process.exit(1);
  }
}
