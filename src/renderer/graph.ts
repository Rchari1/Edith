export interface GraphNodeData {
  id: string;
  title: string;
  origin: 'distilled' | 'claude' | 'human';
  /** First tag. Currently unused visually - the object is monochrome for now. */
  category: string;
  sourceCount: number;
  degree: number;
  missing: boolean;
  updated: string;
}

export interface GraphEdgeData {
  from: string;
  to: string;
}

export interface CategoryInfo {
  name: string;
  color: string;
  count: number;
}

/**
 * A particle riding the flow field. Notes are named particles; dust is the
 * anonymous body of the shape.
 */
interface Body extends GraphNodeData {
  /** Attractor-space coordinates, integrated each frame. */
  sx: number;
  sy: number;
  sz: number;
  /** World position derived from attractor space. */
  x: number;
  y: number;
  z: number;
  r: number;
  /** 0..1 activation, decays over time. */
  considered: number;
  opened: number;
  saved: number;
  /** Projected position/scale this frame, in stage space. */
  px: number;
  py: number;
  pd: number;
  /** Recent world positions - the filament the particle draws. */
  trail: Array<{ x: number; y: number; z: number }>;
}

interface Dust {
  sx: number;
  sy: number;
  sz: number;
  s: number;
  a: number;
}

/** An expanding shockwave from an activated note. */
interface Ripple {
  id: string;
  t: number;
  color: string;
}

interface Star {
  x: number;
  y: number;
  z: number;
  r: number;
  ph: number;
}

/** How long a highlight takes to fade. Long enough to notice, short enough to stay honest. */
const DECAY_MS = 30_000;

/** Perspective strength: focal length in stage pixels. */
const FOCAL = 900;

/**
 * The shape is the Aizawa attractor - a genuinely volumetric strange attractor:
 * a swirling disc threaded onto a vertical column, with particles that
 * occasionally ride up the polar axis and dive back down the outside. It reads
 * three-dimensional from every angle, and exists only as motion.
 */
const AIZ_A = 0.95;
const AIZ_B = 0.7;
const AIZ_C = 0.6;
const AIZ_D = 3.5;
const AIZ_E = 0.25;
const AIZ_F = 0.1;
/** Attractor units -> stage pixels. */
const SCALE = 165;
/** Vertical midpoint of the attractor's z range, for centering on screen. */
const Z_MID = 0.7;
/** Integration speed: quick enough that the flow is unmistakable. */
const FLOW_DT = 0.0025;
/** Present the attractor spiral face-on: tip the column into the screen. */
const FACE_TILT = 1.15;
const FT_C = Math.cos(FACE_TILT);
const FT_S = Math.sin(FACE_TILT);
/** Anonymous particles that give the object its body. */
const DUST_COUNT = 5200;

/** All ambient motion (flow, auto-camera, twinkle, murmurs) honors this. */
const REDUCED_MOTION =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const COLORS = {
  bg: '#0A0A0A',
  star: '#bbbbbb',
  mono: '#d9d9d9',
  dust: '#f5f5f5',
  ghost: '#555555',
  ring: '#7a7a7a',
  accent: '#ffffff',
  considered: '#c4c4c4',
  opened: '#ffffff',
  saved: '#e0e0e0'
};

const TWO_PI = Math.PI * 2;

