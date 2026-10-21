#!/usr/bin/env node
// agline — zero-dependency single-line statusline HUD for Antigravity CLI (agy).
// Reads one JSON payload from stdin, prints exactly one line to stdout.
// Inspired by agy-hud (MIT) by AllenMuu — rewritten from scratch for
// Antigravity CLI 1.4.3's statusline protocol.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.2.0';

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'agline');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const BURN_PATH = path.join(CONFIG_DIR, 'burn-state.json');
const STATS_PATH = path.join(CONFIG_DIR, 'stats.json');

const STDIN_MAX_BYTES = 1024 * 1024;
const STDIN_OVERALL_MS = 2000;
const STDIN_IDLE_MS = 100;

const DEFAULTS = {
  barWidth: 10,
  quotaBarWidth: 6,
  maxWidth: null,
  contextWarning: 70,
  contextCritical: 85,
  showStreak: true,
  showEta: true,
  showQuota: true,
  showGit: true,
};

// ---------- ANSI (hand-rolled, NO_COLOR aware) ----------
const NO_COLOR = !!process.env.NO_COLOR;
const esc = (codes, text) => (NO_COLOR ? String(text) : `\x1b[${codes}m${text}\x1b[0m`);
const dim = (t) => esc(2, t);
const gray = (t) => esc(90, t);

// Strip control chars (incl. ESC), DEL/C1, and bidi/isolate overrides from
// untrusted payload strings so they can never break the one-line contract
// or inject terminal escape sequences.
function sanitize(s) {
  return String(s).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

// Drop a trailing effort qualifier ("Gemini 4 Argon (High)" -> "Gemini 4
// Argon"): it says nothing about the model and only widens the badge. Only
// known effort words are stripped; any other parenthetical is kept.
function stripEffort(name) {
  const s = String(name);
  const stripped = s.replace(/\s*\((?:high|medium|low|max|min)\)\s*$/i, '');
  return stripped.trim() ? stripped : s;
}

// Display width in terminal cells: ANSI sequences are zero-width, code points
// above U+FFFF count 2, and a base char followed by U+FE0F (emoji
// presentation) counts 2.
function vlen(s) {
  const plain = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f) w += 1; // upgrades the previous base char to width 2
    else w += cp > 0xffff ? 2 : 1;
  }
  return w;
}

function truncateAnsi(str, max) {
  if (vlen(str) <= max) return str;
  const limit = Math.max(0, max - 1);
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const end = str.indexOf('m', i);
      if (end === -1) break;
      out += str.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    let w = cp > 0xffff ? 2 : 1;
    let adv = ch.length;
    if (cp <= 0xffff && str[i + adv] === '\uFE0F') {
      w = 2; // emoji presentation sequence (base + U+FE0F)
      adv += 1;
    }
    if (visible + w > limit) break;
    out += str.slice(i, i + adv);
    visible += w;
    i += adv;
  }
  return out + '…' + (NO_COLOR ? '' : '\x1b[0m');
}

// ---------- small helpers ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch {
    /* never throw */
  }
}

function loadConfig() {
  const cfg = readJson(CONFIG_PATH, {});
  const out = { ...DEFAULTS };
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return out;
  const numeric = {
    barWidth: [1, 100],
    quotaBarWidth: [1, 100],
    contextWarning: [0, 100],
    contextCritical: [0, 100],
  };
  for (const [k, [lo, hi]] of Object.entries(numeric)) {
    const v = cfg[k];
    if (v !== undefined && typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) {
      out[k] = v;
    }
  }
  if (cfg.maxWidth !== undefined && cfg.maxWidth !== null) {
    const v = Number(cfg.maxWidth);
    if (Number.isFinite(v) && v > 0) out.maxWidth = v;
  }
  for (const k of ['showStreak', 'showEta', 'showQuota', 'showGit']) {
    if (typeof cfg[k] === 'boolean') out[k] = cfg[k];
  }
  return out;
}

