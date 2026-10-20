#!/usr/bin/env node
// agline installer: bootstrap ~/.config/agline/config.json and point
// ~/.gemini/antigravity-cli/settings.json's statusLine at agline.mjs.
// Preserves every other settings key (JSON round-trip, indent 2).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = '/root/code/agline';
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'agline');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const EXAMPLE_PATH = path.join(HERE, 'config.example.json');
const SETTINGS_PATH = path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json');
const AGLINE_CMD = `node ${path.join(HERE, 'agline.mjs')}`;

function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
    console.log(`created ${CONFIG_PATH} (from config.example.json)`);
  } else {
    console.log(`config already exists: ${CONFIG_PATH} (untouched)`);
  }

  let settings = {};
  let raw = '';
  if (fs.existsSync(SETTINGS_PATH)) {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    settings = JSON.parse(raw);
  } else {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  }

  const prev = settings.statusLine;
  settings.statusLine = { type: 'command', command: AGLINE_CMD, enabled: true };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

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
  console.error(`install failed: ${err?.message || err}`);
  process.exit(1);
}
