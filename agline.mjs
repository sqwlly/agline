#!/usr/bin/env node
// agline — zero-dependency single-line statusline HUD for Antigravity CLI (agy).
// Reads one JSON payload from stdin, prints exactly one line to stdout.
// Inspired by agy-hud (MIT) by AllenMuu — rewritten from scratch for
// Antigravity CLI 1.4.3's statusline protocol.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.2.8';

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'agline');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const BURN_PATH = path.join(CONFIG_DIR, 'burn-state.json');

const STDIN_MAX_BYTES = 1024 * 1024;
const STDIN_OVERALL_MS = 2000;
const STDIN_IDLE_MS = 100;

const DEFAULTS = {
  barWidth: 10,
  quotaBarWidth: 6,
  maxWidth: null,
  contextWarning: 70,
  contextCritical: 85,
  showEta: true,
  showBurnRate: true,
  showQuota: true,
  showSecondaryQuota: true,
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
  for (const k of ['showEta', 'showBurnRate', 'showQuota', 'showSecondaryQuota', 'showGit']) {
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

  if (samples.length < 2) return { eta: null, rate: null, samples };
  const first = samples[0];
  const lastS = samples[samples.length - 1];
  const dtMin = (lastS.t - first.t) / 60000;
  const dUsed = lastS.used - first.used;
  if (lastS.t - first.t < ETA_MIN_SPAN_MS || dUsed <= 0) return { eta: null, rate: null, samples };
  const rate = dUsed / dtMin; // tokens per minute
  const remaining = limit - used;
  const eta = remaining > 0 ? fmtEta(remaining / rate) : null;
  return { eta, rate, samples };
}

function computeBurn(used, limit) {
  const state = readJson(BURN_PATH, {});
  const prevSamples = Array.isArray(state.samples) ? state.samples : [];
  const { eta, rate, samples } = computeEtaFromSamples(prevSamples, used, limit, Date.now());
  if (JSON.stringify(samples) !== JSON.stringify(prevSamples)) writeJson(BURN_PATH, { samples });
  return { eta, rate };
}

// tokens/min → a compact "tok/s" label (1.2k for thousands)
function fmtRate(tokensPerMin) {
  const s = Math.round(tokensPerMin / 60);
  if (s >= 1000) return `${(s / 1000).toFixed(1)}k`;
  return `${s}`;
}

// ---------- quota ----------
// The payload carries per-family buckets named "<family>-5h" / "<family>-weekly"
// ("gemini-*" for Gemini models, "3p-*" for third-party ones). Parse whatever
// families are actually present so future keys (e.g. "claude-5h") just work.
function quotaFamilies(quota) {
  const fams = new Map();
  if (!quota || typeof quota !== 'object') return fams;
  for (const key of Object.keys(quota)) {
    const m = /^(.+)-(5h|weekly)$/.exec(key);
    if (!m) continue;
    let g = fams.get(m[1]);
    if (!g) fams.set(m[1], (g = {}));
    g[m[2] === '5h' ? 'fiveHour' : 'weekly'] = quota[key];
  }
  return fams;
}

// gemini models get the gemini family, everything else the third-party one;
// when the preferred family is absent or carries no usable bucket, fall back
// to any family that does (a family named after the model wins the tie).
function selectQuotaFamily(modelName, fams) {
  if (!fams.size) return null;
  const usable = (g) =>
    (g && Number.isFinite(g.fiveHour?.remaining_fraction)) ||
    (g && Number.isFinite(g.weekly?.remaining_fraction));
  const prefer = /gemini/i.test(modelName) ? 'gemini' : '3p';
  if (fams.has(prefer) && usable(fams.get(prefer))) return prefer;
  const lower = String(modelName).toLowerCase();
  for (const [fam, g] of fams) {
    if (fam !== prefer && fam !== 'gemini' && lower.includes(fam) && usable(g)) return fam;
  }
  for (const [fam, g] of fams) {
    if (fam !== prefer && usable(g)) return fam;
  }
  return fams.has(prefer) ? prefer : fams.keys().next().value;
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
  let s = `${dim(label)} ${esc(code, b.filled)}${dim(b.empty)} ${esc(`1;${code}`, `${pct}%`)}`;
  if (countdown && !opts.dropCountdowns) s += ` ${dim('·')} ${dim(countdown)}`;
  return s;
}

// ---------- line assembly ----------
// buildLine is a pure layout function: everything with side effects or I/O
// (git, burn-rate sampling) is computed once in render() and passed in via
// `fx`.
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
    `${dim('Context')} ${esc(ctxCode, cb.filled)}${dim(cb.empty)} ${esc(`1;${ctxCode}`, `${fx.pctLabel}%`)}`
  );

  if (cfg.showEta && !opts.dropEta && fx.eta) segs.push(dim(`ETA ${fx.eta}`));
  if (cfg.showBurnRate && !opts.dropRate && fx.rate) segs.push(dim(`${fmtRate(fx.rate)} tok/s`));

  if (fx.pct >= cfg.contextCritical) segs.push(esc(93, '⚠️ /compact'));

  if (cfg.showQuota) {
    const fams = quotaFamilies(p.quota);
    const fam = selectQuotaFamily(fx.modelName, fams);
    if (fam) {
      const g = fams.get(fam);
      const blocks = [];
      const b5 = quotaBlock(g.fiveHour, '5h', cfg, opts);
      if (b5) blocks.push(b5);
      if (!opts.dropWeekly) {
        const bW = quotaBlock(g.weekly, 'Wk', cfg, opts);
        if (bW) blocks.push(bW);
      }
      // Other families (e.g. the 3p quota while on a Gemini model) ride along
      // in compact form: tagged labels, no countdowns, first thing to fold.
      if (cfg.showSecondaryQuota && !opts.dropSecondary) {
        for (const [other, og] of fams) {
          if (other === fam) continue;
          const tag = other === 'gemini' ? 'G' : other;
          const sopts = { ...opts, dropCountdowns: true };
          const s5 = quotaBlock(og.fiveHour, `${tag}5h`, cfg, sopts);
          if (s5) blocks.push(s5);
          if (!opts.dropWeekly) {
            const sW = quotaBlock(og.weekly, `${tag}Wk`, cfg, sopts);
            if (sW) blocks.push(sW);
          }
        }
      }
      if (blocks.length) segs.push(blocks.join(` ${dim('·')} `));
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

  const burn = cfg.showEta || cfg.showBurnRate ? computeBurn(used, limit) : { eta: null, rate: null };
  const fx = {
    modelName,
    wsBase,
    gi: cfg.showGit ? gitInfo(ws) : null,
    pct,
    pctLabel,
    eta: cfg.showEta ? burn.eta : null,
    rate: cfg.showBurnRate ? burn.rate : null,
  };

  const tw = Number(cfg.maxWidth ?? p.terminal_width);
  const effW = Math.max(40, (Number.isFinite(tw) && tw > 0 ? tw : 80) - 2);
  const attempts = [
    {},
    { dropRate: true },
    { dropRate: true, dropSecondary: true },
    { dropRate: true, dropSecondary: true, dropEta: true },
    { dropRate: true, dropSecondary: true, dropEta: true, dropWeekly: true },
    { dropRate: true, dropSecondary: true, dropEta: true, dropWeekly: true, dropCountdowns: true },
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

async function main(recordPath) {
  const raw = await readStdin();
  if (recordPath) {
    // Diagnostics must never break rendering — best-effort append only.
    try {
      fs.appendFileSync(recordPath, `${raw.replace(/\s*\n\s*/g, ' ')}\n`);
    } catch {
      /* ignore */
    }
  }
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
const BIN_DIR = path.join(HOME, '.local', 'bin');
const SHIM_PATH = path.join(BIN_DIR, 'agline');
const SETTINGS_PATH = path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json');
// Field-level record of the statusLine state from BEFORE agline first patched
// it, so uninstall can restore exactly that field without touching anything
// else in settings.json. The legacy settings.json.bak is kept as human
// evidence only — never restored wholesale.
const RECEIPT_PATH = path.join(CONFIG_DIR, 'install-receipt.json');

const IS_WIN32 = process.platform === 'win32';
// Marker line inside the generated agline.cmd so install/doctor/uninstall can
// tell our shim apart from a foreign file that happens to sit at the path.
const WIN_CMD_MARKER = ':: agline shim';

// Where the agline.cmd shim goes on Windows: %APPDATA%\npm (the npm global
// prefix, already on PATH for typical Node installs) when it exists, else
// ~/.local/bin. Pure/injectable so tests can exercise the decision on Linux.
function chooseWinShimDir(env, home, exists) {
  const appdata = env && env.APPDATA;
  if (appdata && exists(path.win32.join(appdata, 'npm'))) {
    return { dir: path.win32.join(appdata, 'npm'), npmPrefix: true };
  }
  return { dir: path.win32.join(home, '.local', 'bin'), npmPrefix: false };
}

// Content of the Windows command shim. The target is written relative to the
// shim's own dir (%~dp0) when it stays on the same drive, else absolute.
function winCmdShimContent(sharePath, shimDir) {
  const rel = path.win32.relative(shimDir, sharePath);
  const target = rel && !path.win32.isAbsolute(rel) ? `%~dp0${rel}` : sharePath;
  return `@echo off\r\n${WIN_CMD_MARKER}\r\nnode "${target}" %*\r\n`;
}

// Platform-aware shim location. POSIX: ~/.local/bin/agline (symlink).
// Windows: <chosen dir>/agline.cmd (CMD wrapper).
function shimInfo() {
  if (!IS_WIN32) return { dir: BIN_DIR, path: SHIM_PATH, kind: 'symlink', npmPrefix: false };
  const { dir, npmPrefix } = chooseWinShimDir(process.env, HOME, (p) => fs.existsSync(p));
  return { dir, path: path.join(dir, 'agline.cmd'), kind: 'cmd', npmPrefix };
}

function dirOnPath(dir) {
  const entries = (process.env.PATH || '').split(path.delimiter);
  if (!IS_WIN32) return entries.some((p) => p === dir);
  // Windows PATH lookup is case-insensitive and tolerant of trailing slashes.
  const norm = (s) => s.replace(/[\\/]+$/, '').toLowerCase();
  return entries.some((p) => norm(p) === norm(dir));
}

function fail(msg) {
  console.error(`agline: ${msg}`);
  process.exit(1);
}

// If `p` is a symlink, return its fully-resolved target path, else null.
function symlinkTarget(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return null;
    return path.resolve(path.dirname(p), fs.readlinkSync(p));
  } catch {
    return null;
  }
}

function binDirOnPath() {
  return dirOnPath(BIN_DIR);
}

// Windows shim: write agline.cmd (marker-tagged) into the chosen dir.
// Returns 'already-ok' | 'created' | 'skipped-foreign' like the POSIX path.
// A foreign file (no marker) is never clobbered; our own stale shim is
// rewritten so reinstalls track a moved share dir.
function installShimWin() {
  const { path: shimPath, dir } = shimInfo();
  const want = winCmdShimContent(SHARE_PATH, dir);
  let cur = null;
  try {
    cur = fs.readFileSync(shimPath, 'utf8');
  } catch {
    /* absent */
  }
  if (cur !== null) {
    if (!cur.includes(WIN_CMD_MARKER)) return 'skipped-foreign';
    if (cur === want) return 'already-ok';
    fs.writeFileSync(shimPath, want);
    return 'created';
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(shimPath, want);
  return 'created';
}

// Symlink ~/.local/bin/agline -> ~/.local/share/agline/agline.mjs so the
// `agline` command works after install. Returns one of:
//   'already-ok'      correct symlink in place, nothing done
//   'created'         shim created (or a stale symlink re-pointed)
//   'skipped-foreign' a real file occupies the path — never clobbered
function installShim() {
  if (IS_WIN32) return installShimWin();
  const resolved = symlinkTarget(SHIM_PATH);
  if (resolved === SHARE_PATH) return 'already-ok';
  const isSymlink = resolved !== null;
  let exists = isSymlink;
  if (!exists) {
    try {
      fs.lstatSync(SHIM_PATH);
      exists = true;
    } catch {
      /* absent */
    }
  }
  if (exists && !isSymlink) return 'skipped-foreign';
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (isSymlink) fs.rmSync(SHIM_PATH, { force: true });
  fs.symlinkSync(SHARE_PATH, SHIM_PATH);
  return 'created';
}

// Remove the shim only when it is a symlink pointing into our share dir;
// foreign files are left alone. Returns true when something was removed.
function removeShim() {
  if (IS_WIN32) return removeShimWin();
  const resolved = symlinkTarget(SHIM_PATH);
  if (resolved === null) return false;
  if (resolved !== SHARE_PATH && !resolved.startsWith(SHARE_DIR + path.sep)) return false;
  fs.rmSync(SHIM_PATH, { force: true });
  return true;
}

// Windows: delete agline.cmd only when it carries our marker.
function removeShimWin() {
  const { path: shimPath } = shimInfo();
  let cur = null;
  try {
    cur = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return false;
  }
  if (!cur.includes(WIN_CMD_MARKER)) return false;
  fs.rmSync(shimPath, { force: true });
  return true;
}

function selfPath() {
  return fs.realpathSync(fileURLToPath(import.meta.url));
}

// The statusLine command written into settings.json. Antigravity CLI's
// Windows statusline runner does NOT strip quotes — it splits the command
// naively and node receives the literal quoted path — so the path stays
// unquoted on every platform (`node C:\…\agline.mjs` / `node /…/agline.mjs`).
// A win32 share path containing a space would break the runner's naive
// splitting; install warns about that case explicitly.
function statusLineCommand() {
  return `node ${SHARE_PATH}`;
}

// Inverse of the above for doctor: pull the script path out of the command.
// Handles the bare `node C:\…` / `node /…` form (whitespace split, last token)
// and the legacy 0.2.3 quoted win32 form (`node "C:\…"`).
function statusLineTarget(command) {
  const q = String(command).match(/"([^"]+)"\s*$/);
  if (q) return q[1];
  return String(command).trim().split(/\s+/).pop();
}

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return { settings: {}, existed: false, corrupt: false };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return { settings: null, existed: true, corrupt: true };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { settings: null, existed: true, corrupt: true };
  }
  return { settings, existed: true, corrupt: false };
}

function isAglineStatusLine(sl) {
  return !!sl && typeof sl === 'object' && typeof sl.command === 'string' && sl.command.includes('agline');
}

// Write temp-then-rename so a crash mid-write can never leave a truncated
// settings.json behind. `mode` preserves the existing file's permissions.
function writeFileAtomic(p, text, mode) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  if (mode !== undefined) {
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      /* best effort */
    }
  }
  fs.renameSync(tmp, p);
}

