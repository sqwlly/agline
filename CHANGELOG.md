# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

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
