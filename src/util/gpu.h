// Small helpers for WebGPU objects that many classes make in the same way.

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace hackathon {

// The size of a buffer write must be a multiple of 4 bytes.
inline uint64_t AlignTo4(uint64_t size) { return (size + 3) & ~uint64_t{3}; }

inline wgpu::Buffer CreateBuffer(const wgpu::Device& device, uint64_t size,
                                 wgpu::BufferUsage usage) {
    const wgpu::BufferDescriptor descriptor = {.usage = usage, .size = size};
    return device.CreateBuffer(&descriptor);
}

// A buffer that contains data. The size is rounded up to a multiple of 4 bytes, and the extra
// bytes are 0.
inline wgpu::Buffer CreateBufferWithData(const wgpu::Device& device, const void* data, size_t size,
                                         wgpu::BufferUsage usage) {
    const uint64_t paddedSize = AlignTo4(size);
    wgpu::Buffer buffer = CreateBuffer(device, paddedSize, usage | wgpu::BufferUsage::CopyDst);
    std::vector<uint8_t> padded(paddedSize, 0);
    std::memcpy(padded.data(), data, size);
    device.GetQueue().WriteBuffer(buffer, 0, padded.data(), padded.size());
    return buffer;
}

template <typename T>
wgpu::Buffer CreateBufferWithData(const wgpu::Device& device, const std::vector<T>& data,
                                  wgpu::BufferUsage usage) {
    return CreateBufferWithData(device, data.data(), data.size() * sizeof(T), usage);
}

template <typename T>
void WriteBuffer(const wgpu::Device& device, const wgpu::Buffer& buffer, uint64_t offset,
                 const T* data, size_t count) {
    device.GetQueue().WriteBuffer(buffer, offset, data, count * sizeof(T));
}

// A bind group layout entry for a uniform buffer.
inline wgpu::BindGroupLayoutEntry UniformEntry(uint32_t binding, wgpu::ShaderStage visibility) {
    return {.binding = binding,
            .visibility = visibility,
            .buffer = {.type = wgpu::BufferBindingType::Uniform}};
}

// Blending that adds the color: overlapping glow, flames, and fire add their light. The alpha of
// the target does not change.
inline constexpr wgpu::BlendState kAdditiveBlend = {
    .color = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::One,
              .dstFactor = wgpu::BlendFactor::One},
    .alpha = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::Zero,
              .dstFactor = wgpu::BlendFactor::One},
};

// Additive blending with the source alpha as the weight.
inline constexpr wgpu::BlendState kAlphaAdditiveBlend = {
    .color = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::SrcAlpha,
              .dstFactor = wgpu::BlendFactor::One},
    .alpha = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::Zero,
              .dstFactor = wgpu::BlendFactor::One},
};

// Usual alpha blending over the target. The alpha of the target does not change.
inline constexpr wgpu::BlendState kAlphaBlend = {
    .color = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::SrcAlpha,
              .dstFactor = wgpu::BlendFactor::OneMinusSrcAlpha},
    .alpha = {.operation = wgpu::BlendOperation::Add,
              .srcFactor = wgpu::BlendFactor::Zero,
              .dstFactor = wgpu::BlendFactor::One},
};

}  // namespace hackathon
