#!/usr/bin/env node
// agline installer: bootstrap ~/.config/agline/config.json and point
// ~/.gemini/antigravity-cli/settings.json's statusLine at agline.mjs.
// Preserves every other settings key (JSON round-trip, indent 2).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the real directory of this script (symlinks like
// /root/code -> /data/code are dereferenced) so the installed command path
// is stable no matter where the installer is invoked from.
const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'agline');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const EXAMPLE_PATH = path.join(HERE, 'config.example.json');
const SETTINGS_PATH = path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json');
const AGLINE_CMD = `node ${path.join(HERE, 'agline.mjs')}`;

function fail(msg) {
  console.error(`install failed: ${msg}`);
  process.exit(1);
}

function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
    console.log(`created ${CONFIG_PATH} (from config.example.json)`);
  } else {
    console.log(`config already exists: ${CONFIG_PATH} (untouched)`);
  }

  let settings = {};
  const settingsExisted = fs.existsSync(SETTINGS_PATH);
  if (settingsExisted) {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      fail(
        `${SETTINGS_PATH} is not a JSON object (got ${
          Array.isArray(settings) ? 'array' : settings === null ? 'null' : typeof settings
        }); refusing to overwrite`
      );
    }
  } else {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  }

  if (settingsExisted) {
    const bak = `${SETTINGS_PATH}.bak`;
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(SETTINGS_PATH, bak);
      console.log(`backup written: ${bak}`);
    } else {
      console.log(`backup already exists: ${bak} (oldest kept)`);
    }
  }

  const prev = settings.statusLine;
  settings.statusLine = { type: 'command', command: AGLINE_CMD, enabled: true };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  if (!settingsExisted) {
    try {
      fs.chmodSync(SETTINGS_PATH, 0o600);
    } catch {
      /* best effort */
    }
  }

  console.log(`patched ${SETTINGS_PATH}`);
  console.log(`  statusLine = ${JSON.stringify(settings.statusLine)}`);
  console.log('');
  console.log('Rollback: restore the previous statusLine value:');
  console.log(`  previous statusLine = ${JSON.stringify(prev ?? null)}`);
  if (prev && typeof prev.command === 'string') {
    console.log('');
    console.log('  e.g. edit settings.json and set:');
    console.log(
      `  "statusLine": ${JSON.stringify({ type: prev.type ?? 'command', command: prev.command }, null, 2)}`
    );
  }
}

try {
  main();
} catch (err) {
  fail(err?.message || String(err));
}
