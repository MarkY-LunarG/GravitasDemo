// The lens flare and the sun occlusion probes (src/app/lens_flare.cpp). The constants and the
// ghost table come from lens_flare.cpp.

struct Uniforms {
  viewProjection: mat4x4f,
  // xyz: the unit direction to the sun. w: the aspect ratio of the view (width / height).
  sun: vec4f,
  // rgb: the sun color. a: the flare brightness.
  color: vec4f,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// The position of a point at an infinite distance in the direction dir, as for the sky.
fn projectDirection(dir: vec3f) -> vec4f {
  return uniforms.viewProjection * vec4f(dir, 0.0);
}

// The probe disk: a quad around the sun, at the far plane. The fragment shader removes the corners.
struct ProbeOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
}

const QUAD = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                             vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

@vertex
fn vs_probe(@builtin(vertex_index) index: u32) -> ProbeOutput {
  let dir = uniforms.sun.xyz;
  let u = normalize(cross(dir, vec3f(0.0, 1.0, 0.0)));
  let v = cross(u, dir);
  let corner = QUAD[index];
  var position = projectDirection(dir + (u * corner.x + v * corner.y) * PROBE_RADIUS);
  // At the far plane, so that all objects in front of the sun hide the disk.
  position.z = position.w;
  var output: ProbeOutput;
  output.position = position;
  output.local = corner;
  return output;
}

@fragment
fn fs_probe(input: ProbeOutput) -> @location(0) vec4f {
  if (dot(input.local, input.local) > 1.0) {
    discard;
  }
  return vec4f(0.0);
}

// The flare. The occlusion counts are 64-bit values: x is the low 32 bits.
@group(0) @binding(1) var<storage, read> occlusion: array<vec2u, QUERY_COUNT>;

struct Ghost {
  at: f32,
  radius: f32,
  color: vec3f,
  shape: u32,
}

// The elements: 0 is the glow and the rays at the sun, 1 is the horizontal streak, and the others
// are the ghosts.
struct FlareOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) color: vec3f,
  @location(2) @interpolate(flat) element: u32,
  @location(3) @interpolate(flat) shape: u32,
  // The unit direction on the screen from the center to the sun, in units of the screen height.
  @location(4) @interpolate(flat) axis: vec2f,
}

@vertex
fn vs_flare(@builtin(vertex_index) index: u32, @builtin(instance_index) element: u32) -> FlareOutput {
  var output: FlareOutput;
  let clip = projectDirection(uniforms.sun.xyz);
  let total = f32(occlusion[TOTAL_QUERY].x);
  let visible = select(0.0, f32(occlusion[VISIBLE_QUERY].x) / max(total, 1.0), total > 0.0);
  // The sun is behind the camera, or no part of it is visible: no flare.
  if (clip.w <= 0.0 || visible <= 0.0) {
    output.position = vec4f(0.0, 0.0, 0.0, 1.0);
    return output;
  }
  let sun = clip.xy / clip.w;
  // The flare becomes weaker as the sun goes to the edge of the screen.
  let edge = 1.0 - smoothstep(0.8, 1.2, max(abs(sun.x), abs(sun.y)));
  let strength = visible * edge * uniforms.color.a;

  // The size of the element in screen heights (x, y), and its center.
  var size = vec2f(0.45, 0.45);
  var center = sun;
  var color = uniforms.color.rgb;
  if (element == 1u) {
    size = vec2f(1.4, 0.035);
    color = color * vec3f(0.8, 0.85, 1.0);
  } else if (element >= 2u) {
    let ghost = GHOSTS[element - 2u];
    size = vec2f(ghost.radius);
    center = sun * ghost.at;
    color = ghost.color;
    output.shape = ghost.shape;
  }
  let corner = QUAD[index];
  let aspect = uniforms.sun.w;
  let toSun = vec2f(sun.x * aspect, sun.y);
  output.axis = select(vec2f(1.0, 0.0), normalize(toSun), length(toSun) > 1e-4);
  output.position = vec4f(center + corner * vec2f(size.x / aspect, size.y) * 2.0, 0.0, 1.0);
  output.local = corner;
  output.color = color * strength;
  output.element = element;
  return output;
}

// The distance to the center of a hexagon with a flat top and bottom, 1 at the edge.
fn hexagon(p: vec2f) -> f32 {
  let q = abs(p);
  return max(q.x * 0.866025 + q.y * 0.5, q.y);
}

@fragment
fn fs_flare(input: FlareOutput) -> @location(0) vec4f {
  let p = input.local;
  let r = length(p);
  var brightness = 0.0;
  if (input.element == 0u) {
    // A bright core, a soft glow, and 12 thin rays that fade with distance.
    let angle = atan2(p.y, p.x);
    let rays = pow(abs(cos(angle * 6.0)), 60.0) * 0.6 + pow(abs(cos(angle * 6.0 + 0.5)), 200.0) * 0.4;
    brightness = exp(-r * r * 60.0) * 1.2 + exp(-r * 6.0) * 0.25 + rays * exp(-r * 4.5) * 0.5;
    brightness *= 1.0 - smoothstep(0.8, 1.0, r);
  } else if (input.element == 1u) {
    // Bright at the center line, and weaker to the ends.
    let across = exp(-abs(p.y) * 6.0);
    let along = pow(1.0 - abs(p.x), 3.0);
    brightness = across * along * 0.35;
  } else {
    // A shape with a soft edge and a brighter rim. d is 1 at the edge.
    var d = r;
    if (input.shape == HEXAGON) {
      d = hexagon(p);
    } else if (input.shape == OVAL) {
      let along = dot(p, input.axis);
      let across = dot(p, vec2f(-input.axis.y, input.axis.x));
      d = length(vec2f(along / OVAL_SQUASH, across));
    }
    brightness = (1.0 - smoothstep(0.85, 1.0, d)) * (0.35 + 0.65 * d * d) * GHOST_BRIGHTNESS;
  }
  return vec4f(input.color * brightness, 0.0);
}
