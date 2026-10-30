// The bloom filter of the intro (src/app/bloom.cpp).

struct Uniforms {
  // x: the threshold (0 to 1). y: the width of the soft knee above the threshold. z: the intensity
  // of the bloom in the output.
  values: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

struct Output {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_full(@builtin(vertex_index) index: u32) -> Output {
  let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: Output;
  output.position = vec4f(corners[index], 0.0, 1.0);
  output.uv = vec2f(corners[index].x * 0.5 + 0.5, 0.5 - corners[index].y * 0.5);
  return output;
}

// The average of 4 x 4 source pixels around uv: 4 bilinear samples between pixels.
fn box4(uv: vec2f) -> vec3f {
  let texel = 1.0 / vec2f(textureDimensions(source));
  var sum = vec3f(0.0);
  sum += textureSampleLevel(source, linearSampler, uv + texel * vec2f(-1.0, -1.0), 0.0).rgb;
  sum += textureSampleLevel(source, linearSampler, uv + texel * vec2f(1.0, -1.0), 0.0).rgb;
  sum += textureSampleLevel(source, linearSampler, uv + texel * vec2f(-1.0, 1.0), 0.0).rgb;
  sum += textureSampleLevel(source, linearSampler, uv + texel * vec2f(1.0, 1.0), 0.0).rgb;
  return sum * 0.25;
}

@fragment
fn fs_prefilter(input: Output) -> @location(0) vec4f {
  let color = box4(input.uv);
  // A soft threshold: the part of the brightness above the threshold, with a smooth knee.
  let brightness = max(color.r, max(color.g, color.b));
  let threshold = uniforms.values.x;
  let knee = max(uniforms.values.y, 1e-4);
  let soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
  let amount = max(soft * soft / (4.0 * knee), brightness - threshold) / max(brightness, 1e-4);
  return vec4f(color * max(amount, 0.0), 1.0);
}

@fragment
fn fs_down(input: Output) -> @location(0) vec4f {
  return vec4f(box4(input.uv), 1.0);
}

// A 3 x 3 tent filter of the smaller image, which the blend adds to the larger image.
@fragment
fn fs_up(input: Output) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(source));
  var sum = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let weight = f32((2 - abs(x)) * (2 - abs(y)));
      sum += textureSampleLevel(source, linearSampler, input.uv + texel * vec2f(f32(x), f32(y)), 0.0).rgb * weight;
    }
  }
  return vec4f(sum / 16.0, 1.0);
}

@fragment
fn fs_composite(input: Output) -> @location(0) vec4f {
  let bloom = textureSampleLevel(source, linearSampler, input.uv, 0.0).rgb;
  return vec4f(bloom * uniforms.values.z, 0.0);
}