function writeSettingsAtomic(settings, existed) {
  let mode = 0o600;
  if (existed) {
    try {
      mode = fs.statSync(SETTINGS_PATH).mode;
    } catch {
      /* keep default */
    }
  }
  writeFileAtomic(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', mode);
}

// The statusLine value to hand back on uninstall. Precedence: the install
// receipt (definite record of the pre-agline state), then the statusLine
// field extracted from the legacy whole-file .bak, then null (= agline added
// the field, so it should simply go away). A value pointing at agline itself
// is coerced to null — restoring it would resurrect a dead pointer.
function preAglineStatusLine() {
  const receipt = readJson(RECEIPT_PATH, null);
  if (receipt && typeof receipt === 'object' && !Array.isArray(receipt) && 'previousStatusLine' in receipt) {
    const v = receipt.previousStatusLine ?? null;
    return { value: isAglineStatusLine(v) ? null : v, source: 'receipt' };
  }
  const bak = readJson(`${SETTINGS_PATH}.bak`, null);
  if (bak && typeof bak === 'object' && !Array.isArray(bak)) {
    const v = bak.statusLine ?? null;
    return { value: isAglineStatusLine(v) ? null : v, source: 'settings.json.bak field' };
  }
  return { value: null, source: null };
}

function cmdInstall() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const configCreated = !fs.existsSync(CONFIG_PATH);
  if (configCreated) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
  }

  fs.mkdirSync(SHARE_DIR, { recursive: true });
  const src = selfPath();
  const alreadyThere = fs.existsSync(SHARE_PATH) && fs.realpathSync(SHARE_PATH) === src;
  if (!alreadyThere) {
    fs.copyFileSync(src, SHARE_PATH);
    try {
      fs.chmodSync(SHARE_PATH, 0o755);
    } catch {
      /* best effort */
    }
  }

  const { settings, existed, corrupt } = readSettings();
  if (corrupt) {
    fail(
      `${SETTINGS_PATH} is not valid JSON — refusing to overwrite it. Fix or remove the file manually, then re-run: agline install`
    );
  }
  if (!existed) fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });

  const bak = `${SETTINGS_PATH}.bak`;
  let backupNote = null;
  if (existed) {
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(SETTINGS_PATH, bak);
      backupNote = 'written (evidence only — restore is field-level)';
    } else {
      backupNote = 'already exists, oldest kept (evidence only)';
    }
  }

  // Record the pre-agline statusLine field-level. On reinstall over agline
  // keep the original record (migrating legacy receipt-less installs from
  // the .bak when possible) so the rollback target never becomes agline
  // itself; when another tool owns the field, that tool becomes the target.
  const prev = settings.statusLine;
  let previousStatusLine;
  if (isAglineStatusLine(prev)) {
    previousStatusLine = preAglineStatusLine().value;
  } else {
    previousStatusLine = prev ?? null;
  }
  writeJson(RECEIPT_PATH, {
    version: VERSION,
    installedAt: new Date().toISOString(),
    settingsPath: SETTINGS_PATH,
    previousStatusLine,
  });

  settings.statusLine = { type: 'command', command: statusLineCommand(), enabled: true };
  writeSettingsAtomic(settings, existed);

  const shimResult = installShim();
  const { path: shimPath, dir: shimDir, npmPrefix } = shimInfo();
  const createdNote = IS_WIN32
    ? 'shim written — agline doctor, uninstall, ...'
    : 'symlinked — agline doctor, uninstall, ...';
  const shimNote =
    shimResult === 'already-ok'
      ? 'already current — agline doctor, uninstall, ...'
      : shimResult === 'created'
        ? createdNote
        : 'skipped — a non-agline file already exists there';
  const onPath = dirOnPath(shimDir);

  const row = (label, value, note) =>
    console.log(`  ${dim(label.padEnd(11))} ${value}${note ? dim(` (${note})`) : ''}`);
  console.log('');
  console.log(`${esc(32, '✓')} agline ${VERSION} installed`);
  console.log('');
  row('statusline', SHARE_PATH, alreadyThere ? 'already current' : 'copied');
  row('command', shimPath, shimNote);
  row('config', CONFIG_PATH, configCreated ? 'defaults written' : 'already exists, untouched');
  row('settings', SETTINGS_PATH, 'statusLine patched');
  if (backupNote) row('backup', bak, backupNote);
  if (IS_WIN32 && SHARE_PATH.includes(' ')) {
    console.log('');
    console.log(`${esc(33, '!')} the install path contains a space: ${SHARE_PATH}`);
    console.log(
      `  Antigravity's Windows statusline runner cannot handle quoting, so the statusLine command is written unquoted — on Windows the install path must not contain spaces.`
    );
  }
  if (shimResult !== 'skipped-foreign' && !onPath) {
    console.log('');
    console.log(`${esc(33, '!')} ${shimDir} is not on your PATH`);
    if (IS_WIN32) {
      if (!npmPrefix) {
        console.log(`  add to PATH: setx PATH "%PATH%;%USERPROFILE%\\.local\\bin"`);
        console.log(`  ${dim('(open a new terminal afterwards — setx does not affect the current one)')}`);
      }
    } else {
      console.log(`  add to PATH: export PATH="$HOME/.local/bin:$PATH"`);
    }
  }
  console.log('');
  console.log('Next steps:');
  console.log(`  ${dim('·')} Restart agy (or start a new session) to see the statusline`);
  console.log(`  ${dim('·')} agline doctor        verify the setup anytime`);
  console.log(`  ${dim('·')} edit config.json     tweak bars, thresholds, toggles`);
  console.log(`  ${dim('·')} agline uninstall     restore previous statusLine`);
  console.log('');
  console.log(
    `${dim('Rollback target (saved):')} ${previousStatusLine === null ? 'none' : JSON.stringify(previousStatusLine)} ${dim(`→ ${RECEIPT_PATH}`)}`
  );
}

