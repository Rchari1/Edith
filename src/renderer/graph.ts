export interface GraphNodeData {
  id: string;
  title: string;
  origin: 'distilled' | 'claude' | 'human';
  sourceCount: number;
  degree: number;
  missing: boolean;
  updated: string;
}

export interface GraphEdgeData {
  from: string;
  to: string;
}

interface Body extends GraphNodeData {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** 0..1 activation, decays over time. */
  considered: number;
  opened: number;
  saved: number;
}

/** How long a highlight takes to fade. Long enough to notice, short enough to stay honest. */
const DECAY_MS = 30_000;

const COLORS = {
  bg: '#0b0d12',
  edge: 'rgba(120,140,175,0.13)',
  edgeHot: 'rgba(125,211,252,0.5)',
  idle: '#3d4657',
  idleRing: '#525d73',
  ghost: '#2a3140',
  label: 'rgba(226,232,240,0.88)',
  labelDim: 'rgba(148,163,184,0.5)',
  considered: '#f5b942',
  opened: '#7dd3fc',
  saved: '#4ade80',
  claude: '#a78bfa'
};

export class BrainGraph {
  private ctx: CanvasRenderingContext2D;
  private bodies = new Map<string, Body>();
  private edges: GraphEdgeData[] = [];
  private alpha = 1;

  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dragging = false;
  private dragNode: Body | null = null;
  private lastX = 0;
  private lastY = 0;

  hovered: Body | null = null;
  selected: string | null = null;
  onSelect: (id: string | null) => void = () => {};
  onHover: (node: GraphNodeData | null, x: number, y: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.attach();
    this.resize();
    requestAnimationFrame(this.frame);
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Replace the graph, preserving position and activation of nodes that persist. */
  setData(nodes: GraphNodeData[], edges: GraphEdgeData[]): void {
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const next = new Map<string, Body>();

    nodes.forEach((n, i) => {
      const prev = this.bodies.get(n.id);
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      const ring = 120 + Math.min(260, nodes.length * 3);
      next.set(n.id, {
        ...n,
        x: prev?.x ?? cx + Math.cos(angle) * ring + (Math.random() - 0.5) * 40,
        y: prev?.y ?? cy + Math.sin(angle) * ring + (Math.random() - 0.5) * 40,
        vx: prev?.vx ?? 0,
        vy: prev?.vy ?? 0,
        r: nodeRadius(n),
        considered: prev?.considered ?? 0,
        opened: prev?.opened ?? 0,
        saved: prev?.saved ?? 0
      });
    });

    this.bodies = next;
    this.edges = edges.filter((e) => next.has(e.from) && next.has(e.to));
    this.alpha = Math.max(this.alpha, 0.7);
  }

  /** Light nodes up. This is called straight off an MCP tool call. */
  activate(ids: string[], kind: 'considered' | 'opened' | 'saved'): void {
    for (const id of ids) {
      const body = this.bodies.get(id);
      if (!body) continue;
      body[kind] = 1;
      // Opening implies it was considered; keep the dim ring lit underneath.
      if (kind === 'opened') body.considered = Math.max(body.considered, 0.6);
      this.alpha = Math.max(this.alpha, 0.25);
    }
  }

  focus(id: string): void {
    const body = this.bodies.get(id);
    if (!body) return;
    const rect = this.canvas.getBoundingClientRect();
    this.offsetX = rect.width / 2 - body.x * this.scale;
    this.offsetY = rect.height / 2 - body.y * this.scale;
  }

  private attach(): void {
    const c = this.canvas;

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
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
      const { x, y } = this.toWorld(e);
      const hit = this.hitTest(x, y);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (hit) {
        this.dragNode = hit;
        this.selected = hit.id;
        this.onSelect(hit.id);
      } else {
        this.dragging = true;
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.dragNode) {
        const { x, y } = this.toWorld(e);
        this.dragNode.x = x;
        this.dragNode.y = y;
        this.dragNode.vx = 0;
        this.dragNode.vy = 0;
        this.alpha = Math.max(this.alpha, 0.3);
        return;
      }
      if (this.dragging) {
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
      const { x, y } = this.toWorld(e);
      const hit = this.hitTest(x, y);
      if (hit !== this.hovered) {
        this.hovered = hit;
        this.onHover(hit, e.clientX, e.clientY);
      }
      this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    });

    window.addEventListener('mouseup', () => {
      this.dragging = false;
      this.dragNode = null;
    });

    window.addEventListener('resize', () => this.resize());
  }

