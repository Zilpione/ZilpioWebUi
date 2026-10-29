# Concurrent chat runtimes implementation plan

**Goal:** Allow chats to run concurrently using different managed accounts and environments, including across browser tabs and split panels.

**Architecture:** Introduce runtime instances addressed by an opaque identifier and owned by an account/environment pair. Route browser RPC, event streams, approvals, live sessions and auxiliary APIs to the selected instance; persist the association of each chat with its instance. Each runtime must use isolated authentication storage and process state while preserving access to the correct environment's existing history.

**Constraints:** Existing unmanaged installations and existing managed histories remain usable. Never switch an auth file underneath a running process. Token refresh and re-login must not overwrite fresher credentials. A runtime's failure, shutdown, approval IDs and event stream must not affect other runtimes. Browser-provided identifiers must be validated server-side.

## Tasks

1. Design and test account-specific runtime homes and coordinated token refresh, including restart and concurrent processes using the same account. Preserve history and configuration without unsafe filesystem links.
2. Extract the process, pending requests, approvals, turn bookkeeping and restart lifecycle into isolated runtime instances. Test simultaneous replies and failures with colliding request identifiers.
3. Add a runtime registry and persistent chat-to-runtime ownership; validate association on every request and prevent removal of accounts with active runtimes.
4. Route HTTP, WebSocket, SSE, approvals, review, live sessions, project metadata, usage and AutoReload by runtime. Test reconnect, stale responses, switching and process failure independently.
5. Add account and environment selection per chat/panel, scope browser persistence by runtime, and route sidebar navigation to the chat's stored runtime, including separate browser tabs.
6. Run unit, runtime and browser regressions, then exercise two real authenticated accounts in different environments concurrently when credentials are available.