function bar(pct, width) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return { filled: '▰'.repeat(filled), empty: '▱'.repeat(width - filled) };
}

const ETA_CAP_MINS = 7 * 24 * 60;

function fmtEta(mins) {
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins > ETA_CAP_MINS) return '>7d';
  if (mins < 1) return '<1m';
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d${hh}h` : `${d}d`;
}

// ---------- git (no process spawning) ----------
function resolveRef(gitDir, ref) {
  try {
    const p = path.join(gitDir, ref);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim() || null;
  } catch {
    /* ignore */
  }
  try {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      if (line.slice(sp + 1).trim() === ref) return line.slice(0, sp).trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function gitInfo(dir) {
  try {
    const dotGit = path.join(dir, '.git');
    let gitDir;
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) {
      gitDir = dotGit;
    } else {
      const content = fs.readFileSync(dotGit, 'utf8');
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    // Linked worktrees keep per-worktree files (HEAD, index) in gitDir but
    // share refs and packed-refs in the common dir named by `commondir`.
    let commonDir = gitDir;
    try {
      const cd = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
      if (cd) commonDir = path.resolve(gitDir, cd);
    } catch {
      /* not a worktree */
    }
    const headPath = path.join(gitDir, 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    let branch = null;
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) branch = refMatch[1].trim();

    // dirty ≈ the index was refreshed after the last commit. Compare against
    // the resolved branch ref file (HEAD only changes on checkout/switch);
    // packed refs leave no loose file, so fall back to HEAD there.
    let dirty = false;
    try {
      const indexMtime = fs.statSync(path.join(gitDir, 'index')).mtimeMs;
      let refMtime;
      if (branch) {
        const refPath = path.join(commonDir, 'refs', 'heads', branch);
        refMtime = fs.existsSync(refPath)
          ? fs.statSync(refPath).mtimeMs
          : fs.statSync(headPath).mtimeMs;
      } else {
        refMtime = fs.statSync(headPath).mtimeMs;
      }
      dirty = indexMtime > refMtime;
    } catch {
      dirty = false;
    }

    let diverged = false;
    if (branch) {
      const local = resolveRef(commonDir, `refs/heads/${branch}`);
      const remote = resolveRef(commonDir, `refs/remotes/origin/${branch}`);
      if (local && remote && local !== remote) diverged = true;
    }

    const label = branch || (head ? head.slice(0, 7) : null);
    if (!label) return null;
    return { branch: label, dirty, diverged };
  } catch {
    return null;
  }
}

// ---------- ETA (burn rate) ----------
const ETA_PUSH_MS = 10000; // at most one sample every 10s
const ETA_WINDOW_MS = 10 * 60 * 1000; // keep samples from the last 10 minutes
const ETA_MIN_SPAN_MS = 60000; // need ≥60s of history before estimating

// Pure core: takes the previous samples and returns the ETA plus the updated
// sample window. No I/O — the wrapper below owns persistence.
function computeEtaFromSamples(prevSamples, used, limit, now) {
  if (!(limit > 0) || !(used >= 0)) return { eta: null, samples: prevSamples };
  let samples = Array.isArray(prevSamples)
    ? prevSamples.filter(
        (s) => s && typeof s.t === 'number' && Number.isFinite(s.t) && typeof s.used === 'number'
      )
    : [];

  const last = samples[samples.length - 1];
  if (last && used < 0.7 * last.used) samples = []; // new session / compaction

  const cur = samples[samples.length - 1];
  if (!cur || now - cur.t >= ETA_PUSH_MS) samples = samples.concat({ t: now, used });
  samples = samples.filter((s) => now - s.t <= ETA_WINDOW_MS);

  if (samples.length < 2) return { eta: null, samples };
  const first = samples[0];
  const lastS = samples[samples.length - 1];
  const dtMin = (lastS.t - first.t) / 60000;
  const dUsed = lastS.used - first.used;
  if (lastS.t - first.t < ETA_MIN_SPAN_MS || dUsed <= 0) return { eta: null, samples };
  const rate = dUsed / dtMin; // tokens per minute
  const remaining = limit - used;
  if (remaining <= 0) return { eta: null, samples };
  return { eta: fmtEta(remaining / rate), samples };
}

function computeEta(used, limit) {
  const state = readJson(BURN_PATH, {});
  const prevSamples = Array.isArray(state.samples) ? state.samples : [];
  const { eta, samples } = computeEtaFromSamples(prevSamples, used, limit, Date.now());
  if (JSON.stringify(samples) !== JSON.stringify(prevSamples)) writeJson(BURN_PATH, { samples });
  return eta;
}

// ---------- streak ----------
function localDateKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// True consecutive-day streak: walk back from today (or from yesterday when
// today is not recorded yet) while each day has an entry. Pure — `days` is a
// list of local YYYY-MM-DD keys.
function streakFromDays(days, now = new Date()) {
  const set = new Set(days);
  const cursor = new Date(now.getTime());
  if (!set.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (set.has(localDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function updateStreak() {
  const stats = readJson(STATS_PATH, {});
  let days = Array.isArray(stats.days) ? stats.days.filter((d) => typeof d === 'string') : [];
  const today = localDateKey(new Date());
  if (!days.includes(today)) {
    days = days.concat(today).slice(-400);
    writeJson(STATS_PATH, { days });
  }
  return streakFromDays(days);
}

// ---------- quota ----------
// gemini models get the gemini-* buckets, everything else the third-party ones.
function selectQuotaKeys(modelName) {
  return /gemini/i.test(modelName)
    ? ['gemini-5h', 'gemini-weekly']
    : ['3p-5h', '3p-weekly'];
}

function quotaBlock(q, label, cfg, opts) {
  if (!q || typeof q !== 'object') return null;
  if (typeof q.remaining_fraction !== 'number' || !Number.isFinite(q.remaining_fraction)) {
    return null;
  }
  const frac = Math.max(0, Math.min(1, q.remaining_fraction));
  const now = Date.now();
  let resetMs = null;
  if (typeof q.reset_time === 'number' && Number.isFinite(q.reset_time)) {
    resetMs = q.reset_time - now; // epoch ms
  } else if (typeof q.reset_time === 'string' && q.reset_time) {
    const t = Date.parse(q.reset_time);
    if (!Number.isNaN(t)) resetMs = t - now;
  }
  if (resetMs === null && typeof q.reset_in_seconds === 'number' && Number.isFinite(q.reset_in_seconds)) {
    resetMs = q.reset_in_seconds * 1000;
  }
  let countdown = null;
  if (resetMs !== null && resetMs > 0) countdown = fmtCountdown(resetMs);
  // A reset_time in the past means the bucket has not refreshed yet: show the
  // real remaining_fraction and no countdown (do not fake 100%).
  const pct = Math.round(frac * 100);
  const code = pct > 40 ? 32 : pct > 20 ? 33 : 31;
  const b = bar(pct, cfg.quotaBarWidth);
  let s = `${dim(label)} ${esc(code, b.filled)}${dim(b.empty)} ${esc(`1;${code}`, `${String(pct).padStart(3)}%`)}`;
  if (countdown && !opts.dropCountdowns) s += ` ${dim('·')} ${dim(countdown)}`;
  return s;
}

// ---------- line assembly ----------
// buildLine is a pure layout function: everything with side effects or I/O
// (git, ETA sampling, streak bookkeeping) is computed once in render() and
// passed in via `fx`.
function buildLine(p, cfg, opts, fx) {
  const segs = [];
  const active = typeof p.agent_state === 'string' && p.agent_state !== '' && p.agent_state !== 'idle';
  if (active) {
    const frames = ['◐', '◓', '◑', '◒'];
    segs.push(esc(93, frames[Math.floor(Date.now() / 150) % 4]));
  }

  segs.push(esc('1;96', `[${fx.modelName}]`));

  let wsSeg = esc('1;97', fx.wsBase);
  if (fx.gi) {
    const branch = sanitize(fx.gi.branch);
    wsSeg += ` ${esc(35, `git:(${branch}${fx.gi.dirty ? esc(93, '*') : ''})`)}`;
    if (fx.gi.diverged) wsSeg += ` ${esc(35, '[⇅]')}`;
  }
  segs.push(wsSeg);

  const ctxCode = fx.pct >= cfg.contextCritical ? 31 : fx.pct >= cfg.contextWarning ? 33 : 32;
  const cb = bar(fx.pct, cfg.barWidth);
  segs.push(
    `${dim('Context')} ${esc(ctxCode, cb.filled)}${dim(cb.empty)} ${esc(`1;${ctxCode}`, `${String(fx.pctLabel).padStart(3)}%`)}`
  );

  if (cfg.showEta && !opts.dropEta && fx.eta) segs.push(dim(`ETA ${fx.eta}`));

  if (fx.pct >= cfg.contextCritical) segs.push(esc(93, '⚠️ /compact'));

  if (cfg.showQuota && p.quota && typeof p.quota === 'object') {
    const keys = selectQuotaKeys(fx.modelName);
    const blocks = [];
    const b5 = quotaBlock(p.quota[keys[0]], '5h', cfg, opts);
    if (b5) blocks.push(b5);
    if (!opts.dropWeekly) {
      const bW = quotaBlock(p.quota[keys[1]], 'Wk', cfg, opts);
      if (bW) blocks.push(bW);
    }
    if (blocks.length) segs.push(blocks.join(` ${dim('·')} `));
  }

  if (cfg.showStreak && !opts.dropStreak && fx.streakDays > 1) {
    segs.push(dim(`★ ${fx.streakDays}d`));
    if ([7, 30, 100, 365].includes(fx.streakDays)) {
      segs.push(esc('1;95', `🏆 ${fx.streakDays} days with agline!`));
    }
  }

  const sep = ` ${gray('│')} `;
  return segs.filter(Boolean).join(sep);
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function render(p) {
  const cfg = loadConfig();

  const modelName = stripEffort(sanitize(p.model?.display_name || p.model?.id || 'Gemini'));
  const wsRaw = p.workspace?.current_dir || p.cwd || process.cwd();
  const ws = typeof wsRaw === 'string' && wsRaw ? wsRaw : process.cwd();
  const wsBase = sanitize(path.basename(ws) || ws);

  const cw = p.context_window && typeof p.context_window === 'object' ? p.context_window : {};
  const pct = numOrNull(cw.used_percentage) ?? 0;
  const pctLabel = Math.max(0, Math.min(999, Math.round(pct)));

  const limit = numOrNull(cw.context_window_size) ?? 0;
  let used = numOrNull(cw.estimated_tokens_used);
  if (used === null) used = numOrNull(cw.current_usage);
  if (used === null && cw.current_usage && typeof cw.current_usage === 'object') {
    let sum = 0;
    let found = false;
    for (const k of ['input', 'output', 'input_tokens', 'output_tokens']) {
      const v = numOrNull(cw.current_usage[k]);
      if (v !== null) {
        sum += v;
        found = true;
      }
    }
    if (found) used = sum;
  }
  if (used === null) used = (pct / 100) * limit;

  const fx = {
    modelName,
    wsBase,
    gi: cfg.showGit ? gitInfo(ws) : null,
    pct,
    pctLabel,
    eta: cfg.showEta ? computeEta(used, limit) : null,
    streakDays: cfg.showStreak ? updateStreak() : 0,
  };

  const tw = Number(cfg.maxWidth ?? p.terminal_width);
  const effW = Math.max(40, (Number.isFinite(tw) && tw > 0 ? tw : 80) - 2);
  const attempts = [
    {},
    { dropStreak: true },
    { dropStreak: true, dropEta: true },
    { dropStreak: true, dropEta: true, dropWeekly: true },
    { dropStreak: true, dropEta: true, dropWeekly: true, dropCountdowns: true },
  ];
  let line = '';
  for (const opts of attempts) {
    line = buildLine(p, cfg, opts, fx);
    if (vlen(line) <= effW) return line;
  }
  return truncateAnsi(line, effW);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let idleTimer = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(overallTimer);
      resolve(data);
    };
    // Overall deadline armed before any listener: an open-but-silent pipe can
    // never hang the process (the statusline must always print something).
    const overallTimer = setTimeout(done, STDIN_OVERALL_MS);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
        if (data.length > STDIN_MAX_BYTES) {
          done();
          return;
        }
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(done, STDIN_IDLE_MS);
      });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      if (process.stdin.isTTY) done();
    } catch {
      done();
    }
  });
}

async function main() {
  const raw = await readStdin();
  try {
    process.stdin.destroy();
  } catch {
    /* ignore */
  }
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  try {
    process.stdout.write(`${render(payload)}\n`);
  } catch {
    let model = 'Gemini';
    let base = '?';
    try {
      model = stripEffort(sanitize(payload.model?.display_name || payload.model?.id || 'Gemini'));
    } catch {
      /* ignore */
    }
    try {
      base = sanitize(path.basename(payload.cwd || process.cwd()));
    } catch {
      /* ignore */
    }
    process.stdout.write(`[${model}] │ ${base}\n`);
  }
  // Never process.exit() here: it can truncate a buffered stdout pipe.
  // stdin is destroyed and all timers are cleared, so the process exits
  // naturally after stdout has been flushed.
  process.exitCode = 0;
}

// ---------- install / uninstall ----------
// npx is only the delivery mechanism: `install` copies this file to a stable
// location and points settings.json at it, so every statusline render runs
// plain `node` on a local file instead of paying npm spawn overhead.
const SHARE_DIR = path.join(HOME, '.local', 'share', 'agline');
const SHARE_PATH = path.join(SHARE_DIR, 'agline.mjs');
const SETTINGS_PATH = path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json');

function fail(msg) {
  console.error(`agline: ${msg}`);
  process.exit(1);
}

function selfPath() {
  return fs.realpathSync(fileURLToPath(import.meta.url));
}

function readSettings(strict) {
  if (!fs.existsSync(SETTINGS_PATH)) return { settings: {}, existed: false };
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  const settings = JSON.parse(raw);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    const kind = Array.isArray(settings) ? 'array' : settings === null ? 'null' : typeof settings;
    if (strict) fail(`${SETTINGS_PATH} is not a JSON object (got ${kind}); refusing to overwrite`);
    return { settings: null, existed: true };
  }
  return { settings, existed: true };
}

function cmdInstall() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
    console.log(`created ${CONFIG_PATH} (built-in defaults)`);
  } else {
    console.log(`config already exists: ${CONFIG_PATH} (untouched)`);
  }

  fs.mkdirSync(SHARE_DIR, { recursive: true });
  const src = selfPath();
  const alreadyThere = fs.existsSync(SHARE_PATH) && fs.realpathSync(SHARE_PATH) === src;
  if (alreadyThere) {
    console.log(`already installed: ${SHARE_PATH} (self-copy skipped)`);
  } else {
    fs.copyFileSync(src, SHARE_PATH);
    try {
      fs.chmodSync(SHARE_PATH, 0o755);
    } catch {
      /* best effort */
    }
    console.log(`copied ${src} -> ${SHARE_PATH}`);
  }

  const { settings, existed } = readSettings(true);
  if (!existed) fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });

  if (existed) {
    const bak = `${SETTINGS_PATH}.bak`;
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(SETTINGS_PATH, bak);
      console.log(`backup written: ${bak}`);
    } else {
      console.log(`backup already exists: ${bak} (oldest kept)`);
    }
  }

  const prev = settings.statusLine;
  settings.statusLine = { type: 'command', command: `node ${SHARE_PATH}`, enabled: true };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  if (!existed) {
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
  console.log('');
  console.log(`Or simply run: agline uninstall`);
}

function cmdUninstall() {
  const { settings, existed } = readSettings(false);
  if (settings === null) {
    fail(`${SETTINGS_PATH} is not a JSON object; refusing to touch it`);
  }
  if (existed && settings.statusLine != null) {
    const cmd = settings.statusLine?.command;
    if (typeof cmd !== 'string' || !cmd.includes('agline')) {
      console.error(`agline: statusLine points elsewhere; refusing to modify settings.`);
      console.error(`  current statusLine = ${JSON.stringify(settings.statusLine)}`);
      process.exit(1);
    }
    const bak = `${SETTINGS_PATH}.bak`;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, SETTINGS_PATH);
      console.log(`restored ${SETTINGS_PATH} from ${bak}`);
    } else {
      delete settings.statusLine;
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
      console.log(`removed statusLine key from ${SETTINGS_PATH} (no backup to restore)`);
    }
  } else {
    console.log(`no agline statusLine found in ${SETTINGS_PATH} (nothing to patch)`);
  }
  fs.rmSync(SHARE_DIR, { recursive: true, force: true });
  console.log(`removed ${SHARE_DIR}`);
  console.log(`config kept: ${CONFIG_DIR} (delete manually if unwanted)`);
}

function validateConfig(cfg) {
  // Returns the list of invalid keys; mirrors the rules in loadConfig().
  const invalid = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['<root is not a JSON object>'];
  }
  const numeric = {
    barWidth: [1, 100],
    quotaBarWidth: [1, 100],
    contextWarning: [0, 100],
    contextCritical: [0, 100],
  };
  for (const [k, [lo, hi]] of Object.entries(numeric)) {
    const v = cfg[k];
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi)) {
      invalid.push(`${k} (want number ${lo}..${hi})`);
    }
  }
  if (cfg.maxWidth !== undefined && cfg.maxWidth !== null) {
    const v = Number(cfg.maxWidth);
    if (!(Number.isFinite(v) && v > 0)) invalid.push('maxWidth (want positive number or null)');
  }
  for (const k of ['showStreak', 'showEta', 'showQuota', 'showGit']) {
    if (cfg[k] !== undefined && typeof cfg[k] !== 'boolean') invalid.push(`${k} (want boolean)`);
  }
  const known = new Set([...Object.keys(DEFAULTS)]);
  for (const k of Object.keys(cfg)) {
    if (!known.has(k)) invalid.push(`${k} (unknown key)`);
  }
  return invalid;
}

function cmdDoctor() {
  let failures = 0;
  const ok = (msg) => console.log(`✓ ${msg}`);
  const bad = (msg) => {
    failures += 1;
    console.log(`✗ ${msg}`);
  };
  const warn = (msg) => console.log(`! ${msg}`);

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok(`node ${process.versions.node} (>= 18)`);
  else bad(`node ${process.versions.node} is too old — agline needs node >= 18`);

  // statusLine wiring in the Antigravity CLI settings
  if (!fs.existsSync(SETTINGS_PATH)) {
    bad(`settings not found: ${SETTINGS_PATH} — run: agline install`);
  } else {
    let settings = null;
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch {
      bad(`${SETTINGS_PATH} is not valid JSON`);
    }
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      const sl = settings.statusLine;
      if (!sl || typeof sl.command !== 'string' || !sl.command.includes('agline')) {
        bad(`statusLine in ${SETTINGS_PATH} does not point at agline — run: agline install`);
      } else {
        const target = sl.command.trim().split(/\s+/).pop();
        if (!fs.existsSync(target)) {
          bad(`statusLine target does not exist: ${target}`);
        } else if (sl.enabled === true) {
          ok(`statusLine -> ${target} (enabled)`);
        } else {
          bad(`statusLine -> ${target} but enabled is not true`);
        }
      }
    }
  }

  // installed copy vs this binary
  if (!fs.existsSync(SHARE_PATH)) {
    bad(`installed copy missing: ${SHARE_PATH} — run: agline install`);
  } else {
    const m = fs.readFileSync(SHARE_PATH, 'utf8').match(/const VERSION = '([^']+)'/);
    const installed = m ? m[1] : null;
    if (installed === VERSION) {
      ok(`installed copy ${SHARE_PATH} is v${installed} (up to date)`);
    } else {
      warn(
        `installed copy is v${installed ?? '?'} but this binary is v${VERSION} — upgrade via reinstall: agline install`
      );
    }
  }

  // runtime config
  if (!fs.existsSync(CONFIG_PATH)) {
    ok(`config ${CONFIG_PATH} absent — built-in defaults in use`);
  } else {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const invalid = validateConfig(cfg);
      if (invalid.length) bad(`config ${CONFIG_PATH} has invalid entries: ${invalid.join('; ')}`);
      else ok(`config ${CONFIG_PATH} parses and all keys are valid`);
    } catch {
      bad(`config ${CONFIG_PATH} is not valid JSON`);
    }
  }

  // state dir writable (burn-state.json / stats.json live here)
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const probe = path.join(CONFIG_DIR, '.doctor-write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    ok(`state dir writable: ${CONFIG_DIR}`);
  } catch {
    bad(`state dir not writable: ${CONFIG_DIR}`);
  }

  console.log('');
  console.log('note: agline expects the Antigravity CLI >= 1.4.x statusline payload protocol.');
  process.exitCode = failures ? 1 : 0;
}

function printUsage() {
  console.log(`agline ${VERSION} — single-line statusline HUD for Antigravity CLI

