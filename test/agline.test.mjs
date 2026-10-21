// agline test suite — zero dependencies, node:test only. Runs fully offline:
// HOME is redirected to a temp dir BEFORE importing the module, so all state
// files (config, burn-rate samples, streak stats) land in the temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agline-test-'));
process.env.HOME = tmpHome;
delete process.env.NO_COLOR;

const {
  sanitize,
  stripEffort,
  vlen,
  truncateAnsi,
  bar,
  fmtEta,
  fmtCountdown,
  computeEtaFromSamples,
  localDateKey,
  streakFromDays,
  selectQuotaFamily,
  quotaFamilies,
  quotaBlock,
  render,
  DEFAULTS,
  WIN_CMD_MARKER,
  winCmdShimContent,
  chooseWinShimDir,
  statusLineCommand,
  statusLineTarget,
} = await import('../agline.mjs');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---------- sanitize / stripEffort ----------
test('sanitize strips ESC, newlines and bidi/isolate controls', () => {
  assert.equal(sanitize('a\x1bb'), 'ab'); // ESC itself is stripped
  assert.equal(sanitize('a\x1b[31mb'), 'a[31mb'); // sequence is defused, ESC gone
  assert.equal(sanitize('a\nb\rc'), 'abc');
  assert.equal(sanitize('a‮b⁩c'), 'abc');
  assert.equal(sanitize('clean text'), 'clean text');
});

test('stripEffort removes known effort suffixes only', () => {
  assert.equal(stripEffort('Gemini 4 Argon (High)'), 'Gemini 4 Argon');
  assert.equal(stripEffort('Gemini 4 Argon (medium)'), 'Gemini 4 Argon');
  assert.equal(stripEffort('Claude Opus (MAX)'), 'Claude Opus');
  assert.equal(stripEffort('Claude Opus (Min)'), 'Claude Opus');
  assert.equal(stripEffort('Model (Beta)'), 'Model (Beta)'); // not an effort word
  assert.equal(stripEffort('Model (High) (Beta)'), 'Model (High) (Beta)'); // not trailing
  assert.equal(stripEffort('(High)'), '(High)'); // never strip to empty
});

// ---------- width / truncation ----------
test('vlen ignores SGR and counts astral/emoji as 2', () => {
  assert.equal(vlen('\x1b[1;31mabc\x1b[0m'), 3);
  assert.equal(vlen('🙂'), 2); // astral plane
  assert.equal(vlen('⚠️'), 2); // base + U+FE0F emoji presentation
  assert.equal(vlen('plain'), 5);
  assert.equal(vlen(''), 0);
});

