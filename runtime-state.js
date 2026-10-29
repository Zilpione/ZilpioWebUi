// Mutable state belongs to one app-server process, never to the HTTP server.
export function createRuntimeState() {
  let sequence = 1;
  const pending = new Map();
  const approvalRequests = new Map();
  const activeTurns = new Set();
  const startingTurns = new Set();
  const activeTurnIds = new Map();
  const completedTurnIds = new Set();
  const turnThreads = new Map();
  return {
    pending, approvalRequests, activeTurns, startingTurns, activeTurnIds, completedTurnIds, turnThreads,
    nextRequestId: () => sequence++,
    clearActivity() {
      activeTurns.clear(); activeTurnIds.clear(); completedTurnIds.clear();
      approvalRequests.clear(); turnThreads.clear();
    },
  };
}
