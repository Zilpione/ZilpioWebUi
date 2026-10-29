# Environment/project separation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate chat-history environments from project working folders.
**Architecture:** Keep account store/history layout; expose environment IDs independently of project roots and per-chat cwd. Frontend has independent controls and preserves local selected folder.
**Tech Stack:** Existing Bun, TypeScript, vanilla JavaScript/CSS, Docker.
**Spec:** docs/superpowers/specs/2026-10-27-environment-projects-design.md

## Global Constraints
El/zilpio chat histories and auth/config paths preserved. Project selection never changes account/environment or process revision. Environment switch never changes selected project. Only mounted project roots may be browsed.

## Review Focus
- Existing chats in either environment may reference either project root.
- Stale browsers remain blocked after shared environment switches.
- Folder navigation cannot browse auth/history dirs, including via parent or symlinks.
- Saved project selection survives environment switch and page reload.
- No automatic history migration or deletion.

### Task 1: Backend
- [x] Add failing runtime integration assertions: explicit environments without folder paths, stable defaultCwd across environment switches, multiple nested project cwd in either environment with unchanged revision for project choice.
- [x] Split project roots/default cwd from history selection in server.ts; keep internal account-store workspace compatibility. Run integration tests green.

### Task 2: Frontend
- [x] Add regression tests for environment controls not invoking folder setters and independent folder picker.
- [x] Restore generic project browser, remove seeded environment projects, add Ambiente selector, preserve local project across reload, use environmentId API.

### Task 3: Verify and deploy
- [x] Full unit suite/build, independent review, browser desktop/mobile project vs environment changes.
- [x] Commit changes, update live checkout/image, restart if no active turns, verify HTTPS/current state and preserved histories.

## Verification
137 unit tests and 9 runtime integration tests pass. Independent review identified hidden sidebar switch errors; fixed with a visible toast and regression test. Real browser verified project selection leaves runtime unchanged, environment changes preserve selected project, nested folder browsing, virtual root navigation, reload persistence and mobile selector.

Rollout verified: HTTPS 200, healthy Codex, zero container restarts; previous session files, saved accounts and selected environment/account preserved. Preview container and temporary credential copies removed.
