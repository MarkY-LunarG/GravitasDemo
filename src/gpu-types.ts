// Short names for the WebGPU types that the shared code uses. The types come from @webgpu/types,
// so the same code works with the browser WebGPU API and with @kmamal/gpu (Dawn) on the desktop.

export type Device = GPUDevice;
export type RenderPassEncoder = GPURenderPassEncoder;
export type TextureFormat = GPUTextureFormat;
export type DepthFormat = GPUTextureFormat;
