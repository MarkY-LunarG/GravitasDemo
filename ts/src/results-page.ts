// The results page: after the last scene, a table of the benchmark result of each scene (the scene,
// the total number of frames, and the frames per second), and an Exit button. The table has a row
// for each scene of the benchmark. A scene that did not run (for example, when the benchmark starts
// at a later scene) shows "not run".
//
// The page has its own small font: 5 x 7 pixel glyphs, which a storage buffer holds as bit masks.
// Each text character and each rectangle (the background of a row or the button, or a line) is one
// instance of a quad. The fragment shader of a character tests the bit of its glyph pixel, so the
// text has sharp pixels at an integer scale.

import type { Device, RenderPassEncoder, TextureFormat } from './gpu-types.js';

// The result of one scene.
export interface SceneResult {
  // The scene number, from 1.
  readonly number: number;
  readonly name: string;
  readonly frames: number;
  readonly seconds: number;
}

// The glyphs: 7 rows of 5 pixels, '#' is on. A character that is not here shows as a box.
// prettier-ignore
const GLYPHS: Record<string, string> = {
  ' ': '..... ..... ..... ..... ..... ..... .....',
  '0': '.###. #...# #..## #.#.# ##..# #...# .###.',
  '1': '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  '2': '.###. #...# ....# ...#. ..#.. .#... #####',
  '3': '##### ...#. ..#.. ...#. ....# #...# .###.',
  '4': '...#. ..##. .#.#. #..#. ##### ...#. ...#.',
  '5': '##### #.... ####. ....# ....# #...# .###.',
  '6': '..##. .#... #.... ####. #...# #...# .###.',
  '7': '##### ....# ...#. ..#.. .#... .#... .#...',
  '8': '.###. #...# #...# .###. #...# #...# .###.',
  '9': '.###. #...# #...# .#### ....# ...#. .##..',
  'A': '.###. #...# #...# ##### #...# #...# #...#',
  'B': '####. #...# #...# ####. #...# #...# ####.',
  'C': '.###. #...# #.... #.... #.... #...# .###.',
  'D': '###.. #..#. #...# #...# #...# #..#. ###..',
  'E': '##### #.... #.... ####. #.... #.... #####',
  'F': '##### #.... #.... ####. #.... #.... #....',
  'G': '.###. #...# #.... #.### #...# #...# .####',
  'H': '#...# #...# #...# ##### #...# #...# #...#',
  'I': '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  'J': '..### ...#. ...#. ...#. ...#. #..#. .##..',
  'K': '#...# #..#. #.#.. ##... #.#.. #..#. #...#',
  'L': '#.... #.... #.... #.... #.... #.... #####',
  'M': '#...# ##.## #.#.# #.#.# #...# #...# #...#',
  'N': '#...# #...# ##..# #.#.# #..## #...# #...#',
  'O': '.###. #...# #...# #...# #...# #...# .###.',
  'P': '####. #...# #...# ####. #.... #.... #....',
  'Q': '.###. #...# #...# #...# #.#.# #..#. .##.#',
  'R': '####. #...# #...# ####. #.#.. #..#. #...#',
  'S': '.#### #.... #.... .###. ....# ....# ####.',
  'T': '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  'U': '#...# #...# #...# #...# #...# #...# .###.',
  'V': '#...# #...# #...# #...# #...# .#.#. ..#..',
  'W': '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.',
  'X': '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  'Y': '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..',
  'Z': '##### ....# ...#. ..#.. .#... #.... #####',
  'a': '..... ..... .###. ....# .#### #...# .####',
  'b': '#.... #.... #.##. ##..# #...# #...# ####.',
  'c': '..... ..... .###. #.... #.... #...# .###.',
  'd': '....# ....# .##.# #..## #...# #...# .####',
  'e': '..... ..... .###. #...# ##### #.... .###.',
  'f': '..##. .#..# .#... ###.. .#... .#... .#...',
  'g': '..... .#### #...# #...# .#### ....# .###.',
  'h': '#.... #.... #.##. ##..# #...# #...# #...#',
  'i': '..#.. ..... .##.. ..#.. ..#.. ..#.. .###.',
  'j': '...#. ..... ..##. ...#. ...#. #..#. .##..',
  'k': '#.... #.... #..#. #.#.. ##... #.#.. #..#.',
  'l': '.##.. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  'm': '..... ..... ##.#. #.#.# #.#.# #...# #...#',
  'n': '..... ..... #.##. ##..# #...# #...# #...#',
  'o': '..... ..... .###. #...# #...# #...# .###.',
  'p': '..... ..... ####. #...# ####. #.... #....',
  'q': '..... ..... .##.# #..## .#### ....# ....#',
  'r': '..... ..... #.##. ##..# #.... #.... #....',
  's': '..... ..... .###. #.... .###. ....# ####.',
  't': '.#... .#... ###.. .#... .#... .#..# ..##.',
  'u': '..... ..... #...# #...# #...# #..## .##.#',
  'v': '..... ..... #...# #...# #...# .#.#. ..#..',
  'w': '..... ..... #...# #...# #.#.# #.#.# .#.#.',
  'x': '..... ..... #...# .#.#. ..#.. .#.#. #...#',
  'y': '..... ..... #...# #...# .#### ....# .###.',
  'z': '..... ..... ##### ...#. ..#.. .#... #####',
  '.': '..... ..... ..... ..... ..... .##.. .##..',
  ',': '..... ..... ..... ..... .##.. ..#.. .#...',
  ':': '..... .##.. .##.. ..... .##.. .##.. .....',
  '-': '..... ..... ..... ##### ..... ..... .....',
  '(': '...#. ..#.. .#... .#... .#... ..#.. ...#.',
  ')': '.#... ..#.. ...#. ...#. ...#. ..#.. .#...',
  '/': '..... ....# ...#. ..#.. .#... #.... .....',
  '%': '##... ##..# ...#. ..#.. .#... #..## ...##',
  "'": '..#.. ..#.. ..... ..... ..... ..... .....',
  '"': '.#.#. .#.#. ..... ..... ..... ..... .....',
  '!': '..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..',
  '?': '.###. #...# ....# ...#. ..#.. ..... ..#..',
  '+': '..... ..#.. ..#.. ##### ..#.. ..#.. .....',
  '=': '..... ..... ##### ..... ##### ..... .....',
  '_': '..... ..... ..... ..... ..... ..... #####',
};
const BOX_GLYPH = '##### #...# #...# #...# #...# #...# #####';
const GLYPH_ROWS = 7;
const GLYPH_COLUMNS = 5;
// A character cell is one pixel wider and taller than a glyph, for the space between characters.
const CELL_WIDTH = GLYPH_COLUMNS + 1;
const CELL_HEIGHT = GLYPH_ROWS + 1;

