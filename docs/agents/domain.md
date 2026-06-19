# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout for this repo

This repo is configured as **single-context**.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## ADR status

ADR `status` frontmatter is part of the contract:

- **`accepted`** ADRs are in-force architecture.
- ADRs with **no status frontmatter** are legacy ADRs — treat them as `accepted`.
- **`proposed`** ADRs are planning context, not in-force architecture. Use them only when they belong to the plan or issue you're working on.
- **`deprecated`** and **`superseded by ADR-NNNN`** ADRs are historical — don't build new work around them except to explain why they changed.

When you create an ADR during planning, start it as `proposed`; promote it to `accepted` only after the implementing work lands.

## File structure

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an accepted ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
