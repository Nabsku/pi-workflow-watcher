# Changelog

## Unreleased

### Added

- Added `workflow_complete`, an agent-callable finalizer that only succeeds when the active plan has no open checklist tasks and trusted review plus gate evidence is fresh for the current diff.
- Changed repo automation to default off; users must run `/workflow toggle on` before automatic nudges, TUI surfaces, and hook guards activate.

## 0.2.0 - 2026-05-31

### Added

- Added `/workflow bundle` and `workflow_export_evidence` for sanitized bounded markdown evidence bundles under `.pi/runs` / `artifacts.runsDir`.
- Added publishing documentation for installation, compatible Pi version, loaded command verification, schema adoption caveats, troubleshooting, and release checks.

### Notes

- Evidence bundles summarize state and ledger metadata only; raw prompts and large stdout/stderr are intentionally omitted and obvious tokens/secrets are redacted.

## 0.1.0

- Initial pi-workflow-watcher release with workflow status/next/doctor/evidence/note/gate/init/import tools, hooks, schema, and examples.
