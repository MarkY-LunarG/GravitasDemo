// Reflective glass towers that move past the ship. The towers reflect their surroundings, and the
// reflections also show the reflections in other towers.
//
// The reflections come from two cube maps, A and B, around a point among the towers. In each
// frame:
// 1. Six passes (one for each cube face) render the surroundings into A. The towers in these
//    passes reflect B, as it was at the end of the previous frame.
// 2. Six passes render the surroundings into B. The towers in these passes reflect A.
// 3. The main pass draws the towers, which reflect B.
// Thus a frame has two levels of reflection, and each frame starts from the result of the frame
// before it, so the reflections in reflections continue to build up.
//
// All draws are in render bundles, which are recorded one time and then executed in each frame:
// one bundle for each cube face of each cube map, and one bundle for the main pass. A bundle
// keeps its bind groups, so each cube face has its own camera uniform buffer, and Update()
// changes the contents of the buffers. The bundles use debug groups and debug markers, which
// show in GPU debuggers. The background of a cube face is one triangle with DrawIndirect, and the
// towers are one instanced DrawIndexedIndirect.
//
// The ship is not in the cube maps. Its reflections are exact mirror images instead: each frame,
// the CPU selects the tower walls (up to kMaxMirrors) that face the camera and the ship and are
// near the ship. One pass draws the ship mirrored through each of these walls into a reflection
// image the size of the view, with the id of the wall in a second image. The main pass of a wall
// adds the reflection image where the id is its own id, so a wall shows only its own image.
//
// The cube passes do not draw the terrain and the ship, because they are expensive. The
// background shader draws a simple version of the sky and dark ground below the horizon. All world
// units are meters.

#pragma once

#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <functional>
#include <vector>

namespace hackathon {

class DirectionalLight;
class Ship;

class Buildings {
  public:
    Buildings(const wgpu::Device& device, wgpu::TextureFormat format,
              wgpu::TextureFormat depthFormat, const DirectionalLight& light,
              const Vec3& shipCenter, const Vec3& heading, const Ship& ship);

    // Move the towers back along the heading to scroll (in meters, from the start), set the
    // camera, and record the passes of the cube maps and of the ship reflections. width and height
    // are the size of the view in pixels.
    void Update(const wgpu::CommandEncoder& encoder, double scroll, const Mat4& viewProjection,
                const Vec3& cameraPosition, uint32_t width, uint32_t height);
    // Draw the towers in the main pass.
    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    struct TowerState {
        double along;
        double side;
        double width;
        double depth;
        double height;
        double reflectivity;
        // The rotation around the vertical axis, in radians.
        double yaw;
        Vec3 tint;
    };

    struct ReflectionTargets {
        uint32_t width = 0;
        uint32_t height = 0;
        wgpu::TextureView color;
        wgpu::TextureView id;
        wgpu::TextureView depth;
    };

    void RenderShipReflections(const wgpu::CommandEncoder& encoder, const Mat4& viewProjection,
                               const Vec3& cameraPosition, uint32_t width, uint32_t height);
    const ReflectionTargets& ReflectionTargetsFor(uint32_t width, uint32_t height);
    static double AwayFromStreet(double side, double width, double depth);

    wgpu::Device device_;
    Vec3 shipCenter_;
    Vec3 heading_;
    Vec3 right_;
    Vec3 cubeCenter_;
    std::vector<TowerState> towers_;
    std::vector<float> towerData_;
    wgpu::Buffer towerBuffer_;
    std::vector<wgpu::Buffer> faceCameras_;
    wgpu::Buffer mainCamera_;
    // A view of each layer of the two cube maps, for the render passes.
    std::array<std::vector<wgpu::TextureView>, 2> cubeFaceViews_;
    wgpu::TextureView cubeDepthView_;
    // The bundles of the cube faces: faceBundles_[0] renders into A, and faceBundles_[1] into B.
    std::array<std::vector<wgpu::RenderBundle>, 2> faceBundles_;
    // The main bundle reads the ship reflection images, so it is recorded again when their size
    // changes.
    wgpu::RenderBundle mainBundle_;
    std::function<wgpu::RenderBundle(const wgpu::BindGroup& reflections)> recordMainBundle_;
    const Ship& ship_;
    wgpu::Buffer mirrorBuffer_;
    wgpu::Buffer mirrorViewBuffer_;
    wgpu::BindGroup mirrorBindGroup_;
    std::vector<float> mirrorData_;
    wgpu::BindGroupLayout reflectionLayout_;
    ReflectionTargets reflectionTargets_;
};

}  // namespace hackathon
