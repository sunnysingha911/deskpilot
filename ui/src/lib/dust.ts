// Magic dust: an avatar disintegrates into glowing particles (mode "out"), or gathers from them (mode
// "in", the same motion played backwards). The SVG is rasterised once (data: URL, allowed by the CSP),
// each few pixels become a particle with the avatar's real colour, and they drift up and away while
// shifting to the accent colour. No libraries; one canvas per avatar.

export interface DustOptions {
  svg: SVGSVGElement;
  canvas: HTMLCanvasElement;
  /** #rrggbb glow colour. */
  accent: string;
  mode: "in" | "out";
  ms: number;
  /** Space around the figure, in CSS px, that the canvas covers (it must be laid out that way). */
  pad: { x: number; top: number; bottom: number };
  /** ok = false: the effect couldn't run (e.g. the snapshot failed); the caller should fall back. */
  /** The first frame is on the canvas: hide the live avatar now (avoids a blank frame). */
  onStart?: () => void;
  onDone: (ok: boolean) => void;
}

interface Particle {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  delay: number;
  vx: number;
  vy: number;
  wobble: number;
  spark: boolean;
}

const STEP = 2; // CSS px per particle
const LIFE = 0.42; // fraction of the whole effect one particle takes to fly off

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function loadImage(svg: SVGSVGElement, w: number, h: number): Promise<HTMLImageElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not rasterise the avatar"));
    img.src = src;
  });
}

