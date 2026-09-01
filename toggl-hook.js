#!/usr/bin/env node
'use strict';
/**
 * toggl-hook — starts/stops Toggl Track timers from Claude Code and Gemini CLI sessions.
 *
 * Zero dependencies. Node >= 18 (uses global fetch).
 *
 *   node toggl-hook.js setup        interactive: API token, workspace, project → folder mapping
 *   node toggl-hook.js install      register hooks in ~/.claude and ~/.gemini + idle watchdog (launchd)
 *   node toggl-hook.js uninstall    remove them again
 *   node toggl-hook.js status       what is running, what is mapped, last error
 *   node toggl-hook.js map "Toggl Project" ~/path/to/repo
 *   node toggl-hook.js stop         force-stop the running AI timer now
 *   node toggl-hook.js hook claude  (called by hooks; reads the hook JSON on stdin)
 *   node toggl-hook.js hook gemini
 *   node toggl-hook.js idle-check   (called by launchd every 5 min)
 *
 * How time is measured: a timer starts on the first prompt in a mapped repo and keeps running
 * while there is activity (prompts, tool calls, responses). When you go quiet for longer than
 * `idleMinutes`, the watchdog stops the entry retroactively at your last activity, so idle
 * time is never billed. Closing the session stops the timer immediately. Sessions in the same
 * project share one entry. Several projects can be tracked at once: the first one holds the
 * live Toggl timer (Toggl allows only one), the others are written to Toggl as overlapping
 * completed entries. A manual timer you started yourself is never touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const HOME = os.homedir();
const DIR = process.env.TT_DIR || path.join(HOME, '.timetrack');
const CONFIG_FILE = path.join(DIR, 'config.json');
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_FILE = path.join(DIR, 'hook.log');
const LOCK_DIR = path.join(DIR, '.lock');
const INSTALLED_SCRIPT = path.join(DIR, 'toggl-hook.js');
const API = process.env.TOGGL_API_BASE || 'https://api.track.toggl.com/api/v9';
const LAUNCHD_LABEL = 'com.timetrack.toggl-idle';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const MARK = 'toggl-hook.js'; // how we recognise our own hook entries in settings files

const DEFAULT_CONFIG = {
  apiToken: '',
  workspaceId: 0,
  idleMinutes: 15,
  verifyMinutes: 10,
  tag: 'ai-session',
  billable: true,
  projects: {}, // "Toggl project name": { id: 123, paths: ["~/Projects/startup"] }
};

// ---------- small utils ----------
const nowIso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const expandHome = (p) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);
function log(msg) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch (e) { /* ignore */ }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function loadConfig() { return { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) }; }
function loadState() {
  const st = { entries: {}, sessions: {}, lastUnmapped: '', lastError: '', ...readJson(STATE_FILE, {}) };
  if (st.entry) { // migrate the single-timer state of v1.0
    st.entries[st.entry.projectId] = { ...st.entry, desc: '', live: true, last: st.lastActivity || Date.now(), lastSync: st.lastVerify || 0 };
  }
  delete st.entry; delete st.lastActivity; delete st.lastVerify;
  return st;
}

// mkdir is atomic: a poor man's mutex so parallel hooks don't both start a timer.
async function withLock(fn) {
  fs.mkdirSync(DIR, { recursive: true });
  for (let i = 0; i < 40; i++) {
    try { fs.mkdirSync(LOCK_DIR); break; } catch (e) {
      // stale lock (> 20 s) → steal it
      try { if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 20000) { fs.rmdirSync(LOCK_DIR); continue; } } catch (e2) { /* gone */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return await fn(); } finally { try { fs.rmdirSync(LOCK_DIR); } catch (e) { /* ignore */ } }
}

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
  });
}

