// The LunarG ship: a glTF model with engine flames that ignite, run, and shut down.
// All world units are meters. In the model, +Y is up and +Z is the front of the ship.
//
// Solid parts use the shared sun. The flames are unlit: they use their vertex colors and
// additive blending, as assets/lunarg-ship/viewer.html does. While the engines run, one point
// light behind each engine flickers and lights the solid parts of the ship. The engine lights do
// not light other objects. A glow sprite at each engine light gives a bloom effect: it is a quad
// that faces the camera and adds a soft halo of the light color.

#pragma once

#include "util/gltf.h"
#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <map>
#include <memory>
#include <string>
#include <tuple>
#include <vector>

namespace hackathon {

class DirectionalLight;

// The formats of the targets of DrawMirrored(): the color, the id of the mirror (plus 1, or 0 for
// no image), and the depth. kMirrorFloats is the size of one mirror in the storage buffer, and
// kMirrorViewFloats is the size of the uniform: viewProjection (16 floats) and camera (4).
inline constexpr wgpu::TextureFormat kMirrorColorFormat = wgpu::TextureFormat::RGBA8Unorm;
inline constexpr wgpu::TextureFormat kMirrorIdFormat = wgpu::TextureFormat::R32Uint;
inline constexpr wgpu::TextureFormat kMirrorDepthFormat = wgpu::TextureFormat::Depth24Plus;
inline constexpr size_t kMirrorFloats = 32;
inline constexpr size_t kMirrorViewFloats = 20;

class Ship {
  public:
    // Returns null and writes an error if the model does not have the nodes and the animations of
    // the ship (see assets/lunarg-ship/README.md).
    static std::unique_ptr<Ship> Create(const wgpu::Device& device, wgpu::TextureFormat format,
                                        wgpu::TextureFormat depthFormat,
                                        const DirectionalLight& light, GltfModel model,
                                        std::string& error);

    // The center of the bounding box of the ship in model space, with the engines off.
    const Vec3& Center() const { return center_; }
    // The height of the solid parts of the ship (with no flames or glow), in model units.
    double Height() const { return height_; }
    // The layout of the mirror bind group (group 2) of DrawMirrored().
    const wgpu::BindGroupLayout& MirrorBindGroupLayout() const { return mirrorBindGroupLayout_; }

    // Set the transform from model space to world space.
    void SetPlacement(const Vec3& translation, const Quat& rotation);
    // Set the camera. The glow sprites need the view matrix to face the camera.
    void SetCamera(const Mat4& view, const Mat4& projection);

    // Draw mirror images of the solid parts of the ship, one image for each of count mirrors. The
    // pass must have the targets kMirrorColorFormat and kMirrorIdFormat, and the depth
    // kMirrorDepthFormat. mirrors is a bind group of MirrorBindGroupLayout(). Call Draw() in the
    // same frame, because it sets the model matrices.
    void DrawMirrored(const wgpu::RenderPassEncoder& pass, const wgpu::BindGroup& mirrors,
                      uint32_t count) const;

    // Set the re-entry heating level, from 0 (none) to 1 (full).
    void SetHeat(double level);
    // Ignite the engines, or shut them down. A change in the middle of an ignition or a shutdown
    // starts the other animation at the current flame size, so the flames do not jump.
    void SetEnginesOn(bool on);
    // The engine boost level, from 0 (no boost) to 1 (full boost). The scene can use it, for
    // example to change the speed of the terrain.
    double BoostLevel() const { return boost_; }
    // Turn the engine boost on or off. The boost level changes smoothly.
    void SetBoost(bool on) { boostOn_ = on; }
    // Set the engines on or off at once, with no ignition or shutdown animation. A running engine
    // starts at full flame size.
    void ResetEngines(bool on);

    // Advance the animations by a time step in seconds.
    void Update(double seconds);
    void Draw(const wgpu::RenderPassEncoder& pass);

  private:
    struct GpuPrimitive {
        std::vector<wgpu::Buffer> vertexBuffers;
        wgpu::Buffer indexBuffer;
        wgpu::IndexFormat indexFormat;
        uint32_t indexCount;
    };

