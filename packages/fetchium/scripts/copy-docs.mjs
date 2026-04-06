#!/usr/bin/env node

/**
 * Copies documentation page.md files from the docs site into plugin/docs/
 * with friendly directory-based filenames that mirror the docs site structure.
 *
 * Run from packages/fetchium: node scripts/copy-docs.mjs
 */

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '../..');
const docsAppDir = join(repoRoot, 'docs/src/app');
const pluginDocsDir = join(packageRoot, 'plugin/docs');

const docPages = [
  { src: 'quickstart/page.md', dest: 'quickstart.md' },
  { src: 'setup/project-setup/page.md', dest: 'setup/project-setup.md' },
  { src: 'core/queries/page.md', dest: 'core/queries.md' },
  { src: 'core/types/page.md', dest: 'core/types.md' },
  { src: 'core/entities/page.md', dest: 'core/entities.md' },
  { src: 'core/streaming/page.md', dest: 'core/streaming.md' },
  { src: 'data/mutations/page.md', dest: 'data/mutations.md' },
  { src: 'data/live-data/page.md', dest: 'data/live-data.md' },
  { src: 'data/caching/page.md', dest: 'data/caching.md' },
  { src: 'guides/auth/page.md', dest: 'guides/auth.md' },
  { src: 'guides/error-handling/page.md', dest: 'guides/error-handling.md' },
  { src: 'guides/offline/page.md', dest: 'guides/offline.md' },
  { src: 'guides/testing/page.md', dest: 'guides/testing.md' },
  { src: 'reference/rest-queries/page.md', dest: 'reference/rest-queries.md' },
  { src: 'reference/pagination/page.md', dest: 'reference/pagination.md' },
  {
    src: 'reference/why-signalium/page.md',
    dest: 'reference/why-signalium.md',
  },
  { src: 'api/fetchium/page.md', dest: 'api/fetchium.md' },
  { src: 'api/fetchium-react/page.md', dest: 'api/fetchium-react.md' },
  { src: 'api/stores-sync/page.md', dest: 'api/stores-sync.md' },
  { src: 'api/stores-async/page.md', dest: 'api/stores-async.md' },
];

rmSync(pluginDocsDir, { recursive: true, force: true });

let copied = 0;

for (const { src, dest } of docPages) {
  const srcPath = join(docsAppDir, src);
  const destPath = join(pluginDocsDir, dest);

  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
  copied++;
}

console.log(`Copied ${copied} doc files to plugin/docs/`);