// ---------- Toggl API ----------
async function api(cfg, method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${cfg.apiToken}:api_token`).toString('base64'),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Toggl ${method} ${route} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const getCurrent = (cfg) => api(cfg, 'GET', '/me/time_entries/current');
// Without stopMs this starts a running timer; with it, a completed entry (Toggl allows those to overlap).
function createEntry(cfg, projectId, description, startMs, stopMs) {
  const body = {
    workspace_id: cfg.workspaceId, project_id: projectId, description, tags: [cfg.tag], billable: !!cfg.billable,
    start: nowIso(startMs), duration: -1, created_with: 'toggl-hook',
  };
  if (stopMs) { body.stop = nowIso(stopMs); body.duration = Math.round((stopMs - startMs) / 1000); }
  return api(cfg, 'POST', `/workspaces/${cfg.workspaceId}/time_entries`, body);
}

// ---------- segments ----------
// A segment is one project's stretch of AI activity: state.entries[projectId] = { id, projectId, start, desc, live, last, lastSync }.
// The `live` segment owns the running Toggl timer. Parallel segments (a second project, or a manual timer in the way)
// are kept locally and written to Toggl as completed entries: created once they pass a minute, extended every
// `verifyMinutes` while active, finalised when they close. Entries shorter than a minute never reach Toggl.
async function syncSegment(cfg, seg, stopMs, final) {
  const startMs = Date.parse(seg.start);
  const duration = Math.round((stopMs - startMs) / 1000);
  if (duration < 60) {
    if (!seg.id || !final) return 'skipped';
    await api(cfg, 'DELETE', `/workspaces/${cfg.workspaceId}/time_entries/${seg.id}`);
    return 'deleted';
  }
  if (!seg.id) {
    seg.id = (await createEntry(cfg, seg.projectId, seg.desc, startMs, stopMs)).id;
    return 'created';
  }
  await api(cfg, 'PUT', `/workspaces/${cfg.workspaceId}/time_entries/${seg.id}`, {
    workspace_id: cfg.workspaceId, stop: nowIso(stopMs), duration, created_with: 'toggl-hook',
  });
  return final ? 'stopped' : 'extended';
}
// Finalise a segment at stopMs and forget it. Errors propagate (the segment is kept and retried by the watchdog), except 404.
async function closeSegment(cfg, st, seg, stopMs, why) {
  try {
    const r = await syncSegment(cfg, seg, stopMs, true);
    log(`${why}: ${r} entry ${seg.id || '(never reached a minute)'}`);
  } catch (err) {
    if (!/→ 404/.test(err.message)) throw err;
    log(`${why}: entry ${seg.id} already gone`);
  }
  delete st.entries[seg.projectId];
}
const projectName = (cfg, id) => Object.keys(cfg.projects).find((n) => cfg.projects[n].id === id) || String(id);

// ---------- project mapping ----------
function projectFor(cwd, cfg) {
  if (!cwd) return null;
  let best = null;
  for (const [name, p] of Object.entries(cfg.projects)) {
    for (const raw of p.paths || []) {
      const base = expandHome(raw).replace(/\/+$/, '');
      if (cwd === base || cwd.startsWith(base + '/')) {
        if (!best || base.length > best.len) best = { name, id: p.id, len: base.length };
      }
    }
  }
  return best;
}

// ---------- hook handling ----------
function parseHook(tool, raw) {
  let j = {};
  try { j = JSON.parse(raw); } catch (e) { /* empty stdin */ }
  const sid = j.session_id || process.env.GEMINI_SESSION_ID || process.env.CLAUDE_SESSION_ID || `${tool}-${process.ppid}`;
  const cwd = j.cwd || process.env.GEMINI_CWD || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const event = j.hook_event_name || '';
  return { sid, cwd, event, isEnd: event === 'SessionEnd' };
}

async function handleHook(tool) {
  const raw = await readStdin();
  const { sid, cwd, event, isEnd } = parseHook(tool, raw);
  const cfg = loadConfig();
  if (!cfg.apiToken || !cfg.workspaceId) return; // not set up yet — stay silent
  const project = projectFor(cwd, cfg);
  const now = Date.now();
  const toolName = tool === 'gemini' ? 'Gemini CLI' : 'Claude Code';
  const idleMs = (cfg.idleMinutes || 15) * 60000;
  const syncMs = (cfg.verifyMinutes || 10) * 60000;

  await withLock(async () => {
    const st = loadState();
    try {
      if (!project) {
        st.lastUnmapped = cwd;
        delete st.sessions[sid];
        return;
      }
      const seg = st.entries[project.id];
      const tag = `${event} ${toolName} ${project.name}`;
      if (isEnd) {
        delete st.sessions[sid];
        const others = Object.values(st.sessions).some((s) => s.projectId === project.id && now - s.last <= idleMs);
        if (seg && !others) await closeSegment(cfg, st, seg, now, tag);
        return;
      }

      // Any other event is activity.
      st.sessions[sid] = { cwd, projectId: project.id, tool: toolName, last: now };
      if (seg) {
        seg.last = now;
        if (now - seg.lastSync < syncMs) return; // the cheap path: a local write, no API call
        seg.lastSync = now;
        if (!seg.live) { log(`${tag}: ${await syncSegment(cfg, seg, now, false)} entry ${seg.id || '(local)'}`); return; }
        const cur = await getCurrent(cfg);
        if (cur && cur.id === seg.id) return;
        log(`${tag}: entry ${seg.id} no longer running in Toggl — starting a new one`);
        delete st.entries[project.id]; // stopped by hand: fall through and start again
      }

      // New segment. It takes the live Toggl timer unless another project (or a manual timer) already holds it.
      const fresh = { id: null, projectId: project.id, start: nowIso(now), desc: `${toolName} · ${path.basename(cwd)}`, live: false, last: now, lastSync: now };
      let how = 'parallel';
      if (!Object.values(st.entries).some((s) => s.live)) {
        const cur = await getCurrent(cfg);
        const ours = !!cur && (cur.tags || []).includes(cfg.tag);
        if (cur && !ours) how = `parallel to your manual timer (${cur.description || 'no description'})`;
        else {
          if (cur && cur.project_id === project.id) { fresh.id = cur.id; fresh.start = cur.start; how = 'adopted running'; }
          else {
            if (cur) await syncSegment(cfg, { id: cur.id, projectId: cur.project_id, start: cur.start }, now, true); // stale timer of ours (state was lost)
            fresh.id = (await createEntry(cfg, project.id, fresh.desc, now)).id;
            how = 'started';
          }
          fresh.live = true;
        }
      }
      st.entries[project.id] = fresh;
      log(`${tag}: ${how} entry ${fresh.id || '(local, written to Toggl once it passes a minute)'}`);
    } catch (err) {
      st.lastError = `${new Date().toISOString()} ${err.message}`;
      log(`ERROR ${err.message}`);
    } finally {
      writeJson(STATE_FILE, st);
    }
  });
}

async function idleCheck() {
  const cfg = loadConfig();
  if (!cfg.apiToken) return;
  await withLock(async () => {
    const st = loadState();
    const idleMs = (cfg.idleMinutes || 15) * 60000;
    const now = Date.now();
    for (const [sid, s] of Object.entries(st.sessions)) if (now - s.last > 12 * 3600000) delete st.sessions[sid];
    for (const seg of Object.values(st.entries)) {
      if (now - seg.last <= idleMs) continue;
      try {
        await closeSegment(cfg, st, seg, seg.last, `idle ${Math.round((now - seg.last) / 60000)} min ${projectName(cfg, seg.projectId)}`);
      } catch (err) {
        st.lastError = `${new Date().toISOString()} ${err.message}`;
        log(`ERROR idle-check ${err.message}`);
      }
    }
    writeJson(STATE_FILE, st);
  });
}

async function forceStop() {
  const cfg = loadConfig();
  const st = loadState();
  const segs = Object.values(st.entries);
  if (!segs.length) { console.log('No AI timer running.'); return; }
  const now = Date.now();
  for (const seg of segs) {
    try { await closeSegment(cfg, st, seg, now, `stop ${projectName(cfg, seg.projectId)}`); console.log(`${projectName(cfg, seg.projectId)}: stopped`); }
    catch (err) { console.log(`${projectName(cfg, seg.projectId)}: ${err.message}`); }
  }
  st.sessions = {};
  writeJson(STATE_FILE, st);
}

// ---------- setup / install ----------
function ask(rl, q) { return new Promise((r) => rl.question(q, (a) => r(a.trim()))); }

async function setup() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cfg = loadConfig();
  console.log('\nToggl Track setup\n-----------------');
  console.log('Your API token is at the bottom of https://track.toggl.com/profile');
  const token = await ask(rl, `API token${cfg.apiToken ? ' [keep current]' : ''}: `);
  if (token) cfg.apiToken = token;
  if (!cfg.apiToken) { console.log('No token, aborting.'); rl.close(); return; }
  const me = await api(cfg, 'GET', '/me');
  cfg.workspaceId = me.default_workspace_id;
  console.log(`Hi ${me.fullname}. Workspace ${cfg.workspaceId}.`);

  const projects = (await api(cfg, 'GET', '/me/projects')).filter((p) => p.active !== false);
  if (!projects.length) console.log('You have no Toggl projects yet — create one in Toggl (e.g. "Startup"), then run setup again.');
  console.log('\nFor each Toggl project, enter the repo folder(s) that belong to it (comma-separated, ~ allowed). Enter to skip.\n');
  for (const p of projects) {
    const existing = cfg.projects[p.name] || {};
    const cur = (existing.paths || []).join(', ');
    const a = await ask(rl, `  ${p.name}${cur ? ` [${cur}]` : ''}: `);
    const paths = a ? a.split(',').map((s) => s.trim()).filter(Boolean) : existing.paths || [];
    cfg.projects[p.name] = { id: p.id, paths };
  }
  const idle = await ask(rl, `\nIdle minutes before the timer stops [${cfg.idleMinutes}]: `);
  if (idle && !Number.isNaN(Number(idle))) cfg.idleMinutes = Number(idle);
  rl.close();
  writeJson(CONFIG_FILE, cfg);
  console.log(`\nSaved ${CONFIG_FILE}`);
  console.log('Next: node toggl-hook.js install');
}

function mapProject(name, dir) {
  const cfg = loadConfig();
  if (!cfg.projects[name]) { console.log(`Unknown Toggl project "${name}". Known: ${Object.keys(cfg.projects).join(', ') || '(none — run setup)'}`); process.exit(1); }
  const paths = new Set(cfg.projects[name].paths || []);
  paths.add(dir.replace(/\/+$/, ''));
  cfg.projects[name].paths = [...paths];
  writeJson(CONFIG_FILE, cfg);
  console.log(`${name} ← ${[...paths].join(', ')}`);
}

function hookCommand(tool) { return `"${process.execPath}" "${INSTALLED_SCRIPT}" hook ${tool}`; }

function mergeHooks(file, events, makeHook, remove) {
  const settings = readJson(file, {});
  settings.hooks = settings.hooks || {};
  for (const ev of Object.keys(settings.hooks)) {
    settings.hooks[ev] = (settings.hooks[ev] || []).filter((m) => !(m.hooks || []).some((h) => String(h.command || '').includes(MARK)));
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (!remove) for (const ev of events) (settings.hooks[ev] = settings.hooks[ev] || []).push({ hooks: [makeHook(ev)] });
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  writeJson(file, settings);
}

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'];
const GEMINI_EVENTS = ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent', 'SessionEnd'];

function install() {
  const cfg = loadConfig();
  if (!cfg.apiToken) { console.log('Run `node toggl-hook.js setup` first.'); process.exit(1); }
  fs.mkdirSync(DIR, { recursive: true });
  if (path.resolve(__filename) !== INSTALLED_SCRIPT) fs.copyFileSync(__filename, INSTALLED_SCRIPT);

  mergeHooks(path.join(HOME, '.claude', 'settings.json'), CLAUDE_EVENTS, (ev) => ({
    type: 'command', command: hookCommand('claude'), timeout: 15,
    ...(ev === 'SessionEnd' || ev === 'SessionStart' ? {} : { async: true }),
  }));
  console.log('✓ Claude Code hooks → ~/.claude/settings.json');
  mergeHooks(path.join(HOME, '.gemini', 'settings.json'), GEMINI_EVENTS, () => ({
    name: 'toggl-hook', type: 'command', command: hookCommand('gemini'), timeout: 15000,
  }));
  console.log('✓ Gemini CLI hooks → ~/.gemini/settings.json');

  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${INSTALLED_SCRIPT}</string><string>idle-check</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${path.join(DIR, 'idle.err')}</string>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    try { execSync(`launchctl bootout gui/${process.getuid()} "${PLIST}"`, { stdio: 'ignore' }); } catch (e) { /* not loaded */ }
    fs.writeFileSync(PLIST, plist);
    execSync(`launchctl bootstrap gui/${process.getuid()} "${PLIST}"`, { stdio: 'inherit' });
    console.log('✓ Idle watchdog → launchd, every 5 min');
  } else {
    console.log(`! Not macOS: add a cron entry:  */5 * * * * ${hookCommand('x').replace('hook x', 'idle-check')}`);
  }
  console.log('\nDone. Open Claude Code or Gemini in a mapped repo and the timer starts on your first prompt.');
}

function uninstall() {
  mergeHooks(path.join(HOME, '.claude', 'settings.json'), CLAUDE_EVENTS, null, true);
  mergeHooks(path.join(HOME, '.gemini', 'settings.json'), GEMINI_EVENTS, null, true);
  if (process.platform === 'darwin' && fs.existsSync(PLIST)) {
    try { execSync(`launchctl bootout gui/${process.getuid()} "${PLIST}"`, { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    fs.unlinkSync(PLIST);
  }
  console.log('Hooks and watchdog removed. Config and logs kept in ' + DIR);
}

function status() {
  const cfg = loadConfig();
  const st = loadState();
  console.log(`Config: ${CONFIG_FILE}${cfg.apiToken ? '' : '  (no token — run setup)'}`);
  console.log(`Idle timeout: ${cfg.idleMinutes} min`);
  console.log('Projects:');
  for (const [name, p] of Object.entries(cfg.projects)) console.log(`  ${name} (#${p.id}) ← ${(p.paths || []).join(', ') || '(no folders mapped)'}`);
  const segs = Object.values(st.entries);
  console.log(segs.length ? '' : '\nNo AI timer running.');
  for (const seg of segs) {
    const where = seg.live ? 'live Toggl timer' : `parallel, ${seg.id ? `Toggl entry ${seg.id}` : 'not in Toggl yet'}, synced every ${cfg.verifyMinutes} min`;
    console.log(`${seg.live ? 'Running' : 'Tracking'}: ${projectName(cfg, seg.projectId)} (${where}), started ${seg.start}, last activity ${Math.round((Date.now() - seg.last) / 60000)} min ago`);
  }
  const live = Object.values(st.sessions).filter((s) => Date.now() - s.last < cfg.idleMinutes * 60000);
  if (live.length) console.log(`Active sessions: ${live.map((s) => `${s.tool} in ${s.cwd}`).join('; ')}`);
  if (st.lastUnmapped) console.log(`Last unmapped folder (not tracked): ${st.lastUnmapped}\n  → node toggl-hook.js map "Project" "${st.lastUnmapped}"`);
  if (st.lastError) console.log(`Last error: ${st.lastError}`);
  console.log(`Log: ${LOG_FILE}`);
}

// ---------- main ----------
(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'hook': {
        const tool = args[0] === 'gemini' ? 'gemini' : 'claude';
        try { await handleHook(tool); } catch (e) { log(`FATAL ${e.message}`); }
        if (tool === 'gemini') process.stdout.write('{}');
        break;
      }
      case 'idle-check': await idleCheck(); break;
      case 'setup': await setup(); break;
      case 'install': install(); break;
      case 'uninstall': uninstall(); break;
      case 'status': status(); break;
      case 'stop': await forceStop(); break;
      case 'map': if (args.length < 2) { console.log('usage: map "Toggl Project" /path'); process.exit(1); } mapProject(args[0], args[1]); break;
      default:
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').filter((l) => l.startsWith(' *')).map((l) => l.slice(3)).join('\n'));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
