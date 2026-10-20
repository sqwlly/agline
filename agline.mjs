#!/usr/bin/env node
// agline — zero-dependency single-line statusline HUD for Antigravity CLI (agy).
// Reads one JSON payload from stdin, prints exactly one line to stdout.
// Inspired by agy-hud (MIT) by AllenMuu — rewritten from scratch for
// Antigravity CLI 1.4.3's statusline protocol.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'agline');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const BURN_PATH = path.join(CONFIG_DIR, 'burn-state.json');
const STATS_PATH = path.join(CONFIG_DIR, 'stats.json');

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

function vlen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function truncateAnsi(str, max) {
  let out = '';
  let visible = 0;
  let i = 0;
  const limit = Math.max(0, max - 1);
  while (i < str.length && visible < limit) {
    if (str[i] === '\x1b') {
      const end = str.indexOf('m', i);
      if (end === -1) break;
      out += str.slice(i, end + 1);
      i = end + 1;
    } else {
      out += str[i];
      visible += 1;
      i += 1;
    }
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
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch {
    /* never throw */
  }
}

function loadConfig() {
  const cfg = readJson(CONFIG_PATH, {});
  const out = { ...DEFAULTS };
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (cfg[k] !== undefined) out[k] = cfg[k];
    }
  }
  return out;
}

function bar(pct, width) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return { filled: '▰'.repeat(filled), empty: '▱'.repeat(width - filled) };
}

