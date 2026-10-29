import { repositoryChanges, repositorySync, fetchRepository, pullRepository, pushRepository, repositoryBranch, repositoryDiffs, discardRepositoryChange, commitRepository, commitAndPush, repositoryStatus, listRepositories, assignRepository, detachRepository, pushInitial } from "./project-repository.js";
import { createReadStream, existsSync, readFileSync, mkdirSync, linkSync, statSync, realpathSync, lstatSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, resolve, extname, dirname, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { createProjectFolder, defaultBrowseRoots, isDirectory, listFolders, resolveBrowsePath } from "./folder-service.js";
import { applyReviewPatch } from "./review-service.js";
import { ReviewDiffStore, parseReviewPatchRequest } from "./review-state.js";
import { unifiedDiffFromFileChanges } from "./public/codex-surfaces.js";
import { rpcErrorPayload } from "./public/bridge-errors.js";
import { createTerminalSession, normalizeTerminalResize, resolveTerminalCwd } from "./terminal-service.js";
import { readWorkspaceContext } from "./workspace-context.js";
import { searchWorkspaceFiles } from "./file-search.js";
import { resolveLocalFile } from "./file-service.js";
import { resolveLocalImage } from "./image-service.js";
import { LiveSessionStore } from "./live-session-service.js";
import {
  createPasswordSession,
  createStoredPassword,
  isAllowedBrowserRpcMethod,
  isAuthorizedHttpRequest,
  isRequestAuthorized,
  loginDelayMs,
  passwordSessionCookie,
  resolvePublicAsset,
  resolveSafeRegularFile,
  storedPasswordSessionSecret,
  unauthorizedResponse,
  verifyStoredPassword,
} from "./server-security.js";
import { loadStoredPassword, passwordStorePath, saveStoredPassword, type StoredPassword } from "./password-store.js";
import {
  createAccountIdentityLoader,
  fetchProfileAvatar,
  isLocalAccountRequest,
  resolveAccountIdentity,
  toPublicAccountIdentity,
} from "./profile-service.js";

import { installRollout, rolloutHash } from "./rollout-transfer.js";
import { ThreadOwnership, ensureSafeDirectory } from "./thread-ownership.js";
import { AccountStore } from "./account-store.ts";
import { migrateToZilpio } from "./zilpio-migration.ts";
import { DeviceLogin } from "./codex-login.ts";
import { EnvironmentProjectStores, ProjectStore } from "./project-store.ts";
import { GlobalIntegrations } from "./global-integrations.js";
import { GitHubAccounts } from "./github-accounts.js";
import { AutoReloadService, findAutoReloadMessage, localAutoReloadScope } from "./auto-reload.js";
import { isUsageLimitError } from "./public/codex-notifier.js";
import { CodexRuntime } from "./codex-runtime.js";
import { createRuntimeState } from "./runtime-state.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8899);
const accessToken = process.env.CODEX_WEBUI_ACCESS_TOKEN || null;
const environmentPassword = process.env.CODEX_WEBUI_PASSWORD || null;
const managedPasswordPath = passwordStorePath();
let managedPassword: StoredPassword | null = environmentPassword || accessToken ? null : loadStoredPassword(managedPasswordPath);
let authSecret = environmentPassword || accessToken || storedPasswordSessionSecret(managedPassword);
let passwordSetupInProgress = false;
let passwordLoginInProgress = false;
let passwordLoginAttempts = 0;
const localhostOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
const appRoot = existsSync(resolve(import.meta.dir, "public")) ? import.meta.dir : resolve(import.meta.dir, "..");
const publicDir = resolve(appRoot, "public");
const homeDir = process.env.HOME || process.cwd();
const managedAccounts = process.env.CODEX_WEBUI_MANAGED_ACCOUNTS === "true";
const projectless = !managedAccounts && process.env.CODEX_WEBUI_PROJECTLESS === "true";
const workspaceBase = resolve(process.env.CODEX_WEBUI_WORKSPACE_BASE || homeDir);
// Zilpio is the only environment. Both mounted project roots remain accessible.
const projectRoots = [resolve(workspaceBase, "el"), resolve(workspaceBase, "zilpio")];
if (managedAccounts) for (const path of projectRoots) mkdirSync(path, { recursive: true });
const workspaces = [
  { id: "zilpio", label: "Zilpio", path: projectRoots[1], codexHome: resolve(workspaceBase, ".zilpio") },
];
const defaultCodexHome = resolve(process.env.CODEX_HOME || resolve(homeDir, ".codex"));
if (managedAccounts) migrateToZilpio(workspaceBase);
const accountStore = managedAccounts ? new AccountStore({
  defaultHome: defaultCodexHome,
  loginsDir: resolve(workspaceBase, ".codex-logins"),
  stateDir: resolve(workspaceBase, ".webui"),
  workspaces,
}) : null;
let runtime: {codexHome: string; cwd: string} | null = null;
if (accountStore) {
  accountStore.prepare();
  const selection = accountStore.getState();
  runtime = accountStore.prepareWorkspace(selection.accountId, selection.workspaceId);
  process.env.CODEX_HOME = runtime.codexHome;
}
const configuredReviewRoot = process.env.CODEX_WEBUI_REVIEW_ROOT || null;
const ntfyTopic = process.env.CODEX_WEBUI_NTFY_TOPIC || null;
const ntfyUrl = (process.env.CODEX_WEBUI_NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
if (projectless && !configuredReviewRoot) {
  throw new Error("CODEX_WEBUI_REVIEW_ROOT is required when CODEX_WEBUI_PROJECTLESS=true");
}
const defaultCwd = resolve(process.env.CODEX_WEBUI_CWD || (managedAccounts ? projectRoots[1] : projectless ? homeDir : appRoot));
const browseRoots = managedAccounts ? projectRoots : defaultBrowseRoots(homeDir);
if (managedAccounts) resolveBrowsePath(defaultCwd, browseRoots, homeDir);
const integrations = new GlobalIntegrations(resolve(workspaceBase, ".webui"));
const githubAccounts = new GitHubAccounts({ dir: resolve(workspaceBase, ".webui"), gh: process.env.CODEX_WEBUI_GH_BIN || "gh" });
process.env.CODEX_WEBUI_GIT_IDENTITY = integrations.keyPath;
process.env.CODEX_WEBUI_KNOWN_HOSTS = resolve(workspaceBase, ".webui", "git-known-hosts");
process.env.GIT_SSH = resolve(appRoot, "git-ssh-wrapper.sh");
const projectStoreFile = resolve(workspaceBase, ".webui", "projects.json");
const environmentProjects = accountStore ? new EnvironmentProjectStores({ file: projectStoreFile, roots: browseRoots, environmentIds: workspaces.map(w => w.id), initialEnvironment: accountStore.getState().workspaceId }) : null;
const sharedProjects = environmentProjects ? null : new ProjectStore({ file: projectStoreFile, roots: browseRoots });
function currentProjectStore() { return environmentProjects ? environmentProjects.get(accountStore!.getState().workspaceId) : sharedProjects!; }
function applyProjectInstructions(params: any) {
  if (typeof params.cwd !== 'string') return;
  const project = currentProjectStore().list().find(p => !p.hidden && p.path === resolve(params.cwd));
  if (project?.instructions) params.developerInstructions = [params.developerInstructions, project.instructions].filter(Boolean).join('\n\n');
}

const imageRoots = [...new Set([...browseRoots, resolve(tmpdir()), resolve("/tmp")])];
const fileRoots = [...new Set([...browseRoots, defaultCwd, resolve(tmpdir()), resolve("/tmp")])];
const reviewRoots = managedAccounts ? projectRoots : [resolve(configuredReviewRoot || defaultCwd)];
const clients = new Set<WebSocket>();
const sseClients = new Set<ServerResponse>();
const terminalSessions = new Map<WebSocket, ReturnType<typeof createTerminalSession>>();
const runtimeState = createRuntimeState();
const { pending, approvalRequests, activeTurns, startingTurns, activeTurnIds, completedTurnIds, turnThreads } = runtimeState;
const reviewDiffs = new ReviewDiffStore();
const liveSessions = new LiveSessionStore();
const threadPaths = new Map<string, string>();
let codexSessionsRoot = resolve(runtime?.codexHome || defaultCodexHome, "sessions");
let codex: ChildProcessWithoutNullStreams | null = null;
let stdoutBuffer = "";
let connected = false;
let shuttingDown = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let httpClosed = false;
let accountShutdownPending = 0;
let runtimeChanging = false;
let runtimeRevision = randomUUID();
const webuiInstanceId = randomUUID();
let mutatingRequests = 0;
let browserDispatches = 0;
const accountProcesses = new Map<string, Promise<any>>();
const threadAccounts = new Map<string, string>();
const ownership = accountStore ? new ThreadOwnership(resolve(workspaceBase, ".webui", "thread-ownership.json")) : null;
const hiddenThreads = ownership || new ThreadOwnership(resolve(workspaceBase, ".webui", "hidden-threads.json"));
const threadProjects = new ThreadOwnership(resolve(workspaceBase, ".webui", "thread-projects.json"));
function threadEnvironment() { return accountStore?.getState().workspaceId || 'default'; }
function threadOwner(id: string) { return ownership?.owner(accountStore!.getState().workspaceId, id); }
function rememberAccountThreads(result: any, accountId: string) {
  for (const thread of [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])]) {
    if (typeof thread?.id === 'string') { ownership?.remember(accountStore!.getState().workspaceId, thread.id, accountId); threadAccounts.set(thread.id, threadOwner(thread.id) || accountId); }
  }
}
function filterOwnedThreads(result: any, accountId: string) {
  if (!Array.isArray(result?.data)) return result;
  return {...result, data:result.data.filter((thread: any) => !hiddenThreads.isHidden(threadEnvironment(), thread?.id) && !ownership?.isDeleted(accountStore!.getState().workspaceId, thread?.id) && (!threadOwner(thread?.id) || threadOwner(thread.id) === accountId)).map((thread: any) => ({...thread, accountId:threadOwner(thread.id) || accountId}))};
}
function applyThreadProject(result: any) {
  const apply = (thread: any) => { const project = threadProjects.project(threadEnvironment(), thread?.id); return project ? {...thread, cwd:project, projectless:false} : thread; };
  if (result?.thread) result = {...result, thread:apply(result.thread)};
  if (Array.isArray(result?.data)) result = {...result, data:result.data.map(apply)};
  return result;
}
function selectedAccountId() { return accountStore?.getState().accountId || ""; }
function getAccountProcess(accountId: string) {
  if (!accountStore || !accountStore.getState().accounts.some(account => account.id === accountId)) throw new Error("Account sconosciuto");
  const existing = accountProcesses.get(accountId); if (existing) return existing;
  const start = (async () => {
    const workspaceId = accountStore.getState().workspaceId;
    const home = accountStore.prepareAccountRuntime(accountId, workspaceId);
    const env = { ...process.env, CODEX_HOME: home.codexHome };
    delete env.CODEX_AUTH_PATH; delete env.OPENAI_API_KEY;
    const instance = new CodexRuntime({ cwd: home.cwd, env, args: ["app-server", "--stdio", "-c", 'cli_auth_credentials_store="file"'] });
    instance.workspaceId = workspaceId;
    instance.browserApprovals = new Map();
    instance.on('message', (message: any) => {
      let threadId=message.params?.threadId;const turnId=message.params?.turnId || message.params?.turn?.id;
      if (typeof threadId === 'string' && typeof turnId === 'string') instance.state.turnThreads.set(turnId,threadId);
      else if (typeof turnId === 'string' && instance.state.turnThreads.has(turnId)) message={...message,params:{...message.params,threadId:instance.state.turnThreads.get(turnId)}};
      threadId=message.params?.threadId;
      if (message.method === 'turn/started' && threadId) markAccountTurnStarted(instance,threadId,turnId);
      if (message.method === 'turn/completed' && threadId) markAccountTurnCompleted(instance,threadId,turnId);
      if (message.method === 'turn/diff/updated') reviewDiffs.record(message.params || {});
      if (message.method === 'item/fileChange/patchUpdated') recordFileChangeDiff(message.params || {});
      if (message.method === 'item/completed' && message.params?.item?.type === 'fileChange') recordFileChangeDiff({...message.params,changes:message.params.item.changes});
      if (message.method === 'serverRequest/resolved') {
        for (const [token, nativeId] of instance.browserApprovals) if (nativeId === message.params?.requestId) {instance.browserApprovals.delete(token);broadcast({type:'codex/request/resolved',accountId,requestId:token});}
      }
      if (message.method && message.id !== undefined) {const token=randomUUID();instance.browserApprovals.set(token,message.id);broadcast({type:'codex/request',accountId,payload:{...message,id:token}});}
      else if (message.method) broadcast({type:'codex/notification',accountId,payload:message});
    });
    instance.on('exit', () => {instance.browserApprovals.clear();broadcast({type:'codex/account-disconnected',accountId});});
    instance.on('ready', () => broadcast({type:'codex/account-connected',accountId}));
    instance.on('stderr', (data: string) => console.error('[codex account app-server]', data.trimEnd()));
    instance.on('processError', () => console.error('[codex account app-server] process unavailable'));
    try { await instance.start(); return instance; }
    catch (error) { await instance.stop(); throw error; }
  })();
  accountProcesses.set(accountId,start);
  start.catch(() => { if (accountProcesses.get(accountId) === start) accountProcesses.delete(accountId); });
  return start;
}
type CodexRequestId = number | string;
function markAccountTurnStarted(instance:any, threadId:string, turnId:unknown) {
  if (typeof turnId === 'string' && instance.state.completedTurnIds.has(turnId)) return;
  if (typeof turnId === 'string') instance.state.activeTurnIds.set(threadId,turnId);
  instance.state.activeTurns.add(threadId);
}
function markAccountTurnCompleted(instance:any, threadId:string, turnId:unknown) {
  if (typeof turnId === 'string') {
    instance.state.completedTurnIds.add(turnId);
    if (instance.state.completedTurnIds.size > 2000) instance.state.completedTurnIds.delete(instance.state.completedTurnIds.values().next().value);
    if (instance.state.activeTurnIds.has(threadId) && instance.state.activeTurnIds.get(threadId) !== turnId) return;
  }
  instance.state.activeTurnIds.delete(threadId);instance.state.activeTurns.delete(threadId);
}
function isCodexRequestId(value: unknown): value is CodexRequestId {
  return Number.isSafeInteger(value) || (typeof value === "string" && value.length > 0);
}
function rememberTurnThread(turnId: string, threadId: string) {
  turnThreads.set(turnId, threadId);
  if (turnThreads.size > 2000) turnThreads.delete(turnThreads.keys().next().value!);
}
function markTurnStarted(threadId: string, turnId: unknown) {
  if (typeof turnId === "string" && completedTurnIds.has(turnId)) return;
  if (typeof turnId === "string") activeTurnIds.set(threadId, turnId);
  activeTurns.add(threadId);
}
function markTurnCompleted(threadId: string, turnId: unknown) {
  if (typeof turnId === "string") {
    completedTurnIds.add(turnId);
    if (completedTurnIds.size > 2000) completedTurnIds.delete(completedTurnIds.values().next().value!);
    if (activeTurnIds.has(threadId) && activeTurnIds.get(threadId) !== turnId) return;
  }
  activeTurnIds.delete(threadId); activeTurns.delete(threadId);
}
const deviceLogin = accountStore ? new DeviceLogin({ onAuth: async (auth) => {
  const existing = accountStore.findAuthAccount(auth);
  if (existing && accountProcesses.has(existing.id)) {
    if (runtimeChanging) throw new Error("Runtime busy");
    runtimeChanging = true;
    try {
      const instance = await accountProcesses.get(existing.id);
      if (instance.state.activeTurns.size || instance.state.startingTurns.size || instance.state.approvalRequests.size || instance.state.pending.size) throw new Error("Runtime busy");
      await instance.stop(); accountStore.saveAccountRuntimeAuth(existing.id,instance.workspaceId); accountProcesses.delete(existing.id);
    } finally { runtimeChanging = false; }
  }
  if (!existing?.active) { accountStore.addAuth(auth); return; }
  if (runtimeChanging || mutatingRequests || activeTurns.size || approvalRequests.size || terminalSessions.size) throw new Error("Runtime busy");
  const selected = accountStore.getState();
  runtimeChanging = true;
  try {
    await stopCodexForSwitch();
    accountStore.saveRuntimeAuth(selected.accountId, selected.workspaceId);
    accountStore.addAuth(auth);
    runtime = accountStore.prepareWorkspace(selected.accountId, selected.workspaceId, { preserveRefresh: false });
    startCodex(); await waitForCodex();
    accountLoader.invalidate(); runtimeRevision = randomUUID();
    broadcast({ type: "runtime/changed", ...getRuntimeState() });
  } finally {
    runtimeChanging = false;
    if (!codex) startCodex();
    autoReload.kick();
  }
} }) : null;
function getRuntimeState() {
  const { workspaceId, workspaces, accounts, accountId } = accountStore!.getState();
  return { accountId, accounts, environmentId: workspaceId, environments: workspaces.map(({id,label}) => ({id,label})), runtimeRevision };
}
const accountLoader = createAccountIdentityLoader(async (refresh) => {
  const account = await request("account/read", { refreshToken: refresh });
  if (accountStore) {
    const selected = accountStore.getState().accounts.find(a => a.active);
    return { type: account.account?.type || "unknown", displayName: selected?.label || "Account", imageUrl: null,
      email: selected?.email || null, planType: account.account?.planType || selected?.planType || null,
      initials: (selected?.label || "?").slice(0, 2).toUpperCase() } as any;
  }
  return resolveAccountIdentity(account);
});

