// GPU time of a render pass, from timestamp queries. The device must have the 'timestamp-query'
// feature. The pass writes a timestamp at its start and at its end. After the frame, a copy of
// the two timestamps goes to a buffer that the CPU maps and reads later, so the CPU does not wait
// for the GPU.
//
// Only one frame in SAMPLE_INTERVAL is measured, and only one read-back buffer is mapped at a
// time. With @kmamal/gpu 1.0.0-6, a mapAsync() in each frame sometimes stops the process with a
// native error in a mutex, or makes it hang.
const SAMPLE_INTERVAL = 15;
const READBACK_BUFFERS = 1;

export class GpuTimer {
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly freeBuffers: GPUBuffer[] = [];
  private pending: GPUBuffer | null = null;
  private frameCount = 0;

  // Make a timer, or return null if the device cannot write timestamps.
  static create(device: GPUDevice): GpuTimer | null {
    return device.features.has('timestamp-query') ? new GpuTimer(device) : null;
  }

  private constructor(device: GPUDevice) {
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    // The query set gives its own type and count, so the buffers fit the query set.
    if (this.querySet.type !== 'timestamp') {
      throw new Error(`Expected a timestamp query set, but the type is ${this.querySet.type}`);
    }
    // Each timestamp is a 64-bit value in nanoseconds.
    const size = this.querySet.count * BigUint64Array.BYTES_PER_ELEMENT;
    this.resolveBuffer = device.createBuffer({
      size,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < READBACK_BUFFERS; ++i) {
      this.freeBuffers.push(device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    }
  }

  // The timestampWrites of the render pass descriptor.
  get timestampWrites(): GPURenderPassTimestampWrites {
    return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }

  // Record the copy of the timestamps after the pass. Call this before the command buffer is finished.
  resolve(encoder: GPUCommandEncoder): void {
    this.frameCount += 1;
    if (this.frameCount % SAMPLE_INTERVAL !== 0) {
      return;
    }
    const buffer = this.freeBuffers.pop();
    if (!buffer) {
      return;
    }
    encoder.resolveQuerySet(this.querySet, 0, this.querySet.count, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, buffer, 0, buffer.size);
    this.pending = buffer;
  }

  // Read the timestamps of the resolved frame. Call this after the command buffer is submitted.
  // onTime gets the GPU time of the pass in milliseconds, after the GPU completes the frame.
  read(onTime: (milliseconds: number) => void): void {
    const buffer = this.pending;
    if (!buffer) {
      return;
    }
    this.pending = null;
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const [start, end] = new BigUint64Array(buffer.getMappedRange());
        buffer.unmap();
        this.freeBuffers.push(buffer);
        // A timestamp can be 0 or out of order, for example after a GPU clock change.
        if (end > start) {
          onTime(Number(end - start) / 1e6);
        }
      },
      () => this.freeBuffers.push(buffer),
    );
  }
}
