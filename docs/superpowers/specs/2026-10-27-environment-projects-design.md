# Separate environments from project folders

User approved correction: El and zilpio are environments selecting independent chat histories, while a project is simply a selectable folder. Account selection remains independent. Preserve existing .El/.zilpio data and auth vault; no migration/deletion of chats.

Existing storage metadata workspaceId stays internal for backward compatibility. Public APIs expose environmentId and environments [{id,label}], with no project paths attached. Project roots are separate existing mounted el/zilpio directories; allow either root and its subdirectories in either environment. Default working folder is stable across environments. The browser remembers its selected folder across environment/account changes; picking a project does not restart Codex. Chats keep their own working directories.

UI: persistent Ambiente selector in sidebar; account dialog labels environments; generic folder browser restored as Progetto; no environment entries seeded as projects. Folder choice is local to browser, environment/account choices remain shared and revision protected. Hidden authentication/history dirs remain outside browseable project roots.

Implementation choice: keep existing storage helper and revision protocol, expose explicit environment API names, change only coupling sites. Alternative of moving/renaming histories unnecessary and risks existing chats. Test backend multiple folders in same history and same folder across two histories; browser controls and selection persistence; full suite/build and deploy HTTPS.
