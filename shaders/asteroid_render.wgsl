// The asteroids in the render pass (src/app/asteroids.cpp). The constants come from asteroids.cpp.

@group(0) @binding(0) var<uniform> viewProjection: mat4x4f;
// x is the first entry of the visible list of this draw.
@group(0) @binding(1) var<uniform> drawInfo: vec4u;
@group(0) @binding(2) var<storage, read> asteroids: array<Asteroid>;
@group(0) @binding(3) var<storage, read> visible: array<u32>;
@group(0) @binding(4) var<storage, read> shapeVertices: array<ShapeVertex>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) color: vec3f,
}

// vertex_index includes the baseVertex of the draw, so it selects the shape and the LOD.
@vertex
fn vs_asteroid(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32)
    -> VertexOutput {
  let index = visible[drawInfo.x + instance];
  let asteroid = asteroids[index];
  let vertex = shapeVertices[vertexIndex];
  let world = asteroid.position + rotate(asteroid.orientation, vertex.position.xyz * asteroid.radius);
  var output: VertexOutput;
  output.position = viewProjection * vec4f(world, 1.0);
  output.worldNormal = rotate(asteroid.orientation, vertex.normal.xyz);
  // A gray rock color, a little different for each asteroid.
  let shade = mix(0.35, 0.6, random(index, 5000u));
  output.color = vec3f(shade, shade * 0.95, shade * 0.9);
  return output;
}

@fragment
fn fs_asteroid(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(applyLight(input.color, input.worldNormal), 1.0);
}
