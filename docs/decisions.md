# Decisions

One file, append only. Take the next free number; if two branches take the same one, the second to merge renumbers. Each entry links its plan when there is one, and the plan gets a "Landed in ADR-NNNN" line at its top. Copy the format from [templates/adr.md](templates/adr.md).

Decisions up to version 1.0.0 are in [HANDOFF.md](HANDOFF.md), numbered by section; the owner's decisions are in sections 2, 9, 16, 18, 20, 23, 37 and 38, and every other section ends with what was decided in it. New decisions go here.

## ADR-0001: Adopt the Agentic SDLC harness template

- Date: 2026-11-26
- Status: accepted
- Context: coding agents work on this repo and need the same rules, flow and checks whatever the tool. Until now the rules lived in `CLAUDE.md`, in Spanish, and every change went straight to `main`.
- Decision: use the Agentic SDLC harness template (version in `.harness-version`): `AGENTS.md` in English as the single source, skills and roles in `.agents/` and `.claude/`, specs before code for new features, draft pull requests into a protected `main`, Linear as the tracker, and quality checks in CI. The rules the code already followed became INV-006 onwards in `invariants.md`.
- Consequences: harness changes need a person's review; template upgrades arrive through `update-harness`. The repository moves to English (ALB-348, ALB-353, ALB-355).