test('truncateAnsi never splits escapes, appends … only on real truncation', () => {
  const s = '\x1b[1;96m[Gemini 4 Argon]\x1b[0m │ \x1b[90mrest of the line\x1b[0m';
  const t = truncateAnsi(s, 12);
  assert.ok(t.endsWith('…\x1b[0m'));
  for (const m of t.matchAll(/\x1b\[/g)) {
    assert.match(t.slice(m.index), /^\x1b\[[0-9;]*m/, 'escape sequence left incomplete');
  }
  assert.ok(vlen(t) <= 12);
  assert.equal(truncateAnsi('fits fine', 12), 'fits fine'); // no ellipsis when it fits
  assert.equal(truncateAnsi('12345', 5), '12345'); // exact fit: no ellipsis
  assert.equal(stripAnsi(truncateAnsi('123456', 5)), '1234…');
});

// ---------- bars ----------
test('bar fill counts at 0/42/100%', () => {
  assert.deepEqual(bar(0, 10), { filled: '', empty: '▱'.repeat(10) });
  assert.equal(bar(42, 10).filled, '▰'.repeat(4));
  assert.equal(bar(42, 10).empty, '▱'.repeat(6));
  assert.equal(bar(100, 10).filled, '▰'.repeat(10));
  assert.equal(bar(100, 10).empty, '');
  assert.equal(bar(137, 10).filled, '▰'.repeat(10)); // clamps
});

// ---------- quota ----------
test('quotaFamilies parses every <family>-5h/-weekly bucket', () => {
  const fams = quotaFamilies({
    'gemini-5h': { remaining_fraction: 0.5 },
    'gemini-weekly': { remaining_fraction: 0.1 },
    '3p-5h': { remaining_fraction: 1 },
    '3p-weekly': { remaining_fraction: 0.02 },
    unrelated: { remaining_fraction: 0.9 },
  });
  assert.deepEqual([...fams.keys()].sort(), ['3p', 'gemini']);
  assert.equal(fams.get('gemini').fiveHour.remaining_fraction, 0.5);
  assert.equal(fams.get('3p').weekly.remaining_fraction, 0.02);
  assert.equal(quotaFamilies(null).size, 0);
  assert.equal(quotaFamilies({}).size, 0);
});

test('quota family selection follows the model family', () => {
  const fams = quotaFamilies({
    'gemini-5h': { remaining_fraction: 0.5 },
    '3p-5h': { remaining_fraction: 1 },
    '3p-weekly': { remaining_fraction: 0.02 },
  });
  assert.equal(selectQuotaFamily('Gemini 4 Argon', fams), 'gemini');
  assert.equal(selectQuotaFamily('gemini flash', fams), 'gemini');
  assert.equal(selectQuotaFamily('Claude Sonnet 4.5', fams), '3p');
  assert.equal(selectQuotaFamily('GPT-5', fams), '3p');
});

test('quota family falls back when the preferred family is absent or unusable', () => {
  const geminiOnly = quotaFamilies({ 'gemini-5h': { remaining_fraction: 0.5 } });
  assert.equal(selectQuotaFamily('Claude Sonnet 4.5', geminiOnly), 'gemini');
  const thirdPartyOnly = quotaFamilies({ '3p-weekly': { remaining_fraction: 0.02 } });
  assert.equal(selectQuotaFamily('Gemini 4 Argon', thirdPartyOnly), '3p');
  // preferred family present but without a usable bucket -> other family wins
  const broken = quotaFamilies({
    '3p-5h': { remaining_fraction: 'x' },
    'gemini-weekly': { remaining_fraction: 0.1 },
  });
  assert.equal(selectQuotaFamily('Claude Sonnet 4.5', broken), 'gemini');
  // unknown future families keyed by model name still resolve
  const claudeKeyed = quotaFamilies({ 'claude-5h': { remaining_fraction: 0.3 } });
  assert.equal(selectQuotaFamily('Claude Sonnet 4.5', claudeKeyed), 'claude');
  assert.equal(selectQuotaFamily('Claude Sonnet 4.5', quotaFamilies({})), null);
});

test('quota fraction clamps to [0,1] and percent is natural width', () => {
  assert.ok(stripAnsi(quotaBlock({ remaining_fraction: 1.4 }, '5h', DEFAULTS, {})).includes('100%'));
  assert.ok(stripAnsi(quotaBlock({ remaining_fraction: -0.2 }, '5h', DEFAULTS, {})).includes(' 0%'));
  assert.ok(stripAnsi(quotaBlock({ remaining_fraction: 0.09 }, 'Wk', DEFAULTS, {})).includes(' 9%'));
  assert.ok(!stripAnsi(quotaBlock({ remaining_fraction: 0.09 }, 'Wk', DEFAULTS, {})).includes('  9%'));
  assert.equal(quotaBlock({ remaining_fraction: 'x' }, '5h', DEFAULTS, {}), null);
  assert.equal(quotaBlock(null, '5h', DEFAULTS, {}), null);
});

test('quota countdown uses the compact format', () => {
  const blk = stripAnsi(quotaBlock({ remaining_fraction: 0.77, reset_in_seconds: 9960 }, '5h', DEFAULTS, {}));
  assert.ok(blk.includes('2h46m'));
  assert.ok(!blk.includes('2h 46m'));
  const noCountdown = stripAnsi(
    quotaBlock({ remaining_fraction: 0.77, reset_in_seconds: 9960 }, '5h', DEFAULTS, { dropCountdowns: true })
  );
  assert.ok(!noCountdown.includes('2h46m'));
});

// ---------- compact formats ----------
test('compact countdown/ETA formats', () => {
  assert.equal(fmtCountdown(45 * 60000), '45m');
  assert.equal(fmtCountdown(9960 * 1000), '2h46m');
  assert.equal(fmtCountdown((3 * 24 + 4) * 3600 * 1000), '3d4h');
  assert.equal(fmtCountdown(2 * 86400000), '2d');
  assert.equal(fmtCountdown(0), null);
  assert.equal(fmtEta(30.3), '30m');
  assert.equal(fmtEta(166), '2h46m');
  assert.equal(fmtEta(120), '2h');
  assert.equal(fmtEta(0.5), '<1m');
  assert.equal(fmtEta(8 * 24 * 60), '>7d');
});

// ---------- ETA from samples ----------
test('ETA: <60s span → none, increasing → value, drop>30% → reset, cap >7d', () => {
  const limit = 1000000;
  let r = computeEtaFromSamples(
    [
      { t: 0, used: 1000 },
      { t: 30000, used: 2000 },
    ],
    2000,
    limit,
    30000
  );
  assert.equal(r.eta, null); // 30s of history is not enough

  r = computeEtaFromSamples(
    [
      { t: 0, used: 1000 },
      { t: 120000, used: 22000 },
    ],
    22000,
    limit,
    120000
  );
  // rate = 21000 tok / 2 min = 10500/min; remaining 978000 → 93.1 min → 1h33m
  assert.equal(r.eta, '1h33m');

  r = computeEtaFromSamples(
    [
      { t: 0, used: 100000 },
      { t: 120000, used: 200000 },
    ],
    50000, // < 70% of last sample → new session / compaction
    limit,
    120000
  );
  assert.equal(r.eta, null);
  assert.equal(r.samples.length, 1);
  assert.equal(r.samples[0].used, 50000);

  r = computeEtaFromSamples(
    [
      { t: 0, used: 100 },
      { t: 120000, used: 200 },
    ],
    200,
    limit,
    120000
  );
  assert.equal(r.eta, '>7d'); // slow burn is capped
});

// ---------- streak ----------
test('streak counts consecutive local days', () => {
  const now = new Date(2026, 9, 21, 12, 0, 0); // local noon, avoids midnight edges
  const day = (offset) => {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - offset);
    return localDateKey(d);
  };
  assert.equal(streakFromDays([day(2), day(1), day(0)], now), 3); // today present
  assert.equal(streakFromDays([day(3), day(0)], now), 1); // gap yesterday
  assert.equal(streakFromDays([day(2), day(1)], now), 2); // today missing: start at yesterday
  assert.equal(streakFromDays([day(8), day(0)], now), 1); // gap a week ago
  assert.equal(streakFromDays([day(1), day(1), day(0)], now), 2); // duplicates harmless
  assert.equal(streakFromDays([], now), 0);
});

// ---------- full-render goldens ----------
const projDir = path.join(tmpHome, 'proj');
fs.mkdirSync(projDir, { recursive: true });

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return localDateKey(d);
}

