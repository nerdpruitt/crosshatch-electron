import {
  createGL,
  createProgram,
  createFullscreenQuad,
  createTextureFromImage,
  createFBO,
} from "./gl.js";

async function loadText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}`);
  return await res.text();
}

async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function resizeCanvasToDisplaySize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const displayW = Math.floor(canvas.clientWidth * dpr);
  const displayH = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== displayW || canvas.height !== displayH) {
    canvas.width = displayW;
    canvas.height = displayH;
    return true;
  }
  return false;
}

function createTilingTexture(gl, img) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

const PASSTHROUGH_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_texSize;
uniform vec2 u_outSize;
uniform vec2 u_centerPx;
uniform float u_zoom;

out vec4 outColor;

void main() {
  vec2 fragPx = gl_FragCoord.xy;
  vec2 outCenter = 0.5 * u_outSize;
  vec2 imagePx = (fragPx - outCenter) / max(u_zoom, 1e-6) + u_centerPx;
  vec2 uv = imagePx / u_texSize;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(0.95, 0.95, 0.95, 1.0); // Light gray background
    return;
  }

  outColor = texture(u_image, uv);
}
`;

// --- Image Analysis ---

function mapRange(value, inMin, inMax, outMin, outMax) {
  const clamped = Math.max(inMin, Math.min(inMax, value));
  return outMin + (outMax - outMin) * ((clamped - inMin) / (inMax - inMin));
}

function rgbToLuminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function analyzeImage(gl, srcTex, srcW, srcH) {
  const analysisSize = 64;
  const fbo = createFBO(gl, analysisSize, analysisSize);
  
  const analysisVS = `#version 300 es
    layout(location=0) in vec2 a_pos;
    out vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;
  const analysisFS = `#version 300 es
    precision highp float;
    uniform sampler2D u_image;
    in vec2 v_uv;
    out vec4 outColor;
    void main() {
      outColor = texture(u_image, v_uv);
    }
  `;
  
  const analysisProg = createProgram(gl, analysisVS, analysisFS);
  const analysisQuad = createFullscreenQuad(gl);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
  gl.viewport(0, 0, analysisSize, analysisSize);
  gl.useProgram(analysisProg);
  gl.bindVertexArray(analysisQuad.vao);
  
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(gl.getUniformLocation(analysisProg, "u_image"), 0);
  
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  
  const pixels = new Uint8Array(analysisSize * analysisSize * 4);
  gl.readPixels(0, 0, analysisSize, analysisSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo.fbo);
  gl.deleteTexture(fbo.tex);
  gl.deleteProgram(analysisProg);
  gl.deleteVertexArray(analysisQuad.vao);
  gl.deleteBuffer(analysisQuad.vbo);
  
  const numPixels = analysisSize * analysisSize;
  let sumLum = 0;
  let sumLumSq = 0;
  const luminances = new Float32Array(numPixels);
  
  for (let i = 0; i < numPixels; i++) {
    const r = pixels[i * 4] / 255;
    const g = pixels[i * 4 + 1] / 255;
    const b = pixels[i * 4 + 2] / 255;
    const lum = rgbToLuminance(r, g, b);
    luminances[i] = lum;
    sumLum += lum;
    sumLumSq += lum * lum;
  }
  
  const meanLum = sumLum / numPixels;
  const variance = (sumLumSq / numPixels) - (meanLum * meanLum);
  const stdLum = Math.sqrt(Math.max(0, variance));
  
  let edgeSum = 0;
  for (let y = 1; y < analysisSize - 1; y++) {
    for (let x = 1; x < analysisSize - 1; x++) {
      const idx = y * analysisSize + x;
      const left = luminances[idx - 1];
      const right = luminances[idx + 1];
      const up = luminances[idx - analysisSize];
      const down = luminances[idx + analysisSize];
      
      const gx = right - left;
      const gy = down - up;
      const gradient = Math.sqrt(gx * gx + gy * gy);
      edgeSum += gradient;
    }
  }
  const edgeDensity = edgeSum / ((analysisSize - 2) * (analysisSize - 2));
  
  let localVarSum = 0;
  const blockSize = 8;
  const numBlocks = Math.floor(analysisSize / blockSize);
  
  for (let by = 0; by < numBlocks; by++) {
    for (let bx = 0; bx < numBlocks; bx++) {
      let blockSum = 0;
      let blockSumSq = 0;
      const blockPixels = blockSize * blockSize;
      
      for (let dy = 0; dy < blockSize; dy++) {
        for (let dx = 0; dx < blockSize; dx++) {
          const idx = (by * blockSize + dy) * analysisSize + (bx * blockSize + dx);
          const lum = luminances[idx];
          blockSum += lum;
          blockSumSq += lum * lum;
        }
      }
      
      const blockMean = blockSum / blockPixels;
      const blockVar = (blockSumSq / blockPixels) - (blockMean * blockMean);
      localVarSum += blockVar;
    }
  }
  const textureComplexity = localVarSum / (numBlocks * numBlocks);
  
  return {
    meanLum,
    stdLum,
    edgeDensity: Math.min(1, edgeDensity * 5),
    textureComplexity: Math.min(1, textureComplexity * 20)
  };
}

function calculateAutoSettings(analysis) {
  // Brightness: dark+high contrast = less boost, dark+low contrast = more boost
  let brightness;
  if (analysis.meanLum < 0.35) {
    const contrastFactor = mapRange(analysis.stdLum, 0.1, 0.25, 1.0, 0.3);
    brightness = 0.95 + (0.3 * contrastFactor);
  } else if (analysis.meanLum < 0.55) {
    brightness = mapRange(analysis.meanLum, 0.35, 0.55, 0.95, 0.85);
  } else {
    brightness = mapRange(analysis.meanLum, 0.55, 0.75, 0.85, 0.75);
  }

  const toon = mapRange(analysis.stdLum, 0.1, 0.25, 0.24, 0.28);

  const threshold = analysis.meanLum < 0.35 
    ? mapRange(analysis.meanLum, 0.15, 0.35, 0.25, 0.32)
    : mapRange(analysis.meanLum, 0.35, 0.6, 0.34, 0.30);

  const edges = analysis.meanLum < 0.35
    ? 1.0
    : mapRange(analysis.textureComplexity, 0.4, 0.8, 1.15, 1.0);

  const hatching = analysis.meanLum < 0.35
    ? mapRange(analysis.meanLum, 0.15, 0.35, 0.75, 0.90)
    : 1.0;

  const scale = 2.0;

  return { brightness, scale, hatching, edges, toon, threshold };
}

async function main() {
  const canvas = document.getElementById("gl");
  const gl = createGL(canvas);

  const vsSrc = await loadText("./shaders/fullscreen.vert");
  const fsSrc = await loadText("./shaders/crosshatch.frag");
  const prog = createProgram(gl, vsSrc, fsSrc);
  const quad = createFullscreenQuad(gl);

  const hatchImg = await loadImage("../T_hatch.jpg");
  const hatchTex = createTilingTexture(gl, hatchImg);

  const U = (name) => gl.getUniformLocation(prog, name);
  const u = {
    image: U("u_image"),
    hatchTex: U("u_hatchTex"),
    texSize: U("u_texSize"),
    outSize: U("u_outSize"),

    centerPx: U("u_centerPx"),
    zoom: U("u_zoom"),
    hatchScale: U("u_hatchScale"),
    toonThreshold: U("u_toonThreshold"),
    finalThreshold: U("u_finalThreshold"),
    brightness: U("u_brightness"),
    hatchAmount: U("u_hatchAmount"),
    edgeStrength: U("u_edgeStrength"),
  };

  const canvasOriginal = document.getElementById("glOriginal");
  const glOrig = createGL(canvasOriginal);
  const progOrig = createProgram(glOrig, vsSrc, PASSTHROUGH_FRAG);
  const quadOrig = createFullscreenQuad(glOrig);

  const uOrig = {
    image: glOrig.getUniformLocation(progOrig, "u_image"),
    texSize: glOrig.getUniformLocation(progOrig, "u_texSize"),
    outSize: glOrig.getUniformLocation(progOrig, "u_outSize"),
    centerPx: glOrig.getUniformLocation(progOrig, "u_centerPx"),
    zoom: glOrig.getUniformLocation(progOrig, "u_zoom"),
  };

  let srcTex = null;
  let srcTexOrig = null;
  let srcW = 0,
    srcH = 0;

  let compareMode = false;
  const wrap = document.getElementById("wrap");
  const btnCompare = document.getElementById("btnCompare");
  const btnAuto = document.getElementById("btnAuto");

  let viewCenter = { x: 0, y: 0 };
  let viewZoom = 1;

  function setViewCenter(x, y) {
    viewCenter.x = x;
    viewCenter.y = y;
  }

  function fitToView(outW, outH) {
    if (!srcTex) return;
    viewZoom = Math.min(outW / srcW, outH / srcH);
    setViewCenter(srcW * 0.5, srcH * 0.5);
  }

  function oneToOne() {
    if (!srcTex) return;
    viewZoom = 1.0;
    setViewCenter(srcW * 0.5, srcH * 0.5);
  }

  function screenPxToImagePx(sx, sy, outW, outH) {
    const outCenterX = outW * 0.5;
    const outCenterY = outH * 0.5;
    const ix = (sx - outCenterX) / viewZoom + viewCenter.x;
    const iy = (sy - outCenterY) / viewZoom + viewCenter.y;
    return { x: ix, y: iy };
  }

  const btnOpen = document.getElementById("btnOpen");
  const btnExport = document.getElementById("btnExport");
  const btnFit = document.getElementById("btnFit");
  const btnOneToOne = document.getElementById("btnOneToOne");

  const brightnessEl = document.getElementById("brightness");
  const scaleEl = document.getElementById("flow");
  const hatchingEl = document.getElementById("hatching");
  const edgesEl = document.getElementById("edges");
  const toonEl = document.getElementById("edge");
  const threshEl = document.getElementById("contrast");

  function updateSliderValue(slider) {
    const span = document.querySelector(`.slider-value[data-for="${slider.id}"]`);
    if (span) {
      const val = parseFloat(slider.value);
      span.textContent = val.toFixed(val >= 10 ? 1 : 2);
    }
  }
  
  [brightnessEl, scaleEl, hatchingEl, edgesEl, toonEl, threshEl].forEach(el => {
    if (el) {
      el.addEventListener("input", () => updateSliderValue(el));
      updateSliderValue(el); // Set initial value
    }
  });

  function setDefaults() {
    gl.useProgram(prog);
    gl.uniform1f(u.brightness, parseFloat(brightnessEl?.value ?? 1.0));
    gl.uniform1f(u.hatchScale, parseFloat(scaleEl?.value ?? 2.0));
    gl.uniform1f(u.hatchAmount, parseFloat(hatchingEl?.value ?? 1.0));
    gl.uniform1f(u.edgeStrength, parseFloat(edgesEl?.value ?? 1.0));
    gl.uniform1f(u.toonThreshold, parseFloat(toonEl?.value ?? 0.5));
    gl.uniform1f(u.finalThreshold, parseFloat(threshEl?.value ?? 0.3));
  }

  function renderToTarget(targetFboOrNull, outW, outH) {
    if (!srcTex) return;

    gl.useProgram(prog);
    gl.bindVertexArray(quad.vao);

    if (targetFboOrNull) gl.bindFramebuffer(gl.FRAMEBUFFER, targetFboOrNull);
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.viewport(0, 0, outW, outH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // Bind source image to texture unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(u.image, 0);

    // Bind hatch texture to texture unit 1
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, hatchTex);
    gl.uniform1i(u.hatchTex, 1);

    gl.uniform2f(u.texSize, srcW, srcH);
    gl.uniform2f(u.outSize, outW, outH);

    // View uniforms
    gl.uniform2f(u.centerPx, viewCenter.x, viewCenter.y);
    gl.uniform1f(u.zoom, viewZoom);

    gl.drawArrays(gl.TRIANGLES, 0, quad.vertexCount);

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function renderOriginal(outW, outH) {
    if (!srcTexOrig) return;

    glOrig.useProgram(progOrig);
    glOrig.bindVertexArray(quadOrig.vao);
    glOrig.bindFramebuffer(glOrig.FRAMEBUFFER, null);

    glOrig.viewport(0, 0, outW, outH);
    glOrig.disable(glOrig.DEPTH_TEST);
    glOrig.disable(glOrig.BLEND);

    glOrig.activeTexture(glOrig.TEXTURE0);
    glOrig.bindTexture(glOrig.TEXTURE_2D, srcTexOrig);
    glOrig.uniform1i(uOrig.image, 0);

    glOrig.uniform2f(uOrig.texSize, srcW, srcH);
    glOrig.uniform2f(uOrig.outSize, outW, outH);
    glOrig.uniform2f(uOrig.centerPx, viewCenter.x, viewCenter.y);
    glOrig.uniform1f(uOrig.zoom, viewZoom);

    glOrig.drawArrays(glOrig.TRIANGLES, 0, quadOrig.vertexCount);

    glOrig.bindTexture(glOrig.TEXTURE_2D, null);
    glOrig.bindVertexArray(null);
  }

  function frame() {
    const changed = resizeCanvasToDisplaySize(canvas);

    if (srcTex) {
      // Update slider-driven uniforms live
      gl.useProgram(prog);
      gl.uniform1f(u.brightness, parseFloat(brightnessEl?.value ?? 1.0));
      gl.uniform1f(u.hatchScale, parseFloat(scaleEl?.value ?? 2.0));
      gl.uniform1f(u.hatchAmount, parseFloat(hatchingEl?.value ?? 1.0));
      gl.uniform1f(u.edgeStrength, parseFloat(edgesEl?.value ?? 1.0));
      gl.uniform1f(u.toonThreshold, parseFloat(toonEl?.value ?? 0.5));
      gl.uniform1f(u.finalThreshold, parseFloat(threshEl?.value ?? 0.3));
    }

    if (changed || srcTex) renderToTarget(null, canvas.width, canvas.height);

    // Render original canvas when in compare mode
    if (compareMode && srcTexOrig) {
      resizeCanvasToDisplaySize(canvasOriginal);
      renderOriginal(canvasOriginal.width, canvasOriginal.height);
    }

    requestAnimationFrame(frame);
  }

  async function loadImageFromPath(filePath) {
    const url = `file://${filePath.replaceAll("\\", "/")}`;
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  }

  let isPanning = false;
  let lastX = 0,
    lastY = 0;

  function handleMouseDown(e) {
    if (!srcTex) return;
    isPanning = true;
    lastX = e.clientX;
    lastY = e.clientY;
  }

  canvas.addEventListener("mousedown", handleMouseDown);
  canvasOriginal.addEventListener("mousedown", handleMouseDown);

  window.addEventListener("mouseup", () => {
    isPanning = false;
  });

  window.addEventListener("mousemove", (e) => {
    if (!isPanning || !srcTex) return;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    viewCenter.x -= dx / viewZoom;
    viewCenter.y -= dy / viewZoom;
  });

  function handleWheel(e) {
    if (!srcTex) return;
    e.preventDefault();

    const targetCanvas = e.currentTarget;
    const rect = targetCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    const sx = (e.clientX - rect.left) * dpr;
    const sy = (e.clientY - rect.top) * dpr;

    const outW = targetCanvas.width;
    const outH = targetCanvas.height;

    const before = screenPxToImagePx(sx, sy, outW, outH);

    const zoomFactor = Math.exp(-e.deltaY * 0.0015);
    const newZoom = Math.min(20.0, Math.max(0.05, viewZoom * zoomFactor));

    const outCenterX = outW * 0.5;
    const outCenterY = outH * 0.5;

    viewZoom = newZoom;
    viewCenter.x = before.x - (sx - outCenterX) / viewZoom;
    viewCenter.y = before.y - (sy - outCenterY) / viewZoom;
  }

  canvas.addEventListener("wheel", handleWheel, { passive: false });
  canvasOriginal.addEventListener("wheel", handleWheel, { passive: false });

  btnFit?.addEventListener("click", () =>
    fitToView(canvas.width, canvas.height)
  );
  btnOneToOne?.addEventListener("click", () => oneToOne());

  btnCompare?.addEventListener("click", () => {
    compareMode = !compareMode;
    wrap.classList.toggle("compare-mode", compareMode);
    btnCompare.classList.toggle("active", compareMode);
    
    // Trigger resize after layout change
    setTimeout(() => {
      resizeCanvasToDisplaySize(canvas);
      if (compareMode) {
        resizeCanvasToDisplaySize(canvasOriginal);
      }
    }, 50);
  });

  btnAuto?.addEventListener("click", () => {
    if (!srcTex) return;
    const analysis = analyzeImage(gl, srcTex, srcW, srcH);
    const settings = calculateAutoSettings(analysis);
    if (brightnessEl) { brightnessEl.value = settings.brightness.toFixed(2); updateSliderValue(brightnessEl); }
    if (scaleEl) { scaleEl.value = settings.scale.toFixed(1); updateSliderValue(scaleEl); }
    if (hatchingEl) { hatchingEl.value = settings.hatching.toFixed(2); updateSliderValue(hatchingEl); }
    if (edgesEl) { edgesEl.value = settings.edges.toFixed(1); updateSliderValue(edgesEl); }
    if (toonEl) { toonEl.value = settings.toon.toFixed(2); updateSliderValue(toonEl); }
    if (threshEl) { threshEl.value = settings.threshold.toFixed(2); updateSliderValue(threshEl); }
    setDefaults();
  });

  btnOpen?.addEventListener("click", async () => {
    const filePath = await window.api.pickImage();
    if (!filePath) return;

    const img = await loadImageFromPath(filePath);

    if (srcTex) gl.deleteTexture(srcTex);
    srcTex = createTextureFromImage(gl, img);

    if (srcTexOrig) glOrig.deleteTexture(srcTexOrig);
    srcTexOrig = createTextureFromImage(glOrig, img);

    srcW = img.naturalWidth;
    srcH = img.naturalHeight;

    if (btnExport) btnExport.disabled = false;
    if (btnFit) btnFit.disabled = false;
    if (btnOneToOne) btnOneToOne.disabled = false;
    if (btnCompare) btnCompare.disabled = false;
    if (btnAuto) btnAuto.disabled = false;

    setDefaults();
    fitToView(canvas.width, canvas.height);
  });

  btnExport?.addEventListener("click", async () => {
    if (!srcTex) return;

    const prevCenter = { x: viewCenter.x, y: viewCenter.y };
    const prevZoom = viewZoom;
    viewZoom = 1.0;
    viewCenter.x = srcW * 0.5;
    viewCenter.y = srcH * 0.5;

    const fbo = createFBO(gl, srcW, srcH);
    renderToTarget(fbo.fbo, srcW, srcH);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    const pixels = new Uint8Array(srcW * srcH * 4);
    gl.readPixels(0, 0, srcW, srcH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const c2 = document.createElement("canvas");
    c2.width = srcW;
    c2.height = srcH;
    const ctx = c2.getContext("2d");
    const imageData = ctx.createImageData(srcW, srcH);

    const rowBytes = srcW * 4;
    for (let y = 0; y < srcH; y++) {
      const srcRow = (srcH - 1 - y) * rowBytes;
      const dstRow = y * rowBytes;
      imageData.data.set(pixels.subarray(srcRow, srcRow + rowBytes), dstRow);
    }
    ctx.putImageData(imageData, 0, 0);

    const blob = await new Promise((resolve) =>
      c2.toBlob(resolve, "image/png")
    );
    const buf = new Uint8Array(await blob.arrayBuffer());

    const res = await window.api.savePng(buf);
    if (!res.ok) console.warn("Save canceled/failed");

    gl.deleteFramebuffer(fbo.fbo);
    gl.deleteTexture(fbo.tex);
    viewCenter.x = prevCenter.x;
    viewCenter.y = prevCenter.y;
    viewZoom = prevZoom;
  });

  window.addEventListener("beforeunload", () => {
    if (srcTex) {
      gl.deleteTexture(srcTex);
      srcTex = null;
    }
    gl.deleteTexture(hatchTex);
    if (quad.vao) gl.deleteVertexArray(quad.vao);
    if (quad.vbo) gl.deleteBuffer(quad.vbo);
    gl.deleteProgram(prog);
    if (srcTexOrig) {
      glOrig.deleteTexture(srcTexOrig);
      srcTexOrig = null;
    }
    if (quadOrig.vao) glOrig.deleteVertexArray(quadOrig.vao);
    if (quadOrig.vbo) glOrig.deleteBuffer(quadOrig.vbo);
    glOrig.deleteProgram(progOrig);
  });

  setDefaults();
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  alert(String(err));
});
