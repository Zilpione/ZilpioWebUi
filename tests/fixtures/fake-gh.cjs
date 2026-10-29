#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const stateFile = process.env.FAKE_GH_STATE;
const completeFile = process.env.FAKE_GH_COMPLETE;
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const write = value => fs.writeFileSync(stateFile, JSON.stringify(value));
const args = process.argv.slice(2);
const state = read();
const user = args[args.indexOf('--user') + 1];
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ hosts: { 'github.com': state.accounts.map(a => ({ ...a, host: 'github.com', state: a.state || 'success', token: 'never-expose-this-token' })) } }));
} else if (args[0] === 'auth' && args[1] === 'login') {
  process.stderr.write('! First copy your one-time code: ABCD-1234\n');
  const timer = setInterval(() => {
    if (!fs.existsSync(completeFile)) return;
    const current = read();
    for (const account of current.accounts) account.active = false;
    current.accounts.push({ login: 'SecondUser', active: true });
    write(current);
    clearInterval(timer);
    process.exit(0);
  }, 30);
} else if (args[0] === 'auth' && args[1] === 'setup-git') {
  const finish = () => fs.writeFileSync(path.join(path.dirname(stateFile), 'setup-git'), 'ok');
  if (process.env.FAKE_GH_SLOW_SETUP) setTimeout(finish, 300); else finish();
} else if (args[0] === 'auth' && args[1] === 'switch') {
  for (const account of state.accounts) account.active = account.login === user;
  write(state);
} else if (args[0] === 'auth' && args[1] === 'logout') {
  const removed = state.accounts.find(a => a.login === user);
  state.accounts = state.accounts.filter(a => a.login !== user);
  if (removed?.active && state.accounts.length) state.accounts[0].active = true;
  write(state);
} else {
  process.exit(2);
}
