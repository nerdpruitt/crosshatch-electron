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
uniform float u_hatchScale;      // Texture tiling scale (default 2.0)
uniform float u_toonThreshold;   // Toon shader threshold (default 0.5)
uniform float u_finalThreshold;  // Final color ramp threshold (default 0.3)
uniform float u_brightness;      // Brightness/exposure adjustment (default 1.0)
uniform float u_hatchAmount;     // Hatching amount 0=clean posterization, 1=full hatching
uniform float u_edgeStrength;    // Edge detection strength 0=none, 1=normal, 2=strong

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
// Edge Detection (Sobel)
// ============================================

// Sobel edge detection on luminance channel
// Returns edge strength (0 = no edge, 1 = strong edge)
float detectEdges(sampler2D tex, vec2 uv, vec2 texSize) {
  // Calculate pixel size in UV space
  vec2 pixelSize = 1.0 / texSize;
  
  // Sample 3x3 neighborhood
  float tl = luminance(texture(tex, uv + vec2(-pixelSize.x,  pixelSize.y)).rgb);
  float tm = luminance(texture(tex, uv + vec2(0.0,          pixelSize.y)).rgb);
  float tr = luminance(texture(tex, uv + vec2( pixelSize.x,  pixelSize.y)).rgb);
  
  float ml = luminance(texture(tex, uv + vec2(-pixelSize.x, 0.0)).rgb);
  float mr = luminance(texture(tex, uv + vec2( pixelSize.x, 0.0)).rgb);
  
  float bl = luminance(texture(tex, uv + vec2(-pixelSize.x, -pixelSize.y)).rgb);
  float bm = luminance(texture(tex, uv + vec2(0.0,         -pixelSize.y)).rgb);
  float br = luminance(texture(tex, uv + vec2( pixelSize.x, -pixelSize.y)).rgb);
  
  // Apply Sobel kernels
  // Gx (horizontal):     Gy (vertical):
  // [-1  0  +1]          [-1 -2 -1]
  // [-2  0  +2]          [ 0  0  0]
  // [-1  0  +1]          [+1 +2 +1]
  
  float gx = -tl + tr - 2.0*ml + 2.0*mr - bl + br;
  float gy = -tl - 2.0*tm - tr + bl + 2.0*bm + br;
  
  // Calculate gradient magnitude
  float edgeStrength = sqrt(gx*gx + gy*gy);
  
  // High sensitivity to catch subtle edges in bright areas (hands, faces)
  // Scale to reasonable range (3.5 = catches low-contrast edges)
  return clamp(edgeStrength * 3.5, 0.0, 1.0);
}

// ============================================
// Zone Classification (Comic Book Style)
// ============================================

// Zone thresholds - controlled by uniforms
// u_toonThreshold controls the shadow/midtone boundary
// u_finalThreshold controls the midtone/highlight boundary

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
  
  // Apply brightness adjustment before zone classification
  // Allows lifting dark images into the mid-tone hatching range
  lum = clamp(lum * u_brightness, 0.0, 1.0);

  // ========== Edge Detection ==========
  // Detect edges for bold comic-style outlines
  float edgeStrength = detectEdges(u_image, uv, u_texSize);
  
  // Apply user-controlled edge strength multiplier
  edgeStrength *= u_edgeStrength;
  
  // Bold edge mask for comic contour lines (0.85 = strong outlines)
  float edgeMask = 1.0 - (edgeStrength * 0.85);
  // Hard threshold for pure black lines (no gray - like brush pen)
  // Strong edges become thick black, weak edges become thin black
  edgeMask = step(0.15, edgeMask);

  // ========== Zone Classification ==========
  // Define luminance zones for comic book style:
  // - Highlights (bright): Pure white, no texture
  // - Mid-tones: Apply hatching
  // - Shadows (dark): Solid black
  
  // Add small buffer to shadow threshold to ensure clean solid blacks
  float shadowThreshold = u_toonThreshold + 0.05;  // ~0.35 with buffer
  float highlightThreshold = 1.0 - u_finalThreshold; // ~0.627 default
  
  // ========== Hatch Texture (for mid-tones only) ==========
  float tileScale = u_hatchScale * (u_outSize.y / 800.0);
  vec2 hatchUV = fragPx / u_outSize * tileScale;
  
  // Sample hatch texture
  float hatchValue = luminance(texture(u_hatchTex, hatchUV).rgb);
  
  // ========== Zone-Based Rendering ==========
  float result;
  
  if (lum < shadowThreshold) {
    // SHADOWS: Solid black
    result = 0.0;
  } 
  else if (lum > highlightThreshold) {
    // HIGHLIGHTS: Pure white (clean, no texture)
    result = 1.0;
  } 
  else {
    // MID-TONES: Apply hatching (or clean posterization)
    // Map luminance within mid-tone range to 0-1
    float midTonePos = (lum - shadowThreshold) / (highlightThreshold - shadowThreshold);
    
    // Pure posterization - clean black/white based on luminance position
    float pureResult = step(0.5, midTonePos);
    
    // Texture-based hatching - combines luminance with hatch texture
    float hatchInfluence = hatchValue + midTonePos;
    float textureResult = step(0.5, hatchInfluence);
    
    // Blend between pure posterization and textured hatching
    result = mix(pureResult, textureResult, u_hatchAmount);
  }

  // ========== Apply Bold Outlines ==========
  // Multiply by edge mask - edges become black lines
  result *= edgeMask;

  outColor = vec4(vec3(result), 1.0);
}
