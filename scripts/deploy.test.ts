import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSymlinks, deploy, parseArgs, REQUIRED_FILES, validateDist } from './deploy';

describe('scripts/deploy', () => {
  let tmpBase: string;
  let fakeDist: string;
  let fakeTarget: string;

  function createCompleteFakeDist(distPath: string) {
    fs.mkdirSync(path.join(distPath, 'assets'), { recursive: true });
    // Required files
    fs.writeFileSync(path.join(distPath, 'index.html'), '<html><body>Solux</body></html>');
    fs.writeFileSync(path.join(distPath, 'manifest.webmanifest'), '{"name":"Solux"}');
    fs.writeFileSync(path.join(distPath, 'sw.js'), 'self.addEventListener("fetch", () => {});');
    fs.writeFileSync(path.join(distPath, 'registerSW.js'), 'console.log("sw registered");');
    fs.writeFileSync(path.join(distPath, 'favicon.ico'), 'fake-ico');
    fs.writeFileSync(path.join(distPath, 'favicon.svg'), '<svg></svg>');
    fs.writeFileSync(path.join(distPath, 'apple-touch-icon.png'), 'fake-apple-icon');
    fs.writeFileSync(path.join(distPath, 'pwa-192x192.png'), 'fake-pwa-192');
    fs.writeFileSync(path.join(distPath, 'pwa-512x512.png'), 'fake-pwa-512');
    // Workbox runtime
    fs.writeFileSync(path.join(distPath, 'workbox-12345678.js'), 'define([]);');
    // Hashed assets
    fs.writeFileSync(path.join(distPath, 'assets', 'index-abc12345.js'), 'console.log("app");');
    fs.writeFileSync(path.join(distPath, 'assets', 'index-def67890.css'), 'body { margin: 0; }');
  }

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'solux-deploy-test-'));
    fakeDist = path.join(tmpBase, 'dist');
    fakeTarget = path.join(tmpBase, 'target');
    fs.mkdirSync(fakeDist, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpBase)) {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  describe('validateDist', () => {
    it('succeeds when all required files and bundles exist', () => {
      createCompleteFakeDist(fakeDist);
      expect(() => validateDist(fakeDist)).not.toThrow();
    });

    it('throws when dist directory does not exist', () => {
      const nonExistent = path.join(tmpBase, 'does-not-exist');
      expect(() => validateDist(nonExistent)).toThrow(/Build directory ".*" does not exist/);
    });

    it('throws when dist path is not a directory', () => {
      const filePath = path.join(tmpBase, 'regular-file.txt');
      fs.writeFileSync(filePath, 'hello');
      expect(() => validateDist(filePath)).toThrow(/is not a directory/);
    });

    it('throws when any required PWA file is missing', () => {
      createCompleteFakeDist(fakeDist);
      fs.unlinkSync(path.join(fakeDist, 'manifest.webmanifest'));
      expect(() => validateDist(fakeDist)).toThrow(
        /Missing required PWA file: "manifest.webmanifest"/,
      );
    });

    it('throws when index.html is missing', () => {
      createCompleteFakeDist(fakeDist);
      fs.unlinkSync(path.join(fakeDist, 'index.html'));
      expect(() => validateDist(fakeDist)).toThrow(/Missing required PWA file: "index.html"/);
    });

    it('throws when assets directory is missing', () => {
      createCompleteFakeDist(fakeDist);
      fs.rmSync(path.join(fakeDist, 'assets'), { recursive: true, force: true });
      expect(() => validateDist(fakeDist)).toThrow(/Missing required "assets" directory/);
    });

    it('throws when assets directory lacks .js bundle', () => {
      createCompleteFakeDist(fakeDist);
      fs.unlinkSync(path.join(fakeDist, 'assets', 'index-abc12345.js'));
      expect(() => validateDist(fakeDist)).toThrow(
        /build must contain at least one \.js and one \.css bundle/,
      );
    });

    it('throws when assets directory lacks .css bundle', () => {
      createCompleteFakeDist(fakeDist);
      fs.unlinkSync(path.join(fakeDist, 'assets', 'index-def67890.css'));
      expect(() => validateDist(fakeDist)).toThrow(
        /build must contain at least one \.js and one \.css bundle/,
      );
    });
  });

  describe('checkSymlinks', () => {
    it('succeeds when no symlinks are present', () => {
      createCompleteFakeDist(fakeDist);
      expect(() => checkSymlinks(fakeDist, fakeDist)).not.toThrow();
    });

    it('rejects absolute symlinks', () => {
      createCompleteFakeDist(fakeDist);
      const secretFile = path.join(tmpBase, 'secret.txt');
      fs.writeFileSync(secretFile, 'secret');
      fs.symlinkSync(secretFile, path.join(fakeDist, 'leak.txt'));

      expect(() => checkSymlinks(fakeDist, fakeDist)).toThrow(/Unsafe absolute symlink detected/);
    });

    it('rejects symlinks escaping the dist root', () => {
      createCompleteFakeDist(fakeDist);
      const outsideFile = path.join(tmpBase, 'outside.txt');
      fs.writeFileSync(outsideFile, 'outside');
      fs.symlinkSync('../outside.txt', path.join(fakeDist, 'escape.txt'));

      expect(() => checkSymlinks(fakeDist, fakeDist)).toThrow(
        /Unsafe symlink escaping dist directory/,
      );
    });

    it('rejects broken symlinks', () => {
      createCompleteFakeDist(fakeDist);
      fs.symlinkSync('non-existent-target.js', path.join(fakeDist, 'broken.js'));

      expect(() => checkSymlinks(fakeDist, fakeDist)).toThrow(/Broken symlink detected/);
    });
  });

  describe('deploy execution', () => {
    it('dry-run mode logs planned operations and does NOT touch target directory', () => {
      createCompleteFakeDist(fakeDist);
      const logs: string[] = [];

      const result = deploy({
        distDir: fakeDist,
        targetDir: fakeTarget,
        dryRun: true,
        logger: (msg: string) => logs.push(msg),
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(fs.existsSync(fakeTarget)).toBe(false);
      expect(logs.some((l) => l.includes('[dry-run]'))).toBe(true);
    });

    it('successfully deploys build output to target with atomic promotion', () => {
      createCompleteFakeDist(fakeDist);
      const logs: string[] = [];

      const result = deploy({
        distDir: fakeDist,
        targetDir: fakeTarget,
        logger: (msg: string) => logs.push(msg),
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(fs.existsSync(fakeTarget)).toBe(true);
      expect(fs.existsSync(path.join(fakeTarget, 'assets'))).toBe(true);

      // Verify hashed assets
      expect(fs.readFileSync(path.join(fakeTarget, 'assets', 'index-abc12345.js'), 'utf-8')).toBe(
        'console.log("app");',
      );
      expect(fs.readFileSync(path.join(fakeTarget, 'assets', 'index-def67890.css'), 'utf-8')).toBe(
        'body { margin: 0; }',
      );

      // Verify static files and Workbox chunk
      expect(fs.readFileSync(path.join(fakeTarget, 'workbox-12345678.js'), 'utf-8')).toBe(
        'define([]);',
      );
      expect(fs.readFileSync(path.join(fakeTarget, 'favicon.ico'), 'utf-8')).toBe('fake-ico');

      // Verify atomically promoted lifecycle files
      expect(fs.readFileSync(path.join(fakeTarget, 'index.html'), 'utf-8')).toBe(
        '<html><body>Solux</body></html>',
      );
      expect(fs.readFileSync(path.join(fakeTarget, 'sw.js'), 'utf-8')).toBe(
        'self.addEventListener("fetch", () => {});',
      );
      expect(fs.readFileSync(path.join(fakeTarget, 'manifest.webmanifest'), 'utf-8')).toBe(
        '{"name":"Solux"}',
      );
      expect(fs.readFileSync(path.join(fakeTarget, 'registerSW.js'), 'utf-8')).toBe(
        'console.log("sw registered");',
      );

      // Verify no temporary promotion files linger
      const targetEntries = fs.readdirSync(fakeTarget);
      const tempEntries = targetEntries.filter((f) => f.includes('.tmp-'));
      expect(tempEntries).toHaveLength(0);
    });

    it('preserves existing hashed assets from previous sessions', () => {
      // Setup target with prior deployment assets
      fs.mkdirSync(path.join(fakeTarget, 'assets'), { recursive: true });
      const oldHashedAsset = path.join(fakeTarget, 'assets', 'index-OLD_SESSION.js');
      const oldWorkbox = path.join(fakeTarget, 'workbox-OLD_SESSION.js');
      fs.writeFileSync(oldHashedAsset, 'console.log("active old session");');
      fs.writeFileSync(oldWorkbox, 'old workbox runtime');

      createCompleteFakeDist(fakeDist);

      deploy({
        distDir: fakeDist,
        targetDir: fakeTarget,
        logger: () => {},
      });

      // Old assets must still exist
      expect(fs.existsSync(oldHashedAsset)).toBe(true);
      expect(fs.readFileSync(oldHashedAsset, 'utf-8')).toBe('console.log("active old session");');
      expect(fs.existsSync(oldWorkbox)).toBe(true);
      expect(fs.readFileSync(oldWorkbox, 'utf-8')).toBe('old workbox runtime');

      // New assets must also exist
      expect(fs.existsSync(path.join(fakeTarget, 'assets', 'index-abc12345.js'))).toBe(true);
    });

    it('rejects deployment if validation fails and does not modify target', () => {
      createCompleteFakeDist(fakeDist);
      // Remove sw.js to invalidate build
      fs.unlinkSync(path.join(fakeDist, 'sw.js'));

      expect(() =>
        deploy({
          distDir: fakeDist,
          targetDir: fakeTarget,
          logger: () => {},
        }),
      ).toThrow(/Missing required PWA file: "sw.js"/);

      // Target directory should not have been created
      expect(fs.existsSync(fakeTarget)).toBe(false);
    });
  });

  describe('target directory validation and path normalization', () => {
    it('rejects deployment when targetDir is identical to distDir', () => {
      createCompleteFakeDist(fakeDist);
      expect(() =>
        deploy({
          distDir: fakeDist,
          targetDir: fakeDist,
          logger: () => {},
        }),
      ).toThrow(/resolves to the same path as build directory/);
    });

    it('rejects deployment when targetDir normalizes to distDir with trailing slash', () => {
      createCompleteFakeDist(fakeDist);
      expect(() =>
        deploy({
          distDir: fakeDist,
          targetDir: `${fakeDist}/`,
          logger: () => {},
        }),
      ).toThrow(/resolves to the same path as build directory/);
    });

    it('rejects deployment when targetDir normalizes to distDir with redundant dot segments', () => {
      createCompleteFakeDist(fakeDist);
      const dotTarget = path.join(fakeDist, 'assets', '..');
      expect(() =>
        deploy({
          distDir: fakeDist,
          targetDir: dotTarget,
          logger: () => {},
        }),
      ).toThrow(/resolves to the same path as build directory/);
    });

    it('rejects deployment when relative paths normalize to the same location', () => {
      expect(() =>
        deploy({
          distDir: 'dist',
          targetDir: './dist',
          logger: () => {},
        }),
      ).toThrow(/resolves to the same path as build directory/);
    });

    it('rejects deployment in dry-run mode when targetDir resolves to distDir', () => {
      createCompleteFakeDist(fakeDist);
      expect(() =>
        deploy({
          distDir: fakeDist,
          targetDir: fakeDist,
          dryRun: true,
          logger: () => {},
        }),
      ).toThrow(/resolves to the same path as build directory/);
    });

    it('rejects deployment when targetDir is a symlink resolving to distDir', () => {
      createCompleteFakeDist(fakeDist);
      const symlinkTarget = path.join(tmpBase, 'symlink-target');
      fs.symlinkSync(fakeDist, symlinkTarget);

      expect(() =>
        deploy({
          distDir: fakeDist,
          targetDir: symlinkTarget,
          logger: () => {},
        }),
      ).toThrow(/resolves to the same path as build directory/);
    });

    it('rejects deployment via CLI args when flags normalize to the same path as dist', () => {
      createCompleteFakeDist(fakeDist);

      // Flag --target with --dist
      expect(() =>
        deploy(parseArgs(['node', 'deploy.js', '--dist', fakeDist, '--target', fakeDist])),
      ).toThrow(/resolves to the same path as build directory/);

      // Flag -t with -d and trailing slash
      expect(() =>
        deploy(parseArgs(['node', 'deploy.js', '-d', fakeDist, '-t', `${fakeDist}/`])),
      ).toThrow(/resolves to the same path as build directory/);

      // Flag --target= with redundant dot segments
      expect(() =>
        deploy(
          parseArgs([
            'node',
            'deploy.js',
            `--dist=${fakeDist}`,
            `--target=${path.join(fakeDist, 'assets', '..')}`,
          ]),
        ),
      ).toThrow(/resolves to the same path as build directory/);

      // Positional target argument
      expect(() => deploy(parseArgs(['node', 'deploy.js', '--dist', fakeDist, fakeDist]))).toThrow(
        /resolves to the same path as build directory/,
      );

      // Relative path normalization in CLI args
      expect(() =>
        deploy(parseArgs(['node', 'deploy.js', '--dist', 'dist', '--target', './dist/'])),
      ).toThrow(/resolves to the same path as build directory/);
    });

    it('rejects deployment when targetDir is configured from environment variable matching dist', () => {
      createCompleteFakeDist(fakeDist);
      const configuredTarget = fakeDist;

      expect(() =>
        deploy({
          distDir: fakeDist,
          targetDir: configuredTarget,
          logger: () => {},
        }),
      ).toThrow(/resolves to the same path as build directory/);
    });

    it('does not modify files in distDir when deployment to same path is rejected', () => {
      createCompleteFakeDist(fakeDist);
      const indexPath = path.join(fakeDist, 'index.html');
      const originalContent = fs.readFileSync(indexPath, 'utf-8');

      expect(() =>
        deploy({
          distDir: fakeDist,
          targetDir: fakeDist,
          logger: () => {},
        }),
      ).toThrow(/resolves to the same path as build directory/);

      expect(fs.readFileSync(indexPath, 'utf-8')).toBe(originalContent);
    });
  });

  describe('parseArgs', () => {
    it('parses --target and -t flags', () => {
      expect(parseArgs(['node', 'deploy.js', '--target', '/srv/custom']).targetDir).toBe(
        '/srv/custom',
      );
      expect(parseArgs(['node', 'deploy.js', '-t', '/srv/custom2']).targetDir).toBe('/srv/custom2');
      expect(parseArgs(['node', 'deploy.js', '--target=/srv/custom3']).targetDir).toBe(
        '/srv/custom3',
      );
    });

    it('parses positional target argument', () => {
      expect(parseArgs(['node', 'deploy.js', '/srv/positional']).targetDir).toBe('/srv/positional');
    });

    it('parses --dry-run and -n flags', () => {
      expect(parseArgs(['node', 'deploy.js', '--dry-run']).dryRun).toBe(true);
      expect(parseArgs(['node', 'deploy.js', '-n']).dryRun).toBe(true);
    });

    it('parses --help and -h flags', () => {
      expect(parseArgs(['node', 'deploy.js', '--help']).help).toBe(true);
      expect(parseArgs(['node', 'deploy.js', '-h']).help).toBe(true);
    });

    it('throws on unknown options', () => {
      expect(() => parseArgs(['node', 'deploy.js', '--unknown'])).toThrow(
        /Unknown option: "--unknown"/,
      );
    });

    it('throws when --target is missing value', () => {
      expect(() => parseArgs(['node', 'deploy.js', '--target'])).toThrow(
        /Option --target requires a directory argument/,
      );
    });

    it('throws when --dist is missing value', () => {
      expect(() => parseArgs(['node', 'deploy.js', '--dist'])).toThrow(
        /Option --dist requires a directory argument/,
      );
    });
  });

  describe('REQUIRED_FILES constant', () => {
    it('contains all essential PWA shell files', () => {
      expect(REQUIRED_FILES).toContain('index.html');
      expect(REQUIRED_FILES).toContain('manifest.webmanifest');
      expect(REQUIRED_FILES).toContain('sw.js');
      expect(REQUIRED_FILES).toContain('registerSW.js');
      expect(REQUIRED_FILES).toContain('favicon.ico');
      expect(REQUIRED_FILES).toContain('favicon.svg');
      expect(REQUIRED_FILES).toContain('apple-touch-icon.png');
      expect(REQUIRED_FILES).toContain('pwa-192x192.png');
      expect(REQUIRED_FILES).toContain('pwa-512x512.png');
    });
  });
});
