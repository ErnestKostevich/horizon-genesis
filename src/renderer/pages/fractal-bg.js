/**
 * Horizon "Fractal Core" shared background shader.
 *
 * Usage:
 *   <canvas id="fractalBg" aria-hidden="true"></canvas>
 *   <script src="fractal-bg.js"></script>
 *
 * The canvas is positioned fixed behind everything (z-index -1).
 * Julia set, slow breathing animation, amber + cyan palette.
 * Falls back silently if WebGL isn't available.
 */
(function () {
  'use strict';

  const FRAG = `
    precision highp float;
    uniform vec2  uRes;
    uniform float uTime;

    // Pal: interpolate between amber (low iter) and cyan (high iter), dark at edges.
    vec3 palette(float t) {
      vec3 amber = vec3(1.00, 0.71, 0.40);
      vec3 cyan  = vec3(0.49, 0.90, 1.00);
      vec3 deep  = vec3(0.03, 0.04, 0.06);
      float s = smoothstep(0.0, 0.6, t);
      vec3 c = mix(amber, cyan, s);
      return mix(deep, c, smoothstep(0.0, 0.85, t));
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
      uv *= 1.35;

      // Slow breathing — the "alive" feel.
      float breath = 0.50 + 0.08 * sin(uTime * 0.25);
      vec2 c = vec2(
        -0.76 + 0.035 * cos(uTime * 0.10),
         0.18 + 0.030 * sin(uTime * 0.13)
      );

      vec2 z = uv * breath;
      float iter = 0.0;
      const float MAX = 120.0;
      for (float i = 0.0; i < MAX; i++) {
        float x = z.x * z.x - z.y * z.y + c.x;
        float y = 2.0 * z.x * z.y + c.y;
        z = vec2(x, y);
        if (dot(z, z) > 16.0) break;
        iter += 1.0;
      }
      float t = iter / MAX;

      // Smooth outside radius.
      float smoothIter = iter - log2(max(1.0, log2(dot(z, z)))) * 0.5;
      t = clamp(smoothIter / MAX, 0.0, 1.0);

      vec3 col = palette(t);

      // Soft vignette so content in the foreground reads.
      float r = length((gl_FragCoord.xy - 0.5 * uRes) / uRes);
      col *= 1.0 - smoothstep(0.45, 0.95, r) * 0.65;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const VERT = `
    attribute vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
  `;

  function compile(gl, src, type) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[fractal-bg] shader compile error:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function init() {
    const canvas = document.getElementById('fractalBg');
    if (!canvas) return;

    // Inject the minimal positioning CSS in case the host page forgot it.
    canvas.style.position       = 'fixed';
    canvas.style.inset          = '0';
    canvas.style.width          = '100vw';
    canvas.style.height         = '100vh';
    canvas.style.zIndex         = '-1';
    canvas.style.pointerEvents  = 'none';
    canvas.style.opacity        = '0.78';

    const gl = canvas.getContext('webgl', { antialias: false, alpha: false })
          || canvas.getContext('experimental-webgl');
    if (!gl) { console.warn('[fractal-bg] WebGL unavailable'); return; }

    const vs = compile(gl, VERT, gl.VERTEX_SHADER);
    const fs = compile(gl, FRAG, gl.FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[fractal-bg] link error:', gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1, 1,
      -1,  1,  1, -1,  1, 1,
    ]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes  = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width  = Math.round(canvas.clientWidth  * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    window.addEventListener('resize', resize);

    const start = performance.now();
    let rafId = 0;
    function frame() {
      const t = (performance.now() - start) / 1000;
      gl.uniform2f(uRes,  canvas.width, canvas.height);
      gl.uniform1f(uTime, t);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      rafId = requestAnimationFrame(frame);
    }
    frame();

    // Pause when tab is hidden to save battery.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelAnimationFrame(rafId);
      else frame();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
