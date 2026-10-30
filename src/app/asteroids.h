// A field of 3D asteroids around the ship. The GPU does all of the work after the start:
//
// 1. At the start, a compute shader makes the rock shapes from an icosphere. The surface uses the
//    design of the terrain in 3D: Perlin noise and small craters with the same bowl and rim. Each
//    shape has two levels of detail (LOD) from the same surface function.
// 2. In each frame, a compute shader moves and turns each asteroid, removes the asteroids that
//    are outside the view, selects the LOD from the size on the screen, and adds the asteroid to
//    the list of its shape and LOD. It counts the instances of each list in an indirect draw
//    buffer.
// 3. The render pass draws each list with one instanced DrawIndexedIndirect call. The vertex
//    shader reads the shape vertices and the asteroid data from storage buffers.
//
// All world units are meters. The asteroids use the shared sun. The start positions come from a
// random number generator with a fixed seed, so each run of the benchmark is the same.

#pragma once

#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <cstdint>
#include <vector>

namespace hackathon {

class DirectionalLight;
class ShipPath;

// All asteroids move toward the camera at this speed (times the speed scale from the scene), in
// meters per second.
inline constexpr double kAsteroidFlowSpeed = 150.0;

class Asteroids {
  public:
    // shipCenter is the center of the box. heading is the horizontal direction of the front of the
    // ship. The asteroids move from the front of the ship toward the camera.
    Asteroids(const wgpu::Device& device, wgpu::TextureFormat format,
              wgpu::TextureFormat depthFormat, const DirectionalLight& light,
              const Vec3& shipCenter, const Vec3& heading, const ShipPath& shipPath,
              const Vec3& cameraPosition);

    // Set the camera for the culling, the LOD selection, and the render pass.
    void SetCamera(const Mat4& viewProjection, const Vec3& cameraPosition);
    // Record the update and cull pass for a time step in seconds. speedScale multiplies the flow
    // speed. pathTime is the current time on the ship path. Call this before the render pass that
    // draws the asteroids.
    void Update(const wgpu::CommandEncoder& encoder, double seconds, double speedScale,
                double pathTime);
    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    void MakeShapes(const wgpu::Buffer& directionBuffer, const wgpu::Buffer& shapeVertexBuffer,
                    const std::array<uint32_t, 2>& vertexCounts);
    std::vector<float> MakeAsteroids(const ShipPath& shipPath, const Vec3& cameraPosition) const;

    wgpu::Device device_;
    const DirectionalLight& light_;
    Vec3 shipCenter_;
    Vec3 right_;
    Vec3 up_;
    Vec3 heading_;
    wgpu::Buffer indexBuffer_;
    wgpu::Buffer drawArgsBuffer_;
    // The draw arguments with instanceCount 0. Each frame starts from these values.
    std::vector<uint32_t> drawArgsTemplate_;
    wgpu::Buffer updateParamsBuffer_;
    std::vector<float> updateParams_;
    wgpu::ComputePipeline updatePipeline_;
    wgpu::BindGroup updateBindGroup_;
    wgpu::RenderPipeline renderPipeline_;
    std::vector<wgpu::BindGroup> renderBindGroups_;
    wgpu::Buffer viewProjectionBuffer_;
};

}  // namespace hackathon