    struct DrawItem {
        int node;
        const GltfPrimitive* primitive;
        const GltfMaterial* material;
        const GpuPrimitive* gpuPrimitive;
        wgpu::RenderPipeline pipeline;
        wgpu::Buffer uniformBuffer;
        wgpu::BindGroup bindGroup = nullptr;
    };

    // The current transform and morph weights of a node, after the animations.
    struct NodePose {
        std::vector<double> translation;
        std::vector<double> rotation;
        std::vector<double> scale;
        std::vector<double> weights;
    };

    // Running: the ignite animation plays (and then holds its last frame), and the running
    // animation loops. ShuttingDown: the shutdown animation plays, and the running animation
    // continues to loop until the shutdown animation is complete.
    enum class EngineState { Off, Running, ShuttingDown };

    struct Engine {
        int flameRoot;
        int engine;
    };

    struct Bounds {
        Vec3 min;
        Vec3 max;
    };

    Ship(const wgpu::Device& device, const DirectionalLight& light, GltfModel model);
    bool Initialize(wgpu::TextureFormat format, wgpu::TextureFormat depthFormat,
                    std::string& error);

    Bounds ComputeBounds(const std::vector<const DrawItem*>& items) const;
    void WriteEngineLights();
    double FlameSize() const;
    double TimeAtFlameSize(const GltfAnimation& animation, double size) const;
    void UpdateBoost(double seconds);
    double BoostBrightness() const;
    bool MakeStreaks(std::vector<float>& data, std::string& error) const;
    void UpdatePose();
    void ApplyAnimation(const GltfAnimation& animation, double time);
    void UpdateWorldMatrices();
    void Visit(int index, const Mat4& parent);
    void DrawItemGeometry(const wgpu::RenderPassEncoder& pass, const DrawItem& item,
                          uint32_t instanceCount) const;

    wgpu::Device device_;
    const DirectionalLight& light_;
    const GltfModel model_;
    std::map<const GltfPrimitive*, GpuPrimitive> gpuPrimitives_;
    std::map<std::tuple<bool, bool, bool>, wgpu::RenderPipeline> pipelines_;
    std::vector<DrawItem> opaqueItems_;
    std::vector<DrawItem> blendedItems_;
    std::vector<NodePose> poses_;
    std::vector<Mat4> worldMatrices_;
    int flameRoot_ = -1;
    // For each engine: the flame root node and the engine node (its parent).
    std::vector<Engine> engines_;
    wgpu::Buffer engineLightBuffer_;
    wgpu::Buffer glowUniformBuffer_;
    wgpu::BindGroup glowBindGroup_;
    wgpu::RenderPipeline glowPipeline_;
    wgpu::RenderPipeline heatPipeline_;
    wgpu::RenderPipeline streakPipeline_;
    wgpu::BindGroupLayout mirrorBindGroupLayout_;
    wgpu::RenderPipeline mirrorPipeline_;
    wgpu::Buffer streakBuffer_;
    // The draw of the hull. The streaks use its bind group, for the model matrix of the hull. An
    // index into opaqueItems_, or -1.
    int hullItem_ = -1;
    // From 0 (no heating) to 1 (full re-entry heating).
    double heat_ = 0.0;
    Vec3 cameraPosition_ = {0.0, 0.0, 0.0};
    // Two vec4f for each engine light (position and color), heat, camera, and viewProjection.
    std::vector<float> engineLightData_;
    // The time in seconds since the ship was made. The flicker uses it.
    double clock_ = 0.0;
    // True when the boost is on. The boost level moves toward 1 when it is on, and toward 0 when it
    // is off.
    bool boostOn_ = false;
    // From 0 (no boost) to 1 (full boost).
    double boost_ = 0.0;
    const GltfAnimation* ignite_ = nullptr;
    const GltfAnimation* running_ = nullptr;
    const GltfAnimation* shutdown_ = nullptr;
    std::vector<float> uniformData_;
    Vec3 center_ = {0.0, 0.0, 0.0};
    double height_ = 0.0;
    Mat4 placement_ = Identity();
    Mat4 viewProjection_ = Identity();
    EngineState engineState_ = EngineState::Off;
    double igniteTime_ = 0.0;
    double runningTime_ = 0.0;
    double shutdownTime_ = 0.0;
};

}  // namespace hackathon