Usage:
  agline              render one statusline frame (reads JSON payload from stdin)
  agline install      copy agline to ~/.local/share/agline and enable it in
                      ~/.gemini/antigravity-cli/settings.json
  agline uninstall    restore/remove the statusLine setting and delete
                      ~/.local/share/agline
  agline doctor       check node version, statusLine wiring, installed copy,
                      config and state dir (exit 1 when something is broken)
  agline --version    print version
  agline --help       show this help

Install via npx:  npx @sqwlly/agline install
(or from GitHub:  npx github:sqwlly/agline install)`);
}

// ---------- exports (test suite imports these) + CLI entry guard ----------
export {
  VERSION,
  DEFAULTS,
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
  selectQuotaKeys,
  quotaBlock,
  loadConfig,
  validateConfig,
  buildLine,
  render,
};

// Run the CLI only when executed directly (node agline.mjs …), not when
// imported as a module. Both sides go through realpath so symlinked paths
// (npx bin shims, /root/code -> /data/code) compare equal.
function isMainModule() {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs.realpathSync(path.resolve(argv1)) === selfPath();
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const cmd = process.argv[2];
  if (cmd === undefined) {
    main().catch(() => {
      try {
        process.stdout.write('[Gemini] │ ?\n');
      } catch {
        /* ignore */
      }
      process.exitCode = 0;
    });
  } else if (cmd === 'install') {
    try {
      cmdInstall();
    } catch (err) {
      fail(err?.message || String(err));
    }
  } else if (cmd === 'uninstall') {
    try {
      cmdUninstall();
    } catch (err) {
      fail(err?.message || String(err));
    }
  } else if (cmd === 'doctor') {
    try {
      cmdDoctor();
    } catch (err) {
      fail(err?.message || String(err));
    }
  } else if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(VERSION);
  } else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printUsage();
  } else {
    console.error(`agline: unknown command '${cmd}'`);
    printUsage();
    process.exit(2);
  }
}
