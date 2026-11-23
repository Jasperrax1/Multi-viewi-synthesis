(function () {
  'use strict';
  const video = document.getElementById('remoteVideo');
  const status = document.getElementById('playback');
  const stats = document.getElementById('stats');
  const listeners = new Set();
  const receiver = new CameraReceiverCore.Receiver({
    video,
    send(message) {
      if (message.type === 'playback') status.textContent = `${message.payload.state} / ICE ${message.payload.iceState || '—'}`;
      if (message.type === 'error') status.textContent = message.message;
      if (message.type === 'stats') stats.textContent = JSON.stringify(message.payload, null, 2);
      for (const listener of listeners) listener(message);
    }
  });
  window.CameraReceiver = {
    handle(message) {
      const generation = receiver.generation;
      const result = receiver.handle(message);
      if (receiver.generation !== generation) {
        stats.textContent = '等待统计';
        if (!receiver.pc) status.textContent = '等待会话';
      }
      return result;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  document.getElementById('play').onclick = () => receiver.play();
  window.addEventListener('pagehide', () => receiver.reset());
})();
