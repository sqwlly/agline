# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.2.6] - 2026-10-21

### Added

- Both quota families on one line: when the payload carries the other family too, it now rides along in compact tagged form — `3p5h`/`3pWk` while on a Gemini model, `G5h`/`GWk` while on a third-party model (no countdowns on the secondary family). New config toggle `showSecondaryQuota` (default `true`). The secondary family is the first quota element to fold as the terminal narrows (drop order: streak → secondary quota → ETA → weekly → countdowns).

## [0.2.5] - 2026-10-21

### Added

- `agline --record <file>`: renders the statusline as usual and also appends the raw stdin payload to `<file>` — capture exactly what your Antigravity version sends (point statusLine at `node …/agline.mjs --record ~/agline-payload.jsonl`, run one prompt, inspect the file, then `agline install` to revert). Mentioned in `--help` and as a `doctor` tip.

### Fixed

- Quota for non-Gemini models could silently disappear: the quota buckets are now discovered generically from whatever `<family>-5h` / `<family>-weekly` keys the payload actually carries (so future families like `claude-5h` work without a code change), and when the model's own family is absent or carries no usable bucket, agline falls back to any family that does instead of rendering nothing. `selectQuotaKeys` was replaced by exported `quotaFamilies` / `selectQuotaFamily`.

## [0.2.4] - 2026-10-21

### Fixed

- Windows statusLine quoting: Antigravity CLI's Windows statusline runner does not strip quotes — it splits the command naively and node received the literal quoted path resolved against the workspace cwd (`Cannot find module 'C:\…\minishop\"C:\…\agline.mjs"'`). The win32 statusLine command written to `settings.json` is now unquoted (`node C:\…\agline.mjs`). When the resolved share path contains a space, install prints a warning that the path must not contain spaces on Windows because the runner cannot handle quoting. `agline doctor` still extracts the legacy quoted 0.2.3 form as well as the new bare form. POSIX output is byte-identical to previous releases.

## [0.2.3] - 2026-10-21

### Added

- Windows (win32) install support, best-effort. `agline install` on Windows now writes a marker-tagged `agline.cmd` CMD wrapper instead of attempting a POSIX symlink: into `%APPDATA%\npm` (the npm global prefix, already on PATH for typical Node installs) when that directory exists, else `~/.local/bin` with a `setx PATH` hint and a note that a new terminal is needed. The wrapper invokes the installed copy via a `%~dp0`-relative path (absolute when the share dir is on another drive). A pre-existing file without the `:: agline shim` marker is never clobbered.
- `agline doctor` is platform-aware: on Windows it verifies the `.cmd` shim exists, carries the agline marker and points at an existing target, and its PATH warning checks the directory actually used (with a `setx` hint when the fallback dir was chosen).
- `agline uninstall` on Windows removes the `.cmd` shim (marker-verified) alongside the share dir; settings restore logic is unchanged.

### Fixed

- `agline doctor` previously failed on Windows because the shim checks were POSIX-only (symlink resolution, extensionless executable).
- The statusLine command written to `settings.json` is now quoted on Windows (`node "C:\…\agline.mjs"`) so paths containing spaces survive; `JSON.stringify` escapes the backslashes. POSIX output is byte-identical to previous releases.

## [0.2.2] - 2026-10-21

### Fixed

- `agline doctor` / `agline uninstall` told users to run a command that did not exist: install only placed `agline.mjs` under `~/.local/share/agline/`, so `agline` was never on PATH. `agline install` now symlinks `~/.local/bin/agline` → `~/.local/share/agline/agline.mjs` (shebang + exec bit make it directly runnable; the symlink stays in sync on reinstall). A pre-existing non-symlink file at that path is never clobbered — install warns and skips the shim. When `~/.local/bin` is not on PATH, install prints the `export PATH="$HOME/.local/bin:$PATH"` hint. Re-running install over a correct symlink is a no-op.

### Changed

- `agline uninstall` also removes the `~/.local/bin/agline` shim when it is a symlink pointing into `~/.local/share/agline` (foreign files are left alone).
- `agline doctor` now checks the shim: it must exist and resolve to the installed copy (a foreign file is a warning, not a failure), and warns when `~/.local/bin` is not on PATH.

## [0.2.1] - 2026-10-21

### Changed

- Reverted the 0.2.0 fixed-width percent padding: percentages render at natural width again with a single space (`Context ▱▱▱▱▱▱▱▱▱▱ 0%`, `5h ▰▰▰▰▰▰ 96%`) — the padded form produced ugly gaps. Applies to the context percent and both quota percents.
- `agline install` success output is now a polished summary: installed paths with per-file notes, a "Next steps" block, and the previous statusLine value for rollback — all non-interactive, NO_COLOR aware, under 20 lines.
- `agline uninstall` success output matches the same style: what was restored/removed and a note that the config is kept. Behavior (idempotency, backups, exit codes) is unchanged.

## [0.2.0] - 2026-10-21

### Added

- Test suite (`test/agline.test.mjs`, `node --test`, zero dependencies): sanitization, width/truncation, bar fill, quota selection and clamping, ETA sampling rules, streak counting, and full-render goldens with progressive segment dropping.
- GitHub Actions CI (`.github/workflows/ci.yml`): node 18/20/22 on ubuntu-latest, `node --check` + `npm test`.
- `agline doctor` subcommand: health report for the node version, statusLine wiring, installed-copy version, config validity and state-dir writability (exit 1 when something is broken).
- This changelog.

### Changed

- Fixed-width percentages (`  9%`, ` 45%`, `100%`) — the line no longer jitters between renders.
- Compact countdowns: `4h23m` / `2d18h` instead of `4h 23m` / `2d 18h` (quota resets and ETA).
- Model badge strips a trailing effort qualifier: `Gemini 4 Argon (High)` renders as `[Gemini 4 Argon]`.
- `agline.mjs` now exports its pure internals and only runs the CLI when executed directly — importing the module is side-effect free.

## [0.1.1] - 2026-10-21

### Fixed

- Corrected the npx package name in the usage text.

## [0.1.0] - 2026-10-21

### Added

- Initial release: zero-dependency, single-line statusline HUD for Antigravity CLI (spinner, model badge, workspace + git, context bar with ETA, 5h/weekly quota with reset countdowns, usage-day streak).
