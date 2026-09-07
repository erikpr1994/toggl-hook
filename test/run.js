'use strict';
// End-to-end test against the mock Toggl server. Run: node test/run.js
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 4599;
const TT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
const SCRIPT = path.join(__dirname, '..', 'toggl-hook.js');
const env = { ...process.env, TT_DIR, TOGGL_API_BASE: `http://127.0.0.1:${PORT}` };
const STATE = path.join(TT_DIR, 'state.json');

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-toggl.js'), String(PORT)], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entries = async () => (await fetch(`http://127.0.0.1:${PORT}/_entries`, { headers: { Authorization: 'Basic x' } })).json();
const state = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
function run(args, stdin) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, input: stdin, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
  return r.stdout;
}
const hook = (tool, event, sid, cwd) => run(['hook', tool], JSON.stringify({ session_id: sid, cwd, hook_event_name: event }));

(async () => {
  await sleep(300);
  fs.writeFileSync(path.join(TT_DIR, 'config.json'), JSON.stringify({
    apiToken: 'tok', workspaceId: 42, idleMinutes: 15,
    projects: { Startup: { id: 1, paths: ['~/Projects/startup', '/repos/startup-api'] }, 'Client A': { id: 2, paths: ['/repos/client-a'] } },
  }));

  // 1. unmapped folder → nothing happens
  hook('claude', 'SessionStart', 's1', '/repos/random');
  assert.strictEqual((await entries()).length, 0, 'unmapped must not start');
  assert.strictEqual(state().lastUnmapped, '/repos/random');

  // 2. first prompt in a mapped repo starts a timer (nested folder, ~ expansion)
  hook('claude', 'SessionStart', 's2', path.join(os.homedir(), 'Projects/startup/packages/web'));
  hook('claude', 'UserPromptSubmit', 's2', path.join(os.homedir(), 'Projects/startup/packages/web'));
  let es = await entries();
  assert.strictEqual(es.length, 1); assert.strictEqual(es[0].project_id, 1); assert.strictEqual(es[0].duration, -1);
  assert.deepStrictEqual(es[0].tags, ['ai-session']); assert.strictEqual(es[0].billable, true);
  assert.strictEqual(es[0].description, 'Claude Code · web');
  const first = es[0].id;

  // 3. tool calls in the same session don't hit the API (still one entry) and a Gemini session in the same project shares it
  for (let i = 0; i < 5; i++) hook('claude', 'PostToolUse', 's2', path.join(os.homedir(), 'Projects/startup'));
  assert.strictEqual(hook('gemini', 'BeforeAgent', 'g1', '/repos/startup-api'), '{}', 'gemini hook must print {}');
  assert.strictEqual((await entries()).length, 1);
  assert.strictEqual(Object.keys(state().sessions).length, 2);

  // 4. one session ends while the other is alive → timer keeps running
  hook('claude', 'SessionEnd', 's2', path.join(os.homedir(), 'Projects/startup'));
  assert.strictEqual((await entries())[0].duration, -1, 'other session still active');

  // 5. a second project while the first is running: the first keeps the live timer, the second is tracked locally
  //    (Toggl allows one running timer; the parallel one becomes a completed, overlapping entry)
  const min = (n) => new Date(Date.now() - n * 60000).toISOString();
  let st = state(); st.entries[1].start = min(5); fs.writeFileSync(STATE, JSON.stringify(st));
  hook('claude', 'UserPromptSubmit', 's3', '/repos/client-a/app');
  es = await entries();
  assert.strictEqual(es.length, 1, 'no Toggl entry for the parallel project yet'); assert.strictEqual(es[0].duration, -1, 'first still running');
  st = state();
  assert.strictEqual(st.entries[1].live, true); assert.strictEqual(st.entries[2].live, false); assert.strictEqual(st.entries[2].id, null);
  assert.strictEqual(st.entries[2].desc, 'Claude Code · app');

  // 5b. activity in the parallel project after verifyMinutes writes it to Toggl as a completed entry, overlapping the live one
  st.entries[2].start = min(12); st.entries[2].lastSync = Date.now() - 11 * 60000; fs.writeFileSync(STATE, JSON.stringify(st));
  hook('claude', 'PostToolUse', 's3', '/repos/client-a/app');
  es = await entries();
  assert.strictEqual(es.length, 2); assert.strictEqual(es[0].duration, -1, 'live timer untouched');
  let client = es.find((e) => e.project_id === 2);
  assert.ok(Math.abs(client.duration - 720) <= 2, `parallel entry ~720s, got ${client.duration}`); assert.ok(client.stop, 'completed entry');
  assert.strictEqual(client.description, 'Claude Code · app'); assert.deepStrictEqual(client.tags, ['ai-session']);
  assert.strictEqual(state().entries[2].id, client.id);

  // 5c. ...and is extended on the next sync
  st = state(); st.entries[2].lastSync = Date.now() - 11 * 60000; st.entries[2].start = min(20); fs.writeFileSync(STATE, JSON.stringify(st));
  hook('claude', 'PostToolUse', 's3', '/repos/client-a/app');
  client = (await entries()).find((e) => e.project_id === 2);
  assert.ok(Math.abs(client.duration - 1200) <= 2, `extended to ~1200s, got ${client.duration}`);

  // 6. idle: only the idle project is closed, at its last activity. The live one (still active) keeps running.
  st = state();
  st.entries[2].last = Date.now() - 20 * 60000; st.entries[2].start = min(30);
  fs.writeFileSync(STATE, JSON.stringify(st));
  run(['idle-check']);
  es = await entries();
  client = es.find((e) => e.project_id === 2);
  assert.ok(Math.abs(client.duration - 600) <= 2, `duration should be ~600s, got ${client.duration}`);
  assert.strictEqual(state().entries[2], undefined); assert.strictEqual(es.find((e) => e.project_id === 1).duration, -1);

  // 6b. the live one goes idle too → stopped at last activity
  st = state(); st.entries[1].last = Date.now() - 20 * 60000; st.entries[1].start = min(30); fs.writeFileSync(STATE, JSON.stringify(st));
  run(['idle-check']);
  const startup = (await entries()).find((e) => e.project_id === 1);
  assert.ok(Math.abs(startup.duration - 600) <= 2, `live stopped at last activity, got ${startup.duration}`);
  assert.deepStrictEqual(state().entries, {});

  // 6c. a stop whose sub-second remainder rounds up must still land: Toggl rejects a duration
  // that disagrees with stop - start, and a rejected stop used to leave the timer running for days.
  hook('claude', 'UserPromptSubmit', 's9', '/repos/client-a');
  st = state();
  const started = Math.floor(Date.now() / 1000) * 1000 - 40 * 60000; // whole second
  st.entries[2] = { ...st.entries[2], id: null, start: new Date(started).toISOString(), live: false, lastSync: 0, last: started + 10 * 60000 + 833 };
  fs.writeFileSync(STATE, JSON.stringify(st));
  run(['idle-check']);
  assert.strictEqual(state().entries[2], undefined, 'a .833 s remainder must not block the stop');
  assert.strictEqual(state().lastError, '', 'no API error on stop');
  const rounded = (await entries()).filter((e) => e.project_id === 2).pop();
  assert.strictEqual(rounded.duration, 600, `duration must match stop - start, got ${rounded.duration}`);
  await fetch(`http://127.0.0.1:${PORT}/workspaces/42/time_entries/${rounded.id}`, { method: 'DELETE', headers: { Authorization: 'Basic x' } });
  hook('claude', 'SessionEnd', 's9', '/repos/client-a');

  // 7. idle stop of an entry shorter than a minute deletes it (live) / never creates it (parallel)
  hook('claude', 'UserPromptSubmit', 's4', '/repos/client-a');
  hook('claude', 'UserPromptSubmit', 's4b', '/repos/startup-api');
  st = state();
  for (const id of [1, 2]) { st.entries[id].last = Date.now() - 20 * 60000; st.entries[id].start = new Date(Date.now() - 20 * 60000 - 30000).toISOString(); }
  fs.writeFileSync(STATE, JSON.stringify(st));
  assert.strictEqual((await entries()).length, 3, 'live sub-minute entry exists before idle-check');
  run(['idle-check']);
  assert.strictEqual((await entries()).length, 2, 'sub-minute entries deleted / never created');
  assert.deepStrictEqual(state().entries, {});

  // 8. a manual timer started by the user is never touched: the AI session is tracked in parallel instead
  await fetch(`http://127.0.0.1:${PORT}/_manual`, { method: 'POST', headers: { Authorization: 'Basic x' }, body: JSON.stringify({ description: 'Meeting', project_id: 1 }) });
  hook('claude', 'UserPromptSubmit', 's5', '/repos/startup-api');
  es = await entries();
  assert.strictEqual(es.filter((e) => e.duration < 0).length, 1);
  assert.strictEqual(es.find((e) => e.duration < 0).description, 'Meeting');
  assert.strictEqual(state().entries[1].live, false); assert.strictEqual(state().entries[1].id, null);

  // 9. SessionEnd with no other live sessions closes the segment immediately: the parallel one becomes a completed entry next to the manual timer
  hook('gemini', 'SessionEnd', 'g1', '/repos/startup-api');
  hook('claude', 'SessionEnd', 's4b', '/repos/startup-api');
  st = state(); st.entries[1].start = min(2); fs.writeFileSync(STATE, JSON.stringify(st));
  hook('claude', 'SessionEnd', 's5', '/repos/startup-api');
  es = await entries();
  assert.strictEqual(es.filter((e) => e.duration < 0).length, 1, 'manual timer still running');
  assert.ok(Math.abs(es[es.length - 1].duration - 120) <= 2, 'parallel entry written on SessionEnd');
  assert.deepStrictEqual(state().entries, {});
  await fetch(`http://127.0.0.1:${PORT}/workspaces/42/time_entries/${es.find((e) => e.duration < 0).id}`, { method: 'PUT', headers: { Authorization: 'Basic x' }, body: JSON.stringify({ duration: 5 }) });

  // 9b. ...and a live timer is stopped immediately on SessionEnd
  hook('claude', 'UserPromptSubmit', 's6', '/repos/startup-api');
  assert.strictEqual(state().entries[1].live, true);
  st = state(); st.entries[1].start = min(2); fs.writeFileSync(STATE, JSON.stringify(st));
  hook('claude', 'SessionEnd', 's6', '/repos/startup-api');
  es = await entries();
  assert.strictEqual(es.filter((e) => e.duration < 0).length, 0, 'stopped on SessionEnd');
  assert.deepStrictEqual(state().entries, {});

  // 9c. a live timer stopped by hand in Toggl is noticed at the next verify and restarted
  hook('claude', 'UserPromptSubmit', 's7', '/repos/startup-api');
  const byHand = state().entries[1].id;
  await fetch(`http://127.0.0.1:${PORT}/workspaces/42/time_entries/${byHand}`, { method: 'PUT', headers: { Authorization: 'Basic x' }, body: JSON.stringify({ duration: 5 }) });
  st = state(); st.entries[1].lastSync = Date.now() - 11 * 60000; fs.writeFileSync(STATE, JSON.stringify(st));
  hook('claude', 'PostToolUse', 's7', '/repos/startup-api');
  assert.notStrictEqual(state().entries[1].id, byHand, 'new timer started'); assert.strictEqual(state().entries[1].live, true);
  hook('claude', 'SessionEnd', 's7', '/repos/startup-api');

  // 9d. v1.0 state file (single `entry`) is migrated
  fs.writeFileSync(STATE, JSON.stringify({ entry: { id: 7, projectId: 2, start: min(3) }, lastActivity: Date.now(), lastVerify: Date.now(), sessions: {} }));
  assert.match(run(['status']), /Running: Client A \(live Toggl timer\)/);
  fs.writeFileSync(STATE, JSON.stringify({ entries: {}, sessions: {} }));

  // 10. parallel hooks racing don't create duplicate timers
  const before = (await entries()).length;
  await Promise.all([1, 2, 3, 4].map((i) => new Promise((res) => {
    const p = spawn(process.execPath, [SCRIPT, 'hook', 'claude'], { env });
    p.stdin.end(JSON.stringify({ session_id: `race${i}`, cwd: '/repos/startup-api', hook_event_name: 'UserPromptSubmit' }));
    p.on('exit', res);
  })));
  es = await entries();
  assert.strictEqual(es.filter((e) => e.duration < 0).length, 1, 'exactly one running');
  assert.strictEqual(es.length, before + 1, 'no duplicate started by race');

  // 11. status / stop close every tracked project
  hook('claude', 'UserPromptSubmit', 's8', '/repos/client-a');
  st = state(); st.entries[1].start = min(3); st.entries[2].start = min(3); fs.writeFileSync(STATE, JSON.stringify(st));
  const out = run(['status']);
  assert.match(out, /Running: Startup \(live Toggl timer\)/); assert.match(out, /Tracking: Client A \(parallel, not in Toggl yet/);
  const stopOut = run(['stop']);
  assert.match(stopOut, /Startup: stopped/); assert.match(stopOut, /Client A: stopped/);
  es = await entries();
  assert.strictEqual(es.filter((e) => e.duration < 0).length, 0);
  assert.ok(Math.abs(es[es.length - 1].duration - 180) <= 2, 'parallel entry written by stop'); assert.strictEqual(es[es.length - 1].project_id, 2);
  assert.deepStrictEqual(state().entries, {});

  // 12. broken API → hook still exits 0 and records the error
  const envDown = { ...env, TOGGL_API_BASE: 'http://127.0.0.1:1' };
  const r = spawnSync(process.execPath, [SCRIPT, 'hook', 'claude'], { env: envDown, input: JSON.stringify({ session_id: 'y', cwd: '/repos/client-a', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); assert.match(state().lastError, /fetch|ECONNREFUSED/i);

  // 13. SessionStart in an unmapped folder tells the assistant how to map it; `ignore` silences it, `map` un-ignores
  let ctx = hook('claude', 'SessionStart', 'u1', '/repos/unknown');
  assert.match(ctx, /not mapped to a Toggl project/); assert.match(ctx, /map "<Project>" "\/repos\/unknown"/); assert.match(ctx, /"Startup", "Client A"/);
  assert.strictEqual(hook('claude', 'UserPromptSubmit', 'u1', '/repos/unknown'), '', 'only on SessionStart');
  const gem = JSON.parse(hook('gemini', 'SessionStart', 'u2', '/repos/unknown'));
  assert.strictEqual(gem.hookSpecificOutput.hookEventName, 'SessionStart'); assert.match(gem.hookSpecificOutput.additionalContext, /not mapped/);
  assert.match(run(['status']), /unmapped folder.*\/repos\/unknown/);
  assert.match(run(['ignore', '/repos/unknown/']), /Ignored: \/repos\/unknown/);
  assert.strictEqual(hook('claude', 'SessionStart', 'u3', '/repos/unknown/sub'), '', 'ignored subfolder is silent');
  assert.strictEqual(hook('gemini', 'SessionStart', 'u4', '/repos/unknown'), '{}');
  assert.doesNotMatch(run(['status']), /unmapped folder/); assert.match(run(['status']), /Ignored folders: \/repos\/unknown/);
  run(['map', 'Client A', '/repos/unknown']);
  const cfgNow = JSON.parse(fs.readFileSync(path.join(TT_DIR, 'config.json'), 'utf8'));
  assert.deepStrictEqual(cfgNow.ignore, [], 'map removes the folder from ignore');
  assert.ok(cfgNow.projects['Client A'].paths.includes('/repos/unknown'));
  assert.strictEqual(hook('claude', 'SessionStart', 'u5', '/repos/unknown'), '', 'mapped now');
  assert.strictEqual(state().entries[2].live, true, 'SessionStart in a mapped folder starts tracking');
  hook('claude', 'SessionEnd', 'u5', '/repos/unknown');
  if (process.platform === 'darwin' || process.platform === 'win32') {
    hook('claude', 'UserPromptSubmit', 'u6', '/repos/CLIENT-A/App');
    assert.strictEqual(state().entries[2].live, true, 'case-insensitive match on case-insensitive file systems');
    hook('claude', 'SessionEnd', 'u6', '/repos/CLIENT-A/App');
  }

  // 14. setup: offers the repos you used Claude/Gemini in (collapsed to git roots), accepts piped answers, saves mapping + ignore
  const home = path.join(TT_DIR, 'home');
  for (const d of ['code/api/.git', 'code/api/packages/web', 'code/site', '.gemini']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [path.join(home, 'code/api/packages/web')]: {}, [home]: {}, [path.join(home, 'code/gone')]: {} } }));
  fs.writeFileSync(path.join(home, '.gemini/projects.json'), JSON.stringify({ projects: { [path.join(home, 'code/site')]: 'site' } }));
  const TT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tt2-'));
  const su = spawnSync(process.execPath, [SCRIPT, 'setup'], { env: { ...env, HOME: home, TT_DIR: TT2 }, input: 'tok\n1\ni\n2 ~/code/other\n\n7\n', encoding: 'utf8' });
  assert.strictEqual(su.status, 0, su.stderr);
  assert.match(su.stdout, /Hi Test User/); assert.match(su.stdout, /~\/code\/api: /); assert.match(su.stdout, /~\/code\/site: /);
  assert.doesNotMatch(su.stdout, /packages\/web/, 'nested folder collapsed to its git root');
  const c2 = JSON.parse(fs.readFileSync(path.join(TT2, 'config.json'), 'utf8'));
  assert.strictEqual(c2.apiToken, 'tok'); assert.strictEqual(c2.workspaceId, 42); assert.strictEqual(c2.idleMinutes, 7);
  assert.deepStrictEqual(c2.projects.Startup, { id: 1, paths: ['~/code/api'] });
  assert.deepStrictEqual(c2.projects['Client A'], { id: 2, paths: ['~/code/other'] });
  assert.deepStrictEqual(c2.ignore, ['~/code/site']);
  // 14b. no terminal and no answers (e.g. run from a hook or `!` in Claude Code): finishes with defaults instead of hanging
  const su2 = spawnSync(process.execPath, [SCRIPT, 'setup'], { env: { ...env, HOME: home, TT_DIR: TT2 }, input: '', encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(su2.status, 0, su2.stderr || 'timed out'); assert.match(su2.stdout, /not a terminal/); assert.match(su2.stdout, /Saved/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(TT2, 'config.json'), 'utf8')).projects.Startup, { id: 1, paths: ['~/code/api'] }, 'earlier mapping kept');
  fs.rmSync(TT2, { recursive: true, force: true });

  console.log('all tests passed');
  mock.kill(); fs.rmSync(TT_DIR, { recursive: true, force: true });
})().catch((e) => { console.error(e); mock.kill(); process.exit(1); });