const CHARACTERS = Object.keys(GLYPHS);
// The glyph index of a rectangle with no glyph, and of a character that is not in GLYPHS.
const SOLID = CHARACTERS.length + 1;
const BOX = CHARACTERS.length;

// The quads: x, y, width, and height in pixels (from the upper left), the color, and the glyph.
const INSTANCE_FLOATS = 12;
const MAX_INSTANCES = 4096;

// The colors.
const BACKGROUND = [0.04, 0.05, 0.07, 1] as const;
const TITLE_COLOR = [1.0, 0.85, 0.55, 1] as const;
const TEXT_COLOR = [0.9, 0.9, 0.92, 1] as const;
const HEADER_COLOR = [0.7, 0.78, 0.9, 1] as const;
const HEADER_BACKGROUND = [0.12, 0.15, 0.2, 1] as const;
const ROW_BACKGROUND = [0.08, 0.09, 0.12, 1] as const;
const LINE_COLOR = [0.25, 0.28, 0.34, 1] as const;
const BUTTON_COLOR = [0.2, 0.3, 0.45, 1] as const;
const BUTTON_HOVER_COLOR = [0.3, 0.45, 0.65, 1] as const;

const SHADER = /* wgsl */ `
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
// ${GLYPH_ROWS} rows for each glyph. Bit 4 of a row is the left pixel.
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
  if (input.glyph != ${SOLID}u) {
    let column = min(u32(input.local.x * ${GLYPH_COLUMNS}.0), ${GLYPH_COLUMNS - 1}u);
    let row = min(u32(input.local.y * ${GLYPH_ROWS}.0), ${GLYPH_ROWS - 1}u);
    let bits = glyphs[input.glyph * ${GLYPH_ROWS}u + row];
    if (((bits >> (${GLYPH_COLUMNS - 1}u - column)) & 1u) == 0u) {
      discard;
    }
  }
  return input.color;
}
`;

