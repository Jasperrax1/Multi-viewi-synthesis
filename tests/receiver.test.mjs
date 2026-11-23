import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../web/webrtc-core.js', import.meta.url), 'utf8');
const sandbox = { setInterval, clearInterval };
vm.runInNewContext(source, sandbox);
const { Receiver } = sandbox.CameraReceiverCore;
const signal = (type, sessionId, payload) => ({ v: 1, type, sessionId, payload });
function setup() {
  const sent = [], peers = [], timers = [];
  const video = { srcObject: null, play: async () => {} };
  const receiver = new Receiver({ video, send: (event) => sent.push(event),
    makePeer() {
      const peer = { remoteDescription: null, localDescription: null, candidates: [], closed: false,
        connectionState: 'connected', iceConnectionState: 'connected',
        async setRemoteDescription(desc) { this.remoteDescription = desc; },
        async addIceCandidate(candidate) { this.candidates.push(candidate); },
        getTransceivers() { return [{ receiver: { track: { kind: 'video' } }, setCodecPreferences(list) { peer.codecs = list; } }]; },
        async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; },
        async setLocalDescription(desc) { this.localDescription = desc; },
        async getStats() { return new Map(); },
        close() { this.closed = true; }
      };
      peers.push(peer); return peer;
    },
    capabilities: () => ({ codecs: [{ mimeType: 'video/VP9' }, { mimeType: 'video/VP8' }, { mimeType: 'video/H264' }] }),
    schedule: (callback) => { timers.push(callback); return callback; }, cancel: () => {}
  });
  return { receiver, sent, peers, timers, video };
}
const ready = (receiver, id = 'session-1') => receiver.handle({ v: 1, type: 'ready', sessionId: id, role: 'receiver' });
test('ICE before offer queues then drains and answer prefers H264 then VP8', async () => {
  const { receiver, peers, sent } = setup();
  await ready(receiver);
  await receiver.handle(signal('ice', 'session-1', { candidate: 'host-candidate', sdpMLineIndex: 0 }));
  await receiver.handle(signal('ice', 'session-1', null));
  assert.equal(peers[0].candidates.length, 0);
  await receiver.handle(signal('offer', 'session-1', { type: 'offer', sdp: 'offer-sdp' }));
  assert.equal(peers[0].candidates.length, 2);
  assert.equal(peers[0].candidates[1], null);
  assert.deepEqual(Array.from(peers[0].codecs, (c) => c.mimeType), ['video/H264', 'video/VP8', 'video/VP9']);
  assert.equal(sent.filter((e) => e.type === 'answer').length, 1);
});
test('new session closes prior peer and old callbacks/async answer cannot leak', async () => {
  const { receiver, peers, sent } = setup();
  await ready(receiver);
  const old = peers[0];
  const oldIce = old.onicecandidate;
  let resolveRemote;
  old.setRemoteDescription = () => new Promise((resolve) => { resolveRemote = resolve; });
  const offer = receiver.handle(signal('offer', 'session-1', { type: 'offer', sdp: 'old-offer' }));
  await ready(receiver, 'session-2');
  assert.equal(old.closed, true);
  oldIce({ candidate: { toJSON: () => ({ candidate: 'stale' }) } });
  resolveRemote();
  await offer;
  assert.equal(sent.filter((e) => e.type === 'answer' || e.type === 'ice').length, 0);
  await receiver.handle(signal('ice', 'session-1', { candidate: 'stale' }));
  assert.equal(receiver.queue.length, 0);
  await receiver.handle({ v: 1, type: 'peer-left', sessionId: 'session-1' });
  assert.equal(peers[1].closed, false);
});
test('ICE during createAnswer is applied instead of stranded', async () => {
  const { receiver, peers } = setup();
  await ready(receiver);
  let resolveAnswer;
  peers[0].createAnswer = () => new Promise((resolve) => { resolveAnswer = resolve; });
  const pending = receiver.handle(signal('offer', 'session-1', { type: 'offer', sdp: 'offer' }));
  await Promise.resolve();
  await Promise.resolve();
  await receiver.handle(signal('ice', 'session-1', { candidate: 'late-host' }));
  resolveAnswer({ type: 'answer', sdp: 'answer' });
  await pending;
  assert.equal(peers[0].candidates.length, 1);
  assert.equal(receiver.queue.length, 0);
});
test('malformed, oversized, wrong-role messages do not mutate receiver', async () => {
  const { receiver, sent, peers } = setup();
  await receiver.handle('{');
  await receiver.handle({ v: 1, type: 'ready', sessionId: 'a', role: 'sender' });
  assert.equal(peers.length, 0);
  await ready(receiver);
  await receiver.handle(signal('offer', 'session-1', { type: 'answer', sdp: 'wrong' }));
  await receiver.handle(signal('ice', 'session-1', { candidate: 42 }));
  await receiver.handle(signal('offer', 'session-1', { type: 'offer', sdp: 'x'.repeat(140000) }));
  assert.equal(peers[0].remoteDescription, null);
  assert.equal(sent.filter((e) => e.type === 'error').length, 2);
});
test('bounded candidate queue, reset cleanup, and no old-session stats', async () => {
  const { receiver, peers, sent, timers, video } = setup();
  await ready(receiver);
  for (let i = 0; i < 257; i++) await receiver.handle(signal('ice', 'session-1', { candidate: 'host' }));
  assert.equal(receiver.queue.length, 256);
  assert.equal(sent.at(-1).type, 'error');
  let resolveStats;
  peers[0].getStats = () => new Promise((resolve) => { resolveStats = resolve; });
  const pending = timers[0]();
  await receiver.handle({ v: 1, type: 'reset' });
  resolveStats(new Map());
  await pending;
  assert.equal(receiver.queue.length, 0);
  assert.equal(peers[0].closed, true);
  assert.equal(video.srcObject, null);
  assert.equal(sent.filter((e) => e.type === 'stats').length, 0);
});
test('stats report missing fields null and compute fps from decoded frames', async () => {
  const { receiver, peers, sent, timers } = setup();
  await ready(receiver);
  await timers[0]();
  const missing = sent.at(-1).payload;
  assert.equal(missing.fps, null);
  assert.equal(missing.codecImplementation, null);
  let frames = 10, timestamp = 1000;
  peers[0].getStats = async () => new Map([
    ['in', { id: 'in', type: 'inbound-rtp', kind: 'video', codecId: 'codec', framesDecoded: frames, timestamp, frameWidth: 1280, frameHeight: 720 }],
    ['codec', { type: 'codec', mimeType: 'video/H264' }]
  ]);
  await timers[0]();
  frames = 37; timestamp = 2000;
  await timers[0]();
  assert.equal(sent.at(-1).payload.fps, 27);
  assert.equal(sent.at(-1).payload.codec, 'video/H264');
  assert.equal(sent.at(-1).payload.rttSeconds, null);
});
test('missing browser WebRTC reports explicit diagnostic instead of silent wait', async () => {
  const sent = [];
  const receiver = new Receiver({ send: (message) => sent.push(message), video: {}, makePeer() { throw new Error('not supported'); } });
  await ready(receiver);
  assert.equal(sent.at(-1).type, 'error');
  assert.match(sent.at(-1).message, /RTCPeerConnection unavailable/);
});
