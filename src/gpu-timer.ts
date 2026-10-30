// GPU time of a render pass, from timestamp queries. The device must have the 'timestamp-query'
// feature. The pass writes a timestamp at its start and at its end.
//
// The CPU does not read the timestamps of each frame. After each frame, a small compute pass adds
// the time of the frame to a total on the GPU, so the total has all of the frames. readTotal()
// reads the total one time, for example at the end of a scene, and starts a new total. The CPU
// does not wait for the GPU.

// The total: the time in nanoseconds (low and high 32 bits), the number of measured frames, and
// one unused word.
const TOTAL_WORDS = 4;

const SHADER = /* wgsl */ `
// The two 64-bit timestamps of the pass, in nanoseconds: x is the low 32 bits, y the high 32 bits.
@group(0) @binding(0) var<storage, read> timestamps: array<vec2u, 2>;
// 0 and 1: the total time in nanoseconds (low and high 32 bits). 2: the number of measured frames.
@group(0) @binding(1) var<storage, read_write> total: array<u32, ${TOTAL_WORDS}>;

@compute @workgroup_size(1)
fn cs_add() {
  let start = timestamps[0];
  let end = timestamps[1];
  // Use only a difference from 1 ns to 2^32 ns (4.3 s). A timestamp can be 0 or out of order, for
  // example after a GPU clock change.
  let sameHigh = end.y == start.y && end.x > start.x;
  let nextHigh = end.y == start.y + 1u && end.x < start.x;
  if (!sameHigh && !nextHigh) {
    return;
  }
  // The u32 subtraction wraps, so it is also correct when the high words are different.
  let delta = end.x - start.x;
  let low = total[0] + delta;
  total[1] += select(0u, 1u, low < delta);
  total[0] = low;
  total[2] += 1u;
}
`;

export class GpuTimer {
  private readonly device: GPUDevice;
  private readonly querySet: GPUQuerySet;
  private readonly timestampBuffer: GPUBuffer;
  private readonly totalBuffer: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private readonly bindGroup: GPUBindGroup;
  // Read-back buffers that are not mapped or waiting for a map.
  private readonly freeBuffers: GPUBuffer[] = [];

  // Make a timer, or return null if the device cannot write timestamps.
  static create(device: GPUDevice): GpuTimer | null {
    return device.features.has('timestamp-query') ? new GpuTimer(device) : null;
  }

  private constructor(device: GPUDevice) {
    this.device = device;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    // The query set gives its own type and count, so the buffer fits the query set.
    if (this.querySet.type !== 'timestamp') {
      throw new Error(`Expected a timestamp query set, but the type is ${this.querySet.type}`);
    }
    // Each timestamp is a 64-bit value in nanoseconds.
    this.timestampBuffer = device.createBuffer({
      size: this.querySet.count * BigUint64Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.STORAGE,
    });
    // A new buffer contains zeros, so the total starts at 0.
    this.totalBuffer = device.createBuffer({
      size: TOTAL_WORDS * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'cs_add' } });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.timestampBuffer } },
        { binding: 1, resource: { buffer: this.totalBuffer } },
      ],
    });
  }

  // The timestampWrites of the render pass descriptor.
  get timestampWrites(): GPURenderPassTimestampWrites {
    return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }

  // Add the time of the pass to the total. Call this after the pass, before the command buffer is
  // finished.
  resolve(encoder: GPUCommandEncoder): void {
    encoder.resolveQuerySet(this.querySet, 0, this.querySet.count, this.timestampBuffer, 0);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  // Start a new total, and do not read the total of the frames that are submitted after the previous
  // call.
  discardTotal(): void {
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.totalBuffer);
    this.device.queue.submit([encoder.finish()]);
  }

  // Read the total of the frames that are submitted after the previous call, and start a new
  // total. onTotal gets the GPU time in milliseconds and the number of measured frames, after the
  // GPU completes these frames.
  readTotal(onTotal: (milliseconds: number, frames: number) => void): void {
    const buffer =
      this.freeBuffers.pop() ??
      this.device.createBuffer({
        size: this.totalBuffer.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.totalBuffer, 0, buffer, 0, buffer.size);
    encoder.clearBuffer(this.totalBuffer);
    this.device.queue.submit([encoder.finish()]);
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const [low, high, frames] = new Uint32Array(buffer.getMappedRange());
        buffer.unmap();
        this.freeBuffers.push(buffer);
        onTotal((high * 2 ** 32 + low) / 1e6, frames);
      },
      () => {
        this.freeBuffers.push(buffer);
        onTotal(0, 0);
      },
    );
  }
}
