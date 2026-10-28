/**
 * Native helper binary inputs, shared by PR preview gating and preview caching.
 *
 * - `changed`: whether the native sources differ from the last varlock release
 *   tag (`varlock@<packages/varlock/package.json version>`). When they don't, the
 *   published @varlock/native-helper-* packages already contain exactly these
 *   binaries, so previews depend on those instead of building their own. The
 *   build workflows are not part of this check: CI plumbing changes (action pins
 *   and the like) would otherwise force preview builds until the next release.
 * - `touched`: whether this branch changes the sources or the build workflows
 *   relative to its merge base with origin/main. CI then test-builds that side
 *   even if the preview uses the published helpers, so a broken build is caught
 *   in its own PR instead of at release time.
 * - `key`: content hash of the sources and build workflows (git blob ids, so
 *   identical on every OS), used as the cache key for unsigned preview builds.
 *
 * Releases never use any of this: they always build natives from source.
 *
 * Usage:
 *   bun run scripts/native-sources.ts
 *
 * Outputs (via GITHUB_OUTPUT if available), for each of `macos` and `rust`:
 *   <side>-changed=true|false  <side>-touched=true|false
 *   <side>-key=native-preview-<side>-v1-<sha256>
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MONOREPO_ROOT = path.resolve(import.meta.dir, '..');

// Everything that can change a helper binary or its npm package. Bump the `v1`
// in the key prefix to invalidate preview caches when something outside these
// paths changes the output (runner image, Xcode, Rust toolchain).
const SHARED_INPUTS = [
  'packages/native-helpers/platforms.ts',
  'packages/native-helpers/prepack.ts',
  'packages/native-helpers/postpack.ts',
];
const EXCLUDES = [':(exclude,glob)**/*.md'];

export const NATIVE_SOURCES = {
  macos: [
    'packages/encryption-binary-swift',
    'packages/native-helpers/darwin',
    ...SHARED_INPUTS,
  ],
  rust: [
    'packages/encryption-binary-rust',
    'packages/native-helpers/linux-x64',
    'packages/native-helpers/linux-arm64',
    'packages/native-helpers/win32-x64',
    ...SHARED_INPUTS,
  ],
} as const;

export type NativeSide = keyof typeof NATIVE_SOURCES;

const BUILD_WORKFLOWS: Record<NativeSide, Array<string>> = {
  macos: ['.github/workflows/build-native-macos.yaml'],
  rust: ['.github/workflows/build-native-rust.yaml'],
};

function buildInputs(side: NativeSide) {
  return [...NATIVE_SOURCES[side], ...BUILD_WORKFLOWS[side]];
}

/** npm package names of the helpers each side produces */
export const NATIVE_HELPER_PACKAGES: Record<NativeSide, Array<string>> = {
  macos: ['@varlock/native-helper-darwin'],
  rust: [
    '@varlock/native-helper-linux-x64',
    '@varlock/native-helper-linux-arm64',
    '@varlock/native-helper-win32-x64',
  ],
};

function git(args: Array<string>) {
  return execFileSync('git', args, { cwd: MONOREPO_ROOT, encoding: 'utf-8' });
}

export function lastReleaseTag() {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(MONOREPO_ROOT, 'packages/varlock/package.json'), 'utf-8'));
  return `varlock@${pkgJson.version}`;
}

export function nativeSourceKey(side: NativeSide) {
  const files = git(['ls-files', '-s', '--', ...buildInputs(side), ...EXCLUDES]);
  if (!files.trim()) throw new Error(`no tracked native ${side} inputs found`);
  const hash = crypto.createHash('sha256').update(files).digest('hex');
  return `native-preview-${side}-v1-${hash}`;
}

function refExists(ref: string) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: MONOREPO_ROOT }).status === 0;
}

function differs(fromRef: string, paths: Array<string>) {
  const diff = spawnSync('git', ['diff', '--quiet', fromRef, 'HEAD', '--', ...paths, ...EXCLUDES], { cwd: MONOREPO_ROOT });
  if (diff.status !== 0 && diff.status !== 1) throw new Error(`git diff failed: ${diff.stderr}`);
  return diff.status === 1;
}

/** True when the sources differ from the last release tag, or the tag is not available */
export function nativeSourcesChanged(side: NativeSide) {
  const tagRef = `refs/tags/${lastReleaseTag()}`;
  if (!refExists(tagRef)) {
    console.log(`release tag ${lastReleaseTag()} not found, treating native ${side} sources as changed`);
    return true;
  }
  return differs(tagRef, [...NATIVE_SOURCES[side]]);
}

/** True when this branch changes the sources or build workflows vs its merge base with origin/main */
export function nativeBuildTouched(side: NativeSide) {
  if (!refExists('refs/remotes/origin/main')) return false;
  const mergeBase = git(['merge-base', 'refs/remotes/origin/main', 'HEAD']).trim();
  return differs(mergeBase, buildInputs(side));
}

if (import.meta.main) {
  const lines: Array<string> = [];
  for (const side of Object.keys(NATIVE_SOURCES) as Array<NativeSide>) {
    const changed = nativeSourcesChanged(side);
    const touched = nativeBuildTouched(side);
    const key = nativeSourceKey(side);
    console.log(`native ${side}: changed since ${lastReleaseTag()}=${changed} touched by branch=${touched} key=${key}`);
    lines.push(`${side}-changed=${changed}`, `${side}-touched=${touched}`, `${side}-key=${key}`);
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}
