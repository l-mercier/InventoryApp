// Full-screen animated background: an ordered (Bayer) dither of a slowly drifting
// procedural mountain scene, drawn on a fixed <canvas>. Ported from Apertus Local's
// backdrop.ts (dither mode + procedural "Alps" source only — no ASCII mode, no
// video/gif media sampling, to keep this a plain script with no build step).
window.InventoryBackdrop = (() => {
  const BAYER8 = (() => {
    const m = [
      [0, 32, 8, 40, 2, 34, 10, 42],
      [48, 16, 56, 24, 50, 18, 58, 26],
      [12, 44, 4, 36, 14, 46, 6, 38],
      [60, 28, 52, 20, 62, 30, 54, 22],
      [3, 35, 11, 43, 1, 33, 9, 41],
      [51, 19, 59, 27, 49, 17, 57, 25],
      [15, 47, 7, 39, 13, 45, 5, 37],
      [63, 31, 55, 23, 61, 29, 53, 21],
    ];
    return m.map((r) => r.map((v) => (v + 0.5) / 64));
  })();

  function hash(n) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  }
  function noise1(x) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return hash(i) * (1 - u) + hash(i + 1) * u;
  }
  function noise2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix + iy * 57), b = hash(ix + 1 + iy * 57);
    const c = hash(ix + (iy + 1) * 57), d = hash(ix + 1 + (iy + 1) * 57);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  }
  function ridge(x, oct) {
    let v = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) {
      v += a * (1 - Math.abs(noise1(x * f) * 2 - 1));
      a *= 0.5;
      f *= 2.03;
    }
    return v;
  }

  class AlpsSource {
    constructor() { this.heights = []; this.slopes = []; }
    sample(lum, cols, rows, t, aspect) {
      const layers = [
        { base: 0.5, amp: 0.42, scale: 2.2, speed: 0.004, tone: 0.74, snow: 0.07, seed: 11 },
        { base: 0.66, amp: 0.3, scale: 3.4, speed: 0.009, tone: 0.6, snow: 0.035, seed: 47 },
        { base: 0.84, amp: 0.16, scale: 5.0, speed: 0.018, tone: 0.46, snow: 0, seed: 91 },
      ];
      if (this.heights.length !== layers.length || this.heights[0].length !== cols) {
        this.heights = layers.map(() => new Float32Array(cols));
        this.slopes = layers.map(() => new Float32Array(cols));
      }
      layers.forEach((L, li) => {
        const h = this.heights[li], s = this.slopes[li];
        for (let x = 0; x < cols; x++) {
          const u = (x / cols) * L.scale * aspect * 0.5 + t * L.speed + L.seed;
          h[x] = L.base - L.amp * ridge(u, 6) + L.amp * 0.35;
        }
        for (let x = 0; x < cols; x++) s[x] = (h[Math.min(cols - 1, x + 1)] - h[Math.max(0, x - 1)]) * cols * 0.5;
      });
      const sunX = 0.72, sunY = 0.22, sunR = 0.075;
      for (let y = 0; y < rows; y++) {
        const v = y / rows;
        for (let x = 0; x < cols; x++) {
          const u = x / cols;
          let l = 1;
          const dx = (u - sunX) * aspect, dy = v - sunY, dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < sunR) l = 0.86;
          else if (dist < sunR * 1.12) l = 0.72;
          const c = noise2(u * 6 * aspect - t * 0.03, v * 9) * 0.6 + noise2(u * 13 * aspect - t * 0.05, v * 19) * 0.4;
          if (v < 0.6) l = Math.max(0, l - Math.max(0, c - 0.58) * 1.4);
          for (let li = 0; li < layers.length; li++) {
            const h = this.heights[li][x];
            if (v >= h) {
              const L = layers[li];
              const depth = v - h;
              let tone = L.tone + this.slopes[li][x] * 0.08 - depth * 0.18;
              if (depth < L.snow * (1 + noise1(x * 0.7 + li * 9) * 0.8)) tone = 0.97 - Math.abs(this.slopes[li][x]) * 0.1;
              l = tone;
            }
          }
          lum[y * cols + x] = Math.min(1, Math.max(0, l));
        }
      }
    }
  }

  function hexToRgb(c) {
    const m = c.replace('#', '');
    const n = parseInt(m.length === 3 ? m.split('').map((x) => x + x).join('') : m, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  let canvas = null, ctx = null, source = null, lum = new Float32Array(0);
  let cols = 0, rows = 0, cellW = 6, cellH = 6, dpr = 1, raf = null, last = 0;
  let dither = document.createElement('canvas');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    if (!canvas) return;
    dpr = Math.min(2, devicePixelRatio || 1);
    const w = innerWidth, h = innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    cols = Math.ceil(w / cellW);
    rows = Math.ceil(h / cellH);
    lum = new Float32Array(cols * rows);
    if (reduced) draw(0);
  }

  function draw(t) {
    source.sample(lum, cols, rows, t, (cols * cellW) / (rows * cellH));
    if (dither.width !== cols || dither.height !== rows) { dither.width = cols; dither.height = rows; }
    const dctx = dither.getContext('2d');
    const img = dctx.createImageData(cols, rows);
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink-3').trim() || '#9b9b9b';
    const [r, g, b] = hexToRgb(ink.length === 7 || ink.length === 4 ? ink : '#9b9b9b');
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const d = 1 - lum[i];
        if (d > BAYER8[y & 7][x & 7]) {
          const j = i * 4;
          img.data[j] = r; img.data[j + 1] = g; img.data[j + 2] = b; img.data[j + 3] = 90;
        }
      }
    }
    dctx.putImageData(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(dither, 0, 0, cols * cellW * dpr, rows * cellH * dpr);
  }

  function tick(now) {
    if (!canvas) return;
    if (!reduced && now - last > 1000 / 20) {
      last = now;
      draw(now / 1000);
    }
    raf = requestAnimationFrame(tick);
  }

  let resizeHandler = null;

  function enable() {
    if (canvas) return; // already running
    canvas = document.getElementById('bg');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    source = new AlpsSource();
    resizeHandler = () => resize();
    addEventListener('resize', resizeHandler);
    resize();
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  function disable() {
    if (raf) cancelAnimationFrame(raf);
    if (resizeHandler) removeEventListener('resize', resizeHandler);
    raf = null; resizeHandler = null;
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas = null; ctx = null; source = null;
  }

  return { enable, disable };
})();