function autoReloadScope() {
  if (!accountStore) {
    let auth: any = null;
    try { auth = JSON.parse(readFileSync(process.env.CODEX_AUTH_PATH || resolve(defaultCodexHome, "auth.json"), "utf8")); } catch {}
    return localAutoReloadScope({ auth, apiKey: process.env.OPENAI_API_KEY }) || "local:unavailable";
  }
  const selected = accountStore.getState();
  return JSON.stringify([selected.workspaceId, selected.accountId]);
}
const autoReload = new AutoReloadService({
  file: resolve(workspaceBase, ".webui", "auto-reload.json"),
  scope: autoReloadScope,
  available: () => connected && !runtimeChanging && !shuttingDown && autoReloadScope() !== "local:unavailable",
  busy: (threadId: string) => activeTurns.has(threadId) || startingTurns.has(threadId),
  readUsage: () => request("account/rateLimits/read"),
  start: async (threadId: string, messageId: string, expectedScope: string, canStart: () => boolean, markDispatch: () => void, recovering: boolean) => {
    if (!connected || runtimeChanging || autoReloadScope() !== expectedScope || activeTurns.has(threadId) || startingTurns.has(threadId) || (managedAccounts && (ownership?.linkIntent(accountStore!.getState().workspaceId, threadId) || ownership?.isDeleted(accountStore!.getState().workspaceId, threadId) || (threadOwner(threadId) && threadOwner(threadId) !== selectedAccountId())))) throw new Error("Chat non disponibile");
    startingTurns.add(threadId);
    mutatingRequests++;
    try {
      const result = await request("thread/resume", { threadId });
      if (!connected || runtimeChanging || autoReloadScope() !== expectedScope) throw new Error("Chat non disponibile");
      if (recovering && await findAutoReloadMessage(request, threadId, messageId)) return result?.thread || {};
      if (!canStart()) return { autoReloadCanceled: true };
      if (activeTurns.has(threadId) || result?.thread?.status?.type === "active") throw new Error("Chat già attiva");
      markDispatch();
      let started;
      try { started = await request("turn/start", { threadId, clientUserMessageId: messageId, input: [{ type: "text", text: "riparti" }] }); }
      catch (error) { if (isUsageLimitError(error)) autoReload.fail(threadId); throw error; }
      if (typeof started?.turn?.id === "string") rememberTurnThread(started.turn.id, threadId);
      if (started?.turn?.status === "inProgress") markTurnStarted(threadId, started.turn.id);
      return result?.thread || {};
    } finally { startingTurns.delete(threadId); mutatingRequests--; }
  },
  notify: async (threadId: string, thread: any) => {
    if (!integrations.telegram().enabled) return;
    const name = typeof thread?.name === "string" && thread.name.trim() ? thread.name.trim().slice(0, 120) : threadId.slice(0, 8);
    await integrations.send(`AutoReload: la chat “${name}” è ripartita. Messaggio inviato: riparti.`);
  },
  onChange: (snapshot: any) => broadcast({ type: "auto-reload/changed", ...snapshot, ...(managedAccounts ? { runtimeRevision } : {}) }),
});

const reconciledEnvironments = new Set<string>();
function recoverEnvironmentIntents(environment: string) {
  if (!ownership) return;
  for (const item of ownership.pendingIntents(environment)) {
    try { reconcileThreadLinkIntent(environment, item.threadId, item.accountId); }
    catch { console.error('[codex-webui] interrupted thread transfer requires recovery'); }
  }
  reconciledEnvironments.add(environment);
}
function startCodex() {
  if (shuttingDown) return;
  if (ownership && !runtimeChanging) {
    const environment = accountStore!.getState().workspaceId;
    if (!reconciledEnvironments.has(environment)) recoverEnvironmentIntents(environment);
  }
  if (codex && codex.exitCode === null) return;
  const childEnv = { ...process.env };
  if (managedAccounts) {
    delete childEnv.CODEX_AUTH_PATH;
    delete childEnv.OPENAI_API_KEY;
  }
  const child = spawn("codex", ["app-server", "--stdio", ...(managedAccounts ? ["-c", 'cli_auth_credentials_store="file"'] : [])], {
    cwd: defaultCwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  codex = child;
  connected = false;
  stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const pos = stdoutBuffer.indexOf("\n");
      if (pos < 0) break;
      const line = stdoutBuffer.slice(0, pos).trim();
      stdoutBuffer = stdoutBuffer.slice(pos + 1);
      if (!line) continue;
      try { handleCodex(JSON.parse(line)); }
      catch (error) { console.error("[codex-webui] invalid app-server JSON:", line, error); }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => console.error("[codex app-server]", String(data).trimEnd()));
  child.on("exit", (code, signal) => {
    connected = false;
    runtimeState.clearActivity();
    if (managedAccounts && !runtimeChanging && !shuttingDown) runtimeRevision = randomUUID();
    accountLoader.invalidate();
    reviewDiffs.clear();
    if (!runtimeChanging) broadcast({ type: "bridge/status", ...(managedAccounts ? { runtimeRevision } : {}), status: "disconnected", code, signal });
    for (const item of pending.values()) item.reject(new Error("Codex app-server exited"));
    pending.clear();
    if (codex === child) codex = null;
    if (shuttingDown) maybeFinishShutdown();
    else if (!runtimeChanging) restartTimer = setTimeout(startCodex, 1000);
  });
  initialize().catch((error) => {
    console.error("[codex-webui] initialize failed", error);
    terminateCodex();
  });
}

function terminateCodex(signal: NodeJS.Signals = "SIGTERM") {
  const child = codex;
  if (!child || child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; }
    catch { /* Fall back to terminating the wrapper process. */ }
  }
  child.kill(signal);
}

function maybeFinishShutdown() {
  if (shuttingDown && httpClosed && !codex && !accountShutdownPending) process.exit(0);
}

function sendRaw(message: any) {
  if (shuttingDown) throw new Error("Codex WebUI is shutting down");
  startCodex();
  codex!.stdin.write(JSON.stringify(message) + "\n");
}