function cmdUninstall() {
  const { settings, existed, corrupt } = readSettings();
  if (corrupt) {
    console.error(`agline: ${SETTINGS_PATH} is not valid JSON — refusing to touch it.`);
    console.error('  fix it manually; recovery evidence is kept at:');
    console.error(`    ${RECEIPT_PATH}`);
    console.error(`    ${SETTINGS_PATH}.bak`);
    process.exit(1);
  }
  let settingsNote = 'no agline statusLine found (untouched)';
  let evidenceKept = false;
  if (existed && settings.statusLine != null) {
    if (!isAglineStatusLine(settings.statusLine)) {
      // Another tool owns the field now — never clobber it. Removing our own
      // files below is still safe: agline is not the active statusline.
      settingsNote = `left untouched — statusLine belongs to another tool (${JSON.stringify(settings.statusLine)})`;
    } else {
      const { value, source } = preAglineStatusLine();
      if (value === null) delete settings.statusLine;
      else settings.statusLine = value;
      writeSettingsAtomic(settings, existed);
      evidenceKept = true;
      settingsNote =
        value === null
          ? source
            ? `statusLine removed (pre-install state: none, via ${source}); other settings preserved`
            : 'statusLine removed (no receipt/backup; other settings preserved)'
          : `statusLine restored to pre-install value (via ${source}); other settings preserved`;
    }
  }
  const shimRemoved = removeShim();
  fs.rmSync(SHARE_DIR, { recursive: true, force: true });

  const row = (label, value, note) =>
    console.log(`  ${dim(label.padEnd(11))} ${value}${note ? dim(` (${note})`) : ''}`);
  console.log('');
  console.log(`${esc(32, '✓')} agline ${VERSION} uninstalled`);
  console.log('');
  row('settings', SETTINGS_PATH, settingsNote);
  row('statusline', SHARE_DIR, 'removed');
  row(
    'command',
    shimInfo().path,
    shimRemoved ? 'shim removed' : 'no agline shim found (foreign files are left alone)'
  );
  row('config', CONFIG_DIR, 'kept — delete manually if unwanted');
  if (evidenceKept) {
    row('evidence', RECEIPT_PATH, 'kept for manual recovery');
    console.log(`  ${dim('')} ${dim(`${SETTINGS_PATH}.bak`)}`);
  }
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
  for (const k of ['showEta', 'showBurnRate', 'showQuota', 'showSecondaryQuota', 'showGit']) {
    if (cfg[k] !== undefined && typeof cfg[k] !== 'boolean') invalid.push(`${k} (want boolean)`);
  }
  // showStreak was removed in 0.2.8 — tolerate it in existing configs silently.
  const known = new Set([...Object.keys(DEFAULTS), 'showStreak']);
  for (const k of Object.keys(cfg)) {
    if (!known.has(k)) invalid.push(`${k} (unknown key)`);
  }
  return invalid;
}

