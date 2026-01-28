#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform sampler2D u_hatchTex;
uniform vec2 u_texSize;
uniform vec2 u_outSize;
uniform vec2 u_centerPx;
uniform float u_zoom;
uniform float u_hatchScale;
uniform float u_toonThreshold;
uniform float u_finalThreshold;
uniform float u_brightness;
uniform float u_hatchAmount;
uniform float u_edgeStrength;

out vec4 outColor;

vec3 linearLight(vec3 a, vec3 b) {
  return clamp(a + 2.0 * b - 1.0, 0.0, 1.0);
}

float luminance(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

float toonShade(float lum, float threshold) {
  return smoothstep(threshold - 0.15, threshold + 0.15, lum);
}

// Sobel edge detection
float detectEdges(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 px = 1.0 / texSize;
  
  float tl = luminance(texture(tex, uv + vec2(-px.x,  px.y)).rgb);
  float tm = luminance(texture(tex, uv + vec2(0.0,    px.y)).rgb);
  float tr = luminance(texture(tex, uv + vec2( px.x,  px.y)).rgb);
  float ml = luminance(texture(tex, uv + vec2(-px.x,  0.0)).rgb);
  float mr = luminance(texture(tex, uv + vec2( px.x,  0.0)).rgb);
  float bl = luminance(texture(tex, uv + vec2(-px.x, -px.y)).rgb);
  float bm = luminance(texture(tex, uv + vec2(0.0,   -px.y)).rgb);
  float br = luminance(texture(tex, uv + vec2( px.x, -px.y)).rgb);
  
  float gx = -tl + tr - 2.0*ml + 2.0*mr - bl + br;
  float gy = -tl - 2.0*tm - tr + bl + 2.0*bm + br;
  
  return clamp(sqrt(gx*gx + gy*gy) * 3.5, 0.0, 1.0);
}

void main() {
  vec2 fragPx = gl_FragCoord.xy;
  vec2 outCenter = 0.5 * u_outSize;
  vec2 imagePx = (fragPx - outCenter) / max(u_zoom, 1e-6) + u_centerPx;
  vec2 uv = imagePx / u_texSize;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(1.0);
    return;
  }

  vec3 srcColor = texture(u_image, uv).rgb;
  float lum = clamp(luminance(srcColor) * u_brightness, 0.0, 1.0);

  // Edge detection
  float edge = detectEdges(u_image, uv, u_texSize) * u_edgeStrength;
  float edgeMask = step(0.15, 1.0 - edge * 0.85);

  // Zone thresholds
  float shadowThreshold = u_toonThreshold + 0.05;
  float highlightThreshold = 1.0 - u_finalThreshold;
  
  // Hatch texture
  float tileScale = u_hatchScale * (u_outSize.y / 800.0);
  vec2 hatchUV = fragPx / u_outSize * tileScale;
  float hatchValue = luminance(texture(u_hatchTex, hatchUV).rgb);
  
  // Zone-based rendering
  float result;
  if (lum < shadowThreshold) {
    result = 0.0;
  } else if (lum > highlightThreshold) {
    result = 1.0;
  } else {
    float midTonePos = (lum - shadowThreshold) / (highlightThreshold - shadowThreshold);
    float pureResult = step(0.5, midTonePos);
    float textureResult = step(0.5, hatchValue + midTonePos);
    result = mix(pureResult, textureResult, u_hatchAmount);
  }

  result *= edgeMask;
  outColor = vec4(vec3(result), 1.0);
}
