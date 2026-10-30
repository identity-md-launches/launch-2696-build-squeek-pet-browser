// Optional Web Audio blips. Silent unless the player turns sound on.
type Blip = 'eat' | 'happy' | 'clean' | 'pet' | 'buy' | 'grow';

const NOTES: Record<Blip, number[]> = {
  eat: [520, 440],
  happy: [660, 880],
  clean: [700, 760, 820],
  pet: [600],
  buy: [880, 1180],
  grow: [523, 659, 784, 1047],
};

let ctx: AudioContext | null = null;

export function blip(kind: Blip, muted: boolean) {
  if (muted) return;
  try {
    ctx ??= new AudioContext();
    const start = ctx.currentTime;
    NOTES[kind].forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = 'square';
      o.frequency.value = f;
      const t = start + i * 0.08;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.08);
    });
  } catch {
    /* audio unavailable: stay silent */
  }
}