function request(method: string, params: any = {}) {
  const id = runtimeState.nextRequestId();
  sendRaw({ id, method, params });
  return new Promise<any>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex request timed out: ${method}`));
    }, 30000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

async function initialize() {
  const result = await request("initialize", {
    clientInfo: { name: "codex-webui", title: "Codex WebUI", version: "0.2.0" },
    capabilities: { experimentalApi: true },
  });
  sendRaw({ method: "initialized", params: {} });
  if (typeof result?.codexHome === "string") codexSessionsRoot = resolve(result.codexHome, "sessions");
  connected = true;
  if (!runtimeChanging) broadcast({ type: "bridge/status", ...(managedAccounts ? { runtimeRevision } : {}), status: "connected", info: result });
  autoReload.kick();
}

function handleCodex(message: any) {
  if (message.method && message.params && typeof message.params === "object") {
    const params = message.params;
    const turnId = params.turnId || params.turn?.id;
    if (typeof turnId === "string" && typeof params.threadId === "string") {
      rememberTurnThread(turnId, params.threadId);
    } else if (typeof turnId === "string" && turnThreads.has(turnId)) {
      message = { ...message, params: { ...params, threadId: turnThreads.get(turnId) } };
    }
  }
  if (message.id !== undefined && ("result" in message || "error" in message)) {
    const item = pending.get(Number(message.id));
    if (item) {
      pending.delete(Number(message.id));
      if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else item.resolve(message.result);
      return;
    }
  }
  if (message.id !== undefined && message.method) {
    if (!isCodexRequestId(message.id)) return;
    approvalRequests.set(message.id, message);
    broadcast({ type: "codex/request", payload: message });
    return;
  }
  if (message.method) {
    if (message.method === "serverRequest/resolved") {
      const requestId = message.params?.requestId;
      if (isCodexRequestId(requestId)) {
        approvalRequests.delete(requestId);
        broadcast({ type: "codex/request/resolved", requestId });
      }
    }
    if (message.method === "turn/started" && message.params?.threadId) markTurnStarted(message.params.threadId, message.params.turn?.id);
    if (message.method === "turn/completed" && message.params?.threadId) markTurnCompleted(message.params.threadId, message.params.turn?.id);
    if (!runtimeChanging && message.method === "error" && message.params?.willRetry !== true && isUsageLimitError(message.params?.error)) autoReload.fail(message.params?.threadId, message.params?.turnId);
    if (!runtimeChanging && message.method === "turn/completed" && message.params?.turn?.status === "failed" && isUsageLimitError(message.params.turn.error)) autoReload.fail(message.params.threadId, message.params.turn.id);
    if (message.method === "turn/completed") autoReload.kick();
    if (message.method === "account/updated") { accountLoader.invalidate(); if (!accountStore) { autoReload.kick(); broadcast({ type: "auto-reload/changed", ...autoReload.snapshot() }); } }
    if (message.method === "turn/diff/updated") reviewDiffs.record(message.params || {});
    if (message.method === "item/fileChange/patchUpdated") recordFileChangeDiff(message.params || {});
    if (message.method === "item/completed" && message.params?.item?.type === "fileChange") {
      recordFileChangeDiff({ ...message.params, changes: message.params.item.changes });
    }
    if (message.method === "turn/completed") {
      notifyNtfyTurnCompleted(message.params || {});
      notifyTelegramTurnCompleted(message.params || {}).catch(() => console.error("Telegram notification failed"));
    }
    broadcast({ type: "codex/notification", payload: message });
  }
}

async function notifyTelegramTurnCompleted(params: any) {
  if (!integrations.telegram().enabled) return;
  let chatName = "";
  if (typeof params?.threadId === "string" && params.threadId) {
    try {
      const result = await request("thread/read", { threadId: params.threadId, includeTurns: false });
      const title = [result?.thread?.name, result?.thread?.preview].find(value => typeof value === "string" && value.trim());
      if (title) chatName = title.replace(/\s+/g, " ").trim().slice(0, 110);
    } catch { /* Send the notification with the thread ID if its title cannot be read. */ }
  }
  await integrations.notify({ ...params, chatName });
}

async function notifyNtfyTurnCompleted(params: any) {
  if (!ntfyTopic) return;
  const turnId = typeof params?.turn?.id === "string" ? params.turn.id : "";
  const threadId = typeof params?.threadId === "string" ? params.threadId : "";
  const body = `Codex task completed${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`;
  try {
    await fetch(`${ntfyUrl}/${encodeURIComponent(ntfyTopic)}`, {
      method: "POST",
      headers: { Title: "Codex task completed", Tags: "white_check_mark", ...(turnId ? { "X-Turn-Id": turnId } : {}) },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("ntfy notification failed:", error instanceof Error ? error.message : error);
  }
}

function recordFileChangeDiff({ threadId, turnId, changes }: any) {
  const diff = unifiedDiffFromFileChanges(Array.isArray(changes) ? changes : []);
  if (diff) reviewDiffs.record({ threadId, turnId, diff });
}

function recordReviewDiffsFromRpc(method: string, params: any, result: any) {
  if (!["thread/read", "thread/resume", "thread/turns/list"].includes(method)) return;
  const threadId = result?.thread?.id || params?.threadId;
  const turns = result?.thread?.turns || result?.data || [];
  if (typeof threadId !== "string" || !Array.isArray(turns)) return;
  for (const turn of turns) {
    const changes = (turn?.items || []).flatMap((item: any) => item?.type === "fileChange" && Array.isArray(item.changes) ? item.changes : []);
    const diff = unifiedDiffFromFileChanges(changes);
    if (typeof turn?.id === "string" && diff) reviewDiffs.record({ threadId, turnId: turn.id, diff });
  }
}

function recordThreadPathsFromRpc(result: any) {
  const threads = [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])].filter(Boolean);
  for (const thread of threads) {
    if (typeof thread?.id === "string" && typeof thread?.path === "string") threadPaths.set(thread.id, thread.path);
  }
}

async function readLiveThread(threadId: unknown) {
  if (typeof threadId !== "string" || !threadId) throw new Error("Invalid thread id");
  let path = threadPaths.get(threadId);
  if (!path) {
    const result = await request("thread/read", { threadId, includeTurns: false });
    recordThreadPathsFromRpc(result);
    path = threadPaths.get(threadId);
  }
  if (!path) return { active: false, turn: null, lastEventAt: null };
  const child = relative(codexSessionsRoot, resolve(path));
  const safePath = child && !child.startsWith("..") ? resolveSafeRegularFile(codexSessionsRoot, child) : null;
  if (!safePath) throw new Error("Thread rollout is outside the Codex sessions directory");
  return liveSessions.read(safePath);
}

function broadcast(data: any) {
  if (managedAccounts && data.type?.startsWith('codex/') && data.accountId === undefined) data = {...data, accountId:selectedAccountId()};
  const text = JSON.stringify(data);
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(text);
  for (const client of sseClients) if (!client.writableEnded) client.write(`data: ${text}\n\n`);
}

async function switchThreadAccount(message: any) {
  if (!accountStore || runtimeChanging || message.runtimeRevision !== runtimeRevision) throw new Error("Account o ambiente cambiato: ricarica la pagina.");
  const { threadId, targetAccountId } = message.params || {};
  const source = message.accountId || selectedAccountId();
  if (typeof threadId !== "string" || !threadId || typeof targetAccountId !== "string" || !accountStore.getState().accounts.some(a => a.id === source) || !accountStore.getState().accounts.some(a => a.id === targetAccountId)) throw new Error("Chat o account sconosciuto");
  if (threadOwner(threadId) && threadOwner(threadId) !== source) throw new Error("Account della chat cambiato: ricarica la chat.");
  if (source === targetAccountId) throw new Error("Account già selezionato");
  runtimeChanging = true;
  let targetStarted = false, primaryStopped = false, success = false, linkRegistered = false, linkExists = false;
  const stoppedAccounts = new Set<string>();
  const selected = selectedAccountId();
  const env = accountStore.getState().workspaceId;
  let sourceInstance: any, targetInstance: any;
  try {
    const primaryInvolved = source === selected || targetAccountId === selected;
    if (primaryInvolved && (mutatingRequests || activeTurns.size || startingTurns.size || approvalRequests.size)) throw new Error("Attendi la fine delle attività prima di cambiare account.");
    const drainDeadline = Date.now() + 5000;
    while ((browserDispatches || (primaryInvolved && pending.size)) && Date.now() < drainDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (browserDispatches || (primaryInvolved && (pending.size || mutatingRequests || activeTurns.size || startingTurns.size || approvalRequests.size))) throw new Error("Attendi la fine delle attività prima di cambiare account.");
    if (source !== selected) sourceInstance = await getAccountProcess(source);
    if (targetAccountId !== selected) targetInstance = await getAccountProcess(targetAccountId);
    for (const instance of [sourceInstance, targetInstance].filter(Boolean)) if (instance.state.pending.size || instance.state.activeTurns.size || instance.state.startingTurns.size || instance.state.approvalRequests.size) throw new Error("Attendi la fine delle attività prima di cambiare account.");
    const sourceHome = source === selected ? runtime!.codexHome : sourceInstance.env.CODEX_HOME;
    const targetHome = targetAccountId === selected ? runtime!.codexHome : targetInstance.env.CODEX_HOME;
    const result = await (source === selected ? request("thread/read", {threadId, includeTurns: false}) : sourceInstance.request("thread/read", {threadId, includeTurns: false}));
    if (result?.thread?.id !== threadId || typeof result.thread.path !== "string") throw new Error("Chat non trovata");
    ownership!.remember(env, threadId, source);
    const root = resolve(sourceHome, "sessions"), child = relative(root, resolve(result.thread.path));
    const safe = child && !child.startsWith("..") ? resolveSafeRegularFile(root, child) : null;
    if (!safe) throw new Error("Percorso chat non valido");
    if (source === selected || targetAccountId === selected) { primaryStopped = true; await stopCodexForSwitch(); }
    for (const [id, instance] of [[source, sourceInstance], [targetAccountId, targetInstance]] as any[]) {
      if (!instance) continue;
      await instance.stop(); accountProcesses.delete(id); stoppedAccounts.add(id); accountStore.saveAccountRuntimeAuth(id, instance.workspaceId);
    }
    reconcileThreadLinkIntent(env, threadId, source);
    if (threadOwner(threadId) !== source) throw new Error("Account della chat cambiato: ricarica la chat.");
    const sourceHash = rolloutHash(safe);
    ownership!.registerLink(env, threadId, source, targetAccountId, child, sourceHash, statSync(safe).size, typeof result.thread.name === "string" ? result.thread.name : null); linkRegistered = true;
    const destRoot = resolve(targetHome, "sessions"), dest = resolve(destRoot, child);
    ensureSafeDirectory(destRoot);
    const parent = resolve(dest, ".."); ensureSafeDirectory(parent);
    if (!realpathSync(parent).startsWith(realpathSync(destRoot) + "/") && realpathSync(parent) !== realpathSync(destRoot)) throw new Error("Percorso destinazione non valido");
    if (existsSync(dest) && !resolveSafeRegularFile(destRoot, child)) throw new Error("Percorso destinazione non valido");
    installRollout(safe, dest, ownership!.snapshotHash(env, threadId, targetAccountId));
    linkExists = true;
    ownership!.recordSnapshot(env, threadId, targetAccountId, sourceHash);
    let resumed;
    if (targetAccountId === selected) { startCodex(); await waitForCodex(); targetStarted = true; resumed = await request("thread/resume", {threadId}); }
    else { targetInstance = await getAccountProcess(targetAccountId); targetStarted = true; resumed = await targetInstance.request("thread/resume", {threadId}); }
    if (resumed?.thread?.id !== threadId || typeof resumed.thread.path !== "string") throw new Error("Ripristino chat non riuscito");
    const loaded = resolveSafeRegularFile(destRoot, relative(destRoot, resolve(resumed.thread.path)));
    if (!loaded) throw new Error("Percorso chat ripristinata non valido");
    const sourceBytes = readFileSync(safe), loadedBytes = readFileSync(loaded);
    if (loadedBytes.length < sourceBytes.length || !loadedBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) throw new Error("Cronologia ripristinata diversa");
    if (typeof result.thread.name === "string" && result.thread.name) {
      if (targetAccountId === selected) await request("thread/name/set", {threadId, name:result.thread.name});
      else await targetInstance.request("thread/name/set", {threadId, name:result.thread.name});
      resumed.thread.name = result.thread.name;
    }
    autoReload.remove(threadId);
    ownership!.change(env, threadId, source, targetAccountId); threadAccounts.set(threadId, targetAccountId); threadPaths.delete(threadId);
    success = true;
    return {thread: resumed.thread, accountId:targetAccountId};
  } finally {
    try {
    if (!success && targetStarted) {
      if (targetAccountId === selected) await stopCodexForSwitch();
      else { const instance = await accountProcesses.get(targetAccountId); if (instance) {await instance.stop(); accountStore.saveAccountRuntimeAuth(targetAccountId, instance.workspaceId); accountProcesses.delete(targetAccountId);} }
    }
    if (!success && linkRegistered) { try { reconcileThreadLinkIntent(env, threadId, source, !linkExists); } catch { /* Keep the durable intent until both histories can be reconciled. */ } }
    if (primaryStopped && (!success || source === selected)) { startCodex(); await waitForCodex(); }
    for (const id of stoppedAccounts) if (id !== targetAccountId || !success) await getAccountProcess(id);
    } finally {
      runtimeChanging = false;
      if (success || threadOwner(threadId) !== source) broadcast({type:"thread/account/changed", threadId, accountId:threadOwner(threadId), environmentId:env, runtimeRevision});
      if (primaryStopped && connected) broadcast({type:"bridge/status", runtimeRevision, status:"connected"});
      autoReload.kick();
    }
  }
}

function reconcileThreadLinkIntent(env: string, threadId: string, source: string, untouchedTarget = false) {
const intent = ownership!.linkIntent(env, threadId);
if (intent) {
  const selected = selectedAccountId();
  const homeFor = (id: string) => id === selected ? runtime!.codexHome : resolve(workspaceBase, ".webui", "runtime-homes", id, env);
  const sourceRoot = resolve(homeFor(source), "sessions"), targetRoot = resolve(homeFor(intent.target), "sessions");
  const original = resolveSafeRegularFile(sourceRoot, intent.path), destination = resolveSafeRegularFile(targetRoot, intent.path);
  if (!original) throw new Error("Impossibile verificare la cronologia; riprova dopo il ripristino.");
  if (destination) {
    const sourceBytes = readFileSync(original), targetBytes = readFileSync(destination);
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex"), targetHash = createHash("sha256").update(targetBytes).digest("hex");
    const size = intent.sourceSize;
    const prefixMatches = Number.isSafeInteger(size) && size >= 0 && sourceBytes.length >= size && targetBytes.length >= size &&
      (size === 0 || sourceBytes[size-1] === 10) &&
      createHash("sha256").update(sourceBytes.subarray(0,size)).digest("hex") === intent.sourceHash &&
      sourceBytes.subarray(0,size).equals(targetBytes.subarray(0,size));
    const suffix = Number.isSafeInteger(size) ? targetBytes.subarray(size) : Buffer.alloc(0);
    let suffixValid = suffix.length === 0 || suffix[suffix.length-1] === 10;
    if (suffixValid && suffix.length) { try { for (const line of new TextDecoder("utf-8", {fatal:true}).decode(suffix).split("\n").slice(0,-1)) { const entry = JSON.parse(line); if (entry?.type === "session_meta" && entry?.payload?.id && entry.payload.id !== threadId) throw new Error("Session identity mismatch"); } } catch { suffixValid = false; } }
    if (intent.sourceHash && sourceHash === intent.sourceHash && targetHash === sourceHash) {
      ownership!.recordSnapshot(env, threadId, intent.target, targetHash); ownership!.finishIntent(env, threadId);
    } else if (prefixMatches && suffixValid && targetBytes.length >= sourceBytes.length && targetBytes.subarray(0,sourceBytes.length).equals(sourceBytes)) {
      ownership!.recordSnapshot(env, threadId, intent.target, targetHash);
      ownership!.change(env, threadId, source, intent.target, intent.name);
      threadAccounts.set(threadId, intent.target); threadPaths.delete(threadId); autoReload.remove(threadId);
      if (connected && !runtimeChanging) broadcast({type:"thread/account/changed", threadId, accountId:intent.target, environmentId:env, runtimeRevision});
    } else if (sourceHash === intent.sourceHash && ((intent.previousHash && targetHash === intent.previousHash) || (untouchedTarget && !intent.priorAccounts.includes(intent.target)))) ownership!.cancelUnlinkedIntent(env, threadId);
    else throw new Error("Cronologia destinazione non verificabile.");
  } else {
    try { lstatSync(resolve(targetRoot, intent.path)); throw new Error("Percorso destinazione non verificabile."); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    if (intent.priorAccounts.includes(intent.target)) throw new Error("Cronologia destinazione non disponibile.");
    ownership!.cancelUnlinkedIntent(env, threadId);
  }
}
}

async function deleteTransferredThread(message: any) {
  if (!accountStore || runtimeChanging || message.runtimeRevision !== runtimeRevision) throw new Error("Account o ambiente cambiato: ricarica la pagina.");
  const threadId = message.params?.threadId, source = message.accountId || selectedAccountId();
  const env = accountStore.getState().workspaceId;
  if (typeof threadId !== "string" || threadOwner(threadId) !== source) throw new Error("Account della chat cambiato: ricarica la chat.");
  runtimeChanging = true;
  try {
    if (browserDispatches || mutatingRequests) throw new Error("Attendi la fine delle attività e riprova.");
    reconcileThreadLinkIntent(env, threadId, source);
    if (threadOwner(threadId) !== source) throw new Error("Account della chat cambiato: ricarica la chat.");
    const prior = ownership!.deletion(env, threadId);
    const journal = prior || ownership!.deletionPlan(env, threadId);
    if (!journal) throw new Error("Impossibile eliminare questa chat in sicurezza.");
    const selected = selectedAccountId(), instances = new Map<string, any>();
    for (const id of journal.accounts) {
      if (journal.completed.includes(id)) continue;
      if (id === selected) {
        if (pending.size || mutatingRequests || activeTurns.size || startingTurns.size || approvalRequests.size) throw new Error("Attendi la fine delle attività e riprova l’eliminazione.");
      } else {
        const instance = await getAccountProcess(id);
        if (instance.state.pending.size || instance.state.activeTurns.size || instance.state.startingTurns.size || instance.state.approvalRequests.size) throw new Error("Attendi la fine delle attività e riprova l’eliminazione.");
        instances.set(id, instance);
      }
    }
    if (!prior) { ownership!.beginDeletion(env, threadId, source); autoReload.remove(threadId); }
    for (const id of journal.accounts) {
      if (journal.completed.includes(id)) continue;
      try {
        // A crash can occur after Codex deleted the rollout but before the journal
        // checkpoint. Only infer completion when this account was already started.
        if (journal.started?.includes(id)) {
          const home = id === selected ? runtime!.codexHome : resolve(workspaceBase, ".webui", "runtime-homes", id, env);
          const root = resolve(home, "sessions"), path = resolve(root, journal.path), child = relative(root, path);
          if (!child || child.startsWith("..") || resolve(root, child) !== path) throw new Error("Invalid rollout path");
          ensureSafeDirectory(dirname(path));
          try { lstatSync(path); } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
            ownership!.checkpointDeletion(env, threadId, id);
            continue;
          }
        }
        ownership!.startDeletionAccount(env, threadId, id);
        if (id === selected) await request("thread/delete", {threadId});
        else await instances.get(id).request("thread/delete", {threadId});
        ownership!.checkpointDeletion(env, threadId, id);
      } catch { throw new Error("Eliminazione incompleta: riprova. La chat resta nascosta finché non è completata."); }
    }
    autoReload.remove(threadId);
    return {};
  } finally { runtimeChanging = false; if (threadOwner(threadId) !== source) broadcast({type:"thread/account/changed", threadId, accountId:threadOwner(threadId), environmentId:env, runtimeRevision}); autoReload.kick(); }
}

const nameRecoveries = new Map<string, Promise<void>>();
async function recoverThreadNames(accountId: string, instance?: any) {
  if (!ownership || !accountStore) return;
  const env=accountStore.getState().workspaceId;
  for (const item of ownership.pendingNames(env, accountId)) {
    const key=JSON.stringify([env,item.threadId]);
    let task=nameRecoveries.get(key);
    if (!task) {
      task=(async()=>{ if (instance) await instance.request("thread/name/set", {threadId:item.threadId, name:item.name}); else await request("thread/name/set", {threadId:item.threadId, name:item.name}); ownership.clearPendingName(env,item.threadId); })();
      nameRecoveries.set(key,task); task.finally(()=>nameRecoveries.delete(key)).catch(()=>{});
    }
    await task;
  }
}

async function dispatchBrowserMessage(message: any) {
  if (message?.type === 'rpc' && message.method === 'host/thread/hide') {
    try {
      const threadId = message.params?.threadId;
      if (runtimeChanging || (managedAccounts && message.runtimeRevision !== runtimeRevision)) throw new Error('Account o ambiente cambiato: ricarica la pagina.');
      if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) throw new Error('Chat non valida');
      if (managedAccounts && threadOwner(threadId) && threadOwner(threadId) !== (message.accountId || selectedAccountId())) throw new Error('Account della chat cambiato: ricarica la pagina.');
      hiddenThreads.hide(threadEnvironment(), threadId);
      autoReload.remove(threadId);
      return {type:'rpc/result', id:message.id, result:{}};
    } catch (error) { return rpcErrorPayload(message.id, error); }
  }
  if (managedAccounts && message?.type === "rpc" && message.method === "host/thread/switchAccount") return dispatchBrowserMessageInner(message);
  if (managedAccounts && message?.type === "rpc" && message.method === "thread/delete" && ownership?.isTransferred(accountStore!.getState().workspaceId, message.params?.threadId)) {
    try { return {type:"rpc/result", id:message.id, result:await deleteTransferredThread(message)}; } catch (error) { return rpcErrorPayload(message.id, error); }
  }
  if (managedAccounts && runtimeChanging) return rpcErrorPayload(message?.id, new Error("Cambio account o ambiente in corso; attendere."));
  browserDispatches++;
  try { return await dispatchBrowserMessageInner(message); } finally { browserDispatches--; }
}

async function dispatchBrowserMessageInner(message: any) {
  const id = message?.id;
  if (managedAccounts && message?.type === "rpc" && message.method === "host/thread/switchAccount") {
    try { return {type:"rpc/result", id, result:await switchThreadAccount(message)}; } catch (error) { return rpcErrorPayload(id,error); }
  }
  if (managedAccounts && message?.type === "rpc" && typeof message.params?.threadId === "string") {
    const owner = threadOwner(message.params.threadId);
    if (ownership?.linkIntent(accountStore!.getState().workspaceId, message.params.threadId)) return rpcErrorPayload(id, new Error("Trasferimento interrotto: riprova il cambio account."));
    if (ownership?.isDeleted(accountStore!.getState().workspaceId, message.params.threadId)) return rpcErrorPayload(id, new Error("Eliminazione della chat in corso; riprova."));
    if (owner && owner !== (message.accountId || selectedAccountId())) return rpcErrorPayload(id, new Error("Account della chat cambiato: ricarica la chat."));
  }
  if (managedAccounts && message?.accountId && message.accountId !== selectedAccountId()) {
    try {
      if (runtimeChanging || message.runtimeRevision !== runtimeRevision) throw new Error("Account o ambiente cambiato: ricarica la pagina.");
      const instance = await getAccountProcess(message.accountId);
      if (message.type === "rpc") await recoverThreadNames(message.accountId, instance);
      if (message.type === 'rpc') {
        if (!isAllowedBrowserRpcMethod(message.method) || message.method === 'account/logout') throw new Error('RPC non disponibile');
        const params = {...(message.params || {})};
        if (params.cwd) resolveBrowsePath(params.cwd,browseRoots,homeDir);
        if (message.method === 'thread/start') { params.cwd ||= defaultCwd; applyProjectInstructions(params); }
        if (message.method === 'host/approvals/list') return {type:'rpc/result',id,result:{requests:[...instance.browserApprovals.entries()].map(([token,nativeId]:any)=>{const item=instance.state.approvalRequests.get(nativeId);return item?{...item,id:token}:null}).filter((item:any)=>item?.params?.threadId===params.threadId)}};
        if (message.method === 'host/thread/live') {
          const result=await instance.request('thread/read',{threadId:params.threadId,includeTurns:false});
          const path=result?.thread?.path, root=resolve(instance.env.CODEX_HOME,'sessions');
          if (!path) return {type:'rpc/result',id,result:{active:false,turn:null,lastEventAt:null}};
          const child=relative(root,resolve(path)),safe=child&&!child.startsWith('..')?resolveSafeRegularFile(root,child):null;
          if (!safe) throw new Error('Thread rollout is outside the Codex sessions directory');
          return {type:'rpc/result',id,result:liveSessions.read(safe)};
        }
        const starting=message.method==='turn/start' && params.threadId;
        if (starting && instance.state.startingTurns.has(starting)) throw new Error('Un invio è già in corso per questa chat');
        if (starting) instance.state.startingTurns.add(starting);
        try { let result=await instance.request(message.method,params);if (message.method.startsWith('thread/')) rememberAccountThreads(result,message.accountId);if (message.method === 'thread/list') result = filterOwnedThreads(result, message.accountId);if (message.method === 'thread/delete') ownership?.forget(accountStore!.getState().workspaceId, params.threadId);if(message.method==='turn/start'&&typeof result?.turn?.id==='string'&&typeof params.threadId==='string'){instance.state.turnThreads.set(result.turn.id,params.threadId);if(result.turn.status==='inProgress')markAccountTurnStarted(instance,params.threadId,result.turn.id);}recordReviewDiffsFromRpc(message.method,params,result);if (message.method.startsWith('thread/')) result=applyThreadProject(result);return {type:'rpc/result',id,result}; }
        finally { if (starting) instance.state.startingTurns.delete(starting); }
      }
      if (message.type === 'codex/response' || message.type === 'codex/error') {
        if (!isCodexRequestId(message.requestId)) throw new Error('Invalid Codex request id');
        const nativeId=instance.browserApprovals.get(message.requestId);if(nativeId===undefined)throw new Error('Approvazione scaduta');
        instance.respond(nativeId,message.result,message.error);instance.browserApprovals.delete(message.requestId);
        broadcast({type:'codex/request/resolved',accountId:message.accountId,requestId:message.requestId});
        return {type:'ack',id};
      }
      throw new Error('Unsupported browser bridge message');
    } catch (error) { return rpcErrorPayload(id,error); }
  }
  if (["codex/response", "codex/error"].includes(message?.type) &&
      (runtimeChanging || !approvalRequests.has(message.requestId) || (managedAccounts && message.runtimeRevision !== runtimeRevision))) {
    throw new Error("Approvazione scaduta: ricarica la pagina.");
  }
  if (message?.type === "rpc") {
    try {
      if (!isAllowedBrowserRpcMethod(message.method)) throw new Error("RPC method is not available to browser clients");
      if (runtimeChanging) throw new Error("Cambio account o ambiente in corso; attendere.");
      if (managedAccounts && message.runtimeRevision !== runtimeRevision) throw new Error("Account o ambiente cambiato: ricarica la pagina.");
      if (managedAccounts && message.method === "account/logout") throw new Error("Gestisci gli account dal pannello Account.");
      if (managedAccounts) await recoverThreadNames(selectedAccountId());
      const params = { ...(message.params || {}) };
      const mutation = ["thread/start", "thread/resume", "thread/delete", "thread/name/set", "turn/start", "turn/steer", "turn/interrupt"].includes(message.method);
      const startingThread = message.method === "turn/start" && typeof params.threadId === "string" && params.threadId ? params.threadId : null;
      if (startingThread && startingTurns.has(startingThread)) throw new Error("Un invio è già in corso per questa chat");
      if (startingThread) startingTurns.add(startingThread);
      if (mutation) mutatingRequests++;
      let result;
      try {
        if (managedAccounts && params.cwd) {
          resolveBrowsePath(params.cwd, browseRoots, homeDir);
        }
        if (managedAccounts && message.method === "thread/start") params.cwd = params.cwd || defaultCwd;
        if (message.method === "thread/start") applyProjectInstructions(params);
        if (message.method === "host/approvals/list") {
          if (typeof params.threadId !== "string" || !params.threadId) throw new Error("Invalid thread id");
          result = { requests: [...approvalRequests.values()].filter(item => item.params?.threadId === params.threadId) };
        } else {
          result = message.method === "host/thread/live"
            ? await readLiveThread(params.threadId)
            : await request(message.method, params);
        }
        if (message.method === "turn/start" && typeof result?.turn?.id === "string" && typeof params.threadId === "string") rememberTurnThread(result.turn.id, params.threadId);
        if (message.method === "turn/start" && result?.turn?.status === "inProgress") markTurnStarted(params.threadId, result.turn.id);
        if (message.method === "thread/delete") { autoReload.remove(params.threadId); if (managedAccounts) ownership?.forget(accountStore!.getState().workspaceId, params.threadId); }
      } finally { if (startingThread) startingTurns.delete(startingThread); if (mutation) mutatingRequests--; }
      recordThreadPathsFromRpc(result);
      if (managedAccounts && message.method.startsWith('thread/')) rememberAccountThreads(result,selectedAccountId());
      if (managedAccounts && message.method === 'thread/list') result = filterOwnedThreads(result, selectedAccountId());
      if (!managedAccounts && message.method === 'thread/list' && Array.isArray(result?.data)) result = {...result, data:result.data.filter((thread: any) => !hiddenThreads.isHidden(threadEnvironment(), thread.id))};
      recordReviewDiffsFromRpc(message.method, params, result);
      if (message.method.startsWith("thread/")) result = applyThreadProject(result);
      return { type: "rpc/result", id, result };
    } catch (error) {
      if (!runtimeChanging && message.method === "turn/start" && isUsageLimitError(error)) autoReload.fail(message.params?.threadId);
      return rpcErrorPayload(id, error);
    }
  }
  if (message?.type === "codex/response") {
    if (!isCodexRequestId(message.requestId)) throw new Error("Invalid Codex request id");
    sendRaw({ id: message.requestId, result: message.result });
    approvalRequests.delete(message.requestId);
    broadcast({ type: "codex/request/resolved", requestId: message.requestId });
    return { type: "ack", id };
  }
  if (message?.type === "codex/error") {
    if (!isCodexRequestId(message.requestId)) throw new Error("Invalid Codex request id");
    sendRaw({ id: message.requestId, error: message.error });
    approvalRequests.delete(message.requestId);
    broadcast({ type: "codex/request/resolved", requestId: message.requestId });
    return { type: "ack", id };
  }
  if (message?.type === "ping") return { type: "pong" };
  throw new Error("Unsupported browser bridge message");
}

// A previous explicit delete remains authorized after reconnect or restart.
if (ownership) {
  const deletionRecovery = setInterval(() => {
    if (runtimeChanging || shuttingDown || !connected) return;
    const pending = ownership.pendingDeletions(accountStore!.getState().workspaceId)[0];
    if (pending) void deleteTransferredThread({accountId:pending.accountId, runtimeRevision, params:{threadId:pending.threadId}}).catch(() => {});
  }, 5000);
  deletionRecovery.unref();
}

async function handleClient(client: WebSocket, message: any) {
  try { client.send(JSON.stringify(await dispatchBrowserMessage(message))); }
  catch (error) { client.send(JSON.stringify(rpcErrorPayload(message?.id, error))); }
}

function readJsonBody(req: IncomingMessage, maxBytes = 256_000) {
  return new Promise<any>((resolvePromise, reject) => {
    let body = "", tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", chunk => {
      if (tooLarge) return;
      if (Buffer.byteLength(body) + Buffer.byteLength(chunk) > maxBytes) { tooLarge = true; return; }
      body += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(new Error("Bridge payload too large"));
      try { resolvePromise(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON payload")); }
    });
  });
}

function passwordSetupRequired() {
  return !localhostOnly && !authSecret;
}

function browserPasswordConfigured() {
  return Boolean(environmentPassword || managedPassword || accessToken);
}

function requestMatchesSecret(req: IncomingMessage, submittedPassword: string, expectedSecret: string | null) {
  if (!submittedPassword || !expectedSecret) return false;
  return isRequestAuthorized({
    remoteAddress: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    authorization: `Bearer ${submittedPassword}`,
    accessToken: expectedSecret,
    origin: req.headers.origin,
    fetchSite: req.headers["sec-fetch-site"],
    forwardedFor: req.headers["x-forwarded-for"],
    forwarded: req.headers.forwarded,
    realIp: req.headers["x-real-ip"],
    allowLoopback: false,
  });
}

function validBrowserPassword(req: IncomingMessage, submittedPassword: string) {
  if (environmentPassword) return requestMatchesSecret(req, submittedPassword, environmentPassword);
  if (managedPassword) {
    if (!requestMatchesSecret(req, submittedPassword, submittedPassword)) return false;
    return verifyStoredPassword(submittedPassword, managedPassword);
  }
  return requestMatchesSecret(req, submittedPassword, accessToken);
}

function sendAuthError(res: ServerResponse, status: number, error: string, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify({ error }));
}

function issueBrowserSession(req: IncomingMessage, res: ServerResponse) {
  if (!authSecret) throw new Error("Authentication is not configured");
  const session = createPasswordSession(authSecret);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "set-cookie": passwordSessionCookie(session.token, { secure: Boolean((req.socket as any).encrypted) }),
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ ok: true }));
  integrations.notifyLogin().catch(() => console.error("Telegram login notification failed"));
}

function encodeContentDispositionFilename(filename: string) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

async function stopCodexForSwitch() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const child = codex;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolvePromise, reject) => {
    const force = setTimeout(() => terminateCodex("SIGKILL"), 4000);
    const deadline = setTimeout(() => reject(new Error("Arresto Codex non riuscito")), 6500);
    child.once("exit", () => { clearTimeout(force); clearTimeout(deadline); resolvePromise(); });
    terminateCodex();
  });
}

async function waitForCodex() {
  const deadline = Date.now() + 25_000;
  while (!connected && Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  if (!connected) throw new Error("Codex non è pronto; riprovare.");
}

async function restartCodex() {
  if (runtimeChanging || mutatingRequests || pending.size || activeTurns.size || startingTurns.size || approvalRequests.size || terminalSessions.size) throw Object.assign(new Error("Attendi la fine delle attività e chiudi i terminali prima di riavviare Codex."), { status: 409 });
  runtimeChanging = true;
  try {
    const others = await Promise.all([...accountProcesses.entries()].map(async ([id, value]) => [id, await value] as const));
    if (others.some(([, instance]) => instance.state.activeTurns.size || instance.state.startingTurns.size || instance.state.approvalRequests.size || instance.state.pending.size)) throw Object.assign(new Error("Attendi la fine delle risposte degli altri account."), { status: 409 });
    for (const [id, instance] of others) { await instance.stop(); accountStore!.saveAccountRuntimeAuth(id, instance.workspaceId); accountProcesses.delete(id); }
    await stopCodexForSwitch();
    runtimeState.clearActivity();
    startCodex();
    await waitForCodex();
    if (managedAccounts) {
      runtimeRevision = randomUUID();
      broadcast({ type: "runtime/changed", ...getRuntimeState(), preserveThread: true });
    } else broadcast({ type: "bridge/status", status: "connected" });
    return { ok: true };
  } finally {
    runtimeChanging = false;
    if (!codex) startCodex();
    autoReload.kick();
  }
}

async function switchRuntime(selection: any) {
  if (!accountStore) throw new Error("Gestione account non abilitata");
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("Selezione non valida");
  const previous = accountStore.getState();
  if (selection.expectedRevision !== undefined && selection.expectedRevision !== runtimeRevision) throw Object.assign(new Error("Account o ambiente cambiato: ricarica la pagina."), { status: 409 });
  const accountId = selection.accountId ?? previous.accountId;
  const workspaceId = selection.environmentId ?? selection.workspaceId ?? previous.workspaceId;
  if (typeof accountId !== "string" || typeof workspaceId !== "string" ||
      (accountId && !previous.accounts.some(a => a.id === accountId)) ||
      (!accountId && previous.accounts.length) || !previous.workspaces.some(w => w.id === workspaceId)) throw new Error("Account o ambiente sconosciuto");
  if (accountId === previous.accountId && workspaceId === previous.workspaceId) return getRuntimeState();
  if (runtimeChanging || mutatingRequests || activeTurns.size || approvalRequests.size || terminalSessions.size) {
    throw Object.assign(new Error("Attendi la fine delle risposte e chiudi i terminali prima di cambiare account o ambiente."), { status: 409 });
  }
  runtimeChanging = true;
  try {
    const others = await Promise.all([...accountProcesses.entries()].map(async ([id, value]) => [id, await value] as const));
    if (others.some(([, instance]) => instance.state.activeTurns.size || instance.state.startingTurns.size || instance.state.approvalRequests.size || instance.state.pending.size)) throw Object.assign(new Error("Attendi la fine delle risposte degli altri account."), {status:409});
    for (const [id, instance] of others) { await instance.stop(); accountStore.saveAccountRuntimeAuth(id,instance.workspaceId); accountProcesses.delete(id); }
  } catch (error) { runtimeChanging=false; throw error; }
  try {
    await stopCodexForSwitch();
    if (previous.accountId) accountStore.saveRuntimeAuth(previous.accountId, previous.workspaceId);
    runtime = accountStore.prepareWorkspace(accountId, workspaceId);
    process.env.CODEX_HOME = runtime.codexHome;
    codexSessionsRoot = resolve(runtime.codexHome, "sessions");
    threadPaths.clear(); threadAccounts.clear(); runtimeState.clearActivity();
    recoverEnvironmentIntents(workspaceId);
    startCodex(); await waitForCodex();
    accountStore.commitSelection(accountId, workspaceId);
    accountLoader.invalidate();
    runtimeRevision = randomUUID();
    broadcast({ type: "runtime/changed", ...getRuntimeState(), preserveThread: workspaceId === previous.workspaceId });
    return getRuntimeState();
  } catch (error) {
    await stopCodexForSwitch();
    runtime = accountStore.prepareWorkspace(previous.accountId, previous.workspaceId);
    process.env.CODEX_HOME = runtime.codexHome;
    codexSessionsRoot = resolve(runtime.codexHome, "sessions");
    startCodex();
    throw error;
  } finally { runtimeChanging = false; autoReload.kick(); }
}

function sendJson(res: ServerResponse, status: number, data: any) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(data));
}

// A missing or incomplete ownership index must never make stored conversations disposable.
function accountHasStoredHistory(accountId: string) {
  for (const workspace of [...workspaces, {id: "El"}]) for (const directory of ["sessions", "archived_sessions"]) {
    const components = [".webui", "runtime-homes", accountId, workspace.id, directory];
    let path = workspaceBase, missing = false;
    for (const component of components) {
      path = join(path, component);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
      } catch (error: any) { if (error?.code === "ENOENT") { missing = true; break; } throw error; }
    }
    if (missing) continue;
    const pendingDirs = [path];
    while (pendingDirs.length) {
      const parent = pendingDirs.pop()!;
      for (const entry of readdirSync(parent, {withFileTypes: true})) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) return true;
        pendingDirs.push(join(parent, entry.name));
      }
    }
  }
  return false;
}

async function handleManagedApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!accountStore || !deviceLogin) { sendJson(res, 404, { error: "Gestione account non abilitata" }); return; }
  try {
    if (url.pathname === "/api/runtime" && req.method === "GET") return sendJson(res, 200, getRuntimeState());
    if (url.pathname === "/api/runtime/switch" && req.method === "POST") return sendJson(res, 200, await switchRuntime(await readJsonBody(req, 4096)));
    if (url.pathname === "/api/usage" && req.method === "GET") {
      if (runtimeChanging) return sendJson(res, 409, { error: "Cambio account in corso" });
      return sendJson(res, 200, await request("account/rateLimits/read"));
    }
    if (url.pathname === "/api/accounts/login") {
      if (req.method === "GET") return sendJson(res, 200, deviceLogin.getStatus());
      if (req.method === "POST") return sendJson(res, 200, await deviceLogin.start());
    }
    if (url.pathname === "/api/accounts/login/cancel" && req.method === "POST") { await deviceLogin.cancel(); return sendJson(res, 200, deviceLogin.getStatus()); }
    const match = /^\/api\/accounts\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (match && ["DELETE", "PATCH"].includes(req.method || "")) {
      if (runtimeChanging) throw Object.assign(new Error("Cambio account in corso"), { status: 409 });
      if (req.method === "DELETE") {
        runtimeChanging = true;
        try {
          if (browserDispatches || ownership?.hasAccount(match[1])) throw Object.assign(new Error("Questo account è in uso o possiede delle chat."), {status:409});
          const instance = await accountProcesses.get(match[1]);
          if (instance) {
            if (instance.state.activeTurns.size || instance.state.startingTurns.size || instance.state.approvalRequests.size || instance.state.pending.size) throw Object.assign(new Error("Account in uso"),{status:409});
            await instance.stop(); accountProcesses.delete(match[1]); accountStore.saveAccountRuntimeAuth(match[1],instance.workspaceId);
          }
          let hasHistory = true;
          try { hasHistory = accountHasStoredHistory(match[1]); } catch { /* Fail closed if history cannot be inspected. */ }
          if (hasHistory) throw Object.assign(new Error("Questo account possiede delle chat; cambiane prima l’account."), {status:409});
          accountStore.remove(match[1]);
        } finally { runtimeChanging = false; }
      } else accountStore.rename(match[1], (await readJsonBody(req, 4096)).label);
      accountLoader.invalidate();
      return sendJson(res, 200, getRuntimeState());
    }
    sendJson(res, 405, { error: "Metodo non consentito" });
  } catch (error: any) {
    // Upstream auth failures may contain sensitive data; publish only controlled messages.
    const upstream = url.pathname === "/api/usage" || url.pathname.startsWith("/api/accounts/login");
    sendJson(res, error.status || (upstream ? 502 : 400), { error: upstream ? "Servizio Codex non disponibile. Riprovare." : error.message });
  }
}

const server = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url || "/", "http://localhost"); }
  catch {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ error: "Invalid request URL" }));
    return;
  }
  const appRoute = req.method === "GET" && (url.pathname === "/" || /^\/settings(?:\/[^/]+)?\/?$/.test(url.pathname));
  const loginAssets = new Set(["/", "/index.html", "/style.css", "/favicon.svg", "/zilpio-logo.png", "/auth-bootstrap.js", "/i18n.js", "/codex-brand.js"]);
  if (url.pathname === "/api/auth/status") {
    const authenticated = isAuthorizedHttpRequest(req, authSecret);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({
      setupRequired: passwordSetupRequired() && !authenticated,
      passwordRequired: browserPasswordConfigured(),
      authenticated,
    }));
    return;
  }
  if (url.pathname === "/api/auth/setup") {
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch (error) {
      sendAuthError(res, 400, error instanceof Error ? error.message : "Invalid setup request");
      return;
    }
    const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
    if (submittedPassword.length < 12 || submittedPassword.length > 256) {
      sendAuthError(res, 400, "Password must be between 12 and 256 characters");
      return;
    }
    if (!requestMatchesSecret(req, submittedPassword, submittedPassword)) {
      sendAuthError(res, 403, "Password setup request was rejected");
      return;
    }
    if (!passwordSetupRequired() || passwordSetupInProgress) {
      sendAuthError(res, 409, "Password setup is no longer available");
      return;
    }
    passwordSetupInProgress = true;
    try {
      const credential = createStoredPassword(submittedPassword) as StoredPassword;
      saveStoredPassword(managedPasswordPath, credential);
      managedPassword = credential;
      authSecret = storedPasswordSessionSecret(credential);
      issueBrowserSession(req, res);
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        try {
          managedPassword = loadStoredPassword(managedPasswordPath);
          authSecret = storedPasswordSessionSecret(managedPassword);
        } catch { /* Keep the original exclusive-create failure as the response. */ }
        sendAuthError(res, 409, "Password setup is no longer available");
      } else {
        console.error("[codex-webui] password setup failed", error);
        sendAuthError(res, 500, "Unable to save the password");
      }
    } finally {
      passwordSetupInProgress = false;
    }
    return;
  }
  if (url.pathname === "/api/auth/login") {
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch {
      sendAuthError(res, 401, "Incorrect password");
      return;
    }
    if (passwordLoginInProgress) {
      sendAuthError(res, 400, "Login already in progress");
      return;
    }
    const delay = loginDelayMs(passwordLoginAttempts);
    if (delay === null) {
      sendAuthError(res, 400, "Login attempt limit reached; restart the server");
      return;
    }
    passwordLoginAttempts++;
    passwordLoginInProgress = true;
    try {
      await new Promise(resolve => setTimeout(resolve, delay));
      const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
      if (!validBrowserPassword(req, submittedPassword)) {
        sendAuthError(res, 401, "Incorrect password");
        return;
      }
      issueBrowserSession(req, res);
      return;
    } finally {
      passwordLoginInProgress = false;
    }
  }
  if (!isAuthorizedHttpRequest(req, authSecret)) {
    if (appRoute || loginAssets.has(url.pathname)) {
      const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
      if (file) {
        res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
        res.end(readFileSync(file));
        return;
      }
    }
    unauthorizedResponse(res);
    return;
  }
  if (url.pathname === "/api/runtime/restart" && req.method === "POST") {
    try { return sendJson(res, 200, await restartCodex()); }
    catch (error: any) { return sendJson(res, error.status || 500, { error: error.message || "Riavvio non riuscito" }); }
  }
  if (url.pathname === "/api/webui/restart" && req.method === "POST") {
    if (process.env.CODEX_WEBUI_CONTAINER_RESTART !== "true") return sendJson(res, 503, { error: "Riavvio del contenitore non configurato." });
    if (runtimeChanging || shuttingDown || mutatingRequests || browserDispatches || pending.size || activeTurns.size || startingTurns.size || approvalRequests.size || terminalSessions.size) return sendJson(res, 409, { error: "Attendi la fine delle attività e chiudi i terminali prima di riavviare la WebUI." });
    runtimeChanging = true;
    try {
      const others = await Promise.all([...accountProcesses.values()]);
      if (others.some(instance => instance.state.pending.size || instance.state.activeTurns.size || instance.state.startingTurns.size || instance.state.approvalRequests.size)) { runtimeChanging = false; return sendJson(res, 409, { error: "Attendi la fine delle risposte degli altri account." }); }
      res.once("finish", () => setTimeout(shutdown, 100));
      return sendJson(res, 200, { instanceId: webuiInstanceId });
    } catch { runtimeChanging = false; return sendJson(res, 500, { error: "Impossibile verificare le attività in corso." }); }
  }
  if (["/api/runtime", "/api/runtime/switch", "/api/usage"].includes(url.pathname) || url.pathname.startsWith("/api/accounts/")) {
    await handleManagedApi(req, res, url); return;
  }
  if (url.pathname === "/api/auto-reload" || url.pathname === "/api/auto-reload/import") {
    try {
      if (runtimeChanging) return sendJson(res, 409, { error: "Cambio account o ambiente in corso" });
      const telegram = integrations.telegram();
      const telegramReady = Boolean(telegram.enabled && telegram.token && telegram.chatId);
      if (url.pathname === "/api/auto-reload" && req.method === "GET") return sendJson(res, 200, { ...autoReload.snapshot(), telegramReady, ...(managedAccounts ? { runtimeRevision } : {}) });
      if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non consentito" });
      const data = await readJsonBody(req, 16384);
      if (managedAccounts && data.runtimeRevision !== runtimeRevision) return sendJson(res, 409, { error: "Account o ambiente cambiato: ricarica la pagina" });
      if (url.pathname === "/api/auto-reload/import") {
        if (!Array.isArray(data.threadIds) || data.threadIds.length > 50 || data.threadIds.some((id: unknown) => typeof id !== "string" || !id || id.length > 200)) throw new Error("Chat non valide");
        for (const id of data.threadIds) autoReload.fail(id, null, true);
      } else {
        if (managedAccounts && threadOwner(data.threadId) && threadOwner(data.threadId) !== selectedAccountId()) throw new Error("AutoReload non è disponibile per questa chat con l'account selezionato");
        if (data.enabled === true && autoReloadScope() === "local:unavailable") throw new Error("Account Codex non identificabile: AutoReload non disponibile");
        autoReload.setEnabled(data.threadId, data.enabled);
      }
      return sendJson(res, 200, { ...autoReload.snapshot(), telegramReady, ...(managedAccounts ? { runtimeRevision } : {}) });
    } catch (error: any) { return sendJson(res, 400, { error: error.message || "Impossibile aggiornare AutoReload" }); }
  }
  if (url.pathname === "/api/integrations" || url.pathname.startsWith("/api/integrations/")) {
    try {
      if (url.pathname === "/api/integrations" && req.method === "GET") return sendJson(res, 200, integrations.publicState());
      if (url.pathname === "/api/integrations/github" && req.method === "GET") return sendJson(res, 200, await githubAccounts.list());
      if (url.pathname === "/api/integrations/github/login" && req.method === "GET") return sendJson(res, 200, githubAccounts.loginStatus());
      if (url.pathname === "/api/integrations/github/login" && req.method === "POST") return sendJson(res, 200, githubAccounts.start());
      if (url.pathname === "/api/integrations/github/login" && req.method === "DELETE") return sendJson(res, 200, githubAccounts.cancel());
      if (url.pathname === "/api/integrations/github/nickname" && req.method === "PATCH") {
        const { login, nickname } = await readJsonBody(req, 4096);
        await githubAccounts.rename(login, nickname); return sendJson(res, 200, await githubAccounts.list());
      }
      if (url.pathname === "/api/integrations/github/switch" && req.method === "POST") {
        const { login } = await readJsonBody(req, 4096);
        await githubAccounts.switchAccount(login); return sendJson(res, 200, await githubAccounts.list());
      }
      if (url.pathname === "/api/integrations/github/account" && req.method === "DELETE") {
        const { login } = await readJsonBody(req, 4096);
        await githubAccounts.remove(login); return sendJson(res, 200, await githubAccounts.list());
      }
      if (url.pathname === "/api/integrations/ssh" && req.method === "POST") {
        const { key } = await readJsonBody(req, 60000);
        const publicKey = integrations.saveKey(key);
        return sendJson(res, 200, { ...integrations.publicState(), publicKey });
      }
      if (url.pathname === "/api/integrations/ssh/test" && req.method === "POST") {
        const { host: sshHost } = await readJsonBody(req, 4096);
        if (!integrations.publicState().sshConfigured) throw new Error("Configura prima la chiave SSH");
        if (typeof sshHost !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(sshHost)) throw new Error("Host Git non valido");
        const result = await new Promise<{code: number | null, output: string}>((resolveTest, reject) => {
          const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${process.env.CODEX_WEBUI_KNOWN_HOSTS}`, "-o", "IdentitiesOnly=yes", "-i", integrations.keyPath, `git@${sshHost}`], { stdio: ["ignore", "pipe", "pipe"] });
          let output = ""; const timer = setTimeout(() => child.kill(), 12000);
          child.stdout.on("data", chunk => { output = (output + chunk).slice(0, 4000); });
          child.stderr.on("data", chunk => { output = (output + chunk).slice(0, 4000); });
          child.on("error", error => { clearTimeout(timer); reject(error); });
          child.on("close", code => { clearTimeout(timer); resolveTest({ code, output }); });
        });
        return sendJson(res, 200, result);
      }
      if (url.pathname === "/api/integrations/ssh" && req.method === "DELETE") {
        integrations.removeKey(); return sendJson(res, 200, integrations.publicState());
      }
      if (url.pathname === "/api/integrations/telegram" && req.method === "POST") {
        const data = await readJsonBody(req, 4096);
        if (data.keepToken === true) data.token = integrations.telegram().token;
        integrations.saveTelegram(data); return sendJson(res, 200, integrations.publicState());
      }
      if (url.pathname === "/api/integrations/telegram" && req.method === "DELETE") {
        integrations.saveTelegram({ token: "", chatId: "", enabled: false }); return sendJson(res, 200, integrations.publicState());
      }
      if (url.pathname === "/api/integrations/telegram/test" && req.method === "POST") {
        await integrations.send("Test notifiche Codex: configurazione Telegram attiva."); return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: "Metodo non supportato" });
    } catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : "Operazione non riuscita" }); }
  }
  if (url.pathname === "/api/events") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: "bridge/status", ...(managedAccounts ? { runtimeRevision } : {}), status: connected ? "connected" : "connecting" })}\n\n`);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (url.pathname === "/api/rpc" || url.pathname === "/api/codex/respond") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const payload = await readJsonBody(req);
      const message = url.pathname === "/api/rpc"
        ? { type: "rpc", id: payload.id, method: payload.method, params: payload.params || {}, runtimeRevision: payload.runtimeRevision, accountId: payload.accountId }
        : { type: payload.error ? "codex/error" : "codex/response", requestId: payload.requestId, result: payload.result, error: payload.error, runtimeRevision: payload.runtimeRevision, accountId: payload.accountId };
      const reply = await dispatchBrowserMessage(message);
      if (url.pathname === '/api/codex/respond' && reply?.type === 'rpc/error') return sendJson(res,400,{error:reply.error,code:reply.code});
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(reply));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, codex: connected, version: "0.2.0", instanceId: webuiInstanceId }));
    return;
  }
  if (url.pathname === "/api/config") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ home: homeDir, defaultCwd: managedAccounts ? runtime!.cwd : defaultCwd, reviewRoot: managedAccounts ? defaultCwd : reviewRoots[0], projectless, ...(managedAccounts ? { environmentId: accountStore!.getState().workspaceId, accountId: accountStore!.getState().accountId, environments: workspaces.map(({id,label}) => ({id,label})), projectRoots, runtimeRevision } : {}) }));
    return;
  }
  if (url.pathname === "/api/workspace/context") {
    try {
      const context = readWorkspaceContext(url.searchParams.get("cwd") || defaultCwd, browseRoots);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(context));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/attachments") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    let directory: string | undefined;
    try {
      const payload = await readJsonBody(req, 14_000_000);
      if (typeof payload?.name !== "string" || typeof payload?.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.data)) throw new Error("Invalid attachment");
      const bytes = Buffer.from(payload.data, "base64");
      if (bytes.length > 10 * 1024 * 1024) throw new Error("Attachment exceeds 10 MB");
      const filename = basename(payload.name.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-200);
      if (!filename || filename === "." || filename === "..") throw new Error("Invalid filename");
      directory = mkdtempSync(join(tmpdir(), "codex-upload-"));
      const path = join(directory, filename);
      writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
      return sendJson(res, 200, { path });
    } catch (error) {
      if (directory) rmSync(directory, { recursive: true, force: true });
      return sendJson(res, 400, { error: error instanceof Error ? error.message : "Upload failed" });
    }
  }
  if (url.pathname === "/api/files/search") {
    try {
      const cwd = url.searchParams.get("cwd") || defaultCwd;
      const query = url.searchParams.get("query") || "";
      const items = await searchWorkspaceFiles(cwd, query, { allowedRoots: browseRoots, limit: 30 });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ cwd, query, items }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/download") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const file = resolveLocalFile(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || defaultCwd,
        home: homeDir,
        allowedRoots: fileRoots,
      });
      if (file.path === integrations.keyPath || file.path === integrations.telegramPath || githubAccounts.protects(file.path)) throw new Error("File unavailable");
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeContentDispositionFilename(file.filename)}`,
        "cache-control": "no-store",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      const stream = createReadStream(file.path);
      stream.on("error", () => res.destroy());
      req.on("aborted", () => stream.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "File unavailable" }));
    }
    return;
  }
  if (url.pathname === "/api/images/local") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const image = resolveLocalImage(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || defaultCwd,
        home: homeDir,
        allowedRoots: imageRoots,
      });
      res.writeHead(200, {
        "content-type": image.contentType,
        "content-length": String(image.size),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.filename)}`,
        "cache-control": "private, max-age=60",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      res.end(readFileSync(image.path));
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "Image unavailable" }));
    }
    return;
  }
  if (url.pathname === "/api/account" || url.pathname === "/api/account/avatar") {
    const proxied = Boolean(req.headers["x-forwarded-for"] || req.headers.forwarded || req.headers["x-real-ip"]);
    if (!managedAccounts && (proxied || !isLocalAccountRequest(req.socket.remoteAddress, req.headers.host, req.headers["sec-fetch-site"] as string | undefined))) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Account identity is available only on localhost" }));
      return;
    }
    try {
      const account = await accountLoader.get(url.searchParams.get("refresh") === "1");
      if (url.pathname === "/api/account") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(JSON.stringify(toPublicAccountIdentity(account)));
        return;
      }
      if (!account.imageUrl) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "No profile avatar" }));
        return;
      }
      const avatar = await fetchProfileAvatar(account.imageUrl);
      res.writeHead(200, {
        "content-type": avatar.contentType,
        "content-length": String(avatar.body.byteLength),
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      });
      res.end(avatar.body);
    } catch (error) {
      console.warn("[codex-webui] account request failed:", error instanceof Error ? error.message : String(error));
      if (url.pathname === "/api/account/avatar") {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Profile avatar unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(toPublicAccountIdentity(await resolveAccountIdentity({ account: null, requiresOpenaiAuth: true }))));
    }
    return;
  }
  if (url.pathname === "/api/projects/changes" && req.method === "GET") {
    try {
      const input = url.searchParams.get("path");
      if (!input) throw new Error("Progetto non valido");
      const path = resolveBrowsePath(input, browseRoots, homeDir);
      const changes = await repositoryChanges(path);
      return sendJson(res, 200, { changes, sync: changes ? await repositorySync(path) : null });
    } catch (error: any) { return sendJson(res, 400, { error: error.message || "Stato Git non disponibile" }); }
  }
  if (url.pathname === "/api/projects/fetch" && req.method === "POST") {
    try {
      const data = await readJsonBody(req, 4096);
      if (typeof data.path !== "string") throw new Error("Progetto non valido");
      const path = resolveBrowsePath(data.path, browseRoots, homeDir);
      if (!currentProjectStore().list().some(p => p.path === path && !p.hidden)) throw new Error("Progetto non registrato");
      await fetchRepository(path);
      return sendJson(res, 200, { ok: true });
    } catch { return sendJson(res, 400, { error: "Fetch non riuscito" }); }
  }
  if (url.pathname === "/api/projects/pull" && req.method === "POST") {
    try {
      const data = await readJsonBody(req, 4096);
      if (typeof data.path !== "string") throw new Error("Progetto non valido");
      const path = resolveBrowsePath(data.path, browseRoots, homeDir);
      if (!currentProjectStore().list().some(p => p.path === path && !p.hidden)) throw new Error("Progetto non registrato");
      await pullRepository(path);
      return sendJson(res, 200, { ok: true });
    } catch (error: any) { return sendJson(res, 400, { error: error.message || "Pull non riuscito" }); }
  }
  if (url.pathname === "/api/projects/push" && req.method === "POST") {
    try {
      const data = await readJsonBody(req, 4096);
      if (typeof data.path !== "string") throw new Error("Progetto non valido");
      const path = resolveBrowsePath(data.path, browseRoots, homeDir);
      if (!currentProjectStore().list().some(p => p.path === path && !p.hidden)) throw new Error("Progetto non registrato");
      await pushRepository(path);
      return sendJson(res, 200, { ok: true });
    } catch (error: any) { return sendJson(res, 400, { error: error.message || "Push non riuscito" }); }
  }
  if (url.pathname === "/api/projects/commit" && req.method === "POST") {
    try {
      const data = await readJsonBody(req, 8192);
      if (typeof data.path !== "string") throw new Error("Progetto non valido");
      const path = resolveBrowsePath(data.path, browseRoots, homeDir);
      if (!currentProjectStore().list().some(p => p.path === path && !p.hidden)) throw new Error("Progetto non registrato");
      await commitRepository(path, data.message);
      return sendJson(res, 200, { ok: true });
    } catch (error: any) { return sendJson(res, 400, { error: error.message || "Commit non riuscito" }); }
  }
  if (url.pathname === "/api/projects/changes/detail") {
    try {
      const data = req.method === "GET" ? { path: url.searchParams.get("path") } : await readJsonBody(req, 8192);
      if (typeof data.path !== "string") throw new Error("Progetto non valido");
      const path = resolveBrowsePath(data.path, browseRoots, homeDir);
      if (!currentProjectStore().list().some(p => p.path === path && !p.hidden)) throw new Error("Progetto non registrato");
      if (req.method === "GET") return sendJson(res, 200, { files: await repositoryDiffs(path), branch: await repositoryBranch(path) });
      if (req.method === "DELETE" && typeof data.name === "string") { await discardRepositoryChange(path, data.name); return sendJson(res, 200, { ok: true }); }
      if (req.method === "POST") { await commitAndPush(path, data.message); return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 405, { error: "Metodo non consentito" });
    } catch (error: any) { return sendJson(res, 400, { error: error.message || "Operazione Git non riuscita" }); }
  }
  if (url.pathname === "/api/projects/repository") {
    try {
      const data = req.method === "GET" ? { path: url.searchParams.get("path") } : await readJsonBody(req, 4096);
      if (typeof data.path !== "string") throw new Error("Progetto non valido");
      const path = resolveBrowsePath(data.path, browseRoots, homeDir);
      if (req.method !== "GET" && !currentProjectStore().list().some(p => p.path === path && !p.hidden)) throw new Error("Progetto non registrato");
      if (req.method === "GET") return sendJson(res, 200, await repositoryStatus(path));
      if (req.method === "POST") return sendJson(res, 200, await assignRepository(path, data.name, process.env.CODEX_WEBUI_GH_BIN || "gh"));
      if (req.method === "DELETE") { detachRepository(path); return sendJson(res, 200, { assigned: false }); }
      if (req.method === "PATCH") { await pushInitial(path); return sendJson(res, 200, { pushed: true }); }
      return sendJson(res, 405, { error: "Metodo non consentito" });
    } catch (error: any) { return sendJson(res, 400, { error: error.message || "Operazione non riuscita" }); }
  }
  if (url.pathname === "/api/projects/repositories" && req.method === "GET") {
    try { return sendJson(res, 200, { repositories: await listRepositories(process.env.CODEX_WEBUI_GH_BIN || "gh") }); }
    catch (error: any) { return sendJson(res, 400, { error: error.message }); }
  }
  if (url.pathname === "/api/threads/project") {
    try {
      if (req.method !== "POST") return sendJson(res, 405, { error:"Metodo non consentito" });
      const {threadId, path} = await readJsonBody(req, 4096);
      if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) throw new Error('Chat non valida');
      if (!currentProjectStore().list().some(p => p.path === path && !p.hidden)) throw new Error('Progetto non disponibile');
      if (!isDirectory(resolveBrowsePath(path, browseRoots, homeDir))) throw new Error('La cartella progetto non esiste');
      const owner = threadOwner(threadId), instance = owner && owner !== selectedAccountId() ? await getAccountProcess(owner) : null;
      const result = await (instance ? instance.request('thread/read', {threadId, includeTurns:false}) : request('thread/read', {threadId, includeTurns:false}));
      if (!result?.thread || hiddenThreads.isHidden(threadEnvironment(), threadId)) throw new Error('Chat non disponibile');
      if (result.thread.status?.type === 'active' || (instance ? instance.state.activeTurns.has(threadId) || instance.state.startingTurns.has(threadId) : activeTurns.has(threadId) || startingTurns.has(threadId))) throw new Error('Attendi il completamento della chat prima di spostarla');
      threadProjects.setProject(threadEnvironment(), threadId, path);
      broadcast({type:'threads/project-changed', threadId, path});
      return sendJson(res, 200, {ok:true});
    } catch (error: any) { return sendJson(res, error.status || 400, {error:error.message}); }
  }
  if (url.pathname === "/api/projects/move") {
    try {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non consentito" });
      if (!environmentProjects || !accountStore) return sendJson(res, 400, { error: "Ambienti non disponibili" });
      const { path, environmentId } = await readJsonBody(req, 4096);
      const project = environmentProjects.move(accountStore.getState().workspaceId, environmentId, path);
      broadcast({ type: "projects/changed" });
      return sendJson(res, 200, { project });
    } catch (error: any) { return sendJson(res, error.status || 400, { error: error.message }); }
  }
  if (url.pathname === "/api/projects") {
    try {
      if (req.method === "GET") return sendJson(res, 200, { projects: currentProjectStore().list() });
      if (req.method === "POST") {
        const { parent, name } = await readJsonBody(req, 4096);
        const created = createProjectFolder(parent, name, browseRoots);
        const project = currentProjectStore().update(created.path, {});
        broadcast({ type: "projects/changed" });
        return sendJson(res, 201, project);
      }
      if (req.method === "PATCH" || req.method === "DELETE") {
        const { path, ...changes } = await readJsonBody(req, 262144);
        const project = req.method === "DELETE" ? currentProjectStore().hide(path) : currentProjectStore().update(path, changes);
        broadcast({ type: "projects/changed" });
        return sendJson(res, 200, { project, projects: currentProjectStore().list() });
      }
      return sendJson(res, 405, { error: "Metodo non consentito" });
    } catch (error: any) {
      return sendJson(res, error.status || 400, { error: error.message });
    }
  }
  if (url.pathname === "/api/folders") {
    try {
      const requestedPath = url.searchParams.get("path") || "~";
      if (managedAccounts && ["~", homeDir].includes(requestedPath)) {
        return sendJson(res, 200, { path: homeDir, parent: null, selectable: false, folders: projectRoots.map(path => ({ name: path.split("/").at(-1), path })) });
      }
      const path = resolveBrowsePath(requestedPath, browseRoots, homeDir);
      if (!isDirectory(path)) throw new Error("Directory not found");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      const listing = listFolders(path, browseRoots);
      res.end(JSON.stringify({ ...listing, ...(managedAccounts && projectRoots.includes(path) ? { parent: homeDir } : {}) }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/review/patch") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy(new Error("Review patch payload too large"));
    });
    req.on("end", async () => {
      let requestPayload: ReturnType<typeof parseReviewPatchRequest> | null = null;
      let operationStarted = false;
      let reviewMutation = false;
      let success = false;
      try {
        const payload = JSON.parse(body || "{}");
        requestPayload = parseReviewPatchRequest(payload);
        if (runtimeChanging || (managedAccounts && (ownership?.isDeleted(accountStore!.getState().workspaceId, requestPayload.threadId) || ownership?.linkIntent(accountStore!.getState().workspaceId, requestPayload.threadId)))) throw new Error("Chat non disponibile durante l’eliminazione.");
        mutatingRequests++; reviewMutation = true;
        const stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);
        operationStarted = true;
        const owner = threadOwner(requestPayload.threadId) || threadAccounts.get(requestPayload.threadId);
        const threadResult = owner && owner !== selectedAccountId()
          ? await (await getAccountProcess(owner)).request("thread/read", { threadId: requestPayload.threadId, includeTurns: false })
          : await request("thread/read", { threadId: requestPayload.threadId, includeTurns: false });
        const cwd = threadResult?.thread?.cwd;
        if (typeof cwd !== "string" || !cwd) throw new Error("Thread working directory is unavailable");
        const result = await applyReviewPatch({ cwd, diff: stored.diff, action: requestPayload.action }, reviewRoots);
        success = true;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (reviewMutation) mutatingRequests--;
        if (operationStarted && requestPayload) reviewDiffs.finish(requestPayload.threadId, requestPayload.turnId, requestPayload.action, success);
      }
    });
    return;
  }
  if (url.pathname.startsWith("/vendor/katex/")) {
    let relative;
    try { relative = decodeURIComponent(url.pathname.slice("/vendor/katex/".length)); }
    catch { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return; }
    const katexDir = resolve(appRoot, "node_modules/katex/dist");
    const file = resolveSafeRegularFile(katexDir, relative);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  if (url.pathname === "/vendor/xterm/xterm.css") {
    const xtermDir = resolve(appRoot, "node_modules/@xterm/xterm/css");
    const file = resolveSafeRegularFile(xtermDir, "xterm.css");
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
  }
  res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});

const sseKeepalive = setInterval(() => {
  for (const client of sseClients) if (!client.writableEnded) client.write(": keepalive\n\n");
}, 25_000);
sseKeepalive.unref();

const wss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; }
  catch { socket.destroy(); return; }
  if ((pathname !== "/ws" && pathname !== "/terminal") || !isAuthorizedHttpRequest(req, authSecret)) {
    const body = JSON.stringify({ error: "Authentication required" });
    socket.end([
      "HTTP/1.1 401 Unauthorized",
      "Connection: close",
      'WWW-Authenticate: Basic realm="Codex WebUI", charset="UTF-8"',
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "X-Content-Type-Options: nosniff",
      "",
      body,
    ].join("\r\n"));
    return;
  }
  const target = pathname === "/terminal" ? terminalWss : wss;
  target.handleUpgrade(req, socket, head, client => target.emit("connection", client, req));
});
wss.on("connection", (client) => {
  clients.add(client);
  client.send(JSON.stringify({ type: "bridge/status", ...(managedAccounts ? { runtimeRevision } : {}), status: connected ? "connected" : "connecting" }));
  client.on("message", (raw) => {
    try { handleClient(client, JSON.parse(String(raw))); }
    catch (error) { client.send(JSON.stringify({ type: "rpc/error", error: String(error) })); }
  });
  client.on("close", () => clients.delete(client));
});
terminalWss.on("connection", (client, req) => {
  let terminal: ReturnType<typeof createTerminalSession> | null = null;
  try {
    const url = new URL(req.url || "/terminal", "http://localhost");
    const cwd = resolveTerminalCwd(url.searchParams.get("cwd"), browseRoots, defaultCwd);
    terminal = createTerminalSession({
      cwd,
      cols: 100,
      rows: 24,
      onData: data => { if (client.readyState === WebSocket.OPEN) client.send(data); },
      onExit: event => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(`\r\n[Process exited ${event.exitCode}]\r\n`);
          client.close(1000, "Terminal exited");
        }
      },
    });
    terminalSessions.set(client, terminal);
  } catch (error) {
    console.error("[codex-webui] terminal failed", error);
    client.close(1011, "Terminal unavailable");
    return;
  }
  client.on("message", (raw, isBinary) => {
    if (!terminal || raw.byteLength > 1_000_000) return;
    if (isBinary) {
      terminal.write(Buffer.from(raw as Buffer).toString("utf8"));
      return;
    }
    try {
      const resize = normalizeTerminalResize(JSON.parse(String(raw)));
      if (resize) terminal.resize(resize.cols, resize.rows);
    } catch { /* Terminal input is sent as binary; ignore malformed control frames. */ }
  });
  client.on("close", () => {
    terminalSessions.delete(client);
    terminal?.kill();
    terminal = null;
  });
  client.on("error", () => client.close());
});

const frontendBuild = await Bun.build({
  entrypoints: [resolve(publicDir, "app.js")],
  outdir: publicDir,
  naming: "app.bundle.js",
  target: "browser",
  minify: false,
});
if (!frontendBuild.success) throw new Error(`Frontend build failed: ${frontendBuild.logs.join("\n")}`);

startCodex();
server.listen(port, host, () => {
  console.log(`Codex WebUI listening on http://${host}:${port}`);
  if (passwordSetupRequired()) console.warn(`[codex-webui] LAN password setup is required; the first LAN visitor will create it in ${managedPasswordPath}`);
  if (!localhostOnly) {
    const addresses = Object.values(networkInterfaces()).flat().filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.family === "IPv4" && !entry.internal);
    for (const entry of addresses) console.log(`LAN: http://${entry.address}:${port} (authentication required)`);
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  autoReload.stop();
  deviceLogin?.dispose();
  githubAccounts.dispose();
  connected = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  clearInterval(sseKeepalive);
  for (const item of pending.values()) item.reject(new Error("Codex WebUI is shutting down"));
  pending.clear();
  for (const client of clients) client.terminate();
  clients.clear();
  for (const client of sseClients) client.end();
  sseClients.clear();
  wss.close();
  for (const [client, terminal] of terminalSessions) { terminal.kill(); client.terminate(); }
  terminalSessions.clear();
  terminalWss.close();
  for (const [accountId, running] of accountProcesses) {
    accountShutdownPending++;
    void running.then(async instance => { await instance.stop(); try { accountStore?.saveAccountRuntimeAuth(accountId,instance.workspaceId); } catch { console.error('[codex-webui] could not save account runtime auth'); } }).catch(() => {}).finally(() => { accountShutdownPending--; maybeFinishShutdown(); });
  }
  terminateCodex();
  server.close(() => { httpClosed = true; maybeFinishShutdown(); });
  server.closeAllConnections?.();
  const forceExit = setTimeout(() => {
    terminateCodex("SIGKILL");
    process.exit(0);
  }, 5000);
  forceExit.unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
