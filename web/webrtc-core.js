/* Shared, network-free receiver. Shared by desktop diagnostic UI and its tests. */
(function (root) {
  'use strict';
  const MAX_MESSAGE = 131072;
  const sessionPattern = /^[A-Za-z0-9_-]{1,100}$/;
  const finite = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
  function validIce(value) {
    return value === null || (value && typeof value === 'object' && !Array.isArray(value) &&
      typeof value.candidate === 'string' && value.candidate.length <= 16384 &&
      (value.sdpMid == null || typeof value.sdpMid === 'string') &&
      (value.sdpMLineIndex == null || (Number.isInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0)));
  }
  function preferCodecs(transceiver, capabilities) {
    if (!transceiver.setCodecPreferences || !capabilities || !Array.isArray(capabilities.codecs)) return false;
    const codecs = capabilities.codecs;
    const rank = (codec) => /\/h264$/i.test(codec.mimeType) ? 0 : /\/vp8$/i.test(codec.mimeType) ? 1 : 2;
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
    return true;
  }
  class Receiver {
    constructor(options) {
      this.send = options.send;
      this.video = options.video;
      this.makePeer = options.makePeer || (() => new RTCPeerConnection({ iceServers: [] }));
      this.capabilities = options.capabilities || (() => typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities('video') : null);
      this.makeStream = options.makeStream || ((track) => new MediaStream([track]));
      this.schedule = options.schedule || ((callback) => setInterval(callback, 1000));
      this.cancel = options.cancel || ((timer) => clearInterval(timer));
      this.pc = null;
      this.sessionId = null;
      this.generation = 0;
      this.queue = [];
      this.statsTimer = null;
      this.previous = null;
      this.statsBusy = false;
      this.offerBusy = false;
    }
    emit(type, payload, message) {
      if (!this.sessionId) return;
      const event = { v: 1, type, sessionId: this.sessionId };
      if (payload !== undefined) event.payload = payload;
      if (message !== undefined) event.message = String(message).slice(0, 500);
      this.send(event);
    }
    active(pc, generation) { return this.pc === pc && this.generation === generation; }
    reset() {
      this.generation += 1;
      if (this.statsTimer !== null) this.cancel(this.statsTimer);
      this.statsTimer = null;
      if (this.pc) {
        this.pc.onicecandidate = null;
        this.pc.ontrack = null;
        this.pc.onconnectionstatechange = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.close();
      }
      this.pc = null;
      this.sessionId = null;
      this.queue = [];
      this.previous = null;
      this.statsBusy = false;
      this.offerBusy = false;
      if (this.video) this.video.srcObject = null;
    }
    start(sessionId) {
      this.reset();
      this.sessionId = sessionId;
      let pc;
      try { pc = this.makePeer(); }
      catch (error) {
        this.emit('error', undefined, `RTCPeerConnection unavailable: ${String(error).slice(0, 200)}`);
        return;
      }
      const generation = this.generation;
      this.pc = pc;
      pc.onicecandidate = (event) => {
        if (this.active(pc, generation)) this.emit('ice', event.candidate ? event.candidate.toJSON() : null);
      };
      pc.ontrack = (event) => {
        if (!this.active(pc, generation) || event.track.kind !== 'video') return;
        this.video.srcObject = event.streams[0] || this.makeStream(event.track);
        this.play();
      };
      pc.onconnectionstatechange = () => {
        if (this.active(pc, generation)) this.emit('playback', { state: pc.connectionState, iceState: pc.iceConnectionState });
      };
      pc.oniceconnectionstatechange = () => {
        if (this.active(pc, generation)) this.emit('playback', { state: pc.connectionState, iceState: pc.iceConnectionState });
      };
      this.statsTimer = this.schedule(() => this.stats(pc, generation));
      this.emit('playback', { state: 'waiting-offer' });
    }
    async play() {
      const pc = this.pc;
      const generation = this.generation;
      if (!pc || !this.video) return;
      try {
        await this.video.play();
        if (this.active(pc, generation)) this.emit('playback', { state: 'playing' });
      } catch (error) {
        if (this.active(pc, generation)) this.emit('playback', { state: 'needs-user-gesture', detail: String(error).slice(0, 200) });
      }
    }
    async handle(input) {
      let event;
      const operationGeneration = this.generation;
      try {
        const encoded = typeof input === 'string' ? input : JSON.stringify(input);
        if (!encoded || encoded.length > MAX_MESSAGE) throw new Error('Message exceeds limit');
        event = JSON.parse(encoded);
        if (!event || Array.isArray(event) || event.v !== 1 || typeof event.type !== 'string') throw new Error('Invalid envelope');
        if (event.type === 'reset') { this.reset(); return; }
        if (!sessionPattern.test(event.sessionId || '')) throw new Error('Invalid session');
        if (event.type === 'ready') {
          if (event.role !== 'receiver') throw new Error('Receiver role required');
          if (event.sessionId !== this.sessionId || !this.pc) this.start(event.sessionId);
          return;
        }
        if (event.sessionId !== this.sessionId || !this.pc) return;
        if (event.type === 'peer-left') { this.reset(); return; }
        if (event.type !== 'offer' && event.type !== 'ice') throw new Error('Unsupported message type');
        const pc = this.pc;
        const generation = this.generation;
        if (event.type === 'ice') {
          if (!validIce(event.payload)) throw new Error('Invalid ICE');
          if (!pc.remoteDescription) {
            if (this.queue.length >= 256) throw new Error('ICE queue limit');
            this.queue.push(event.payload);
          } else {
            await pc.addIceCandidate(event.payload);
          }
          return;
        }
        if (!event.payload || event.payload.type !== 'offer' || typeof event.payload.sdp !== 'string' || event.payload.sdp.length > 100000) throw new Error('Invalid offer');
        if (this.offerBusy || pc.remoteDescription) throw new Error('Duplicate offer');
        this.offerBusy = true;
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: event.payload.sdp });
          if (!this.active(pc, generation)) return;
          for (const transceiver of pc.getTransceivers()) {
            if (transceiver.receiver.track.kind === 'video') {
              transceiver.direction = 'recvonly';
              try { preferCodecs(transceiver, this.capabilities()); }
              catch (error) { this.emit('playback', { state: 'codec-preference-unavailable', detail: String(error).slice(0, 200) }); }
            } else {
              transceiver.direction = 'inactive';
            }
          }
          while (this.queue.length) {
            await pc.addIceCandidate(this.queue.shift());
            if (!this.active(pc, generation)) return;
          }
          const answer = await pc.createAnswer();
          if (!this.active(pc, generation)) return;
          await pc.setLocalDescription(answer);
          if (!this.active(pc, generation)) return;
          this.emit('answer', { type: 'answer', sdp: pc.localDescription.sdp });
        } finally {
          if (this.active(pc, generation)) this.offerBusy = false;
        }
      } catch (error) {
        // A stale promise must not report an error against a new session.
        if (this.generation === operationGeneration && event && event.sessionId === this.sessionId) this.emit('error', undefined, error.message || error);
      }
    }
    async stats(pc, generation) {
      if (!this.active(pc, generation) || this.statsBusy) return;
      this.statsBusy = true;
      try {
        const report = await pc.getStats();
        if (!this.active(pc, generation)) return;
        let inbound = null;
        let pair = null;
        report.forEach((entry) => {
          if (entry.type === 'inbound-rtp' && (entry.kind === 'video' || entry.mediaType === 'video') && !entry.isRemote) inbound = entry;
          if (entry.type === 'transport' && entry.selectedCandidatePairId) pair = report.get(entry.selectedCandidatePairId);
        });
        const codec = inbound && report.get(inbound.codecId);
        let fps = null;
        if (inbound && this.previous && inbound.id === this.previous.id && inbound.timestamp > this.previous.timestamp && inbound.framesDecoded >= this.previous.framesDecoded) {
          fps = (inbound.framesDecoded - this.previous.framesDecoded) * 1000 / (inbound.timestamp - this.previous.timestamp);
        }
        if (inbound && finite(inbound.framesDecoded) !== null) this.previous = { id: inbound.id, timestamp: inbound.timestamp, framesDecoded: inbound.framesDecoded };
        this.emit('stats', {
          timestamp: inbound ? finite(inbound.timestamp) : null,
          codec: codec ? codec.mimeType || null : null,
          codecImplementation: inbound ? inbound.decoderImplementation || null : null,
          powerEfficientDecoder: inbound && typeof inbound.powerEfficientDecoder === 'boolean' ? inbound.powerEfficientDecoder : null,
          fps: finite(fps), width: inbound ? finite(inbound.frameWidth) : null, height: inbound ? finite(inbound.frameHeight) : null,
          framesDecoded: inbound ? finite(inbound.framesDecoded) : null,
          framesDropped: inbound ? finite(inbound.framesDropped) : null,
          bytesReceived: inbound ? finite(inbound.bytesReceived) : null,
          packetsLost: inbound ? finite(inbound.packetsLost) : null,
          jitter: inbound ? finite(inbound.jitter) : null,
          rttSeconds: pair ? finite(pair.currentRoundTripTime) : null,
          candidatePairState: pair ? pair.state || null : null,
          connectionState: pc.connectionState, iceState: pc.iceConnectionState
        });
      } catch (error) {
        if (this.active(pc, generation)) this.emit('error', undefined, `getStats: ${String(error).slice(0, 200)}`);
      } finally {
        if (this.active(pc, generation)) this.statsBusy = false;
      }
    }
  }
  root.CameraReceiverCore = { Receiver, preferCodecs, validIce };
})(typeof globalThis !== 'undefined' ? globalThis : window);
