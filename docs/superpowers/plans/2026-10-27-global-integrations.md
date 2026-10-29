# Global integrations implementation plan

Goal: persistent shared SSH credentials and Telegram job notifications, accessible from settings.
Architecture: store secrets in the existing persistent webui state directory with restricted permissions; expose authenticated API endpoints and inject a shared Git SSH wrapper into application child processes. Send Telegram notifications from turn completion events.
Tech stack: Bun, Node-compatible APIs, existing vanilla browser UI.

1. Add tests for secret storage, key validation, removal, and Telegram delivery, then implement the service.
2. Connect authenticated routes, runtime Git environment and completion notifications.
3. Add settings controls and top-left gear; verify build, targeted tests and existing checks.