// POSIX shim check: ~/.local/bin/agline must be a symlink to the installed copy.
function doctorShimPosix(ok, bad, warn) {
  const shimResolved = symlinkTarget(SHIM_PATH);
  let shimForeign = false;
  if (shimResolved === null) {
    try {
      fs.lstatSync(SHIM_PATH);
      shimForeign = true;
    } catch {
      /* absent */
    }
  }
  if (shimResolved === SHARE_PATH) {
    ok(`command shim ${SHIM_PATH} -> ${SHARE_PATH}`);
  } else if (shimForeign) {
    warn(`${SHIM_PATH} exists but is not an agline shim — leaving it alone; the shim was skipped at install`);
  } else if (shimResolved !== null) {
    bad(`command shim ${SHIM_PATH} points at ${shimResolved}, expected ${SHARE_PATH} — run: agline install`);
  } else {
    bad(`command shim missing: ${SHIM_PATH} — run: agline install`);
  }
  if (!shimForeign && !binDirOnPath()) {
    warn(`${BIN_DIR} is not on PATH — add to PATH: export PATH="$HOME/.local/bin:$PATH"`);
  }
}

// Windows shim check: agline.cmd must exist, carry our marker, and point at an
// existing target. The target is read from the shim's own `node "..."` line
// (%~dp0-relative targets resolve against the shim's directory).
function doctorShimWin(ok, bad, warn) {
  const { path: shimPath, dir, npmPrefix } = shimInfo();
  let content = null;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    /* absent */
  }
  let shimForeign = false;
  if (content === null) {
    bad(`command shim missing: ${shimPath} — run: agline install`);
  } else if (!content.includes(WIN_CMD_MARKER)) {
    shimForeign = true;
    warn(`${shimPath} exists but is not an agline shim — leaving it alone; the shim was skipped at install`);
  } else {
    const m = content.match(/node "([^"]+)"/);
    const rawTarget = m ? m[1] : null;
    const target = rawTarget ? rawTarget.replace(/^%~dp0/, path.dirname(shimPath) + path.sep) : null;
    if (!target) {
      bad(`command shim ${shimPath} has no node target — run: agline install`);
    } else if (!fs.existsSync(target)) {
      bad(`command shim ${shimPath} target does not exist: ${target} — run: agline install`);
    } else {
      ok(`command shim ${shimPath} -> ${target}`);
    }
  }
  if (!shimForeign && !dirOnPath(dir)) {
    if (npmPrefix) {
      warn(`${dir} is not on PATH — unusual for the npm global prefix; check your Node installation`);
    } else {
      warn(`${dir} is not on PATH — add to PATH: setx PATH "%PATH%;%USERPROFILE%\\.local\\bin" (then open a new terminal)`);
    }
  }
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
        const target = statusLineTarget(sl.command);
        if (!fs.existsSync(target)) {
          bad(`statusLine target does not exist: ${target}`);
        } else if (sl.enabled === true) {
          ok(`statusLine -> ${target} (enabled)`);
          if (!fs.existsSync(RECEIPT_PATH)) {
            warn(
              `install receipt missing: ${RECEIPT_PATH} — uninstall falls back to the .bak statusLine field; re-run: agline install`
            );
          }
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

  // command shim, and whether its directory is on PATH
  if (IS_WIN32) {
    doctorShimWin(ok, bad, warn);
  } else {
    doctorShimPosix(ok, bad, warn);
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

  // state dir writable (burn-state.json lives here)
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
  console.log('tip: quota/model looks wrong? capture the real payload with `--record` (see: agline --help).');
  process.exitCode = failures ? 1 : 0;
}

function printUsage() {
  console.log(`agline ${VERSION} — single-line statusline HUD for Antigravity CLI

Usage:
  agline              render one statusline frame (reads JSON payload from stdin)
  agline install      copy agline to ~/.local/share/agline, put the \`agline\`
                      command on PATH (POSIX: symlink in ~/.local/bin;
                      Windows: agline.cmd in %APPDATA%\\npm or ~/.local/bin),
                      and enable the statusline in
                      ~/.gemini/antigravity-cli/settings.json
  agline uninstall    restore/remove the statusLine setting and delete
                      ~/.local/share/agline and the command shim
  agline doctor       check node version, statusLine wiring, installed copy,
                      command shim, config and state dir (exit 1 when something
                      is broken)
  agline --record F   render normally and also append the raw stdin payload to
                      the file F (diagnostics: capture what your Antigravity
                      version actually sends — point statusLine at this form,
                      run one prompt, inspect F, then \`agline install\` to revert)
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
  fmtRate,
  computeEtaFromSamples,
  computeBurn,
  selectQuotaFamily,
  quotaFamilies,
  quotaBlock,
  loadConfig,
  validateConfig,
  buildLine,
  render,
  installShim,
  removeShim,
  binDirOnPath,
  dirOnPath,
  WIN_CMD_MARKER,
  winCmdShimContent,
  chooseWinShimDir,
  statusLineCommand,
  statusLineTarget,
  cmdInstall,
  cmdUninstall,
  cmdDoctor,
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
  const renderFallback = () => {
    try {
      process.stdout.write('[Gemini] │ ?\n');
    } catch {
      /* ignore */
    }
    process.exitCode = 0;
  };
  if (cmd === undefined) {
    main().catch(renderFallback);
  } else if (cmd === '--record' || cmd.startsWith('--record=')) {
    const recordPath = cmd.startsWith('--record=') ? cmd.slice('--record='.length) : process.argv[3];
    if (!recordPath) {
      console.error('agline: --record needs a file path (--record <path> or --record=<path>)');
      process.exit(2);
    }
    main(recordPath).catch(renderFallback);
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