  private toWorld(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - this.offsetX) / this.scale,
      y: (e.clientY - rect.top - this.offsetY) / this.scale
    };
  }

  private hitTest(x: number, y: number): Body | null {
    let best: Body | null = null;
    let bestD = Infinity;
    for (const b of this.bodies.values()) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < b.r + 8 && d < bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  }

  /** O(n^2) repulsion. Fine for a personal knowledge base; revisit past ~2k nodes. */
  private simulate(dt: number): void {
    const bodies = [...this.bodies.values()];
    if (bodies.length === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    if (this.alpha > 0.005) {
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i]!;
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j]!;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            d2 = 1;
          }
          const force = (2600 * this.alpha) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }

      for (const e of this.edges) {
        const a = this.bodies.get(e.from)!;
        const b = this.bodies.get(e.to)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const rest = 130;
        const force = (d - rest) * 0.02 * this.alpha;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      for (const b of bodies) {
        b.vx += (cx - b.x) * 0.0016 * this.alpha;
        b.vy += (cy - b.y) * 0.0016 * this.alpha;
      }

      this.alpha *= 0.985;
    }

    for (const b of bodies) {
      if (b === this.dragNode) continue;
      b.vx *= 0.86;
      b.vy *= 0.86;
      b.x += b.vx * dt * 0.06;
      b.y += b.vy * dt * 0.06;
    }
  }

  private decay(dt: number): void {
    const step = dt / DECAY_MS;
    for (const b of this.bodies.values()) {
      b.considered = Math.max(0, b.considered - step);
      b.opened = Math.max(0, b.opened - step);
      b.saved = Math.max(0, b.saved - step * 2);
    }
  }

  private lastT = performance.now();

  private frame = (t: number): void => {
    const dt = Math.min(48, t - this.lastT);
    this.lastT = t;
    this.simulate(dt);
    this.decay(dt);
    this.render();
    requestAnimationFrame(this.frame);
  };

  private render(): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    for (const e of this.edges) {
      const a = this.bodies.get(e.from)!;
      const b = this.bodies.get(e.to)!;
      const heat = Math.max(a.opened, b.opened, a.considered * 0.5, b.considered * 0.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = heat > 0.05 ? COLORS.edgeHot : COLORS.edge;
      ctx.lineWidth = heat > 0.05 ? 1.1 + heat * 1.6 : 0.9;
      ctx.globalAlpha = heat > 0.05 ? 0.35 + heat * 0.65 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const b of this.bodies.values()) {
      const activation = Math.max(b.opened, b.considered, b.saved);
      const color = b.saved > 0.02
        ? COLORS.saved
        : b.opened > 0.02
          ? COLORS.opened
          : b.considered > 0.02
            ? COLORS.considered
            : b.missing
              ? COLORS.ghost
              : b.origin === 'claude'
                ? COLORS.claude
                : COLORS.idle;

      if (activation > 0.02) {
        ctx.shadowBlur = 14 + activation * 34;
        ctx.shadowColor = color;
      }

      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r + activation * 3.5, 0, Math.PI * 2);
      if (b.missing && activation < 0.02) {
        ctx.strokeStyle = COLORS.ghost;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = b.missing ? 0.45 : 0.55 + activation * 0.45;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.shadowBlur = 0;

      if (this.selected === b.id || this.hovered === b) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = this.selected === b.id ? '#e2e8f0' : COLORS.idleRing;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      const showLabel = this.scale > 0.55 && (b.r > 7 || activation > 0.02 || this.hovered === b);
      if (showLabel) {
        ctx.font = '11px ui-sans-serif, -apple-system, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = activation > 0.02 ? COLORS.label : COLORS.labelDim;
        const label = b.title.length > 26 ? `${b.title.slice(0, 25)}...` : b.title;
        ctx.fillText(label, b.x, b.y + b.r + 13);
      }
    }

    ctx.restore();
  }
}

function nodeRadius(n: GraphNodeData): number {
  if (n.missing) return 4;
  return 5 + Math.min(9, Math.sqrt(n.degree) * 2.2 + Math.sqrt(n.sourceCount) * 1.4);
}
