# Accounts and usage implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship account management, usage bars and two isolated workspace histories.
**Architecture:** Existing Bun bridge retained; secure local account vault plus workspace CODEX_HOME. Frontend uses authenticated HTTP APIs.
**Tech Stack:** Bun, TypeScript, vanilla JS/CSS, Docker Compose, Codex app-server 0.164.0.
**Spec:** docs/superpowers/specs/2026-10-27-accounts-usage-design.md

## Global Constraints
Preserve default .codex; auth only in .codex-logins; histories .El and .zilpio; only El/zilpio workspaces; default configuration shared; no credentials in browser responses or logs.

## Review Focus
- Failed login leaves active account unchanged.
- Concurrent switches and running turns cannot cross accounts/workspaces.
- Missing weekly quotas do not appear as 100% remaining.
- Global browser selections cannot run a stale thread in another workspace.
- Authentication and default configuration survive redeployment.

### Task 1: Vault and workspace configuration
Files: account-store.ts, tests/account-store.test.ts.
- [x] Write tests for import, permissions, sanitized account list, path validation, removal, config sharing and chat separation; run RED.
- [x] Implement AccountStore with auth-only vault and separate metadata, workspace runtime setup; run GREEN.

### Task 2: Frontend
Files: public/account-panel.js, public/usage-bars.js, public/index.html, public/style.css, public/app.js, tests/account-panel.test.ts.
- [x] Test quotas (primary/secondary reversed, null, percentages clamped, reset units), render two bars and account/workspace controls.
- [x] Implement endpoint calls and refresh, account add/cancel/rename/remove/switch and El/zilpio selectors; verify browser/mobile.

### Task 3: Bridge integration
Files: codex-login.ts, server.ts, profile-service.ts, tests/runtime.integration.test.ts.
- [x] Test unauthorized management, login lifecycle, switch validation/busy guard, restore on failure, unchanged default auth.
- [x] Implement device login isolated process, vault persistence, serial restart, authenticated APIs and real quota query; run unit/integration checks.

### Task 4: Deploy
Files: Docker Compose stack, README.md, package.json.
- [x] Run full tests, check build, independent review and resolve material findings.
- [x] Copy tested files to deployed checkout, persist .codex-logins/.El/.zilpio/.webui mounts, restart container.
- [x] Verify HTTPS, two folders, actual quota response, account list and healthy Codex. New account OAuth left for user.

## Verification record
Independent review found crash-state, stale-browser revision, and active-account reauthentication races; all fixed with regression coverage. Unit suite: 130 passing; runtime integration: 7 passing; build check passing. Browser desktop/mobile: quota bars, El/zilpio switch, real device-login start/cancel, no page errors or horizontal overflow.
