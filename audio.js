// Synthesized sounds: pentatonic pops when building, a soft blip when removing, and a
// low filtered-noise surf in the background. No audio files needed.

const SCALE = [0, 2, 4, 7, 9]; // major pentatonic, semitones

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.lastPop = 0;
    // Go fully silent while the page is hidden (other app, locked screen, background tab)
    const sync = () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else this.ctx.resume();
    };
    document.addEventListener('visibilitychange', sync);
    addEventListener('pagehide', () => this.ctx?.suspend());
    addEventListener('pageshow', sync);
  }

  // Browsers only allow audio after a user gesture
  ensure() {
    if (this.ctx) {
      // iOS reports 'interrupted' after calls or backgrounding
      if (this.ctx.state !== 'running' && !document.hidden) this.ctx.resume();
      return;
    }
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
    this.startSurf();
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
