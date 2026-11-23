/* Desktop-only transport adapter. Never bundled into the Harmony local page. */
(function () {
  'use strict';
  const element = (id) => document.getElementById(id);
  let token = null;
  let tokenAddress = null;
  let socket = null;
  let generation = 0;
  let currentSession = null;
  let captureBusy = false;
  let pendingRequestId = null;
  let photoURL = null;
  const diagnostics = [];
  const addressInput = element('address');
  addressInput.value = location.origin;
  function record(message) {
    if (!['stats', 'playback', 'error'].includes(message.type)) return;
    diagnostics.push({ at: new Date().toISOString(), ...message });
    if (diagnostics.length > 1600) diagnostics.shift();
  }
  function state(message) { element('connection').textContent = message; }
  function controls(connected) {
    element('connect').disabled = connected;
    element('disconnect').disabled = !connected;
    element('shutter').disabled = !connected || captureBusy;
  }
  function reset() {
    generation += 1;
    currentSession = null;
    if (socket) { socket.onclose = null; socket.close(); }
    socket = null;
    CameraReceiver.handle({ v: 1, type: 'reset' });
    controls(false);
  }
  function serverAddress() {
    const url = new URL(addressInput.value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请输入仅包含协议、主机和端口的 HTTP(S) 地址');
    return url.origin;
  }
  async function request(base, path, options = {}, credential = token) {
    if (!/^\/api\//.test(path)) throw new Error('Invalid API path');
    const headers = { ...options.headers };
    if (path !== '/api/pair' && credential) headers.Authorization = `Bearer ${credential}`;
    const response = await fetch(base + path, { ...options, headers, cache: 'no-store', signal: AbortSignal.timeout(35000) });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    return response;
  }
  CameraReceiver.subscribe((message) => {
    record(message);
    if (message.sessionId !== currentSession) return;
    if (message.type === 'playback' && ['playing', 'connected'].includes(message.payload.state)) state(`会话 ${currentSession}：视频已连接`);
    if (['answer', 'ice'].includes(message.type) && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  });
  element('connect').onclick = async () => {
    reset();
    const attempt = generation;
    element('connect').disabled = true;
    try {
      const base = serverAddress();
      if (tokenAddress !== base) { token = null; pendingRequestId = null; }
      if (!token) {
        const response = await request(base, '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: element('code').value.trim() }) });
        const pairing = await response.json();
        if (attempt !== generation) return;
        token = pairing.token;
        tokenAddress = base;
        element('code').value = '';
      }
      if (attempt !== generation) return;
      const url = new URL(base);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/signal';
      url.searchParams.set('token', token);
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => { if (attempt === generation) { state('信令已连接，等待发送源'); controls(true); } };
      ws.onmessage = (event) => {
        if (attempt !== generation || typeof event.data !== 'string' || event.data.length > 131072) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'ready' && message.v === 1 && message.role === 'receiver') {
            currentSession = message.sessionId;
            state(`会话 ${currentSession}：正在协商`);
          }
          if (message.type === 'peer-left' && message.sessionId === currentSession) {
            currentSession = null;
            state('发送源离线；等待重新连接');
          }
          if (message.type === 'error') state(String(message.message || '信令错误'));
          if (['ready', 'offer', 'ice', 'peer-left'].includes(message.type)) CameraReceiver.handle(message);
        } catch (_) { state('无效信令消息'); }
      };
      ws.onclose = (event) => {
        if (attempt !== generation) return;
        CameraReceiver.handle({ v: 1, type: 'reset' });
        currentSession = null;
        controls(false);
        state(`信令断开 (${event.code})。可重新连接；服务重启后需刷新并用新配对码。`);
      };
      ws.onerror = () => {
        if (attempt === generation) state('WebSocket 失败：检查地址、同一 Wi-Fi、防火墙。若 ICE 失败，另检查 AP 隔离和 UDP 限制。');
      };
    } catch (error) {
      if (attempt === generation) { state(error.message); controls(false); }
    }
  };
  element('disconnect').onclick = () => { reset(); state('已断开；配对凭据仅保留在此页面内存'); };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function jpegBytes(response) {
    const max = 20 * 1024 * 1024;
    const announced = Number(response.headers.get('Content-Length'));
    if (announced > max) throw new Error('JPEG 超过限制');
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) throw new Error('JPEG 超过限制');
        parts.push(value);
      }
    } catch (error) { await reader.cancel(); throw error; }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  }
  element('shutter').onclick = async () => {
    if (captureBusy || !socket || socket.readyState !== WebSocket.OPEN) return;
    captureBusy = true;
    controls(true);
    const attempt = generation;
    let terminal = false;
    try {
      if (!window.crypto || !crypto.subtle) throw new Error('照片校验需要安全上下文：请在开发电脑通过 http://localhost:8787/receiver.html 验证；LAN 鸿蒙端由原生 Crypto 完成校验');
      const base = serverAddress();
      const captureToken = token;
      const captureRequest = (path, options) => request(base, path, options, captureToken);
      pendingRequestId = pendingRequestId || crypto.randomUUID();
      const requestId = pendingRequestId;
      element('photo').textContent = `拍照任务 ${requestId}，请求不明确时重试沿用同一 ID`;
      let job = await (await captureRequest('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) })).json();
      if (attempt !== generation) return;
      const deadline = performance.now() + 40000;
      while (job.state === 'pending' && performance.now() < deadline) {
        await delay(300);
        if (attempt !== generation) return;
        job = await (await captureRequest(`/api/jobs/${encodeURIComponent(requestId)}`)).json();
      }
      if (job.state === 'failed') { terminal = true; throw new Error(job.error || '拍照失败'); }
      if (job.state !== 'ready') throw new Error('等待任务超时；重试将查询同一任务');
      if (attempt !== generation) return;
      if (job.requestId !== requestId || !Number.isInteger(job.byteLength) || job.byteLength <= 0 || job.byteLength > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(job.sha256)) throw new Error('无效照片元信息');
      let response;
      for (let retries = 0; ; retries += 1) {
        try {
          if (attempt !== generation) return;
          response = await captureRequest(`/api/jobs/${encodeURIComponent(requestId)}/photo`);
          break;
        }
        catch (error) { if (error.status !== 409 || retries >= 10) throw error; await delay(300); }
      }
      const bytes = await jpegBytes(response);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== job.byteLength || digest !== job.sha256.toLowerCase()) throw new Error('JPEG 长度或 SHA256 校验失败，未标记接收');
      if (attempt !== generation) return;
      if (photoURL) URL.revokeObjectURL(photoURL);
      photoURL = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      const link = document.createElement('a');
      link.href = photoURL;
      link.download = `${requestId}.jpg`;
      link.textContent = `已接收并校验 JPEG：${job.width}×${job.height}, ${job.byteLength} bytes；点击保存`;
      element('photo').replaceChildren(link);
      terminal = true;
      diagnostics.push({ at: new Date().toISOString(), type: 'photo-verified', requestId, byteLength: bytes.byteLength, sha256: digest });
    } catch (error) {
      if (attempt === generation) element('photo').textContent = error.message;
    } finally {
      if (terminal) pendingRequestId = null;
      captureBusy = false;
      controls(!!socket && socket.readyState === WebSocket.OPEN);
    }
  };
  element('export').onclick = () => {
    const blob = new Blob([JSON.stringify({ source: 'desktop-receiver', opticalLatencyMeasured: false, missingFieldsAreNull: true, samples: diagnostics }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'receiver-diagnostics.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.addEventListener('pagehide', () => { reset(); if (photoURL) URL.revokeObjectURL(photoURL); });
})();
