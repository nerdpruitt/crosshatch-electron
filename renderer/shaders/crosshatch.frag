#version 300 es
precision highp float;

uniform sampler2D u_image;       // Source image
uniform sampler2D u_hatchTex;    // Hand-drawn hatch texture (T_hatch.jpg)
uniform vec2 u_texSize;
uniform vec2 u_outSize;

// View
uniform vec2 u_centerPx;
uniform float u_zoom;

// Crosshatch controls (matching Blender nodes)
uniform float u_hatchScale;      // Texture tiling scale (default 5.0)
uniform float u_toonThreshold;   // Toon shader threshold (default 0.3)
uniform float u_finalThreshold;  // Final color ramp threshold (default 0.373)

out vec4 outColor;

// ============================================
// Blend Modes
// ============================================

// Linear Light blend mode (Blender's formula)
// result = A + 2*B - 1, clamped
vec3 linearLight(vec3 a, vec3 b) {
  return clamp(a + 2.0 * b - 1.0, 0.0, 1.0);
}

// ============================================
// Toon Shader (using luminance for 2D)
// ============================================

float luminance(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

// Toon/cel shading: posterize based on threshold
// Mimics: Diffuse BSDF → Shader to RGB → Color Ramp (threshold 0.3)
float toonShade(float lum, float threshold) {
  return smoothstep(threshold - 0.15, threshold + 0.15, lum);
}

// ============================================
// Main
// ============================================

void main() {
  vec2 fragPx = gl_FragCoord.xy;
  vec2 outCenter = 0.5 * u_outSize;

  vec2 imagePx = (fragPx - outCenter) / max(u_zoom, 1e-6) + u_centerPx;
  vec2 uv = imagePx / u_texSize;

  // Outside image => white paper
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(1.0);
    return;
  }

  // Sample source image
  vec3 srcColor = texture(u_image, uv).rgb;
  float lum = luminance(srcColor);

  // ========== Hatch Texture ==========
  // Tile the hand-drawn texture across screen space
  // Scale based on output size for consistent density
  float tileScale = u_hatchScale * (u_outSize.y / 800.0);
  vec2 hatchUV = fragPx / u_outSize * tileScale;

  // Sample the hand-drawn hatch texture (tiling)
  vec3 hatchPattern = texture(u_hatchTex, hatchUV).rgb;

  // ========== Toon Shader ==========
  // Posterize luminance (simulates toon shading for 2D)
  float toon = toonShade(lum, u_toonThreshold);
  vec3 toonColor = vec3(toon);

  // ========== Combining Tex with Toon (Linear Light) ==========
  vec3 combined = linearLight(hatchPattern, toonColor);

  // ========== Final Color Ramp ==========
  // Threshold at ~0.373, black to white
  float result = smoothstep(u_finalThreshold - 0.15, u_finalThreshold + 0.15, luminance(combined));

  outColor = vec4(vec3(result), 1.0);
}
