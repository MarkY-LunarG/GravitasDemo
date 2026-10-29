// WebGPU type names for code that receives objects from @kmamal/gpu.
// The @kmamal/gpu typings do not export their interfaces, and they are not compatible
// with @webgpu/types, so derive the types from the module API.

import type gpu from '@kmamal/gpu';

type Instance = ReturnType<typeof gpu.create>;
type Adapter = NonNullable<Awaited<ReturnType<Instance['requestAdapter']>>>;
type CommandEncoder = ReturnType<Device['createCommandEncoder']>;

export type Device = Awaited<ReturnType<Adapter['requestDevice']>>;
export type RenderPassEncoder = ReturnType<CommandEncoder['beginRenderPass']>;
export type TextureFormat = ReturnType<Instance['getPreferredCanvasFormat']>;
