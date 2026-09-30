// Synthesized sounds: pentatonic pops when building, a soft blip when removing, and a
// low filtered-noise surf in the background. No audio files needed.

const SCALE = [0, 2, 4, 7, 9]; // major pentatonic, semitones
const RAIN_GAIN = 0.05;

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.rain = 0;
    this.lastPop = 0;
    // Go fully silent while the page is hidden (other app, locked screen, background tab).
    // The context is closed rather than suspended and only reopened by the next gesture: iOS
    // leaves a context created or resumed outside a gesture silent after backgrounding.
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.close(); });
    addEventListener('pagehide', () => this.close());
  }

  // Browsers only allow audio after a user gesture
  ensure() {
    if (document.hidden) return;
    if (!this.ctx) this.open();
    // iOS reports 'interrupted' after calls; a context opened outside a gesture starts suspended
    else if (this.ctx.state !== 'running') this.ctx.resume();
  }

  open() {
    // Play through the iOS silent switch like media audio instead of ringer-style sounds
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    const ctx = (this.ctx = new AudioContext());
    // A silent buffer started inside the gesture unlocks output on older iOS
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);
    this.lastPop = 0;
    this.startSurf();
    this.startRain();
  }

  close() {
    if (!this.ctx) return;
    this.ctx.close();
    this.ctx = this.master = null;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  // Higher floors play higher notes
  pop(level) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (t - this.lastPop < 0.035) return; // fast drags would otherwise turn into noise
    this.lastPop = t;
    const semis = SCALE[level % 5] + 12 * Math.floor(level / 5) + (Math.random() < 0.5 ? 0 : 12);
    const f = 330 * Math.pow(2, semis / 12);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f * 1.5, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.04);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  remove() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(160, t + 0.14);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // Camera shutter: click then clack, each a burst of bandpassed noise over a short falling knock
  shutter() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    for (const [at, f, v] of [[0, 2600, 0.55], [0.09, 1500, 0.45]]) {
      const src = ctx.createBufferSource(), band = ctx.createBiquadFilter(), gain = ctx.createGain();
      src.buffer = buf;
      band.type = 'bandpass';
      band.frequency.value = f;
      band.Q.value = 0.7;
      gain.gain.setValueAtTime(v, t + at);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.1);
      src.connect(band).connect(gain).connect(this.master);
      src.start(t + at);
      const osc = ctx.createOscillator(), knock = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f / 3, t + at);
      osc.frequency.exponentialRampToValueAtTime(f / 8, t + at + 0.06);
      knock.gain.setValueAtTime(0.2, t + at);
      knock.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.08);
      osc.connect(knock).connect(this.master);
      osc.start(t + at);
      osc.stop(t + at + 0.1);
    }
  }

  // Rain: a soft hiss with sparse patter mixed in, faded in and out by setRain
  startRain() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let drop = 0;
    for (let i = 0; i < len; i++) {
      if (Math.random() < 0.0012) drop = 0.6 + Math.random() * 0.8;
      drop *= 0.996;
      data[i] = (Math.random() * 2 - 1) * (0.25 + drop);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 900;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 6000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = this.rain * RAIN_GAIN;
    src.connect(high).connect(low).connect(this.rainGain).connect(this.master);
    src.start();
  }

  setRain(level) {
    this.rain = level;
    if (this.ctx) this.rainGain.gain.setTargetAtTime(level * RAIN_GAIN, this.ctx.currentTime, 0.8);
  }

  // Brown noise through a lowpass, swelling slowly like waves
  startSurf() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.09;
    lfoGain.gain.value = 0.035;
    lfo.connect(lfoGain).connect(gain.gain);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    lfo.start();
  }
}
