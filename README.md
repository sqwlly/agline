# agline

A zero-dependency, single-line statusline HUD for **Google Antigravity CLI** (`agy`).
One Node.js ESM file — no `npm install`, no build step. Node 18+ is enough.

Inspired by agy-hud (MIT) by AllenMuu — rewritten from scratch for Antigravity CLI 1.4.3's statusline protocol.

![agline in action](docs/demo.svg)

<sub>Synthesized asciinema replay (`docs/demo.cast` → `docs/demo.svg` via svg-term-cli) of real `agline.mjs` output frames — not a screen recording.</sub>

## What it shows

```
[Gemini 4 Argon] │ veyra git:(main*) │ Context ▰▰▰░░░░░░░ 30% │ ETA 2h10m │ 317 tok/s │ 5h ▰▰▰▰▰▱ 77% · 2h15m · Wk ▰▱▱▱▱▱ 10% · 3d4h
```

- **Spinner** (`◐ ◓ ◑ ◒`) while the agent is active
- **Model badge** (bold bright cyan)
- **Workspace + git** branch, dirty `*`, `[⇅]` when local/`origin` hashes differ (pure filesystem reads, no `git` process; the compared remote is always `origin`). Works in linked worktrees via `commondir` resolution.
- **Context** bar from `context_window.used_percentage` (green → yellow at `contextWarning` → red at `contextCritical`, plus `⚠ /compact` at critical)
- **ETA** to context exhaustion from a rolling burn-rate (`~/.config/agline/burn-state.json`)
- **Quota** 5h / weekly buckets with reset countdowns. The current model's family leads (`5h`/`Wk`); when the payload carries the other family too, it rides along in compact tagged form (`3p5h`/`3pWk` or `G5h`/`GWk`, no countdowns — disable via `showSecondaryQuota`)
- **Burn rate** — live token throughput (`317 tok/s`) from the same rolling samples as the ETA

Segments drop progressively (burn rate → secondary quota family → ETA → weekly quota → countdowns → `…` truncation) to fit the terminal width. Percentages render at natural width with a single space (`9%`, `45%`, `100%`), and countdowns are compact (`2h46m`, `3d4h`). ANSI-aware: never cuts inside an escape sequence. Respects `NO_COLOR`.

## Install

```sh
npx @sqwlly/agline install
```

(Straight from npm — no clone needed. The GitHub form `npx github:sqwlly/agline install` also works.)

npx is only the delivery mechanism: the installer copies `agline.mjs` to a stable location,
`~/.local/share/agline/agline.mjs`, and points the statusLine at that path — so every render
runs plain `node` on a local file (~40 ms), independent of the npx cache.

It also symlinks the `agline` command into `~/.local/bin` (`~/.local/bin/agline` → the installed
copy), so after install you can run `agline doctor`, `agline uninstall`, etc. directly — no npx
needed. If `~/.local/bin` is not on your PATH the installer prints the one-line `export` to add it,
and if a non-agline file already sits at `~/.local/bin/agline` the shim is skipped with a warning
instead of clobbering it.

This creates `~/.config/agline/config.json` (from built-in defaults, if missing), copies
`agline.mjs` to `~/.local/share/agline/`, and patches
`~/.gemini/antigravity-cli/settings.json` → `statusLine` to:

```json
{ "type": "command", "command": "node ~/.local/share/agline/agline.mjs", "enabled": true }
```

(with the actual home path expanded).

