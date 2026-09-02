// Smoke tests for the backend API.
// Boots the real Express app on an ephemeral port and hits read-only GETs.
// Run with: npm run test:server

process.env.NODE_ENV = 'test';
process.env.MOCK_INTEGRATIONS = 'true';
// Use a throwaway database so tests never touch the seeded one.
process.env.DB_PATH = require('node:path').join(require('node:os').tmpdir(), `lead-customer-dashboard-test-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../src/server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + path, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
  });
}

test('GET /api/dashboard/stats returns all counters', async () => {
  const res = await get('/api/dashboard/stats');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body);
  for (const key of ['total_active_leads', 'meetings_this_week', 'leads_need_attention', 'new_users_last_30_days']) {
    assert.ok(Number.isInteger(res.body[key]), `${key} should be an integer, got ${res.body[key]}`);
  }
});

test('GET /api/dashboard/activity returns an array', async () => {
  const res = await get('/api/dashboard/activity');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/leads returns {leads, total}', async () => {
  const res = await get('/api/leads');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.leads));
  assert.ok(Number.isInteger(res.body.total));
});

test('GET /api/new-users returns {users, total}', async () => {
  const res = await get('/api/new-users');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.users));
  assert.ok(Number.isInteger(res.body.total));
});

test('GET /api/established-users returns {users, total}', async () => {
  const res = await get('/api/established-users');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.users));
  assert.ok(Number.isInteger(res.body.total));
});

test('GET /api/recycle-bin returns all four tab collections', async () => {
  const res = await get('/api/recycle-bin');
  assert.strictEqual(res.status, 200);
  for (const key of ['notes', 'activity', 'leads', 'users']) {
    assert.ok(Array.isArray(res.body[key]), `${key} should be an array`);
  }
});

test('GET /api/new-users/overdue returns array', async () => {
  const res = await get('/api/new-users/overdue');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/new-users/needs-review returns array', async () => {
  const res = await get('/api/new-users/needs-review');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('POST /api/recycle-bin/bulk-delete rejects empty ids', async () => {
  const result = await post('/api/recycle-bin/bulk-delete', { type: 'lead', ids: [] });
  assert.strictEqual(result.status, 400);
});

test('POST /api/activity/bulk-soft-delete rejects empty ids', async () => {
  const result = await post('/api/activity/bulk-soft-delete', { ids: [] });
  assert.strictEqual(result.status, 400);
});

test('POST /api/notes/bulk-soft-delete rejects empty ids', async () => {
  const result = await post('/api/notes/bulk-soft-delete', { ids: [] });
  assert.strictEqual(result.status, 400);
});
