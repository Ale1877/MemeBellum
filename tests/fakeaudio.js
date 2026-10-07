// AudioContext falso: cuenta nodos creados y dispara onended cuando venció el stop(), con el reloj falso.
function makeFakeAudio(clock) {
  const count = { osc: 0, src: 0, gain: 0, filter: 0 };
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = (extra = {}) => ({ connect() {}, disconnect() {}, ...extra });
  class FakeAC {
    constructor() { this.state = 'running'; this.sampleRate = 8000; this.destination = node(); count.ctx = (count.ctx || 0) + 1; }
    get currentTime() { return clock.now / 1000; }
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    createGain() { count.gain++; return node({ gain: param() }); }
    createBiquadFilter() { count.filter++; return node({ frequency: param(), type: '' }); }
    createOscillator() { count.osc++; const o = node({ frequency: param(), type: '', onended: null, start() {}, stop(t) { clock.setTimeout(() => o.onended && o.onended(), Math.max(0, (t - clock.now / 1000) * 1000) + 1); } }); return o; }
    createBufferSource() { count.src++; const o = node({ buffer: null, onended: null, start() {}, stop(t) { clock.setTimeout(() => o.onended && o.onended(), Math.max(0, (t - clock.now / 1000) * 1000) + 1); } }); return o; }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }
  return { FakeAC, count };
}
module.exports = { makeFakeAudio };
