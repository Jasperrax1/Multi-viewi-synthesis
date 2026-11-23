const canvas = document.querySelector('#scene'), ctx = canvas.getContext('2d');
const status = document.querySelector('#status');
const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);
let socket = null, peer = null, session = null, stream = null, queuedIce = [], operation = Promise.resolve(), generation = 0, statsTimer = null;
const log = text => { status.textContent = text; };
function draw() {
  const t = performance.now(), x = (t / 5) % 960;
  ctx.fillStyle = '#14293a'; ctx.fillRect(0, 0, 960, 720);
  ctx.fillStyle = '#14cab2'; ctx.fillRect(x - 90, 190, 180, 340);
  ctx.strokeStyle = '#658598'; ctx.lineWidth = 2;
  for (let n = 0; n <= 960; n += 80) { ctx.beginPath(); ctx.moveTo(n,0); ctx.lineTo(n,720); ctx.stroke(); }
  ctx.fillStyle = '#fff'; ctx.font = '48px monospace'; ctx.fillText(new Date().toISOString(), 40, 90);
  ctx.font = '30px monospace'; ctx.fillText(`SYNTHETIC 4:3 960x720 · ${Math.floor(t)} ms`, 40, 650);
  // Four edge markers make full-frame FIT/cropping observable in diagnostic captures.
  for (const [label, x, y, color] of [['TL', 0, 0, '#ff3333'], ['TR', 920, 0, '#33ff33'], ['BL', 0, 680, '#3399ff'], ['BR', 920, 680, '#ffff33']]) {
    ctx.fillStyle = color; ctx.fillRect(x, y, 40, 40);
    ctx.fillStyle = '#000'; ctx.font = '20px monospace'; ctx.fillText(label, x + 4, y + 27);
  }
  ctx.fillStyle = Math.floor(t / 1000) % 2 ? '#ffb020' : '#f05050'; ctx.fillRect(800, 30, 120, 120);
}
setInterval(draw, 1000 / 30); draw();
function send(type, payload, id = session) { if (socket?.readyState === WebSocket.OPEN && id) socket.send(JSON.stringify({ v: 1, type, sessionId: id, payload })); }
function reset() { generation++; if (statsTimer) clearInterval(statsTimer); statsTimer = null; peer?.close(); peer = null; session = null; queuedIce = []; }
async function ready(m) {
  reset(); session = m.sessionId; const id = session, g = generation;
  const pc = new RTCPeerConnection({ iceServers: [] }); peer = pc;
  pc.onicecandidate = e => { if (peer === pc && session === id) send('ice', e.candidate?.toJSON() ?? null, id); };
  pc.onconnectionstatechange = () => { if (peer === pc) log(`Session ${id}\nWebRTC: ${pc.connectionState}\n目标 960×720 / 30fps；实际发送统计将在连接后显示。`); };
  const track = stream.getVideoTracks()[0]; const sender = pc.addTrack(track, stream);
  const transceiver = pc.getTransceivers().find(t => t.sender === sender);
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (transceiver?.setCodecPreferences && codecs) {
    const score = c => /h264/i.test(c.mimeType) ? 0 : /vp8/i.test(c.mimeType) ? 1 : 2;
    try { transceiver.setCodecPreferences([...codecs].sort((a,b) => score(a) - score(b))); }
    catch (error) { log(`Codec偏好设置不可用，将使用浏览器协商：${error.message}`); }
  }
  const offer = await pc.createOffer(); if (g !== generation) return;
  await pc.setLocalDescription(offer); if (g !== generation) return;
  send('offer', { type: 'offer', sdp: pc.localDescription.sdp }, id);
  statsTimer = setInterval(async () => {
    try {
      const stats = await pc.getStats(); if (peer !== pc) return;
      const lines = [];
      stats.forEach(s => { if (s.type === 'outbound-rtp' && s.kind === 'video') { const codec = stats.get(s.codecId); lines.push(JSON.stringify({ codec: codec?.mimeType ?? null, implementation: s.encoderImplementation ?? null, width: s.frameWidth ?? null, height: s.frameHeight ?? null, fps: s.framesPerSecond ?? null, framesEncoded: s.framesEncoded ?? null, bytesSent: s.bytesSent ?? null })); } });
      log(`Session ${id}\nWebRTC: ${pc.connectionState}\n${lines.join('\n')}\n硬件编码是否启用必须看实际实现字段；缺失为 null。`);
    } catch (error) { if (peer === pc) log(error.message); }
  }, 1000);
}
async function capture(requestId) {
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const bytes = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEG conversion failed')), 'image/jpeg', 0.95));
    const response = await fetch(`/api/jobs/${encodeURIComponent(requestId)}/photo`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/jpeg' }, body: bytes });
    if (!response.ok) throw new Error(`Upload HTTP ${response.status}`);
  } catch (error) {
    await fetch(`/api/jobs/${encodeURIComponent(requestId)}/fail`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error.message }) }).catch(() => {});
  }
}
async function handle(m) {
  if (m.type === 'capture') { void capture(m.requestId); return; }
  if (m.type === 'ready') return ready(m);
  if (m.type === 'error') { log(m.message); return; }
  if (m.sessionId !== session || !peer) return;
  const pc = peer, g = generation;
  if (m.type === 'peer-left') { reset(); log('接收端已离线；等待重新连接。'); return; }
  if (m.type === 'answer') {
    await pc.setRemoteDescription(m.payload); if (g !== generation) return;
    for (const candidate of queuedIce.splice(0)) { if (g !== generation) return; await pc.addIceCandidate(candidate); }
  } else if (m.type === 'ice') { if (!pc.remoteDescription) { if (queuedIce.length >= 256) throw new Error('ICE队列超限'); queuedIce.push(m.payload); } else await pc.addIceCandidate(m.payload); }
}
document.querySelector('#connect').onclick = () => {
  if (socket) return;
  if (!token) { log('缺少发送端凭据：请使用服务启动时输出的完整 localhost 链接。'); return; }
  if (!canvas.captureStream || !window.RTCPeerConnection || !window.isSecureContext) { log('需要支持 WebRTC 的本机 localhost 安全上下文。'); return; }
  stream = canvas.captureStream(30);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal?token=${encodeURIComponent(token)}`); socket = ws;
  ws.onopen = () => log('信令已连接，等待接收端配对。');
  ws.onmessage = e => { operation = operation.then(() => { if (socket === ws) return handle(JSON.parse(e.data)); }).catch(error => { if (socket === ws) { log(`WebRTC 错误：${error.message}`); reset(); } }); };
  ws.onclose = () => { if (socket !== ws) return; socket = null; reset(); stream?.getTracks().forEach(t => t.stop()); stream = null; log('信令断开。请检查服务/网络，点击启动重试。'); };
  ws.onerror = () => log('信令失败：检查服务与发送端凭据。');
};
document.querySelector('#disconnect').onclick = () => { reset(); socket?.close(); stream?.getTracks().forEach(t => t.stop()); };
window.addEventListener('pagehide', () => { reset(); socket?.close(); stream?.getTracks().forEach(t => t.stop()); });
