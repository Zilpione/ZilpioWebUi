# Two simultaneous chat panels

**Goal:** Open two conversations at once on the current account and environment, each with its own draft, model, project, streaming events, and approval prompts.

**Approach:** Keep the existing main conversation and host a second instance of the same UI in a same-origin panel. Each instance has its own conversation state and bridge connection; the host supplies selection, drag-and-drop, and panel resizing. Prevent the embedded panel from changing the main panel's remembered chat or project. Keep the current server and its single runtime for this phase.

**Verification:** Run the browser regression against a deterministic app-server that accepts overlapping turns on two projects with different models. Assert each panel receives only its own stream and approval, and that each request carries the right thread, model, and project. Exercise opening, closing, dragging, and resizing. Run the existing build and unit suite.
