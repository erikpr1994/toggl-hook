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
    projects: { Startup: { id: 1, paths: ['~/Projects/startup', '/repos/startup-api'] }, 'Peak Health': { id: 2, paths: ['/repos/peak'] } },
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
  hook('claude', 'UserPromptSubmit', 's3', '/repos/peak/app');
  es = await entries();
  assert.strictEqual(es.length, 1, 'no Toggl entry for the parallel project yet'); assert.strictEqual(es[0].duration, -1, 'first still running');
  st = state();
  assert.strictEqual(st.entries[1].live, true); assert.strictEqual(st.entries[2].live, false); assert.strictEqual(st.entries[2].id, null);
  assert.strictEqual(st.entries[2].desc, 'Claude Code · app');

  // 5b. activity in the parallel project after verifyMinutes writes it to Toggl as a completed entry, overlapping the live one
  st.entries[2].start = min(12); st.entries[2].lastSync = Date.now() - 11 * 60000; fs.writeFileSync(STATE, JSON.stringify(st));
  hook('claude', 'PostToolUse', 's3', '/repos/peak/app');
  es = await entries();
  assert.strictEqual(es.length, 2); assert.strictEqual(es[0].duration, -1, 'live timer untouched');
  let peak = es.find((e) => e.project_id === 2);
  assert.ok(Math.abs(peak.duration - 720) <= 2, `parallel entry ~720s, got ${peak.duration}`); assert.ok(peak.stop, 'completed entry');
  assert.strictEqual(peak.description, 'Claude Code · app'); assert.deepStrictEqual(peak.tags, ['ai-session']);
  assert.strictEqual(state().entries[2].id, peak.id);

  // 5c. ...and is extended on the next sync
  st = state(); st.entries[2].lastSync = Date.now() - 11 * 60000; st.entries[2].start = min(20); fs.writeFileSync(STATE, JSON.stringify(st));
  hook('claude', 'PostToolUse', 's3', '/repos/peak/app');
  peak = (await entries()).find((e) => e.project_id === 2);
  assert.ok(Math.abs(peak.duration - 1200) <= 2, `extended to ~1200s, got ${peak.duration}`);

  // 6. idle: only the idle project is closed, at its last activity. The live one (still active) keeps running.
  st = state();
  st.entries[2].last = Date.now() - 20 * 60000; st.entries[2].start = min(30);
  fs.writeFileSync(STATE, JSON.stringify(st));
  run(['idle-check']);
  es = await entries();
  peak = es.find((e) => e.project_id === 2);
  assert.ok(Math.abs(peak.duration - 600) <= 2, `duration should be ~600s, got ${peak.duration}`);
  assert.strictEqual(state().entries[2], undefined); assert.strictEqual(es.find((e) => e.project_id === 1).duration, -1);

  // 6b. the live one goes idle too → stopped at last activity
  st = state(); st.entries[1].last = Date.now() - 20 * 60000; st.entries[1].start = min(30); fs.writeFileSync(STATE, JSON.stringify(st));
  run(['idle-check']);
  const startup = (await entries()).find((e) => e.project_id === 1);
  assert.ok(Math.abs(startup.duration - 600) <= 2, `live stopped at last activity, got ${startup.duration}`);
  assert.deepStrictEqual(state().entries, {});

  // 7. idle stop of an entry shorter than a minute deletes it (live) / never creates it (parallel)
  hook('claude', 'UserPromptSubmit', 's4', '/repos/peak');
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
  assert.match(run(['status']), /Running: Peak Health \(live Toggl timer\)/);
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
  hook('claude', 'UserPromptSubmit', 's8', '/repos/peak');
  st = state(); st.entries[1].start = min(3); st.entries[2].start = min(3); fs.writeFileSync(STATE, JSON.stringify(st));
  const out = run(['status']);
  assert.match(out, /Running: Startup \(live Toggl timer\)/); assert.match(out, /Tracking: Peak Health \(parallel, not in Toggl yet/);
  const stopOut = run(['stop']);
  assert.match(stopOut, /Startup: stopped/); assert.match(stopOut, /Peak Health: stopped/);
  es = await entries();
  assert.strictEqual(es.filter((e) => e.duration < 0).length, 0);
  assert.ok(Math.abs(es[es.length - 1].duration - 180) <= 2, 'parallel entry written by stop'); assert.strictEqual(es[es.length - 1].project_id, 2);
  assert.deepStrictEqual(state().entries, {});

  // 12. broken API → hook still exits 0 and records the error
  const envDown = { ...env, TOGGL_API_BASE: 'http://127.0.0.1:1' };
  const r = spawnSync(process.execPath, [SCRIPT, 'hook', 'claude'], { env: envDown, input: JSON.stringify({ session_id: 'y', cwd: '/repos/peak', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); assert.match(state().lastError, /fetch|ECONNREFUSED/i);

  console.log('all tests passed');
  mock.kill(); fs.rmSync(TT_DIR, { recursive: true, force: true });
})().catch((e) => { console.error(e); mock.kill(); process.exit(1); });