/** Runs the effect; returns a cancel function. Calls onDone when finished, or as soon as it fails. */
export function playDust(o: DustOptions): () => void {
  let raf = 0;
  let cancelled = false;
  const box = o.svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  const dpr = window.devicePixelRatio || 1;
  const cw = w + o.pad.x * 2;
  const ch = h + o.pad.top + o.pad.bottom;
  o.canvas.width = Math.round(cw * dpr);
  o.canvas.height = Math.round(ch * dpr);
  const ctx = o.canvas.getContext("2d");
  if (!ctx) {
    o.onDone(false);
    return () => {};
  }
  ctx.scale(dpr, dpr);
  const [ar, ag, ab] = rgb(o.accent);

  loadImage(o.svg, w, h)
    .then((img) => {
      if (cancelled) return;
      // The figure at full resolution, used as-is for the parts that haven't turned to dust yet.
      const fig = document.createElement("canvas");
      fig.width = Math.round(w * dpr);
      fig.height = Math.round(h * dpr);
      const fctx = fig.getContext("2d")!;
      fctx.drawImage(img, 0, 0, fig.width, fig.height);
      const data = fctx.getImageData(0, 0, fig.width, fig.height).data; // may throw if the canvas is tainted

      const ps: Particle[] = [];
      for (let y = 0; y < h; y += STEP) {
        for (let x = 0; x < w; x += STEP) {
          const i = (Math.round((y + STEP / 2) * dpr) * fig.width + Math.round((x + STEP / 2) * dpr)) * 4;
          if ((data[i + 3] ?? 0) < 90) continue;
          // Patchy sweep, mostly from the top down, so it reads as crumbling rather than fading.
          const patch = 0.5 + 0.5 * Math.sin(x * 0.17 + 1.3) * Math.cos(y * 0.13 - 0.7);
          const delay = Math.min(1 - LIFE, (0.35 * (y / h) + 0.18 * patch + 0.07 * Math.random()) * ((1 - LIFE) / 0.6));
          ps.push({
            x,
            y,
            r: data[i]!,
            g: data[i + 1]!,
            b: data[i + 2]!,
            delay,
            vx: (Math.random() - 0.35) * 46,
            vy: 50 + Math.random() * 70,
            wobble: Math.random() * Math.PI * 2,
            spark: Math.random() < 0.2,
          });
        }
      }
      const stars = Array.from({ length: 18 }, () => ({ x: Math.random() * (w + 30) - 15, y: Math.random() * h, at: Math.random() * 0.8, s: 2 + Math.random() * 3 }));

      const start = performance.now();
      let started = false;
      const frame = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - start) / o.ms);
        // "in" replays the dissolve backwards, so the dust gathers into the figure.
        const time = o.mode === "out" ? t : 1 - t;
        ctx.clearRect(0, 0, cw, ch);
        ctx.save();
        ctx.translate(o.pad.x, o.pad.top);

        // 1. What's still solid: the figure with holes where particles have left.
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(fig, 0, 0, w, h);
        ctx.globalCompositeOperation = "destination-out";
        for (const p of ps) if (time > p.delay) ctx.fillRect(p.x - 0.25, p.y - 0.25, STEP + 0.5, STEP + 0.5);

        // 2. The dust in flight, shifting from its own colour to the glow colour.
        ctx.globalCompositeOperation = "source-over";
        for (const p of ps) {
          const u = (time - p.delay) / LIFE;
          if (u <= 0 || u >= 1) continue;
          const e = u * u;
          const x = p.x + p.vx * e + Math.sin(u * 7 + p.wobble) * 5 * u;
          const y = p.y - p.vy * e - 18 * u;
          const k = Math.min(1, u * 2.6);
          const size = STEP * (1.15 - u * 0.5);
          ctx.globalAlpha = (1 - u) ** 0.8;
          ctx.fillStyle = `rgb(${Math.round(p.r + (ar - p.r) * k)},${Math.round(p.g + (ag - p.g) * k)},${Math.round(p.b + (ab - p.b) * k)})`;
          ctx.fillRect(x, y, size, size);
        }
        ctx.globalCompositeOperation = "lighter";
        for (const p of ps) {
          if (!p.spark) continue;
          const u = (time - p.delay) / LIFE;
          if (u <= 0 || u >= 1) continue;
          const e = u * u;
          const x = p.x + p.vx * e + Math.sin(u * 7 + p.wobble) * 5 * u;
          const y = p.y - p.vy * e - 18 * u;
          ctx.globalAlpha = 0.95 * (1 - u * 0.8);
          ctx.fillStyle = o.accent;
          ctx.beginPath();
          ctx.arc(x + 1, y + 1, 2.4 * (1 - u * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }

        // 3. Twinkles around the figure while the magic happens.
        for (const s of stars) {
          const v = (t - s.at) / 0.25;
          if (v <= 0 || v >= 1) continue;
          const a = Math.sin(v * Math.PI);
          ctx.globalAlpha = a;
          ctx.fillStyle = "#ffffff";
          const r = s.s * a;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y - r * 2);
          ctx.lineTo(s.x + r * 0.5, s.y - r * 0.5);
          ctx.lineTo(s.x + r * 2, s.y);
          ctx.lineTo(s.x + r * 0.5, s.y + r * 0.5);
          ctx.lineTo(s.x, s.y + r * 2);
          ctx.lineTo(s.x - r * 0.5, s.y + r * 0.5);
          ctx.lineTo(s.x - r * 2, s.y);
          ctx.lineTo(s.x - r * 0.5, s.y - r * 0.5);
          ctx.closePath();
          ctx.fill();
        }

        // 4. Arrival ends with a soft flash as the figure becomes solid.
        if (o.mode === "in" && t > 0.78) {
          const a = Math.sin(((t - 0.78) / 0.22) * Math.PI);
          const g = ctx.createRadialGradient(w / 2, h * 0.45, 4, w / 2, h * 0.45, w * 0.75);
          g.addColorStop(0, `rgba(${ar},${ag},${ab},${0.55 * a})`);
          g.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
          ctx.globalAlpha = 1;
          ctx.fillStyle = g;
          ctx.fillRect(-o.pad.x, -o.pad.top, cw, ch);
        }
        ctx.restore();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        if (!started) {
          started = true;
          o.onStart?.();
        }

        if (t < 1) raf = requestAnimationFrame(frame);
        else {
          ctx.clearRect(0, 0, cw, ch);
          o.onDone(true);
        }
      };
      raf = requestAnimationFrame(frame);
    })
    .catch(() => {
      if (!cancelled) o.onDone(false);
    });

  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, cw, ch);
  };
}
