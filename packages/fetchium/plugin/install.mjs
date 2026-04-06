#!/usr/bin/env node

/**
 * Sets up Fetchium agent files for Claude Code and/or Cursor by creating
 * symlinks into node_modules/fetchium/plugin/. Files stay in sync
 * automatically when the package is updated.
 *
 * Usage:
 *   npx fetchium-agents           # set up both .claude/ and .cursor/
 *   npx fetchium-agents --cursor  # Cursor only
 *   npx fetchium-agents --claude  # Claude Code only
 */

import { existsSync, mkdirSync, symlinkSync, lstatSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = __dirname;
const projectRoot = resolve(pluginRoot, '../../..');

const args = process.argv.slice(2);
const forceCursor = args.includes('--cursor');
const forceClaude = args.includes('--claude');
const installBoth = !forceCursor && !forceClaude;

function symlink(target, linkPath) {
  const linkDir = dirname(linkPath);
  mkdirSync(linkDir, { recursive: true });

  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      rmSync(linkPath, { recursive: true });
    }
  } catch {
    // doesn't exist, fine
  }

  const relTarget = relative(linkDir, target);
  symlinkSync(relTarget, linkPath);
}

const installed = [];

// --- Claude Code ---
if (forceClaude || installBoth) {
  symlink(join(pluginRoot, 'agents/fetchium.md'), join(projectRoot, '.claude/agents/fetchium.md'));
  installed.push('  .claude/agents/fetchium.md');

  symlink(join(pluginRoot, 'skills/design'), join(projectRoot, '.claude/skills/fetchium-design'));
  installed.push('  .claude/skills/fetchium-design/');

  symlink(join(pluginRoot, 'skills/teach'), join(projectRoot, '.claude/skills/fetchium-teach'));
  installed.push('  .claude/skills/fetchium-teach/');
}

// --- Cursor ---
if (forceCursor || installBoth) {
  const cursorSkillsIsSymlink =
    existsSync(join(projectRoot, '.cursor/skills')) && lstatSync(join(projectRoot, '.cursor/skills')).isSymbolicLink();

  symlink(join(pluginRoot, 'agents/fetchium.md'), join(projectRoot, '.cursor/rules/fetchium.md'));
  installed.push('  .cursor/rules/fetchium.md');

  if (cursorSkillsIsSymlink) {
    installed.push('  .cursor/skills/ is already symlinked — Claude Code skills are shared');
  } else {
    symlink(join(pluginRoot, 'skills/design'), join(projectRoot, '.cursor/skills/fetchium-design'));
    installed.push('  .cursor/skills/fetchium-design/');

    symlink(join(pluginRoot, 'skills/teach'), join(projectRoot, '.cursor/skills/fetchium-teach'));
    installed.push('  .cursor/skills/fetchium-teach/');
  }
}

if (installed.length > 0) {
  console.log('\nFetchium agent files symlinked (all point to node_modules/fetchium/plugin/):\n');
  for (const line of installed) {
    console.log(line);
  }
  console.log('\nFiles stay in sync automatically when you update the fetchium package.');
  console.log('The plugin is also available for direct use: claude --plugin-dir node_modules/fetchium/plugin\n');
} else {
  console.log('Nothing to do. Run with --cursor or --claude to target a specific tool.\n');
}
