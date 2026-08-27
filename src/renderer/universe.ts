/**
 * Deep space behind the Pensieve.
 *
 * The brief is depth, not decoration. An earlier attempt at this filled the
 * frame with bright crossing filaments and competed with the graph for
 * attention; a real night sky is mostly empty, and the emptiness is what makes
 * the few bright things read as far away.
 *
 * So: almost entirely black, sparse stars across three depth planes, and haze
 * so faint it is only visible once you stop looking for it. Nothing here is
 * data - the graph on top remains the only thing that means anything.
 *
 * Its own canvas, so graph.ts is untouched apart from clearing rather than
 * filling its background.
 */

interface Star {
  x: number;
  y: number;
  /** 0 = furthest, 2 = nearest. Drives size, brightness and drift. */
  plane: 0 | 1 | 2;
  r: number;
  base: number;
  phase: number;
  twinkle: number;
  hue: number;
}

interface Haze {
  x: number;
  y: number;
  rx: number;
  ry: number;
  angle: number;
  hue: number;
  alpha: number;
}

/** Stars are near-white; real ones vary slightly blue to warm. */
const STAR_HUES = [210, 220, 40, 0];

/** Per-plane: share of stars, radius scale, brightness, drift speed. */
const PLANES = [
  { share: 0.62, radius: 0.5, bright: 0.32, drift: 0.0016 },
  { share: 0.28, radius: 0.9, bright: 0.55, drift: 0.0042 },
  { share: 0.1, radius: 1.5, bright: 0.85, drift: 0.009 }
] as const;

export class Universe {
  private ctx: CanvasRenderingContext2D;
  private stars: Star[] = [];
  private haze: Haze[] = [];
  private w = 0;
  private h = 0;
  private raf = 0;
  private t = 0;

  /** Lifts briefly when the brain is used. Kept small - a hint, not a flash. */
  private charge = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.raf = requestAnimationFrame(this.frame);
  }

  pulse(strength = 1): void {
    this.charge = Math.min(1, this.charge + strength * 0.5);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.floor(this.w * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seed();
  }

  private seed(): void {
    // Density scaled to area, so a large window is not empty and a small one
    // is not a snowstorm.
    const total = Math.round(Math.min(520, Math.max(140, (this.w * this.h) / 3400)));

    this.stars = [];
    PLANES.forEach((plane, index) => {
      const count = Math.round(total * plane.share);
      for (let i = 0; i < count; i++) {
        this.stars.push({
          x: Math.random() * this.w,
          y: Math.random() * this.h,
          plane: index as 0 | 1 | 2,
          r: plane.radius * (0.6 + Math.random() * 0.8),
          base: plane.bright * (0.5 + Math.random() * 0.5),
          phase: Math.random() * Math.PI * 2,
          // Only some stars twinkle; a sky where everything blinks looks fake.
          twinkle: Math.random() < 0.35 ? 0.25 + Math.random() * 0.35 : 0,
          hue: STAR_HUES[Math.floor(Math.random() * STAR_HUES.length)]!
        });
      }
    });

    // Two or three vast, barely-there clouds. Elongated, because round haze
    // reads as a vignette rather than distance.
    const hazeCount = this.w > 1100 ? 3 : 2;
    this.haze = Array.from({ length: hazeCount }, () => ({
      x: Math.random() * this.w,
      y: Math.random() * this.h,
      rx: this.w * (0.35 + Math.random() * 0.35),
      ry: this.h * (0.14 + Math.random() * 0.16),
      angle: (Math.random() - 0.5) * 1.2,
      hue: [212, 268, 190][Math.floor(Math.random() * 3)]!,
      alpha: 0.018 + Math.random() * 0.016
    }));
  }

  private frame = (now: number): void => {
    this.t = now / 1000;
    this.charge *= 0.99;
    this.render();
    this.raf = requestAnimationFrame(this.frame);
  };

  private render(): void {
    const ctx = this.ctx;
    const lift = 1 + this.charge * 0.5;

    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'lighter';

    // --- haze: distance, not colour. Should be hard to notice. ---
    for (const c of this.haze) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.angle);
      ctx.scale(1, c.ry / c.rx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, c.rx);
      g.addColorStop(0, `hsla(${c.hue}, 70%, 60%, ${c.alpha * lift})`);
      g.addColorStop(0.6, `hsla(${c.hue}, 70%, 55%, ${c.alpha * 0.35 * lift})`);
      g.addColorStop(1, `hsla(${c.hue}, 70%, 50%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, c.rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // --- stars ---
    for (const s of this.stars) {
      const plane = PLANES[s.plane]!;
      // Slow lateral drift, faster on nearer planes. Wraps rather than resets,
      // so nothing ever pops into existence.
      const x = (s.x + this.t * plane.drift * 60) % (this.w + 40) - 20;
      const flicker = s.twinkle ? 1 + Math.sin(this.t * 1.6 + s.phase) * s.twinkle : 1;
      const a = Math.min(1, s.base * flicker * lift);

      if (s.plane === 2) {
        // Near stars get a small halo, which is what sells the depth.
        const g = ctx.createRadialGradient(x, s.y, 0, x, s.y, s.r * 7);
        g.addColorStop(0, `hsla(${s.hue}, 40%, 92%, ${a * 0.5})`);
        g.addColorStop(1, `hsla(${s.hue}, 40%, 80%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, s.y, s.r * 7, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = `hsla(${s.hue}, 30%, 95%, ${a})`;
      ctx.beginPath();
      ctx.arc(x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }
}