function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** FNV-1a - seeds each note's particle deterministically. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 - tiny deterministic PRNG so the particle field never re-rolls. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One Euler step of the Aizawa field, kept inside its basin. */
function flowStep(p: { sx: number; sy: number; sz: number }, dt: number): void {
  const dx = (p.sz - AIZ_B) * p.sx - AIZ_D * p.sy;
  const dy = AIZ_D * p.sx + (p.sz - AIZ_B) * p.sy;
  const dz =
    AIZ_C +
    AIZ_A * p.sz -
    (p.sz * p.sz * p.sz) / 3 -
    (p.sx * p.sx + p.sy * p.sy) * (1 + AIZ_E * p.sz) +
    AIZ_F * p.sz * p.sx * p.sx * p.sx;
  p.sx += dx * dt;
  p.sy += dy * dt;
  p.sz += dz * dt;
  // Aizawa is not globally attracting: a particle flung far outside (a hard
  // drag) could diverge. Clamp to the basin; the flow pulls it home.
  if (!Number.isFinite(p.sx) || !Number.isFinite(p.sy) || !Number.isFinite(p.sz)) {
    p.sx = 0.1;
    p.sy = 0.1;
    p.sz = Z_MID + Math.random() * 0.3;
    return;
  }
  p.sx = Math.max(-4, Math.min(4, p.sx));
  p.sy = Math.max(-4, Math.min(4, p.sy));
  p.sz = Math.max(-2, Math.min(3, p.sz));
}

/** Drop a particle near the basin and let it settle onto the attractor. */
function seedParticle(rand: () => number): { sx: number; sy: number; sz: number } {
  const p = {
    sx: (rand() - 0.5) * 2,
    sy: (rand() - 0.5) * 2,
    sz: rand() * 1.4
  };
  const settle = 400 + Math.floor(rand() * 1000);
  for (let i = 0; i < settle; i++) flowStep(p, 0.004);
  return p;
}

export class BrainGraph {
  private ctx: CanvasRenderingContext2D;
  private bodies = new Map<string, Body>();
  private dust: Dust[] = [];

  private stars: Star[] = [];
  private ripples: Ripple[] = [];
  private murmurTimer = 0;

  /** Camera orbit around the vertical axis through the shape's center. */
  private yaw = Math.PI / 2;
  private yawVel = 0;
  private pitch = 0.16;
  private lastInteract = -Infinity;
  private targetYaw: number | null = null;

  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  /** Node the camera is gliding toward; null when the camera is free. */
  private flyId: string | null = null;
  private breath = 1;
  private panning = false;
  private orbiting = false;
  private dragNode: Body | null = null;
  private lastX = 0;
  private lastY = 0;

  /** Per-frame rotation terms, shared by projection and unprojection. */
  private cosY = 1;
  private sinY = 0;
  private cosP = 1;
  private sinP = 0;
  private cx = 0;
  private cy = 0;

  private spriteCache = new Map<string, HTMLCanvasElement>();

  hovered: Body | null = null;
  selected: string | null = null;
  /** Note being previewed from the sidebar list - it and its road ahead light up. */
  private previewId: string | null = null;
  /** Category highlight - dormant while the object is monochrome. */
  highlight: string | null = null;
  onSelect: (id: string | null) => void = () => {};
  onHover: (node: GraphNodeData | null, x: number, y: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.seedDust();
    this.attach();
    this.resize();
    // Open the scene already close to the shape, centered in the visible area.
    const r0 = canvas.getBoundingClientRect();
    if (r0.width > 0) {
      this.scale = 1.7;
      const px = r0.width / 2 + 150;
      const py = r0.height / 2;
      this.offsetX = px * (1 - this.scale);
      this.offsetY = py * (1 - this.scale);
    }
    requestAnimationFrame(this.frame);
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seedStars(rect.width, rect.height);
  }