function seedState() {
  const stateDir = path.join(tmpHome, '.config', 'agline');
  fs.mkdirSync(stateDir, { recursive: true });
  // 3-day streak ending today → "★ 3d"
  fs.writeFileSync(
    path.join(stateDir, 'stats.json'),
    JSON.stringify({ days: [dayKey(2), dayKey(1), dayKey(0)] })
  );
  // burn samples: 64% → 100% of `used` over ~9 min → ETA 30m for pct 45
  const now = Date.now();
  fs.writeFileSync(
    path.join(stateDir, 'burn-state.json'),
    JSON.stringify({
      samples: [
        { t: now - 540000, used: 301989 },
        { t: now - 4000, used: 471859 },
      ],
    })
  );
}

function fixedPayload(terminalWidth) {
  const now = Date.now();
  return {
    cwd: projDir,
    model: { id: 'gemini-4-argon', display_name: 'Gemini 4 Argon (High)' },
    workspace: { current_dir: projDir },
    version: '1.4.3',
    context_window: {
      context_window_size: 1048576,
      used_percentage: 45,
      estimated_tokens_used: 471859,
    },
    quota: {
      'gemini-5h': { remaining_fraction: 0.77, reset_time: new Date(now + 9960000).toISOString() },
      'gemini-weekly': { remaining_fraction: 0.09, reset_time: new Date(now + 273600000).toISOString() },
    },
    agent_state: 'idle',
    terminal_width: terminalWidth,
  };
}

