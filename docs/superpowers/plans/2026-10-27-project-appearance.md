# Project appearance implementation plan

Spec: docs/superpowers/specs/2026-10-27-project-appearance-design.md

- [x] Implement persistent ProjectStore, test color/icon/path validation, save/reload, reversible hide, and unchanged files.
- [x] Add authenticated project list/update/hide/register routes, register created folders; events refresh all clients without changing runtime.
- [x] Add project settings UI, style project rows, list empty registered projects, preserve hidden-project chats under Altre chat, restore removed projects.
- [x] Run unit/integration/browser tests and independent review, deploy, verify data and HTTPS.

Verification: 155 unit tests and 11 integration tests pass, build check passes. Independent review found dirty form refresh and missing historical folder removal issues; both fixed with regressions. Browser confirms shared style updates, persisted appearance, removal retaining file and chats under Altre chat, restore manager, mobile layout and unchanged runtime.

Live rollout verified: healthy Codex, GET projects 200, invalid path update denied, HTTPS 200 and settings dialog deployed. Preview credentials/container removed.
