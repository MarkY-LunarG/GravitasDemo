// The results page (src/app/results_page.cpp). The glyph sizes and SOLID come from
// results_page.cpp, as abstract integers.

struct Quad {
  rect: vec4f,
  color: vec4f,
  // x: the glyph index.
  glyph: vec4f,
}
struct Uniforms {
  // xy: the size of the view in pixels.
  size: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> quads: array<Quad>;
// GLYPH_ROWS rows for each glyph. Bit 4 of a row is the left pixel.
@group(0) @binding(2) var<storage, read> glyphs: array<u32>;

struct Output {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
  @location(2) @interpolate(flat) glyph: u32,
}

@vertex
fn vs_quad(@builtin(vertex_index) index: u32, @builtin(instance_index) instance: u32) -> Output {
  let corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
                                vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let quad = quads[instance];
  let corner = corners[index];
  let pixel = quad.rect.xy + corner * quad.rect.zw;
  var output: Output;
  output.position = vec4f(pixel.x / uniforms.size.x * 2.0 - 1.0, 1.0 - pixel.y / uniforms.size.y * 2.0, 0.0, 1.0);
  output.local = corner;
  output.color = quad.color;
  output.glyph = u32(quad.glyph.x);
  return output;
}

@fragment
fn fs_quad(input: Output) -> @location(0) vec4f {
  if (input.glyph != SOLID) {
    let column = min(u32(input.local.x * GLYPH_COLUMNS), GLYPH_COLUMNS - 1u);
    let row = min(u32(input.local.y * GLYPH_ROWS), GLYPH_ROWS - 1u);
    let bits = glyphs[input.glyph * GLYPH_ROWS + row];
    if (((bits >> (GLYPH_COLUMNS - 1u - column)) & 1u) == 0u) {
      discard;
    }
  }
  return input.color;
}