test('golden render at width 150: all segments, new formats', () => {
  seedState();
  const line = stripAnsi(render(fixedPayload(150)));
  assert.ok(!line.includes('\n'), 'exactly one line');
  assert.ok(line.includes('[Gemini 4 Argon]'), 'effort suffix stripped from badge');
  assert.ok(!line.includes('(High)'));
  assert.ok(line.includes(' 45%'), 'context percent');
  assert.ok(line.includes(' 77% · 2h46m'), '5h quota, compact countdown');
  assert.ok(line.includes('Wk ▰▱▱▱▱▱ 9% · 3d4h'), 'weekly quota, compact countdown');
  assert.ok(line.includes('ETA 30m'));
  assert.ok(line.includes('★ 3d'));
  assert.ok(line.includes(' │ '));
});

test('golden render at width 100: streak and ETA dropped first', () => {
  seedState();
  const line = stripAnsi(render(fixedPayload(100)));
  assert.ok(!line.includes('\n'));
  assert.ok(vlen(render(fixedPayload(100))) <= 98);
  assert.ok(!line.includes('★'), 'streak drops first');
  assert.ok(!line.includes('ETA'), 'ETA drops second');
  assert.ok(line.includes('Wk'), 'weekly quota still present');
  assert.ok(line.includes('2h46m'));
});

test('golden render at width 70: weekly and countdowns dropped', () => {
  seedState();
  const line = stripAnsi(render(fixedPayload(70)));
  assert.ok(!line.includes('\n'));
  assert.ok(vlen(render(fixedPayload(70))) <= 68);
  assert.ok(!line.includes('Wk'), 'weekly quota dropped');
  assert.ok(!line.includes('2h46m'), 'countdowns dropped');
  assert.ok(line.includes('Context'), 'context bar always survives');
  assert.ok(line.includes(' 45%'));
});

test('natural-width percent: single space before %, no padding', () => {
  seedState();
  const mk = (pct) =>
    stripAnsi(
      render({
        ...fixedPayload(150),
        context_window: { context_window_size: 1048576, used_percentage: pct },
      })
    );
  const line9 = mk(9);
  const line100 = mk(100);
  assert.ok(line9.includes(' 9%'), 'single space before 9%');
  assert.ok(!line9.includes('  9%'), 'no padding for single-digit percent');
  assert.ok(line100.includes(' 100%'));
  assert.equal(line9.indexOf('Context'), line100.indexOf('Context'));
});

