/**
 * The neural field: an ambient layer rendered behind the Pensieve graph.
 *
 * Two things the reference image has that a real knowledge graph cannot:
 * density and colour. A vault of a few notes is inherently sparse, and drawing
 * fake edges between real notes would be a lie. So this is a separate layer of
 * ambient filaments that belong to no note - texture, explicitly not data -
 * with the real graph drawn on top of it.
 *
 * Deliberately its own canvas. graph.ts is untouched, so this whole effect can
 * be deleted by removing one element and one import.
 */

interface Filament {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** 0 = far, 1 = near. Drives brightness, width and parallax. */
  depth: number;
  hue: number;
  drift: number;
  phase: number;
}

interface Node {
  x: number;
  y: number;
  depth: number;
  hue: number;
  phase: number;
  size: number;
}

interface Cloud {
  x: number;
  y: number;
  r: number;
  hue: number;
  alpha: number;
  vx: number;
  vy: number;
}

/** The logo gradient, as hues: cyan -> violet -> amber, plus a teal. */
const HUES = [197, 258, 42, 168];

function hsla(hue: number, s: number, l: number, a: number): string {
  return `hsla(${hue}, ${s}%, ${l}%, ${a})`;
}

export class NeuralField {
  private ctx: CanvasRenderingContext2D;
  private filaments: Filament[] = [];
  private nodes: Node[] = [];
  private clouds: Cloud[] = [];
  private w = 0;
  private h = 0;
  private t = 0;
  private raf = 0;

  /** Rises briefly when the brain is used, so the field reacts without shouting. */
  private charge = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Call when Claude touches the brain. The field brightens and settles back. */
  pulse(strength = 1): void {
    this.charge = Math.min(1.4, this.charge + strength);
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
    const area = this.w * this.h;
    // Scaled to area so a large window is not sparse and a small one is not soup.
    const filamentCount = Math.round(Math.min(150, Math.max(40, area / 9000)));
    const cloudCount = Math.round(Math.min(9, Math.max(4, area / 240000)));

    this.filaments = [];
    this.nodes = [];
    this.clouds = [];

    for (let i = 0; i < cloudCount; i++) {
      this.clouds.push({
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        r: 180 + Math.random() * 320,
        hue: HUES[Math.floor(Math.random() * HUES.length)]!,
        alpha: 0.05 + Math.random() * 0.07,
        vx: (Math.random() - 0.5) * 0.05,
        vy: (Math.random() - 0.5) * 0.05
      });
    }

    for (let i = 0; i < filamentCount; i++) {
      const depth = Math.random();
      // Long, shallow-angled strands crossing the frame, as in the reference -
      // not short segments, which read as noise rather than structure.
      const ax = Math.random() * this.w * 1.4 - this.w * 0.2;
      const ay = Math.random() * this.h * 1.4 - this.h * 0.2;
      const angle = Math.random() * Math.PI;
      const len = 240 + Math.random() * 700;
      this.filaments.push({
        ax,
        ay,
        bx: ax + Math.cos(angle) * len,
        by: ay + Math.sin(angle) * len,
        depth,
        hue: HUES[Math.floor(Math.random() * HUES.length)]!,
        drift: 0.1 + Math.random() * 0.35,
        phase: Math.random() * Math.PI * 2
      });
    }

    // Nodes sit on filaments, so the brightest points read as junctions.
    for (const f of this.filaments) {
      if (Math.random() > 0.45) continue;
      const t = 0.2 + Math.random() * 0.6;
      this.nodes.push({
        x: f.ax + (f.bx - f.ax) * t,
        y: f.ay + (f.by - f.ay) * t,
        depth: f.depth,
        hue: f.hue,
        phase: Math.random() * Math.PI * 2,
        size: 0.6 + Math.random() * 1.6
      });
    }
  }

  private frame = (now: number): void => {
    this.t = now / 1000;
    this.charge *= 0.985;
    this.render();
    this.raf = requestAnimationFrame(this.frame);
  };

  private render(): void {
    const ctx = this.ctx;
    const boost = 1 + this.charge * 0.85;

    ctx.clearRect(0, 0, this.w, this.h);

    // --- nebula: soft colour behind everything, drifting slowly ---
    ctx.globalCompositeOperation = 'lighter';
    for (const c of this.clouds) {
      c.x += c.vx;
      c.y += c.vy;
      if (c.x < -c.r) c.x = this.w + c.r;
      if (c.x > this.w + c.r) c.x = -c.r;
      if (c.y < -c.r) c.y = this.h + c.r;
      if (c.y > this.h + c.r) c.y = -c.r;

      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
      g.addColorStop(0, hsla(c.hue, 80, 55, c.alpha * boost));
      g.addColorStop(0.55, hsla(c.hue, 75, 45, c.alpha * 0.35 * boost));
      g.addColorStop(1, hsla(c.hue, 70, 40, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- filaments: far ones first, so depth reads correctly ---
    const sorted = [...this.filaments].sort((a, b) => a.depth - b.depth);
    for (const f of sorted) {
      // Parallax: near strands drift further, which separates the planes.
      const sway = Math.sin(this.t * f.drift + f.phase) * (4 + f.depth * 14);
      const alpha = (0.05 + f.depth * 0.3) * boost;
      const light = 55 + f.depth * 25;

      ctx.strokeStyle = hsla(f.hue, 85, light, alpha);
      ctx.lineWidth = 0.25 + f.depth * 0.9;
      ctx.beginPath();
      ctx.moveTo(f.ax + sway, f.ay);
      ctx.lineTo(f.bx + sway * 1.4, f.by);
      ctx.stroke();
    }

    // --- junctions: the bright points where strands meet ---
    for (const n of this.nodes) {
      const twinkle = 0.6 + Math.sin(this.t * 1.1 + n.phase) * 0.4;
      const a = (0.12 + n.depth * 0.55) * twinkle * boost;
      const r = (n.size + n.depth * 1.4) * (1 + this.charge * 0.5);
      const sway = Math.sin(this.t * 0.25 + n.phase) * (4 + n.depth * 14);

      const g = ctx.createRadialGradient(n.x + sway, n.y, 0, n.x + sway, n.y, r * 6);
      g.addColorStop(0, hsla(n.hue, 90, 88, a));
      g.addColorStop(0.35, hsla(n.hue, 90, 68, a * 0.45));
      g.addColorStop(1, hsla(n.hue, 90, 60, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x + sway, n.y, r * 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = hsla(n.hue, 100, 95, Math.min(1, a * 2.2));
      ctx.beginPath();
      ctx.arc(n.x + sway, n.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }
}
