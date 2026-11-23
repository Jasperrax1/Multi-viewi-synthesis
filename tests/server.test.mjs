import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { createCameraServer } from '../server/app.mjs';

// Tiny baseline JPEG, dimensions are parsed; storage must preserve all bytes.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=', 'base64');
async function fixture(t, options = {}) {
  const app = await createCameraServer(options); const address = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route, {token, method = 'GET', value, bytes} = {}) => fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(value ? { 'Content-Type': 'application/json' } : {}), ...(bytes ? { 'Content-Type': 'image/jpeg' } : {}) }, body: bytes ?? (value ? JSON.stringify(value) : undefined) });
  const pair = await request('/api/pair', { method: 'POST', value: { code: app.pairingCode } }); const { token } = await pair.json();
  const sockets = [];
  const connect = async auth => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/signal?token=' + auth);
    ws.inbox = []; ws.waiters = [];
    ws.on('message', data => { const m = JSON.parse(data.toString()); const i = ws.waiters.findIndex(w => w.type === m.type); if (i >= 0) ws.waiters.splice(i,1)[0].resolve(m); else ws.inbox.push(m); });
    sockets.push(ws); await once(ws, 'open'); return ws;
  };
  t.after(() => { for (const ws of sockets) ws.terminate(); });
  return { app, base, token, request, connect };
}
function message(ws, type) {
  const i = ws.inbox.findIndex(m => m.type === type); if (i >= 0) return Promise.resolve(ws.inbox.splice(i,1)[0]);
  return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(`No ${type}`)), 1500); ws.waiters.push({ type, resolve: m => { clearTimeout(timeout); resolve(m); } }); });
}
const signal = (ws, type, sessionId, payload) => ws.send(JSON.stringify({v:1,type,sessionId,payload}));

test('one-use pairing, protected APIs, static routing and upgrade origin', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/health')).status, 200);
  assert.equal((await f.request('/api/jobs')).status, 401);
  assert.equal((await fetch(f.base + '/api/jobs', {headers:{Authorization:f.token}})).status,401);
  assert.equal((await f.request('/api/pair', {method:'POST',value:{code:f.app.pairingCode}})).status,403);
  assert.equal((await f.request('/sender.html')).status,200);
  assert.equal((await f.request('/server/app.mjs')).status,404);
  const ws = new WebSocket(f.base.replace('http:','ws:') + '/signal?token=' + f.token, {origin:'http://evil.invalid'});
  const [error] = await once(ws,'error'); assert.match(error.message,/403/);
});

test('roles, bidirectional signaling, stale session fencing and reconnect', async t => {
  const f = await fixture(t); const sender = await f.connect(f.app.senderToken), receiver = await f.connect(f.token);
  const s = await message(sender,'ready'), r = await message(receiver,'ready'); assert.equal(s.sessionId,r.sessionId); assert.equal(s.role,'sender');
  const duplicate = new WebSocket(f.base.replace('http:','ws:') + '/signal?token=' + f.token);
  const [error] = await once(duplicate,'error'); assert.match(error.message,/409/);
  signal(sender,'offer',s.sessionId,{type:'offer',sdp:'v=0\r\n'}); assert.equal((await message(receiver,'offer')).payload.type,'offer');
  signal(receiver,'answer',s.sessionId,{type:'answer',sdp:'v=0\r\n'}); assert.equal((await message(sender,'answer')).payload.type,'answer');
  signal(receiver,'offer',s.sessionId,{type:'offer',sdp:'wrong role'}); assert.match((await message(receiver,'error')).message,/role/);
  signal(sender,'ice','old-session',{candidate:'old'});
  signal(sender,'ice',s.sessionId,{candidate:'current',sdpMid:'0',sdpMLineIndex:0}); assert.equal((await message(receiver,'ice')).payload.candidate,'current');
  signal(receiver,'ice',s.sessionId,null); assert.equal((await message(sender,'ice')).payload,null);
  const closed = once(receiver,'close'); receiver.close(); assert.equal((await message(sender,'peer-left')).sessionId,s.sessionId);
  await closed; const receiver2 = await f.connect(f.token); const next = await message(sender,'ready'); await message(receiver2,'ready'); assert.notEqual(next.sessionId,s.sessionId);
});

test('idempotent shutter, serialization and original JPEG metadata/hash', async t => {
  const f = await fixture(t); const sender = await f.connect(f.app.senderToken);
  let response = await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'capture_0001'}}); assert.equal(response.status,202);
  assert.equal((await message(sender,'capture')).requestId,'capture_0001');
  response = await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'capture_0001'}}); assert.equal((await response.json()).state,'pending');
  assert.equal((await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'capture_0002'}})).status,409);
  assert.equal((await f.request('/api/jobs/capture_0001/photo',{token:f.token,method:'POST',bytes:JPEG})).status,403);
  response = await f.request('/api/jobs/capture_0001/photo',{token:f.app.senderToken,method:'POST',bytes:JPEG}); assert.equal(response.status,201);
  const metadata = await response.json(); assert.equal(metadata.width,1); assert.equal(metadata.height,1); assert.equal(metadata.byteLength,JPEG.length); assert.equal(metadata.sha256,createHash('sha256').update(JPEG).digest('hex'));
  const photo = await f.request(metadata.downloadPath,{token:f.token}); assert.deepEqual(Buffer.from(await photo.arrayBuffer()),JPEG);
  response = await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'capture_0001'}}); assert.equal((await response.json()).state,'ready'); assert.equal(sender.inbox.filter(m=>m.type==='capture').length,0);
  assert.equal((await f.request('/api/jobs/capture_0001/photo',{token:f.app.senderToken,method:'POST',bytes:JPEG})).status,409);
});

test('capture timeout, invalid upload and disconnect become inspectable failures', async t => {
  const f = await fixture(t,{jobTimeoutMs:100}); const sender = await f.connect(f.app.senderToken);
  await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'timeout_0001'}}); await message(sender,'capture');
  await new Promise(resolve=>setTimeout(resolve,140));
  let job = await (await f.request('/api/jobs/timeout_0001',{token:f.token})).json(); assert.equal(job.state,'failed'); assert.match(job.error,/timed out/);
  await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'invalid_0001'}});
  assert.equal((await f.request('/api/jobs/invalid_0001/photo',{token:f.app.senderToken,method:'POST',bytes:Buffer.from('no jpeg')})).status,400);
  job = await (await f.request('/api/jobs/invalid_0001',{token:f.token})).json(); assert.equal(job.state,'failed');
  await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'disconnect_0001'}}); sender.close(); await once(sender,'close');
  job = await (await f.request('/api/jobs/disconnect_0001',{token:f.token})).json(); assert.equal(job.state,'failed'); assert.match(job.error,/disconnected/);
});

test('size limits, path-safe identifiers and sender-offline diagnosis', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'../bad/path'}})).status,400);
  assert.equal((await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'offline_0001'}})).status,503);
  await f.connect(f.app.senderToken);
  await f.request('/api/jobs',{token:f.token,method:'POST',value:{requestId:'oversize_0001'}});
  const response = await f.request('/api/jobs/oversize_0001/photo',{token:f.app.senderToken,method:'POST',bytes:Buffer.alloc(20*1024*1024+1)}); assert.equal(response.status,413);
});
