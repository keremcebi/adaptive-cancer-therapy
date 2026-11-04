/* EvoDose — custom GLSL tumor tissue shader (raw WebGL, no library).
   Artsy living tissue: domain-warped fbm stroma, voronoi cells with
   membranes + nuclei, a wavy resistant invasion front, vessels, and an
   iridescent drug front. Green = sensitive (S), red = resistant (R).
   Usage: var t = createTissueShader(canvas); t.setDrug(1); t.setProgress(0.4);
*/
"use strict";
function createTissueShader(canvas, opts) {
  opts = opts || {};
  var gl = canvas.getContext("webgl", { antialias: false, alpha: false })
        || canvas.getContext("experimental-webgl");
  if (!gl) return null;

  var VERT = [
    "attribute vec2 aPos;",
    "varying vec2 vUv;",
    "void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }"
  ].join("\n");

  var FRAG = [
    "precision highp float;",
    "varying vec2 vUv;",
    "uniform vec2 uRes;",
    "uniform float uTime;",
    "uniform float uDrug;",
    "uniform float uProg;",
    "uniform float uSeed;",
    "",
    "float hash21(vec2 p){ p = fract(p*vec2(234.34,435.345)); p += dot(p,p+34.23); return fract(p.x*p.y); }",
    "vec2 hash22(vec2 p){ float n = hash21(p); return vec2(n, hash21(p+n+17.17)); }",
    "float noise(vec2 p){",
    "  vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);",
    "  float a=hash21(i); float b=hash21(i+vec2(1.0,0.0));",
    "  float c=hash21(i+vec2(0.0,1.0)); float d=hash21(i+vec2(1.0,1.0));",
    "  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);",
    "}",
    "float fbm(vec2 p){",
    "  float v=0.0; float a=0.5;",
    "  mat2 rot = mat2(0.80,0.60,-0.60,0.80);",
    "  for(int i=0;i<5;i++){ v+=a*noise(p); p=rot*p*2.02+vec2(11.3,7.7); a*=0.5; }",
    "  return v;",
    "}",
    "/* voronoi: returns (F1, F2, cellHash, distToCellPoint) */",
    "vec4 voro(vec2 p, float t){",
    "  vec2 ip=floor(p); vec2 fp=fract(p);",
    "  float f1=8.0; float f2=8.0; float id=0.0; float dp=8.0;",
    "  for(int j=-1;j<=1;j++){",
    "    for(int i=-1;i<=1;i++){",
    "      vec2 g=vec2(float(i),float(j));",
    "      vec2 o=hash22(ip+g);",
    "      o = 0.5 + 0.38*sin(t*0.55 + 6.2831*o);",
    "      vec2 r = g + o - fp;",
    "      float d = dot(r,r);",
    "      if(d<f1){ f2=f1; f1=d; id=hash21(ip+g); dp=sqrt(d); }",
    "      else if(d<f2){ f2=d; }",
    "    }",
    "  }",
    "  return vec4(sqrt(f1), sqrt(f2), id, dp);",
    "}",
    "",
    "void main(){",
    "  vec2 uv = vUv;",
    "  vec2 p = (gl_FragCoord.xy - 0.5*uRes) / min(uRes.x,uRes.y);",
    "  float t = uTime;",
    "",
    "  /* domain warp: two fbm layers folding the tissue into itself */",
    "  vec2 q = vec2(fbm(p*1.6 + vec2(0.0,0.0) + t*0.03),",
    "                fbm(p*1.6 + vec2(5.2,1.3) - t*0.02));",
    "  vec2 r = vec2(fbm(p*1.6 + 3.0*q + vec2(1.7,9.2) + 0.08*t),",
    "                fbm(p*1.6 + 3.0*q + vec2(8.3,2.8) - 0.06*t));",
    "  float f = fbm(p*1.6 + 2.5*r);",
    "",
    "  /* stroma base: posterised fbm so it reads painted, not photographic */",
    "  float bands = floor(f*7.0)/7.0;",
    "  float stroma = mix(f, bands, 0.45);",
    "  vec3 col = mix(vec3(0.016,0.027,0.023), vec3(0.075,0.11,0.09), stroma);",
    "  col = mix(col, vec3(0.05,0.03,0.045), smoothstep(0.55,0.85,fbm(p*2.3 - r)));",
    "",
    "  /* blood vessels: ridged noise carved into dark red channels */",
    "  float vess = 1.0 - abs(2.0*fbm(p*1.15 + vec2(uSeed) + q*1.4) - 1.0);",
    "  vess = smoothstep(0.86,0.99,vess);",
    "  float pulse = 0.75 + 0.25*sin(t*1.6 + p.x*3.0 + p.y*2.0);",
    "  col = mix(col, vec3(0.30,0.07,0.09)*pulse, vess*0.85);",
    "  col += vec3(0.45,0.12,0.12) * pow(vess,3.0) * 0.6;",
    "",
    "  /* cells: voronoi over warp-folded space, so colonies bulge organically */",
    "  vec2 cp = p*5.2 + r*1.6 + vec2(uSeed*3.1);",
    "  vec4 cell = voro(cp, t);",
    "  float edge = cell.y - cell.x;",
    "  float membrane = 1.0 - smoothstep(0.0,0.14,edge);",
    "  float body = 1.0 - smoothstep(0.55,0.95,cell.w);",
    "  float nucleus = 1.0 - smoothstep(0.08,0.36,cell.w);",
    "  float breath = 0.85 + 0.15*sin(t*1.3 + cell.z*40.0);",
    "",
    "  /* resistant front: wavy invasion boundary sweeping in from the right */",
    "  float frontX = mix(1.05, -0.65, uProg) + (f-0.5)*0.85 + (cell.z-0.5)*0.10;",
    "  float resistant = smoothstep(-0.06,0.12, p.x - frontX);",
    "  float frontGlow = exp(-abs(p.x - frontX)*14.0);",
    "",
    "  vec3 sBody = vec3(0.10,0.48,0.24);",
    "  vec3 sNuc  = vec3(0.03,0.20,0.10);",
    "  vec3 sMem  = vec3(0.38,0.92,0.52);",
    "  vec3 rBody = vec3(0.62,0.10,0.10);",
    "  vec3 rNuc  = vec3(0.28,0.02,0.07);",
    "  vec3 rMem  = vec3(1.00,0.34,0.20);",
    "  vec3 cBody = mix(sBody, rBody, resistant);",
    "  vec3 cNuc  = mix(sNuc, rNuc, resistant);",
    "  vec3 cMem  = mix(sMem, rMem, resistant);",
    "",
    "  /* drug pressure: sensitive cells pale and shrink, resistant hold size */",
    "  float sShrink = mix(1.0, 0.45, uDrug*(1.0-resistant));",
    "  float alive = body * breath * mix(sShrink, 1.08, resistant);",
    "  col = mix(col, cBody*(0.55+0.65*f), clamp(alive,0.0,1.0)*0.88);",
    "  col = mix(col, cNuc, nucleus*clamp(alive,0.0,1.0)*0.9);",
    "  col += cMem * membrane * (0.35+0.45*breath) * clamp(alive+0.25,0.0,1.0);",
    "  col += vec3(1.0,0.42,0.18) * frontGlow * (0.25+0.55*uProg);",
    "  /* speckles */",
    "  col += vec3(0.9) * step(0.992, hash21(floor(cp*14.0)+floor(t*2.0))) * 0.07;",
    "",
    "  /* drug front: iridescent cyan sweep from the right when drug is on */",
    "  float dfx = mix(1.6, -0.25, uDrug) + (f-0.5)*0.7;",
    "  float df = exp(-abs(p.x - dfx)*6.0);",
    "  vec3 iri = 0.5 + 0.5*cos(6.2831*(p.y*1.4 + t*0.15) + vec3(0.0,0.35,0.7));",
    "  col += mix(vec3(0.20,0.83,0.74), iri, 0.45) * df * 0.38;",
    "  col += vec3(0.20,0.83,0.74) * smoothstep(dfx, dfx+1.1, p.x) * uDrug * 0.07;",
    "",
    "  /* print finish: halftone dots, grain, vignette */",
    "  float ht = 0.96 + 0.07*sin((uv.x+uv.y)*uRes.y*1.9);",
    "  col *= ht;",
    "  col += (hash21(gl_FragCoord.xy + fract(t)*371.0)-0.5)*0.055;",
    "  float vig = smoothstep(1.25, 0.35, length(p*vec2(0.82,1.0)));",
    "  col *= mix(0.55, 1.05, vig);",
    "  col = pow(max(col,0.0), vec3(0.92));",
    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      if (window.console) console.warn("tissue-shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }
  var vs = shader(gl.VERTEX_SHADER, VERT), fs = shader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  var prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  var uRes = gl.getUniformLocation(prog, "uRes");
  var uTime = gl.getUniformLocation(prog, "uTime");
  var uDrug = gl.getUniformLocation(prog, "uDrug");
  var uProg = gl.getUniformLocation(prog, "uProg");
  var uSeed = gl.getUniformLocation(prog, "uSeed");
  gl.uniform1f(uSeed, opts.seed || 0);

  var drug = 0, drugTarget = opts.drug != null ? opts.drug : 1;
  var progress = opts.progress != null ? opts.progress : 0.35, progressTarget = progress;
  var start = performance.now(), raf = null, running = false;
  var dpr = Math.min(window.devicePixelRatio || 1, 1.75);

  function resize() {
    var w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  function draw(now) {
    resize();
    drug += (drugTarget - drug) * 0.045;
    progress += (progressTarget - progress) * 0.03;
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.uniform1f(uDrug, drug);
    gl.uniform1f(uProg, progress);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function loop(now) {
    if (!running) return;
    draw(now);
    raf = requestAnimationFrame(loop);
  }
  var api = {
    setDrug: function (v) { drugTarget = v; },
    setProgress: function (v) { progressTarget = Math.max(0, Math.min(1, v)); },
    drawOnce: function () { draw(performance.now()); },
    start: function () {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    },
    stop: function () {
      running = false;
      if (raf) cancelAnimationFrame(raf);
    }
  };
  draw(performance.now());
  return api;
}