// The bit masks of the glyphs, in the order of CHARACTERS, then the box.
function glyphBits(): Uint32Array {
  const patterns = [...CHARACTERS.map((character) => GLYPHS[character]), BOX_GLYPH];
  const bits = new Uint32Array(patterns.length * GLYPH_ROWS);
  patterns.forEach((pattern, glyph) => {
    pattern.split(' ').forEach((row, rowIndex) => {
      let value = 0;
      for (const pixel of row) {
        value = (value << 1) | (pixel === '#' ? 1 : 0);
      }
      bits[glyph * GLYPH_ROWS + rowIndex] = value;
    });
  });
  return bits;
}

type Color = readonly [number, number, number, number];
type Rect = { x: number; y: number; width: number; height: number };

export class ResultsPage {
  private readonly device: Device;
  private readonly uniformBuffer: GPUBuffer;
  private readonly quadBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly pipeline: GPURenderPipeline;
  private readonly quads = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
  private quadCount = 0;
  // The Exit button in pixels, from the last layout.
  private button: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private pointer: [number, number] = [-1, -1];

  constructor(device: Device, format: TextureFormat) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      size: 4 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.quadBuffer = device.createBuffer({
      size: this.quads.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const bits = glyphBits();
    const glyphBuffer = device.createBuffer({
      size: bits.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(glyphBuffer, 0, bits);
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_quad' },
      fragment: { module, entryPoint: 'fs_quad', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.quadBuffer } },
        { binding: 2, resource: { buffer: glyphBuffer } },
      ],
    });
  }

  // Set the position of the mouse pointer in pixels, for the highlight of the button.
  setPointer(x: number, y: number): void {
    this.pointer = [x, y];
  }

  // True if the point (in pixels) is on the Exit button.
  isOnExitButton(x: number, y: number): boolean {
    const { x: left, y: top, width, height } = this.button;
    return x >= left && x < left + width && y >= top && y < top + height;
  }

  // Draw the page into colorView. width and height are its size in pixels. sceneNames has the names
  // of all of the scenes, in order. results has the result of each scene that ran.
  draw(
    encoder: GPUCommandEncoder,
    colorView: GPUTextureView,
    width: number,
    height: number,
    sceneNames: readonly string[],
    results: readonly SceneResult[],
  ): void {
    this.layout(width, height, sceneNames, results);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([width, height, 0, 0]));
    this.device.queue.writeBuffer(this.quadBuffer, 0, this.quads, 0, this.quadCount * INSTANCE_FLOATS);
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: BACKGROUND[0], g: BACKGROUND[1], b: BACKGROUND[2], a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6, this.quadCount);
    pass.end();
  }

  // Make the quads of the page: the title, the table, and the button.
  private layout(width: number, height: number, sceneNames: readonly string[], results: readonly SceneResult[]): void {
    this.quadCount = 0;
    // The size of one glyph pixel in screen pixels. It is an integer, so the text is sharp.
    const scale = Math.max(1, Math.floor(Math.min(height / 200, width / 320)));
    const titleScale = scale * 2;
    const rowHeight = CELL_HEIGHT * scale + 6 * scale;
    const padding = 8 * scale;

    const headers = ['Scene', 'Total frames', 'Frames per second'];
    // One row for each scene. If a scene has more than one result (for example, after the N key
    // goes back to it), the row has the sum of its frames and its time.
    const rows = sceneNames.map((name, index) => {
      const sceneResults = results.filter((result) => result.number === index + 1);
      const label = `Scene ${index + 1}: ${name}`;
      if (sceneResults.length === 0) {
        return [label, 'not run', 'not run'];
      }
      const frames = sceneResults.reduce((sum, result) => sum + result.frames, 0);
      const seconds = sceneResults.reduce((sum, result) => sum + result.seconds, 0);
      return [label, String(frames), (seconds > 0 ? frames / seconds : 0).toFixed(1)];
    });
    // The width of each column: the widest text, and padding at the two sides.
    const columnWidths = headers.map(
      (header, column) =>
        Math.max(this.textWidth(header, scale), ...rows.map((row) => this.textWidth(row[column], scale))) + 2 * padding,
    );
    const tableWidth = columnWidths.reduce((sum, value) => sum + value, 0);
    const tableHeight = rowHeight * (rows.length + 1);
    const title = 'Benchmark results';
    const titleHeight = CELL_HEIGHT * titleScale;
    const buttonHeight = rowHeight + 2 * scale;
    const gap = 3 * rowHeight;
    const total = titleHeight + gap + tableHeight + gap + buttonHeight;
    let y = Math.max(padding, Math.round((height - total) / 2));
    const left = Math.round((width - tableWidth) / 2);

    this.text(title, Math.round((width - this.textWidth(title, titleScale)) / 2), y, titleScale, TITLE_COLOR);
    y += titleHeight + gap;

    // The header row and the result rows. The scene names go to the left of their column, and the
    // numbers go to the right, so that the digits are in line.
    const allRows = [headers, ...rows];
    allRows.forEach((row, rowIndex) => {
      const header = rowIndex === 0;
      this.rect({ x: left, y, width: tableWidth, height: rowHeight }, header ? HEADER_BACKGROUND : ROW_BACKGROUND);
      let x = left;
      row.forEach((cell, column) => {
        const textY = y + Math.round((rowHeight - GLYPH_ROWS * scale) / 2);
        const textX = column === 0 ? x + padding : x + columnWidths[column] - padding - this.textWidth(cell, scale);
        this.text(cell, textX, textY, scale, header ? HEADER_COLOR : TEXT_COLOR);
        x += columnWidths[column];
      });
      y += rowHeight;
      this.rect({ x: left, y: y - 1, width: tableWidth, height: Math.max(1, Math.floor(scale / 2)) }, LINE_COLOR);
    });

    // The Exit button, below the table in the center.
    y += gap;
    const label = 'Exit';
    const buttonWidth = this.textWidth(label, scale) + 12 * scale;
    this.button = { x: Math.round((width - buttonWidth) / 2), y, width: buttonWidth, height: buttonHeight };
    const hover = this.isOnExitButton(this.pointer[0], this.pointer[1]);
    this.rect(this.button, hover ? BUTTON_HOVER_COLOR : BUTTON_COLOR);
    this.text(
      label,
      this.button.x + Math.round((buttonWidth - this.textWidth(label, scale)) / 2),
      y + Math.round((buttonHeight - GLYPH_ROWS * scale) / 2),
      scale,
      TEXT_COLOR,
    );
  }

  // The width of a text in pixels, with no space after the last character.
  private textWidth(text: string, scale: number): number {
    return text.length > 0 ? (text.length * CELL_WIDTH - 1) * scale : 0;
  }

  private text(text: string, x: number, y: number, scale: number, color: Color): void {
    for (const character of text) {
      if (character !== ' ') {
        const index = CHARACTERS.indexOf(character);
        const glyph = index >= 0 ? index : BOX;
        this.quad({ x, y, width: GLYPH_COLUMNS * scale, height: GLYPH_ROWS * scale }, color, glyph);
      }
      x += CELL_WIDTH * scale;
    }
  }

  private rect(rect: Rect, color: Color): void {
    this.quad(rect, color, SOLID);
  }

  private quad(rect: Rect, color: Color, glyph: number): void {
    if (this.quadCount >= MAX_INSTANCES) {
      return;
    }
    this.quads.set(
      [rect.x, rect.y, rect.width, rect.height, ...color, glyph, 0, 0, 0],
      this.quadCount * INSTANCE_FLOATS,
    );
    this.quadCount += 1;
  }
}
