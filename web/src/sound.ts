// A few short synthesised tones. No audio files; off until the user turns sound on.

let ctx: AudioContext | null = null;

function tone(freq: number, at: number, length: number, gain: number, type: OscillatorType = 'sine', slideTo?: number) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime + at);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + at + length);
  amp.gain.setValueAtTime(0, ctx.currentTime + at);
  amp.gain.linearRampToValueAtTime(gain, ctx.currentTime + at + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + length);
  osc.connect(amp).connect(ctx.destination);
  osc.start(ctx.currentTime + at);
  osc.stop(ctx.currentTime + at + length + 0.05);
}

const CUES = {
  hold: () => tone(880, 0, 0.18, 0.05),
  reject: () => tone(220, 0, 0.22, 0.05, 'square', 150),
  block: () => (tone(196, 0, 0.5, 0.09, 'sine', 98), tone(784, 0.12, 0.6, 0.04)),
  verdict: () => (tone(523, 0, 0.35, 0.05), tone(659, 0.1, 0.35, 0.05), tone(784, 0.2, 0.6, 0.05)),
};

export function play(name: keyof typeof CUES) {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    CUES[name]();
  } catch {
    // Audio is a nicety; never let it break the app.
  }
}
