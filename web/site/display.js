// Display: draws the Lisa's 1-bit framebuffer with WebGL2 (sharp-bilinear scaling plus optional CRT
// effects), falling back to a plain 2D canvas when WebGL2 is unavailable.
//
// The Lisa's pixels are not square, so the canvas is laid out at a chosen display aspect ratio and
// the shader stretches the framebuffer to fill it. `toSource()` maps a point on the canvas back to
// Lisa screen pixels, undoing the CRT curvature, so the mouse lands where it looks like it does.

export const ASPECTS = {
  // The original LisaEm "aspect corrected" size: 720x364 stretched to 720x500.
  lisa: { label: 'Lisa (720×500)', ratio: 720 / 500 },
  square: { label: 'Square pixels', ratio: 720 / 364 },
  fourThree: { label: '4:3', ratio: 4 / 3 },
};

// Named stops of the Edge slider (device pixels of softening at the picture's edge): A hard, B crisp (default), C soft.
export const EDGES = { A: 0, B: 1.5, C: 4, max: 6 };

export const PRESETS = {
  clean:  { curve: 0,    scan: 0,    glow: 0,    mask: 0,    vignette: 0,    border: 0.03 },
  soft:   { curve: 0.04, scan: 0.35, glow: 0.35, mask: 0.12, vignette: 0.25, border: 0.05 },
  crt:    { curve: 0.09, scan: 0.6,  glow: 0.5,  mask: 0.25, vignette: 0.4,  border: 0.07 },
};

const VERT = `#version 300 es
in vec2 aPos; out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; vUV.y = 1.0 - vUV.y; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;      // R8: 1.0 where the Lisa pixel is black ink
uniform vec2 uTexSize;       // framebuffer size in Lisa pixels
uniform vec2 uOut;           // canvas size in device pixels
uniform float uCurve, uScan, uGlow, uMask, uVig, uBorder, uEdge; // uBorder: black margin on each side, as a fraction of the canvas
uniform vec3 uPaper, uInk;
in vec2 vUV; out vec4 o;

vec2 curve(vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + uCurve * dot(c, c);
  c /= 1.0 + uCurve;
  return c * 0.5 + 0.5;
}

// Sharp-bilinear: bilinear only across a narrow band at texel edges, so lines stay crisp at any scale.
vec2 sharp(vec2 uv, vec2 scale) {
  vec2 t = uv * uTexSize;
  vec2 tf = floor(t), s = t - tf;
  vec2 region = 0.5 - 0.5 / scale;
  vec2 d = s - 0.5;
  vec2 f = (d - clamp(d, -region, region)) * scale + 0.5;
  return (tf + f) / uTexSize;
}

void main() {
  // The tube is drawn inside the canvas with a black margin all round (the same fraction on both axes, so the
  // picture keeps its aspect): p runs 0..1 across the visible screen only.
  vec2 p = (vUV - uBorder) / (1.0 - 2.0 * uBorder);
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 uv = curve(p);
  vec2 edge = min(uv, 1.0 - uv);
  if (edge.x < 0.0 || edge.y < 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec2 scale = max(uOut / uTexSize, vec2(1.0));
  float ink = texture(uTex, sharp(uv, scale)).r;
  float light = 1.0 - ink;                         // the phosphor glows where the page is white

  if (uGlow > 0.0) {                               // cheap bloom: two rings of taps
    vec2 px = 1.0 / uTexSize;
    float b = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = 6.2831853 * float(i) / 8.0;
      vec2 dir = vec2(cos(a), sin(a));
      b += 1.0 - texture(uTex, uv + dir * px * 1.5).r;
      b += 1.0 - texture(uTex, uv + dir * px * 3.5).r;
    }
    b /= 16.0;
    light = clamp(light + uGlow * 0.55 * max(b - light, 0.0), 0.0, 1.0);
  }

  float rows = uOut.y / uTexSize.y;                // device pixels per scanline
  float sl = 1.0;
  if (uScan > 0.0) {
    float y = fract(uv.y * uTexSize.y) - 0.5;
    float width = mix(0.28, 0.5, light);           // bright lines bloom wider, as on a real tube
    float prof = exp(-pow(y / width, 2.0) * 1.6);
    sl = mix(1.0, prof, uScan * smoothstep(1.5, 3.5, rows));
  }

  vec3 col = mix(uInk, uPaper, light) * sl;

  if (uMask > 0.0) {                               // aperture grille, faded out when pixels are tiny
    float k = mod(gl_FragCoord.x, 3.0);
    vec3 m = vec3(k < 1.0 ? 1.0 : 0.62, (k >= 1.0 && k < 2.0) ? 1.0 : 0.62, k >= 2.0 ? 1.0 : 0.62);
    float vis = smoothstep(1.0, 2.5, uOut.x / uTexSize.x);
    col *= mix(vec3(1.0), m * 1.15, uMask * vis);
  }

  vec2 c = p * 2.0 - 1.0;
  col *= 1.0 - uVig * 0.5 * dot(c, c);
  // The picture ends sharply: the edge is only anti-aliased, over about a device pixel and a half, whatever the size
  // (a fade relative to the picture was visible as a gradient several pixels wide).
  vec2 edgePx = edge * uOut;
  float corner = clamp(min(edgePx.x, edgePx.y) / max(uEdge, 0.001), 0.0, 1.0);
  o = vec4(col * corner, 1.0);
}`;