test('render with a non-Gemini model leads with the 3p quota buckets', () => {
  seedState();
  const now = Date.now();
  const line = stripAnsi(
    render({
      ...fixedPayload(200),
      model: { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
      quota: {
        'gemini-5h': { remaining_fraction: 0.77, reset_time: new Date(now + 9960000).toISOString() },
        '3p-5h': { remaining_fraction: 0.61, reset_time: new Date(now + 9960000).toISOString() },
        '3p-weekly': { remaining_fraction: 0.02, reset_time: new Date(now + 273600000).toISOString() },
      },
    })
  );
  assert.ok(line.includes('[Claude Sonnet 4.5]'));
  assert.ok(line.includes('5h ▰▰▰▰▱▱ 61%'), `3p 5h quota leads, not the gemini one:\n${line}`);
  assert.ok(line.includes('Wk ▱▱▱▱▱▱ 2%'), '3p weekly quota');
  assert.ok(line.includes('G5h ▰▰▰▰▰▱ 77%'), 'gemini quota rides along as the tagged secondary');
});

test('render falls back to whichever quota family exists', () => {
  seedState();
  const now = Date.now();
  const line = stripAnsi(
    render({
      ...fixedPayload(150),
      model: { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
      quota: {
        'gemini-5h': { remaining_fraction: 0.77, reset_time: new Date(now + 9960000).toISOString() },
      },
    })
  );
  assert.ok(line.includes('5h ▰▰▰▰▰▱ 77%'), `falls back to the gemini family:\n${line}`);
});

function fixedPayloadBoth(terminalWidth) {
  const now = Date.now();
  const p = fixedPayload(terminalWidth);
  p.quota = {
    ...p.quota,
    '3p-5h': { remaining_fraction: 1, reset_time: new Date(now + 18000000).toISOString() },
    '3p-weekly': { remaining_fraction: 0.018, reset_time: new Date(now + 47077000).toISOString() },
  };
  return p;
}

test('secondary quota family rides along in tagged compact form (no countdowns)', () => {
  seedState();
  const line = stripAnsi(render(fixedPayloadBoth(200)));
  assert.ok(line.includes('3p5h ▰▰▰▰▰▰ 100%'), `tagged 3p 5h block:\n${line}`);
  assert.ok(line.includes('3pWk ▱▱▱▱▱▱ 2%'), 'tagged 3p weekly block');
  assert.ok(line.includes('100% · 3pWk'), 'secondary blocks carry no countdowns');
  assert.ok(line.includes('5h ▰▰▰▰▰▱ 77% · 2h46m'), 'primary family keeps its countdown');
});

test('secondary quota folds before ETA and weekly as the width shrinks', () => {
  seedState();
  const at140 = stripAnsi(render(fixedPayloadBoth(140)));
  assert.ok(!at140.includes('3p5h'), 'secondary family dropped at 140');
  assert.ok(!at140.includes('★'), 'streak dropped first');
  assert.ok(at140.includes('ETA 30m'), 'ETA still present');
  assert.ok(at140.includes('Wk ▰▱▱▱▱▱ 9%'), 'primary weekly still present');
  const at100 = stripAnsi(render(fixedPayloadBoth(100)));
  assert.ok(!at100.includes('ETA'), 'ETA folds after the secondary family');
  assert.ok(at100.includes('5h ▰▰▰▰▰▱ 77%'));
});

test('showSecondaryQuota: false hides the other family even on a wide terminal', () => {
  seedState();
  fs.writeFileSync(
    path.join(tmpHome, '.config', 'agline', 'config.json'),
    JSON.stringify({ showSecondaryQuota: false })
  );
  try {
    const line = stripAnsi(render(fixedPayloadBoth(200)));
    assert.ok(!line.includes('3p5h'), `secondary hidden:\n${line}`);
    assert.ok(line.includes('5h ▰▰▰▰▰▱ 77%'), 'primary family still shown');
  } finally {
    fs.rmSync(path.join(tmpHome, '.config', 'agline', 'config.json'), { force: true });
  }
});

// ---------- install/uninstall shim (CLI end-to-end, temp HOME per case) ----------
const CLI = fileURLToPath(new URL('../agline.mjs', import.meta.url));

function cliHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agline-cli-'));
}

function runCli(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NO_COLOR: '1', ...extraEnv },
  });
}

const shimPathOf = (home) => path.join(home, '.local', 'bin', 'agline');
const sharePathOf = (home) => path.join(home, '.local', 'share', 'agline', 'agline.mjs');

