#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const distDir = 'dist';

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(distDir);
const totalGz = files.reduce((acc, f) => acc + gzipSync(readFileSync(f)).length, 0);

const sha    = execSync('git rev-parse --short HEAD').toString().trim();
const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();

const hostKitRaw = pkg.dependencies?.['@bilkobibitkov/host-kit'] ?? '0.0.0';
const hostKitVer = hostKitRaw.replace(/^[\^~]/, '');

const manifest = {
  schemaVersion: 1,
  slug: 'outdoor-hours',
  version: pkg.version,
  builtAt: new Date().toISOString(),
  gitSha: sha,
  gitBranch: branch,
  hostKit: { version: hostKitVer },
  golden: { path: '/projects/outdoor-hours/', expect: 'Outdoor Hours' },
  health: {},
  bundle: { sizeBytesGz: totalGz, fileCount: files.length },
};

writeFileSync(join(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`emit-manifest: outdoor-hours ${pkg.version} (${sha}, kit ${hostKitVer}, ${(totalGz / 1024).toFixed(1)} KB gz)`);