All other settings are preserved (JSON round-trip, indent 2, atomic temp-then-rename write that
keeps the file's permissions). The pre-agline `statusLine` value is recorded field-level in
`~/.config/agline/install-receipt.json` — on reinstall over agline the original record is kept
(legacy receipt-less installs recover it from the `.bak`), so the rollback target never becomes
agline itself. The current `settings.json` is also copied to `settings.json.bak` as human
evidence (an existing `.bak` is kept — the oldest wins; it is never restored wholesale). The
installer refuses to touch a `settings.json` that is not valid JSON, and is idempotent on re-run.

## Uninstall

```sh
agline uninstall        # or: npx @sqwlly/agline uninstall
```

Restore is **field-level**: if agline's statusLine is active, only that one field is set back to
its pre-install value (from the install receipt, falling back to the `statusLine` field inside
`settings.json.bak`, falling back to simply removing the field agline added). Every other key —
including ones you edited *after* installing agline — is left exactly as-is. A restore candidate
pointing at agline itself is coerced to removal, and a corrupt `settings.json` is refused
byte-for-byte with the evidence paths printed. If the statusLine now belongs to another tool, it
is left untouched (agline's own files are still removed). Then `~/.local/share/agline` and the
`~/.local/bin/agline` shim are removed (only when it is agline's own; foreign files are left
alone). The receipt, the `.bak`, and your config in `~/.config/agline/` are kept for manual
recovery; delete them manually if unwanted.

## Windows (best-effort)

Windows (win32) is supported on a best-effort basis — it is implemented and unit-tested but not
exercised on real Windows hardware in CI.

What works the same: `install` / `uninstall` / `doctor`, the statusLine wiring in
`settings.json`, and the statusline renderer itself (pure Node, no shell-outs).

What's different:

- **No symlink.** Instead of the POSIX `~/.local/bin/agline` symlink, install writes a small
  `agline.cmd` CMD wrapper (tagged with a `:: agline shim` marker line so uninstall/doctor can
  tell it apart from foreign files — a file without the marker is never touched).
- **Shim location.** The wrapper goes to `%APPDATA%\npm` (the npm global prefix, already on PATH
  for typical Node installs) when that directory exists; otherwise to `%USERPROFILE%\.local\bin`,
  and the installer prints a `setx PATH "%PATH%;%USERPROFILE%\.local\bin"` hint — open a **new
  terminal** afterwards, `setx` does not affect the current one.
- **settings.json** gets an unquoted command (`node C:\…\agline.mjs`) — Antigravity's Windows
  statusline runner takes quotes literally, so the install path must not contain spaces
  (install prints a warning if it does); the file stays ordinary JSON.

If something is off on Windows, please open an issue at
https://github.com/sqwlly/agline/issues with the full output of `agline doctor`.

## Doctor

```sh
agline doctor           # or: npx @sqwlly/agline doctor
```

Prints a health report — node version, statusLine wiring in `settings.json`, installed-copy
version vs the binary you're running, the `~/.local/bin/agline` command shim (and whether
`~/.local/bin` is on PATH), config validity, state-dir writability — and exits 1 when something
is broken (0 otherwise). No network calls.

## Config

`~/.config/agline/config.json` (all keys optional, defaults shown):

```json
{
  "barWidth": 10,
  "quotaBarWidth": 6,
  "maxWidth": null,
  "contextWarning": 70,
  "contextCritical": 85,
  "showEta": true,
  "showBurnRate": true,
  "showQuota": true,
  "showSecondaryQuota": true,
  "showGit": true
}
```

- `barWidth` / `quotaBarWidth` — cells in the context / quota bars (`▰`/`▱`)
- `maxWidth` — hard cap for the rendered line; `null` uses `terminal_width` from the payload (fallback 80), minus 2, floor 40
- `contextWarning` / `contextCritical` — percent thresholds for yellow / red (and `⚠ /compact`)
- `showEta` / `showBurnRate` / `showQuota` / `showGit` — segment toggles
- `showSecondaryQuota` — also show the *other* quota family in compact tagged form (`3p5h`/`3pWk` while on Gemini, `G5h`/`GWk` while on a third-party model)

## Files

| Path | Purpose |
| --- | --- |
| `agline.mjs` | the entire statusline + CLI (`node agline.mjs [install\|uninstall\|doctor\|--version\|--help]`) |
| `config.example.json` | documented defaults (reference only; the installer embeds them) |
| `~/.local/bin/agline` | command shim → `~/.local/share/agline/agline.mjs` (POSIX; created by install, removed by uninstall). On Windows: `agline.cmd` in `%APPDATA%\npm` or `%USERPROFILE%\.local\bin` |
| `~/.config/agline/config.json` | runtime config (not in repo) |
| `~/.config/agline/burn-state.json` | ETA burn-rate samples (runtime) |

## Development

Zero dependencies — no `npm install` needed, ever.

```sh
npm test   # node --test (node:test + node:assert only)
```

CI runs `node --check agline.mjs` and `npm test` on node 18/20/22 (`.github/workflows/ci.yml`).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
