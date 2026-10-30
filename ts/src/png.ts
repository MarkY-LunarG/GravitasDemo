// A small PNG decoder for the desktop target, which has no image decoder. It supports the images
// of this application: 8 bits for each sample, no interlace, and the color types gray, RGB,
// palette (with or without transparency), gray with alpha, and RGBA. The browser target uses the
// image decoder of the browser.

// An image with 4 bytes for each pixel (red, green, blue, and alpha), with no premultiplied alpha.
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
// The number of samples in a pixel for each color type.
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Decode a PNG file. inflate decompresses zlib data (for example zlib.inflateSync of Node.js).
export function decodePng(file: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): RgbaImage {
  if (!SIGNATURE.every((value, index) => file[index] === value)) {
    throw new Error('The file is not a PNG image');
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const compressed: Uint8Array[] = [];
  for (let offset = SIGNATURE.length; offset < file.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...file.subarray(offset + 4, offset + 8));
    const chunk = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bitDepth = chunk[8];
      colorType = chunk[9];
      const interlace = chunk[12];
      if (bitDepth !== 8 || interlace !== 0 || CHANNELS[colorType] === undefined) {
        throw new Error(`Unsupported PNG: bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace}`);
      }
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'tRNS') {
      transparency = chunk;
    } else if (type === 'IDAT') {
      compressed.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    // The chunk has a length, a type, the data, and a CRC.
    offset += 12 + length;
  }

  const joined = new Uint8Array(compressed.reduce((sum, chunk) => sum + chunk.length, 0));
  let position = 0;
  for (const chunk of compressed) {
    joined.set(chunk, position);
    position += chunk.length;
  }
  const raw = inflate(joined);
  const channels = CHANNELS[colorType];
  const stride = width * channels;
  const pixels = unfilter(raw, stride, height, channels);

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; ++i) {
    const source = i * channels;
    const target = i * 4;
    if (colorType === 3) {
      if (!palette) {
        throw new Error('The PNG image has no palette');
      }
      const index = pixels[source];
      data[target] = palette[index * 3];
      data[target + 1] = palette[index * 3 + 1];
      data[target + 2] = palette[index * 3 + 2];
      data[target + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (colorType === 0 || colorType === 4) {
      data[target] = data[target + 1] = data[target + 2] = pixels[source];
      data[target + 3] = colorType === 4 ? pixels[source + 1] : 255;
    } else {
      data[target] = pixels[source];
      data[target + 1] = pixels[source + 1];
      data[target + 2] = pixels[source + 2];
      data[target + 3] = colorType === 6 ? pixels[source + 3] : 255;
    }
  }
  return { width, height, data };
}

// Undo the filter of each row. Each row starts with a filter type byte. bpp is the number of bytes
// in a pixel.
function unfilter(raw: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; ++y) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = y * stride;
    const previous = current - stride;
    for (let x = 0; x < stride; ++x) {
      const left = x >= bpp ? out[current + x - bpp] : 0;
      const up = y > 0 ? out[previous + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[previous + x - bpp] : 0;
      let predictor = 0;
      if (filter === 1) {
        predictor = left;
      } else if (filter === 2) {
        predictor = up;
      } else if (filter === 3) {
        predictor = (left + up) >> 1;
      } else if (filter === 4) {
        // The Paeth predictor: the neighbor that is nearest to left + up - upLeft.
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toUpLeft = Math.abs(estimate - upLeft);
        predictor = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter type ${filter}`);
      }
      out[current + x] = (row[x] + predictor) & 0xff;
    }
  }
  return out;
}
