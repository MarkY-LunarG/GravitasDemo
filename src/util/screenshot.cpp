#include "util/screenshot.h"

#include "util/gpu.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>

#include <cstdio>
#include <cstring>
#include <vector>

namespace hackathon {

void Screenshot::Capture(const wgpu::Device& device, const wgpu::Texture& texture,
                         const std::string& path) {
    const wgpu::TextureFormat format = texture.GetFormat();
    const bool bgra =
        format == wgpu::TextureFormat::BGRA8Unorm || format == wgpu::TextureFormat::BGRA8UnormSrgb;
    if (!bgra && format != wgpu::TextureFormat::RGBA8Unorm &&
        format != wgpu::TextureFormat::RGBA8UnormSrgb) {
        std::fprintf(stderr,
                     "Screenshot: the texture format is not an 8-bit RGBA or BGRA format\n");
        return;
    }
    const uint32_t width = texture.GetWidth();
    const uint32_t height = texture.GetHeight();
    // A row of a texture copy must be a multiple of 256 bytes.
    const uint32_t bytesPerRow = (width * 4 + 255) & ~255u;
    const wgpu::Buffer buffer =
        CreateBuffer(device, uint64_t{bytesPerRow} * height,
                     wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead);
    const wgpu::TexelCopyTextureInfo source = {.texture = texture};
    const wgpu::TexelCopyBufferInfo destination = {
        .layout = {.bytesPerRow = bytesPerRow, .rowsPerImage = height}, .buffer = buffer};
    const wgpu::Extent3D size = {width, height, 1};
    const wgpu::CommandEncoder encoder = device.CreateCommandEncoder();
    encoder.CopyTextureToBuffer(&source, &destination, &size);
    const wgpu::CommandBuffer commands = encoder.Finish();
    device.GetQueue().Submit(1, &commands);

    state_->pending = true;
    buffer.MapAsync(
        wgpu::MapMode::Read, 0, buffer.GetSize(), wgpu::CallbackMode::AllowProcessEvents,
        [state = state_, buffer, path, width, height, bytesPerRow, bgra](
            wgpu::MapAsyncStatus status, wgpu::StringView) {
            state->pending = false;
            if (status != wgpu::MapAsyncStatus::Success) {
                std::fprintf(stderr, "Screenshot: cannot read the texture\n");
                return;
            }
            const auto* mapped = static_cast<const uint8_t*>(buffer.GetConstMappedRange());
            // The surface is opaque, so write RGB.
            std::vector<uint8_t> pixels(size_t{width} * height * 3);
            for (uint32_t y = 0; y < height; ++y) {
                const uint8_t* row = mapped + size_t{y} * bytesPerRow;
                for (uint32_t x = 0; x < width; ++x) {
                    uint8_t* out = &pixels[(size_t{y} * width + x) * 3];
                    out[0] = row[x * 4 + (bgra ? 2 : 0)];
                    out[1] = row[x * 4 + 1];
                    out[2] = row[x * 4 + (bgra ? 0 : 2)];
                }
            }
            buffer.Unmap();
            if (stbi_write_png(path.c_str(), static_cast<int>(width), static_cast<int>(height), 3,
                               pixels.data(), static_cast<int>(width * 3)) == 0) {
                std::fprintf(stderr, "Screenshot: cannot write %s\n", path.c_str());
                return;
            }
            std::printf("Wrote %s\n", path.c_str());
        });
}

}  // namespace hackathon
