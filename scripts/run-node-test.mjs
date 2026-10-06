#!/usr/bin/env node
/**
 * scripts/run-node-test.mjs — bundle a test entry with esbuild, then run it.
 *
 * The host sources use extensionless relative imports (resolved by esbuild in
 * the real build), which plain `node` cannot resolve. Bundling first lets the
 * test import the REAL handler/source modules — a mock would not prove the
 * shipped code path.
 *
 * Usage: node scripts/run-node-test.mjs tests/host.volatile02.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = process.argv[2]
if (!entry) {
  console.error('usage: node scripts/run-node-test.mjs <test-entry.mjs>')
  process.exit(2)
}

// Bundle INSIDE the repo (gitignored) so external framework imports
// (@deepseek-ai/*) resolve from this package's node_modules exactly as they do
// at runtime — a bundle under the OS temp dir cannot see them.
const outDir = path.join(root, '.tmp-tests')
const outfile = path.join(outDir, path.basename(entry))

try {
  mkdirSync(outDir, { recursive: true })
  await build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    external: ['@deepseek-ai/*', 'cordis'],
    logLevel: 'warning',
  })

  const run = spawnSync(process.execPath, [outfile], { cwd: root, stdio: 'inherit' })
  process.exit(run.status ?? 1)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
