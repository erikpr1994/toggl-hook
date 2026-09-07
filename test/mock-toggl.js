'use strict';
// Minimal fake of the Toggl Track v9 endpoints toggl-hook uses. Run: node test/mock-toggl.js [port]
const http = require('http');
const entries = [];
let nextId = 1000;
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
// Toggl validates that a completed entry's duration matches stop - start, to the second.
const mismatch = (e) => e.stop && e.duration >= 0
  && Math.floor(Date.parse(e.stop) / 1000) - Math.floor(Date.parse(e.start) / 1000) !== e.duration;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = body ? JSON.parse(body) : null;
    const url = req.url.replace(/\?.*$/, '');
    if (!/^Basic /.test(req.headers.authorization || '')) return send(res, 403, { error: 'no auth' });
    if (req.method === 'GET' && url === '/me') return send(res, 200, { fullname: 'Test User', default_workspace_id: 42 });
    if (req.method === 'GET' && url === '/me/projects') return send(res, 200, [{ id: 1, name: 'Startup', active: true }, { id: 2, name: 'Client A', active: true }]);
    if (req.method === 'GET' && url === '/me/time_entries/current') return send(res, 200, entries.find((e) => e.duration < 0) || null);
    if (req.method === 'GET' && url === '/_entries') return send(res, 200, entries);
    if (req.method === 'POST' && url === '/_manual') { // test helper: user starts a manual timer
      for (const e of entries) if (e.duration < 0) { e.duration = 1; e.stop = new Date().toISOString(); }
      const e = { id: nextId++, ...j, duration: -1, tags: j.tags || [] }; entries.push(e); return send(res, 200, e);
    }
    let m;
    if (req.method === 'POST' && (m = url.match(/^\/workspaces\/(\d+)\/time_entries$/))) {
      if (j.duration < 0) for (const e of entries) if (e.duration < 0) { e.duration = 1; e.stop = new Date().toISOString(); } // starting a timer auto-stops the previous one; completed entries may overlap
      const e = { id: nextId++, workspace_id: Number(m[1]), ...j };
      if (mismatch(e)) return send(res, 400, 'Stop and duration mismatch');
      entries.push(e); return send(res, 200, e);
    }
    if ((m = url.match(/^\/workspaces\/\d+\/time_entries\/(\d+)$/))) {
      const e = entries.find((x) => x.id === Number(m[1]));
      if (!e) return send(res, 404, { error: 'not found' });
      if (req.method === 'PUT') {
        const next = { ...e, ...j };
        if (mismatch(next)) return send(res, 400, 'Stop and duration mismatch');
        Object.assign(e, j); return send(res, 200, e);
      }
      if (req.method === 'DELETE') { entries.splice(entries.indexOf(e), 1); return send(res, 200); }
    }
    send(res, 404, { error: `unhandled ${req.method} ${url}` });
  });
});
server.listen(Number(process.argv[2]) || 4599, () => console.log('mock toggl on', server.address().port));
