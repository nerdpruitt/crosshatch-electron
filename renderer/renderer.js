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

// Create a tiling texture (for the hatch pattern)
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

// Passthrough fragment shader for displaying original image
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

async function main() {
  // === Processed canvas (right side / main) ===
  const canvas = document.getElementById("gl");
  const gl = createGL(canvas);

  const vsSrc = await loadText("./shaders/fullscreen.vert");
  const fsSrc = await loadText("./shaders/crosshatch.frag");
  const prog = createProgram(gl, vsSrc, fsSrc);
  const quad = createFullscreenQuad(gl);

  // Load the hand-drawn hatch texture
  const hatchImg = await loadImage("../T_hatch.jpg");
  const hatchTex = createTilingTexture(gl, hatchImg);

  // Uniform locations helper
  const U = (name) => gl.getUniformLocation(prog, name);

  // Uniform locations (matching Blender shader parameters)
  const u = {
    image: U("u_image"),
    hatchTex: U("u_hatchTex"),
    texSize: U("u_texSize"),
    outSize: U("u_outSize"),

    // View
    centerPx: U("u_centerPx"),
    zoom: U("u_zoom"),

    // Crosshatch controls (from Blender nodes)
    hatchScale: U("u_hatchScale"), // Texture tiling scale
    toonThreshold: U("u_toonThreshold"), // Toon Color Ramp threshold (0.5)
    finalThreshold: U("u_finalThreshold"), // Final Color Ramp threshold (0.3)
    brightness: U("u_brightness"), // Brightness/exposure (default 1.0)
  };

  // === Original canvas (left side for compare mode) ===
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
  let srcTexOrig = null; // Texture for original canvas
  let srcW = 0,
    srcH = 0;

  // Compare mode state
  let compareMode = false;
  const wrap = document.getElementById("wrap");
  const btnCompare = document.getElementById("btnCompare");

  // Camera (view)
  let viewCenter = { x: 0, y: 0 }; // image pixels
  let viewZoom = 1; // screen px per image px

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

  // UI elements
  const btnOpen = document.getElementById("btnOpen");
  const btnExport = document.getElementById("btnExport");
  const btnFit = document.getElementById("btnFit");
  const btnOneToOne = document.getElementById("btnOneToOne");

  // Sliders mapped to Blender parameters
  const brightnessEl = document.getElementById("brightness"); // Brightness/exposure
  const scaleEl = document.getElementById("flow"); // Hatch texture scale
  const toonEl = document.getElementById("edge"); // Toon threshold
  const threshEl = document.getElementById("contrast"); // Final threshold

  function setDefaults() {
    gl.useProgram(prog);

    // Shader defaults
    gl.uniform1f(u.brightness, parseFloat(brightnessEl?.value ?? 1.0));
    gl.uniform1f(u.hatchScale, parseFloat(scaleEl?.value ?? 2.0));
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

  // Render original image (passthrough shader)
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

  // Pan (works on both canvases)
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

  // Zoom around cursor (works on both canvases)
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

  // Buttons
  btnFit?.addEventListener("click", () =>
    fitToView(canvas.width, canvas.height)
  );
  btnOneToOne?.addEventListener("click", () => oneToOne());

  // Compare toggle button
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

  btnOpen?.addEventListener("click", async () => {
    const filePath = await window.api.pickImage();
    if (!filePath) return;

    const img = await loadImageFromPath(filePath);

    // Create texture for processed canvas
    if (srcTex) gl.deleteTexture(srcTex);
    srcTex = createTextureFromImage(gl, img);

    // Create texture for original canvas
    if (srcTexOrig) glOrig.deleteTexture(srcTexOrig);
    srcTexOrig = createTextureFromImage(glOrig, img);

    srcW = img.naturalWidth;
    srcH = img.naturalHeight;

    if (btnExport) btnExport.disabled = false;
    if (btnFit) btnFit.disabled = false;
    if (btnOneToOne) btnOneToOne.disabled = false;
    if (btnCompare) btnCompare.disabled = false;

    setDefaults();
    fitToView(canvas.width, canvas.height);
  });

  btnExport?.addEventListener("click", async () => {
    if (!srcTex) return;

    // Save current view state
    const prevCenter = { x: viewCenter.x, y: viewCenter.y };
    const prevZoom = viewZoom;

    // Set view to full image (1:1 zoom, centered)
    viewZoom = 1.0;
    viewCenter.x = srcW * 0.5;
    viewCenter.y = srcH * 0.5;

    const fbo = createFBO(gl, srcW, srcH);
    renderToTarget(fbo.fbo, srcW, srcH);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    const pixels = new Uint8Array(srcW * srcH * 4);
    gl.readPixels(0, 0, srcW, srcH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Convert to PNG via 2D canvas (flip Y)
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

    // Restore previous view state
    viewCenter.x = prevCenter.x;
    viewCenter.y = prevCenter.y;
    viewZoom = prevZoom;
  });

  // Cleanup GL resources on window close
  window.addEventListener("beforeunload", () => {
    // Processed canvas cleanup
    if (srcTex) {
      gl.deleteTexture(srcTex);
      srcTex = null;
    }
    gl.deleteTexture(hatchTex);
    if (quad.vao) gl.deleteVertexArray(quad.vao);
    if (quad.vbo) gl.deleteBuffer(quad.vbo);
    gl.deleteProgram(prog);

    // Original canvas cleanup
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
