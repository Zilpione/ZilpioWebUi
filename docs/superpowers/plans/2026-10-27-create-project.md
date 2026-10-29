# Create project folders

User request: add **Aggiungi progetto** to create a project from the web panel. Existing projects are directories independent of selected environment/account. Add a name field in the project picker and create a child directory under the currently viewed project folder; select it for the next new chat after successful creation. Creation does not restart Codex or switch environment/account. Plain folder only, no automatic Git initialization.

- [x] Test directory creation, name/path validation, duplicate rejection and authenticated API; implement POST /api/projects backed by folder-service.js.
- [x] Add inline folder creation UI, loading/errors, cancel and automatic selection; verify browser desktop/mobile.
- [x] Full unit/runtime tests, build and review; update live image, preserve existing chats/auth and verify HTTPS.

Verification: 143 unit tests, 10 runtime integration tests, build checks and real desktop/mobile browser flow pass. Independent review found pending-request picker-session race; fixed with generation invalidation and regression coverage. Duplicate creation preserves existing content, directory creation never changes account/environment/revision.

Rollout complete: live health and HTTPS 200, creation button served, authenticated creation validation 400 for empty name. Preview container and temporary credentials removed.