  private seedStars(w: number, h: number): void {
    const count = Math.min(260, Math.round((w * h) / 8000));
    this.stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      z: 0.15 + Math.random() * 0.35,
      r: 0.4 + Math.random() * 1.1,
      ph: Math.random() * TWO_PI
    }));
  }

  private seedDust(): void {
    const rand = mulberry(0x5eed);
    this.dust = Array.from({ length: DUST_COUNT }, () => ({
      ...seedParticle(rand),
      s: 0.45 + rand() * 0.95,
      a: 0.07 + rand() * 0.12
    }));
  }

  /** The shape is the data: every note becomes a particle in the flow. */
  setData(nodes: GraphNodeData[], _edges: GraphEdgeData[]): void {
    const next = new Map<string, Body>();
    for (const n of nodes) {
      const prev = this.bodies.get(n.id);
      const spawn = prev ?? seedParticle(mulberry(hashStr(n.id)));
      next.set(n.id, {
        ...n,
        sx: spawn.sx,
        sy: spawn.sy,
        sz: spawn.sz,
        x: prev?.x ?? 0,
        y: prev?.y ?? 0,
        z: prev?.z ?? 0,
        r: nodeRadius(n),
        considered: prev?.considered ?? 0,
        opened: prev?.opened ?? 0,
        saved: prev?.saved ?? 0,
        px: prev?.px ?? 0,
        py: prev?.py ?? 0,
        pd: prev?.pd ?? 1,
        trail: prev?.trail ?? []
      });
    }
    this.bodies = next;
    this.ripples = this.ripples.filter((r) => next.has(r.id));
  }

  /** Categories are dormant while the object is monochrome. */
  categories(): CategoryInfo[] {
    return [];
  }

  setHighlight(category: string | null): void {
    this.highlight = category;
  }

  /** Sidebar hover: spotlight one particle and the path it is about to travel. */
  preview(id: string | null): void {
    this.previewId = id;
  }

  /** Light nodes up. This is called straight off an MCP tool call. */
  activate(ids: string[], kind: 'considered' | 'opened' | 'saved'): void {
    const color = COLORS[kind];
    for (const id of ids) {
      const body = this.bodies.get(id);
      if (!body) continue;
      body[kind] = 1;
      // Opening implies it was considered; keep the dim glow lit underneath.
      if (kind === 'opened') body.considered = Math.max(body.considered, 0.6);
      if (this.ripples.length > 40) this.ripples.shift();
      this.ripples.push({ id, t: 0, color });
    }
  }

  /** Swing the camera around until the note faces us, then glide onto it. */
  focus(id: string): void {
    const body = this.bodies.get(id);
    if (!body) return;
    this.flyId = id;
    const rx = body.x - this.cx;
    const rz = body.z;
    if (Math.hypot(rx, rz) > 1) this.targetYaw = -Math.PI / 2 - Math.atan2(rz, rx);
  }

  private markInteract(): void {
    this.lastInteract = performance.now();
    this.flyId = null;
    this.targetYaw = null;
  }

  /* ---------------- interaction ---------------- */

  private attach(): void {
    const c = this.canvas;

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.markInteract();
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(3.5, Math.max(0.2, this.scale * factor));
      // Zoom toward the cursor rather than the origin.
      this.offsetX = mx - ((mx - this.offsetX) * next) / this.scale;
      this.offsetY = my - ((my - this.offsetY) * next) / this.scale;
      this.scale = next;
    }, { passive: false });

    c.addEventListener('mousedown', (e) => {
      this.markInteract();
      const { x, y } = this.toStage(e);
      const hit = this.hitTest(x, y);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (hit && e.button === 0 && !e.shiftKey) {
        this.dragNode = hit;
        this.selected = hit.id;
        this.onSelect(hit.id);
      } else if (e.button === 2 || e.shiftKey) {
        // Right or shift-drag pans; plain drag orbits the shape.
        this.panning = true;
      } else {
        this.orbiting = true;
        this.yawVel = 0;
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.dragNode) {
        this.markInteract();
        const { x, y } = this.toStage(e);
        this.moveNodeTo(this.dragNode, x, y);
        return;
      }
      if (this.orbiting) {
        this.markInteract();
        const dYaw = (e.clientX - this.lastX) * 0.005;
        this.yaw += dYaw;
        this.yawVel = dYaw;
        this.pitch = Math.min(0.9, Math.max(-0.9, this.pitch + (e.clientY - this.lastY) * 0.003));
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        return;
      }
      if (this.panning) {
        this.markInteract();
        this.offsetX += e.clientX - this.lastX;
        this.offsetY += e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (!inside) {
        if (this.hovered) {
          this.hovered = null;
          this.onHover(null, 0, 0);
        }
        return;
      }
      const { x, y } = this.toStage(e);
      const hit = this.hitTest(x, y);
      if (hit !== this.hovered) {
        this.hovered = hit;
        this.onHover(hit, e.clientX, e.clientY);
      }
      this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    });

    window.addEventListener('mouseup', () => {
      this.panning = false;
      this.orbiting = false;
      // A released particle simply rejoins the flow from wherever it was left -
      // the attractor reclaims it on its own.
      this.dragNode = null;
    });

    window.addEventListener('resize', () => this.resize());
  }

  /** Screen event -> stage space (the plane projection lands on, before pan/zoom). */
  private toStage(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    // Undo the breathing zoom first, then the pan/zoom transform.
    const sx = (e.clientX - rect.left - cx) / this.breath + cx;
    const sy = (e.clientY - rect.top - cy) / this.breath + cy;
    return { x: (sx - this.offsetX) / this.scale, y: (sy - this.offsetY) / this.scale };
  }

  /** Put a dragged particle where the cursor is, preserving its current depth. */
  private moveNodeTo(b: Body, sx: number, sy: number): void {
    const z2 = FOCAL / Math.max(0.05, b.pd) - FOCAL;
    const x1 = (sx - this.cx) / Math.max(0.05, b.pd);
    const y2 = (sy - this.cy) / Math.max(0.05, b.pd);
    // Invert pitch, then yaw.
    const ry = y2 * this.cosP + z2 * this.sinP;
    const z1 = -y2 * this.sinP + z2 * this.cosP;
    const rx = x1 * this.cosY + z1 * this.sinY;
    const rz = -x1 * this.sinY + z1 * this.cosY;
    b.x = this.cx + rx;
    b.y = this.cy + ry;
    b.z = rz;
    // Back into attractor space (undoing the face-on tilt), so releasing
    // hands the particle to the flow.
    const v1 = -ry;
    const d1 = rz;
    const v0 = v1 * FT_C + d1 * FT_S;
    const d0 = -v1 * FT_S + d1 * FT_C;
    b.sx = rx / SCALE;
    b.sy = d0 / SCALE;
    b.sz = Z_MID + v0 / SCALE;
  }

  private hitTest(x: number, y: number): Body | null {
    let best: Body | null = null;
    let bestD = Infinity;
    let bestPd = -Infinity;
    for (const b of this.bodies.values()) {
      const d = Math.hypot(b.px - x, b.py - y);
      if (d < b.r * b.pd + 8 && (b.pd > bestPd || d < bestD)) {
        best = b;
        bestD = d;
        bestPd = b.pd;
      }
    }
    return best;
  }

  /* ---------------- time ---------------- */

  private decay(dt: number): void {
    const step = dt / DECAY_MS;
    for (const b of this.bodies.values()) {
      b.considered = Math.max(0, b.considered - step);
      b.opened = Math.max(0, b.opened - step);
      b.saved = Math.max(0, b.saved - step * 2);
    }
  }

  private updateCamera(dt: number, t: number): void {
    const idleFor = t - this.lastInteract;

    // Guided flight toward a focused note.
    if (this.targetYaw !== null) {
      let d = this.targetYaw - this.yaw;
      d = ((d + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
      const k = Math.min(1, dt * 0.004);
      this.yaw += d * k;
      if (Math.abs(d) < 0.01) this.targetYaw = null;
    } else if (this.orbiting) {
      // Handled in mousemove.
    } else if (Math.abs(this.yawVel) > 0.0004) {
      // Released with a flick: keep spinning, bleed off gently.
      this.yaw += this.yawVel * (dt / 16.7);
      this.yawVel *= Math.pow(0.94, dt / 16.7);
    } else if (!REDUCED_MOTION && idleFor > 2500) {
      // The resting state: an imperceptibly slow orbit - one turn in ~7 minutes.
      const ease = Math.min(1, (idleFor - 2500) / 3000);
      this.yaw += 0.000015 * dt * ease;
    }

    const wobble = REDUCED_MOTION ? 0 : 0.01 * Math.sin(t * 0.00007);
    this.cosY = Math.cos(this.yaw);
    this.sinY = Math.sin(this.yaw);
    this.cosP = Math.cos(this.pitch + wobble);
    this.sinP = Math.sin(this.pitch + wobble);

    // Glide the viewport onto the focused note as it swings around.
    if (this.flyId) {
      const b = this.bodies.get(this.flyId);
      if (!b) {
        this.flyId = null;
      } else {
        const rect = this.canvas.getBoundingClientRect();
        const tx = rect.width / 2 - b.px * this.scale;
        const ty = rect.height / 2 - b.py * this.scale;
        const k = Math.min(1, dt * 0.005);
        this.offsetX += (tx - this.offsetX) * k;
        this.offsetY += (ty - this.offsetY) * k;
        if (this.targetYaw === null && Math.hypot(tx - this.offsetX, ty - this.offsetY) < 0.5) this.flyId = null;
      }
    }

    // A breath so shallow it is felt rather than seen.
    this.breath = REDUCED_MOTION ? 1 : 1 + 0.003 * Math.sin(t * 0.00012);
  }

  /** World point -> stage space through the camera's rotation and perspective. */
  private project(wx: number, wy: number, wz: number): { x: number; y: number; pd: number } {
    const rx = wx - this.cx;
    const ry = wy - this.cy;
    const x1 = rx * this.cosY - wz * this.sinY;
    const z1 = rx * this.sinY + wz * this.cosY;
    const y2 = ry * this.cosP - z1 * this.sinP;
    const z2 = ry * this.sinP + z1 * this.cosP;
    const pd = FOCAL / Math.max(FOCAL * 0.2, FOCAL + z2);
    return { x: this.cx + x1 * pd, y: this.cy + y2 * pd, pd };
  }

  /** Attractor space -> world space, tipped so the spiral disc faces the viewer. */
  private toWorld(sx: number, sy: number, sz: number): { x: number; y: number; z: number } {
    const v0 = (sz - Z_MID) * SCALE;
    const d0 = sy * SCALE;
    return {
      x: this.cx + sx * SCALE,
      y: this.cy - (v0 * FT_C - d0 * FT_S),
      z: v0 * FT_S + d0 * FT_C
    };
  }

  private updateMotion(dt: number, t: number): void {
    const rect = this.canvas.getBoundingClientRect();
    // The canvas runs full-bleed under the glass sidebar; keep the shape
    // centered in the visible area to its right.
    this.cx = rect.width / 2 + 150;
    this.cy = rect.height / 2;

    this.updateCamera(dt, t);

    const step = REDUCED_MOTION ? 0 : FLOW_DT * (dt / 16.7);

    // Notes ride the flow.
    for (const b of this.bodies.values()) {
      if (b !== this.dragNode) {
        if (step > 0) {
          flowStep(b, step);
          flowStep(b, step);
        }
        const w = this.toWorld(b.sx, b.sy, b.sz);
        b.x = w.x;
        b.y = w.y;
        b.z = w.z;
      }
      const proj = this.project(b.x, b.y, b.z);
      b.px = proj.x;
      b.py = proj.y;
      b.pd = proj.pd;

      // Filaments: world-space, so camera moves leave no smear - only flow does.
      if (!REDUCED_MOTION) {
        const last = b.trail[b.trail.length - 1];
        if (!last || Math.hypot(b.x - last.x, b.y - last.y, b.z - last.z) > 2.5) {
          b.trail.push({ x: b.x, y: b.y, z: b.z });
          const hot =
            Math.max(b.opened, b.considered, b.saved) > 0.04 ||
            this.selected === b.id ||
            this.previewId === b.id;
          const cap = hot ? 38 : 30;
          while (b.trail.length > cap) b.trail.shift();
        }
      }
    }

    // The anonymous body of the shape rides along.
    if (step > 0) {
      for (const d of this.dust) {
        flowStep(d, step);
        flowStep(d, step);
      }
    }

    // Rare murmurs: now and then one thought stirs.
    if (!REDUCED_MOTION && this.bodies.size > 0) {
      this.murmurTimer -= dt;
      if (this.murmurTimer <= 0) {
        this.murmurTimer = 9000 + Math.random() * 13000;
        const all = [...this.bodies.values()].filter((b) => !b.missing);
        const b = all[Math.floor(Math.random() * all.length)];
        if (b && this.ripples.length < 40) this.ripples.push({ id: b.id, t: 0.45, color: COLORS.mono });
      }
    }

    for (const r of this.ripples) r.t += dt / 1100;
    this.ripples = this.ripples.filter((r) => r.t < 1);
  }

  private lastT = performance.now();

  private frame = (t: number): void => {
    const dt = Math.min(48, t - this.lastT);
    this.lastT = t;
    this.decay(dt);
    this.updateMotion(dt, t);
    this.render(t);
    requestAnimationFrame(this.frame);
  };

  /* ---------------- drawing ---------------- */

  /** A quiet dot with a slight gaussian falloff. */
  private dotSprite(color: string): HTMLCanvasElement {
    let sprite = this.spriteCache.get(color);
    if (sprite) return sprite;
    sprite = document.createElement('canvas');
    const S = 128;
    const c = S / 2;
    sprite.width = sprite.height = S;
    const sctx = sprite.getContext('2d')!;
    const g = sctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, hexToRgba(color, 0.95));
    g.addColorStop(0.5, hexToRgba(color, 0.42));
    g.addColorStop(0.8, hexToRgba(color, 0));
    g.addColorStop(1, hexToRgba(color, 0));
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, S, S);
    this.spriteCache.set(color, sprite);
    return sprite;
  }

  /** Depth cue: far things recede, near things pop. */
  private depthAlpha(pd: number): number {
    return Math.min(1, 0.3 + 0.8 * pd);
  }

  private render(t: number): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    // A single deep-teal ground: flat, confident, no gradient theatrics.
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.save();
    // Breathing zoom around the viewport center, then the user's pan/zoom.
    ctx.translate(cx, cy);
    ctx.scale(this.breath, this.breath);
    ctx.translate(-cx, -cy);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    // The anonymous body of the shape: lighter and airier than the real notes,
    // so the two particle species stay visually distinct.
    const dustSprite = this.dotSprite(COLORS.dust);
    for (const d of this.dust) {
      const w = this.toWorld(d.sx, d.sy, d.sz);
      const pt = this.project(w.x, w.y, w.z);
      const s = d.s * 3.4 * pt.pd;
      ctx.globalAlpha = d.a * this.depthAlpha(pt.pd);
      ctx.drawImage(dustSprite, pt.x - s / 2, pt.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    // Trails of thought: a faint glow under a thin thread, tapering to nothing.
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const b of this.bodies.values()) {
      if (b.trail.length < 2) continue;
      const activation = Math.max(b.opened, b.considered, b.saved);
      const focused = this.selected === b.id || this.previewId === b.id;
      const stateColor = b.saved > 0.02 ? COLORS.saved : b.opened > 0.02 ? COLORS.opened : COLORS.considered;
      const color = activation > 0.04 ? stateColor : focused ? COLORS.accent : COLORS.mono;
      const maxA = focused ? 0.4 : activation > 0.04 ? 0.28 : 0.1;
      let prev = this.project(b.trail[0]!.x, b.trail[0]!.y, b.trail[0]!.z);
      for (let i = 1; i < b.trail.length; i++) {
        const pt = this.project(b.trail[i]!.x, b.trail[i]!.y, b.trail[i]!.z);
        const k = i / b.trail.length;
        const depth = this.depthAlpha(pt.pd);
        ctx.strokeStyle = color;
        // A whisper of glow.
        ctx.globalAlpha = k * maxA * 0.22 * depth;
        ctx.lineWidth = (focused ? 3.2 : 2.6) * k * pt.pd;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        // The thread.
        ctx.globalAlpha = k * maxA * depth;
        ctx.lineWidth = (focused ? 1.3 : 1) * (0.4 + 0.6 * k) * pt.pd;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        prev = pt;
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Ripples: a quiet ring rolling out from a touched note.
    for (const r of this.ripples) {
      const b = this.bodies.get(r.id);
      if (!b) continue;
      const grow = 14 + r.t * 70;
      ctx.globalAlpha = (1 - r.t) * 0.22 * this.depthAlpha(b.pd);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 1 * b.pd;
      ctx.beginPath();
      ctx.arc(b.px, b.py, grow * b.pd, 0, TWO_PI);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Lit paths: a hovered note previews its road ahead in cyan; a selected
    // note keeps its road lit in white for as long as it stays selected.
    const litPaths: Array<{ b: Body; color: string; alpha: number }> = [];
    const pb = this.previewId ? this.bodies.get(this.previewId) : null;
    if (pb) litPaths.push({ b: pb, color: COLORS.accent, alpha: 0.55 });
    if (this.selected && this.selected !== this.previewId) {
      const sb = this.bodies.get(this.selected);
      if (sb) litPaths.push({ b: sb, color: COLORS.accent, alpha: 0.42 });
    }
    for (const lit of litPaths) {
      // The road ahead: run a phantom copy forward through the flow.
      const ghost = { sx: lit.b.sx, sy: lit.b.sy, sz: lit.b.sz };
      ctx.lineCap = 'round';
      let prev = this.project(lit.b.x, lit.b.y, lit.b.z);
      const STEPS = 60;
      for (let i = 1; i <= STEPS; i++) {
        for (let k = 0; k < 6; k++) flowStep(ghost, 0.003);
        const w = this.toWorld(ghost.sx, ghost.sy, ghost.sz);
        const pt = this.project(w.x, w.y, w.z);
        const fade = (1 - i / STEPS) * this.depthAlpha(pt.pd);
        ctx.strokeStyle = lit.color;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = fade * lit.alpha * 0.2;
        ctx.lineWidth = 3.2 * pt.pd;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        ctx.globalAlpha = fade * lit.alpha * 0.8;
        ctx.lineWidth = 1 * pt.pd;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        prev = pt;
      }
      ctx.globalAlpha = 1;
    }

    // Named particles, painted far to near. No labels - hover carries the name.
    const byDepth = [...this.bodies.values()].sort((a, b) => a.pd - b.pd);
    for (const b of byDepth) {
      const activation = Math.max(b.opened, b.considered, b.saved);
      const depth = this.depthAlpha(b.pd);
      const pr = b.r * b.pd;
      const stateColor = b.saved > 0.02
        ? COLORS.saved
        : b.opened > 0.02
          ? COLORS.opened
          : b.considered > 0.02
            ? COLORS.considered
            : null;
      const color = stateColor ?? (b.missing ? COLORS.ghost : COLORS.mono);

      const previewed = this.previewId === b.id;
      const halo = (pr + activation * 2.5 * b.pd) * 1.5;
      ctx.globalAlpha = ((b.missing ? 0.45 : 0.9) + activation * 0.1 + (previewed ? 0.22 : 0)) * depth;
      ctx.drawImage(this.dotSprite(previewed && !stateColor ? COLORS.accent : color), b.px - halo / 2, b.py - halo / 2, halo, halo);
      ctx.globalAlpha = 1;

      const focus = this.selected === b.id ? 1 : previewed ? 0.7 : this.hovered === b ? 0.45 : 0;
      if (focus > 0) {
        // A small soft halo instead of a hard ring - restrained, not a bloom.
        ctx.globalCompositeOperation = 'lighter';
        const aura = (pr + 5) * (1.6 + 0.5 * focus);
        ctx.globalAlpha = 0.28 * focus * depth;
        ctx.drawImage(this.dotSprite(COLORS.accent), b.px - aura / 2, b.py - aura / 2, aura, aura);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  }
}

function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

function nodeRadius(n: GraphNodeData): number {
  if (n.missing) return 3;
  return 3.5 + Math.min(6, Math.sqrt(n.degree) * 1.5 + Math.sqrt(n.sourceCount) * 1);
}