function fmtEta(mins) {
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins < 1) return '<1m';
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
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
    const headPath = path.join(gitDir, 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    let branch = null;
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) branch = refMatch[1].trim();

    let dirty = false;
    try {
      dirty = fs.statSync(path.join(gitDir, 'index')).mtimeMs > fs.statSync(headPath).mtimeMs;
    } catch {
      dirty = false;
    }

    let diverged = false;
    if (branch) {
      const local = resolveRef(gitDir, `refs/heads/${branch}`);
      const remote = resolveRef(gitDir, `refs/remotes/origin/${branch}`);
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
function computeEta(used, limit) {
  if (!(limit > 0) || !(used >= 0)) return null;
  const now = Date.now();
  const state = readJson(BURN_PATH, {});
  let samples = Array.isArray(state.samples) ? state.samples : [];

  const last = samples[samples.length - 1];
  if (last && used < 0.7 * last.used) samples = []; // new session / compaction

  const cur = samples[samples.length - 1];
  let changed = false;
  if (!cur || now - cur.t >= 20000 || cur.used !== used) {
    samples.push({ t: now, used });
    changed = true;
  }
  samples = samples.slice(-12);
  if (changed || samples.length !== (Array.isArray(state.samples) ? state.samples.length : 0)) {
    writeJson(BURN_PATH, { samples });
  }

  if (samples.length < 2) return null;
  const first = samples[0];
  const lastS = samples[samples.length - 1];
  const dtMin = (lastS.t - first.t) / 60000;
  const dUsed = lastS.used - first.used;
  if (dtMin < 1 || dUsed <= 0) return null;
  const rate = dUsed / dtMin; // tokens per minute
  const remaining = limit - used;
  if (remaining <= 0) return null;
  return fmtEta(remaining / rate);
}

// ---------- streak ----------
function updateStreak() {
  const stats = readJson(STATS_PATH, {});
  let days = Array.isArray(stats.days) ? stats.days : [];
  const today = new Date().toISOString().slice(0, 10);
  if (!days.includes(today)) {
    days = days.concat(today).slice(-400);
    writeJson(STATS_PATH, { days });
  }
  return days.length;
}

// ---------- quota ----------
function quotaBlock(q, label, cfg, opts) {
  if (!q || typeof q.remaining_fraction !== 'number') return null;
  let frac = q.remaining_fraction;
  let countdown = null;
  const now = Date.now();
  let resetMs = null;
  if (q.reset_time) {
    const t = Date.parse(q.reset_time);
    if (!Number.isNaN(t)) resetMs = t - now;
  }
  if (resetMs === null && typeof q.reset_in_seconds === 'number') {
    resetMs = q.reset_in_seconds * 1000;
  }
  if (resetMs !== null && resetMs <= 0) {
    frac = 1;
  } else if (resetMs !== null) {
    countdown = fmtCountdown(resetMs);
  }
  const pct = Math.round(frac * 100);
  const code = pct > 40 ? 32 : pct > 20 ? 33 : 31;
  const b = bar(pct, cfg.quotaBarWidth);
  let s = `${dim(label)} ${esc(code, b.filled)}${dim(b.empty)} ${esc(`1;${code}`, `${pct}%`)}`;
  if (countdown && !opts.dropCountdowns) s += ` ${dim('·')} ${dim(countdown)}`;
  return s;
}

// ---------- line assembly ----------
function buildLine(p, cfg, opts) {
  const segs = [];
  const active = typeof p.agent_state === 'string' && p.agent_state !== '' && p.agent_state !== 'idle';
  if (active) {
    const frames = ['◐', '◓', '◑', '◒'];
    segs.push(esc(93, frames[Math.floor(Date.now() / 150) % 4]) + ' ');
  }

  const modelName = p.model?.display_name || p.model?.id || 'Gemini';
  segs.push(esc('1;96', `[${modelName}]`));

  const ws = p.workspace?.current_dir || p.cwd || process.cwd();
  let wsSeg = esc('1;97', path.basename(ws) || ws);
  if (cfg.showGit) {
    const gi = gitInfo(ws);
    if (gi) {
      wsSeg += ` ${esc(35, `git:(${gi.branch}${gi.dirty ? esc(93, '*') : ''})`)}`;
      if (gi.diverged) wsSeg += ` ${esc(35, '[⇅]')}`;
    }
  }
  segs.push(wsSeg);

  const cw = p.context_window || {};
  const pct = typeof cw.used_percentage === 'number' ? cw.used_percentage : 0;
  const ctxCode = pct >= cfg.contextCritical ? 31 : pct >= cfg.contextWarning ? 33 : 32;
  const cb = bar(pct, cfg.barWidth);
  segs.push(`${dim('Context')} ${esc(ctxCode, cb.filled)}${dim(cb.empty)} ${esc(`1;${ctxCode}`, `${Math.round(pct)}%`)}`);

  const limit = typeof cw.context_window_size === 'number' ? cw.context_window_size : 0;
  const used =
    typeof cw.estimated_tokens_used === 'number' ? cw.estimated_tokens_used : (pct / 100) * limit;
  if (cfg.showEta && !opts.dropEta) {
    const eta = computeEta(used, limit);
    if (eta) segs.push(dim(`ETA ${eta}`));
  }

  if (pct >= cfg.contextCritical) segs.push(esc(93, '⚠ /compact'));

  if (cfg.showQuota && p.quota && typeof p.quota === 'object') {
    const gemini = /gemini/i.test(modelName);
    const keys = gemini ? ['gemini-5h', 'gemini-weekly'] : ['3p-5h', '3p-weekly'];
    const blocks = [];
    const b5 = quotaBlock(p.quota[keys[0]], '5h', cfg, opts);
    if (b5) blocks.push(b5);
    if (!opts.dropWeekly) {
      const bW = quotaBlock(p.quota[keys[1]], 'Wk', cfg, opts);
      if (bW) blocks.push(bW);
    }
    if (blocks.length) segs.push(blocks.join(` ${dim('·')} `));
  }

  if (cfg.showStreak && !opts.dropStreak) {
    const days = updateStreak();
    if (days > 1) segs.push(dim(`★ ${days}d`));
    if ([7, 30, 100, 365].includes(days)) {
      segs.push(esc('1;95', `🏆 ${days} days with agline!`));
    }
  }

  const sep = ` ${gray('│')} `;
  return segs.filter(Boolean).join(sep);
}

function render(p) {
  const cfg = loadConfig();
  const effW = Math.max(40, (cfg.maxWidth || p.terminal_width || 80) - 2);
  const attempts = [
    {},
    { dropStreak: true },
    { dropStreak: true, dropEta: true },
    { dropStreak: true, dropEta: true, dropWeekly: true },
    { dropStreak: true, dropEta: true, dropWeekly: true, dropCountdowns: true },
  ];
  let line = '';
  for (const opts of attempts) {
    line = buildLine(p, cfg, opts);
    if (vlen(line) <= effW) return line;
  }
  return truncateAnsi(line, effW);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let timer = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(data);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
        if (timer) clearTimeout(timer);
        timer = setTimeout(done, 100);
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
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    payload = {};
  }
  try {
    process.stdout.write(render(payload) + '\n');
  } catch {
    let model = 'Gemini';
    let base = '?';
    try {
      model = payload.model?.display_name || payload.model?.id || 'Gemini';
    } catch {
      /* ignore */
    }
    try {
      base = path.basename(payload.cwd || process.cwd());
    } catch {
      /* ignore */
    }
    process.stdout.write(`[${model}] │ ${base}\n`);
  }
  process.exit(0);
}

main().catch(() => {
  try {
    process.stdout.write('[Gemini] │ ?\n');
  } catch {
    /* ignore */
  }
  process.exit(0);
});