test('install symlinks ~/.local/bin/agline -> the installed copy, and the shim runs', () => {
  const home = cliHome();
  const r = runCli(home, ['install']);
  assert.equal(r.status, 0, r.stderr);
  const shim = shimPathOf(home);
  assert.ok(fs.lstatSync(shim).isSymbolicLink(), 'shim is a symlink');
  assert.equal(fs.readlinkSync(shim), sharePathOf(home));
  assert.ok(r.stdout.includes(shim), 'summary lists the command row');
  const v = spawnSync(shim, ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('re-running install over a correct symlink is a no-op success', () => {
  const home = cliHome();
  assert.equal(runCli(home, ['install']).status, 0);
  const shim = shimPathOf(home);
  const before = fs.lstatSync(shim);
  const r = runCli(home, ['install']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readlinkSync(shim), sharePathOf(home));
  assert.equal(fs.lstatSync(shim).mtimeMs, before.mtimeMs, 'symlink untouched on re-run');
});

test('install never clobbers a foreign file at the shim path', () => {
  const home = cliHome();
  const shim = shimPathOf(home);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, 'foreign\n');
  const r = runCli(home, ['install']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(shim, 'utf8'), 'foreign\n', 'foreign file untouched');
  assert.ok(!fs.lstatSync(shim).isSymbolicLink());
  assert.ok(r.stdout.includes('skipped'), 'summary notes the skip');
});

test('uninstall removes the shim, but only when it is agline’s own symlink', () => {
  const home = cliHome();
  assert.equal(runCli(home, ['install']).status, 0);
  const r = runCli(home, ['uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(shimPathOf(home)), 'shim removed');
  assert.ok(r.stdout.includes('shim removed'));

  const home2 = cliHome();
  const foreign = shimPathOf(home2);
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, 'foreign\n');
  const r2 = runCli(home2, ['uninstall']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign\n', 'foreign file survives uninstall');
});

test('doctor reports the shim: healthy after install, missing before, PATH absence is a warning', () => {
  const home = cliHome();
  const before = runCli(home, ['doctor']);
  assert.equal(before.status, 1, 'no install → doctor fails');
  assert.ok(before.stdout.includes('command shim missing'));

  assert.equal(runCli(home, ['install']).status, 0);
  const after = runCli(home, ['doctor']);
  assert.equal(after.status, 0, after.stdout);
  assert.ok(after.stdout.includes(`command shim ${shimPathOf(home)}`));

  const noPath = runCli(home, ['doctor'], { PATH: '/usr/bin:/bin' });
  assert.equal(noPath.status, 0, `PATH absence warns but does not fail:\n${noPath.stdout}`);
  assert.ok(noPath.stdout.includes('! '), 'warning marker printed');
  assert.ok(noPath.stdout.includes('is not on PATH'));
});

// ---------- Windows (win32) shim logic — pure functions, testable on Linux ----------
test('winCmdShimContent: marker, CRLF, %~dp0-relative target on the same drive', () => {
  const home = 'C:\\Users\\jane';
  const shimDir = 'C:\\Users\\jane\\.local\\bin';
  const share = 'C:\\Users\\jane\\.local\\share\\agline\\agline.mjs';
  const content = winCmdShimContent(share, shimDir);
  assert.ok(content.includes(WIN_CMD_MARKER), 'ownership marker present');
  assert.ok(content.includes('\r\n'), 'CRLF line endings');
  assert.ok(
    content.includes('node "%~dp0..\\share\\agline\\agline.mjs" %*'),
    `%~dp0-relative target:\n${content}`
  );
  assert.ok(content.startsWith('@echo off'));
  assert.ok(!content.includes(home), 'no absolute home path when relative works');
});

test('winCmdShimContent: falls back to an absolute target across drives', () => {
  const content = winCmdShimContent('D:\\tools\\agline\\agline.mjs', 'C:\\Users\\jane\\bin');
  assert.ok(content.includes(WIN_CMD_MARKER));
  assert.ok(
    content.includes('node "D:\\tools\\agline\\agline.mjs" %*'),
    `absolute fallback:\n${content}`
  );
  assert.ok(!content.includes('%~dp0'), 'no %~dp0 prefix on a cross-drive path');
});

test('chooseWinShimDir: %APPDATA%\\npm wins when it exists, else ~/.local/bin', () => {
  const home = 'C:\\Users\\jane';
  const npmDir = 'C:\\Users\\jane\\AppData\\Roaming\\npm';
  const all = () => true;
  const none = () => false;

  // APPDATA set and the npm global prefix exists → use it
  assert.deepEqual(chooseWinShimDir({ APPDATA: 'C:\\Users\\jane\\AppData\\Roaming' }, home, all), {
    dir: npmDir,
    npmPrefix: true,
  });
  // APPDATA set but %APPDATA%\npm missing → ~/.local/bin
  assert.deepEqual(chooseWinShimDir({ APPDATA: 'C:\\Users\\jane\\AppData\\Roaming' }, home, none), {
    dir: 'C:\\Users\\jane\\.local\\bin',
    npmPrefix: false,
  });
  // APPDATA unset → ~/.local/bin
  assert.deepEqual(chooseWinShimDir({}, home, all), {
    dir: 'C:\\Users\\jane\\.local\\bin',
    npmPrefix: false,
  });
});

test('statusLine command with a Windows path: unquoted, valid JSON, escaped backslashes, round-trips', () => {
  // Antigravity's win32 statusline runner takes quotes literally, so the
  // command is written WITHOUT quotes (0.2.4+).
  const share = 'C:\\Users\\jane\\.local\\share\\agline\\agline.mjs';
  const settings = {
    statusLine: { type: 'command', command: `node ${share}`, enabled: true },
    otherKey: { nested: true },
  };
  const raw = JSON.stringify(settings, null, 2) + '\n';
  assert.ok(raw.includes('C:\\\\Users\\\\jane'), 'backslashes escaped in the JSON text');
  assert.ok(!raw.includes('node \\"'), 'no quotes around the path in the JSON text');
  const back = JSON.parse(raw);
  assert.equal(back.statusLine.command, `node ${share}`, 'command round-trips exactly');
  assert.ok(!back.statusLine.command.includes('"'), 'no quotes in the parsed command');
  assert.equal(back.otherKey.nested, true, 'other settings preserved');
  assert.equal(statusLineTarget(back.statusLine.command), share, 'doctor extracts the bare win32 path');
});

test('statusLineCommand emits an unquoted node command on every platform', () => {
  const cmd = statusLineCommand();
  assert.ok(cmd.startsWith('node '), 'node prefix');
  assert.ok(!cmd.includes('"'), 'no quotes — the win32 runner takes them literally');
  assert.ok(cmd.endsWith('agline.mjs'));
  assert.equal(statusLineTarget(cmd), cmd.slice('node '.length), 'doctor extracts the emitted target');
});

test('statusLineTarget: bare win32 drive-letter path and legacy quoted form', () => {
  // bare win32 path with a drive letter (0.2.4+ form)
  assert.equal(
    statusLineTarget('node C:\\Users\\jane\\.local\\share\\agline\\agline.mjs'),
    'C:\\Users\\jane\\.local\\share\\agline\\agline.mjs'
  );
  // legacy 0.2.3 quoted form still parses (incl. a space inside the quotes)
  assert.equal(
    statusLineTarget('node "C:\\Users\\jane doe\\.local\\share\\agline\\agline.mjs"'),
    'C:\\Users\\jane doe\\.local\\share\\agline\\agline.mjs'
  );
  // POSIX-style unquoted command still extracts via whitespace split
  assert.equal(
    statusLineTarget('node /home/u/.local/share/agline/agline.mjs'),
    '/home/u/.local/share/agline/agline.mjs'
  );
});

test('--record appends the raw payload to a file and still renders', () => {
  const home = cliHome();
  const log = path.join(home, 'payload.jsonl');
  const payload = JSON.stringify({ model: { display_name: 'Claude Sonnet 4.5' }, terminal_width: 120 });
  const r = spawnSync(process.execPath, [CLI, '--record', log], {
    encoding: 'utf8',
    input: payload,
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[Claude Sonnet 4.5]'), 'renders the statusline');
  assert.equal(fs.readFileSync(log, 'utf8').trim(), payload, 'raw payload captured verbatim');
});
