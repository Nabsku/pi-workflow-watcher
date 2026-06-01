# Changelog

## Unreleased

## 0.2.0 - 2026-05-31

### Added

- Added `/workflow bundle` and `workflow_export_evidence` for sanitized bounded markdown evidence bundles under `.pi/runs` / `artifacts.runsDir`.
- Added publishing documentation for installation, compatible Pi version, loaded command verification, schema adoption caveats, troubleshooting, and release checks.

### Notes

- Evidence bundles summarize state and ledger metadata only; raw prompts and large stdout/stderr are intentionally omitted and obvious tokens/secrets are redacted.

## 0.1.0

- Initial pi-workflow-watcher release with workflow status/next/doctor/evidence/note/gate/init/import tools, hooks, schema, and examples.
