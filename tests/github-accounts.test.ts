import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubAccounts } from '../github-accounts.js';

const fakeGh = new URL('./fixtures/fake-gh.cjs', import.meta.url).pathname;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(25); }
  throw new Error('Timed out waiting for GitHub authorization');
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'github-accounts-'));
  const state = join(dir, 'accounts.json'), complete = join(dir, 'complete');
  writeFileSync(state, JSON.stringify({ accounts: [{ login: 'FirstUser', active: true }] }));
  const github = new GitHubAccounts({ dir, gh: fakeGh, env: { ...process.env, FAKE_GH_STATE: state, FAKE_GH_COMPLETE: complete } });
  return { dir, state, complete, github };
}

test('lists existing accounts, saves a nickname privately and never exposes CLI secrets', async () => {
  const {dir, github} = fixture();
  try {
    let status = await github.list();
    expect(status.accounts).toMatchObject([{login: 'FirstUser', nickname: 'FirstUser', active: true, connected: true}]);
    expect(JSON.stringify(status)).not.toContain('never-expose-this-token');
    await github.rename('FirstUser', 'Personale');
    expect((await github.list()).accounts[0].nickname).toBe('Personale');
    expect(statSync(join(dir, 'github-nicknames.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'github-nicknames.json'), 'utf8')).not.toContain('never-expose-this-token');
    await expect(github.rename('FirstUser', 'x'.repeat(81))).rejects.toThrow();
    await expect(github.rename('unknown', 'Altro')).rejects.toThrow();
  } finally { github.dispose(); rmSync(dir, {recursive:true, force:true}); }
});

test('device login is shared, exposes only the code, and configures Git after completion', async () => {
  const {dir, complete, github} = fixture();
  try {
    github.start(); github.start();
    await waitFor(() => github.loginStatus().userCode === 'ABCD-1234');
    expect(github.loginStatus()).toMatchObject({status:'pending', userCode:'ABCD-1234', verificationUrl:'https://github.com/login/device'});
    await expect(github.switchAccount('FirstUser')).rejects.toThrow();
    writeFileSync(complete, 'ok');
    await waitFor(() => github.loginStatus().status === 'completed');
    expect(readFileSync(join(dir, 'setup-git'), 'utf8')).toBe('ok');
    expect((await github.list()).accounts).toMatchObject([{login:'FirstUser',active:false},{login:'SecondUser',active:true}]);
  } finally { github.dispose(); rmSync(dir, {recursive:true, force:true}); }
});

test('switches and removes only the chosen account and preserves the other account', async () => {
  const {dir, state, github} = fixture();
  try {
    writeFileSync(state, JSON.stringify({ accounts: [{login:'FirstUser',active:true},{login:'SecondUser',active:false}] }));
    await github.rename('SecondUser', 'Lavoro');
    await github.switchAccount('SecondUser');
    expect((await github.list()).accounts).toMatchObject([{login:'FirstUser',active:false},{login:'SecondUser',nickname:'Lavoro',active:true}]);
    await github.remove('FirstUser');
    expect((await github.list()).accounts).toMatchObject([{login:'SecondUser',nickname:'Lavoro',active:true}]);
  } finally { github.dispose(); rmSync(dir, {recursive:true, force:true}); }
});

test('cancelling a pending device login leaves the existing account untouched', async () => {
  const {dir, github} = fixture();
  try {
    github.start();
    await waitFor(() => github.loginStatus().userCode === 'ABCD-1234');
    github.cancel();
    await delay(100);
    expect(github.loginStatus()).toEqual({status:'idle'});
    expect((await github.list()).accounts).toMatchObject([{login:'FirstUser',active:true}]);
  } finally { github.dispose(); rmSync(dir, {recursive:true, force:true}); }
});

test('a completed authorization cannot be cancelled while Git is being configured', async () => {
  const {dir, complete, github} = fixture();
  try {
    github.env.FAKE_GH_SLOW_SETUP = '1';
    github.start();
    await waitFor(() => github.loginStatus().userCode === 'ABCD-1234');
    writeFileSync(complete, 'ok');
    await waitFor(() => github.loginStatus().finalizing === true);
    expect(() => github.cancel()).toThrow();
    await waitFor(() => github.loginStatus().status === 'completed');
    expect((await github.list()).accounts).toMatchObject([{login:'FirstUser',active:false},{login:'SecondUser',active:true}]);
  } finally { github.dispose(); rmSync(dir, {recursive:true, force:true}); }
});