export class Display {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.aspect = 'lisa';
    this.fx = { ...PRESETS.soft, edge: EDGES.B }; // border: the black margin around the screen, as a fraction of the height (0..0.25)
    this.paper = [0.93, 0.945, 0.9];
    this.ink = [0.02, 0.022, 0.02];
    this.frame = null; // last {bits, width, height}
    this.gl = null;
    try { this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true }); } catch { /* fall through */ }
    if (this.gl) this._initGL(); else this.ctx = canvas.getContext('2d');
    this.renderer = this.gl ? 'WebGL2' : '2D canvas';
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    this.resize();
  }

  _initGL() {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    this.prog = p;
    this.u = Object.fromEntries(['uTex', 'uTexSize', 'uOut', 'uCurve', 'uScan', 'uGlow', 'uMask', 'uVig', 'uBorder', 'uEdge', 'uPaper', 'uInk']
      .map((n) => [n, gl.getUniformLocation(p, n)]));
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.texW = this.texH = 0;
  }

  setAspect(nameOrRatio) { // a name from ASPECTS, or a number (width/height)
    this.aspect = nameOrRatio;
    this._applyLayout();
    this.resize();
  }
  _applyLayout() {
    const ratio = typeof this.aspect === 'number' ? this.aspect : ASPECTS[this.aspect].ratio;
    this.canvas.parentElement?.style.setProperty('--aspect', ratio);
  }
  /** Softness of the picture's edge in device pixels (0 = hard). */
  get edgeSoft() { const e = +this.fx.edge; return Math.max(0.001, Math.min(EDGES.max, Number.isFinite(e) ? e : EDGES.B)); }
  get border() { return Math.min(0.25, Math.max(0, this.fx.border || 0)); } // fraction of the canvas on each side
  setEffects(fx) {
    Object.assign(this.fx, fx);
    this.redraw();
  }
  get curve() { return this.gl ? this.fx.curve : 0; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.redraw();
  }

  /** @param {{bits: Uint8Array, width: number, height: number}} screen packed 1-bpp, MSB leftmost */
  present(screen) { this.frame = screen; this.redraw(); }

  redraw() {
    const f = this.frame;
    if (!f) { this._clear(); return; }
    if (!this.gl) { this._draw2d(f); return; }
    const gl = this.gl, { width: w, height: h, bits } = f;
    const px = new Uint8Array(w * h), stride = w >> 3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) px[y * w + x] = (bits[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this.texW !== w || this.texH !== h) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, px); this.texW = w; this.texH = h; }
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, px);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform2f(this.u.uTexSize, w, h);
    gl.uniform2f(this.u.uOut, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uCurve, this.fx.curve);
    gl.uniform1f(this.u.uScan, this.fx.scan);
    gl.uniform1f(this.u.uGlow, this.fx.glow);
    gl.uniform1f(this.u.uMask, this.fx.mask);
    gl.uniform1f(this.u.uVig, this.fx.vignette);
    gl.uniform1f(this.u.uBorder, this.border);
    gl.uniform1f(this.u.uEdge, this.edgeSoft);
    gl.uniform3fv(this.u.uPaper, this.paper);
    gl.uniform3fv(this.u.uInk, this.ink);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _clear() {
    if (this.gl) { this.gl.clearColor(0.04, 0.04, 0.04, 1); this.gl.clear(this.gl.COLOR_BUFFER_BIT); }
    else { this.ctx.fillStyle = '#0a0a0a'; this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); }
  }

  _draw2d(f) {
    if (!this._off || this._off.width !== f.width) { this._off = document.createElement('canvas'); this._off.width = f.width; this._off.height = f.height; }
    const img = new ImageData(f.width, f.height), stride = f.width >> 3;
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        const v = (f.bits[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 8 : 240, o = (y * f.width + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
      }
    this._off.getContext('2d').putImageData(img, 0, 0);
    const W = this.canvas.width, H = this.canvas.height, by = this.border * H, bx = this.border * W;
    this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, W, H);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this._off, bx, by, W - 2 * bx, H - 2 * by);
  }

  /**
   * Map a point in client coordinates to Lisa screen pixels, undoing the CRT curvature.
   * Returns null when the point is outside the visible tube.
   */
  toSource(clientX, clientY, srcW = 720, srcH = 364) {
    const r = this.canvas.getBoundingClientRect();
    let u = (clientX - r.left) / r.width, v = (clientY - r.top) / r.height;
    const bx = this.border, by = this.border;                           // undo the black margin
    u = (u - bx) / (1 - 2 * bx); v = (v - by) / (1 - 2 * by);
    const k = this.curve;
    if (k) { // same transform as the shader's curve()
      let cx = u * 2 - 1, cy = v * 2 - 1;
      const f = (1 + k * (cx * cx + cy * cy)) / (1 + k);
      u = (cx * f) * 0.5 + 0.5; v = (cy * f) * 0.5 + 0.5;
    }
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return [Math.min(srcW - 1, Math.max(0, Math.floor(u * srcW))), Math.min(srcH - 1, Math.max(0, Math.floor(v * srcH)))];
  }
}
