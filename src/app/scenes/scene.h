// The interface of a benchmark scene, and the shared objects that each scene can use.
//
// The App (src/app/app.cpp) owns the shared objects. In each frame, it moves the camera, updates
// and draws the ship, and calls Update() and Draw() of the current scene. A scene contains only
// what is special to it: its name, its duration, its own objects, and which shared objects it
// draws. When a scene starts, the App puts the ship back at its start position, turns the boost and
// the heat off, sets the engines on or off for the scene, and sets the sun and the terrain style of
// the scene.

#pragma once

#include "app/terrain.h"
#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace hackathon {

class DirectionalLight;
class Ship;

// The sun of a scene: the direction from a surface toward the sun, the color of the sunlight, and
// the color of the ambient light.
struct SceneSun {
    Vec3 direction;
    Vec3 color;
    Vec3 ambient;
};

// A turn of the ship around its center, in radians. Positive values turn the nose to the right,
// raise the nose, and move the top of the ship to its right (a bank into a right turn).
struct ShipTurn {
    double yaw = 0.0;
    double pitch = 0.0;
    double roll = 0.0;
};

// The objects that all scenes share. The App makes them once.
struct SharedObjects {
    wgpu::Device device;
    // The color format and the depth format of the main render pass. A scene that makes pipelines
    // must use these formats.
    wgpu::TextureFormat format;
    wgpu::TextureFormat depthFormat;
    DirectionalLight* sun;
    Terrain* terrain;
    // A scene can use the ship to turn the engine boost on.
    Ship* ship;
    // The start position of the ship center, and the horizontal unit vector of the ship front.
    Vec3 shipCenter;
    Vec3 heading;
    // The camera position of a stationary camera. It looks at shipCenter.
    Vec3 cameraStart;
    // Move the ship center to offset meters from its start position, along the right, up, and
    // heading directions, and turn the ship. The camera does not follow the ship.
    std::function<void(const Vec3& offset, const ShipTurn& turn)> moveShip;
};

// The values of one frame that a scene can use.
struct FrameInfo {
    // The time step in seconds.
    double seconds;
    // The time in seconds since the start of the scene.
    double sceneTime;
    // Things that move past the ship move this many times faster than usual. It is 1 without an
    // engine boost, and larger during a boost.
    double speedScale;
    Mat4 viewProjection;
    Vec3 cameraPosition;
    // The size of the view in pixels.
    uint32_t width;
    uint32_t height;
    // The command encoder of the frame. A scene can record compute passes in it. The render pass
    // comes after them.
    wgpu::CommandEncoder encoder;
};

// The fixed properties of a scene.
struct SceneProperties {
    std::string name;
    // The duration in seconds. The last scene can have a duration of infinity, so that it continues
    // until the application stops. Otherwise, the App is finished at the end of the last scene.
    double duration = 0.0;
    // False for a scene that is not part of the benchmark (the intro). It has no result and no
    // scene number, and --scene=N does not count it.
    bool benchmark = true;
    // False for a scene with the engines off. The engines are on or off at the start of the scene.
    bool engines = true;
    // A camera that does not move, at this angle in degrees around the ship: 0 is behind the ship,
    // 90 is at its left side, and -90 is at its right side. The camera stays at the start distance
    // and height, and looks at the start position of the ship. Without it, the camera follows its
    // path.
    std::optional<double> cameraAngle = std::nullopt;
    // The camera looks at a point this many meters in front of the start position of the ship,
    // along its heading. A positive value moves the ship to the left of the screen in a side view.
    double cameraLookAhead = 0.0;
    // The sun of the scene. Without it, the scene has the default sun of the App.
    std::optional<SceneSun> sun = std::nullopt;
    // The look of the shared terrain. Without it, the terrain has kDefaultTerrainStyle.
    std::optional<TerrainStyle> terrainStyle = std::nullopt;
};

class Scene {
  public:
    explicit Scene(SceneProperties properties) : properties_(std::move(properties)) {}
    virtual ~Scene() = default;

    const SceneProperties& Properties() const { return properties_; }

    // Advance the scene objects. The App calls this before the render pass of the frame.
    virtual void Update(const FrameInfo& /*frame*/) {}
    // Draw the scene objects. The App draws the ship after the scene objects.
    virtual void Draw(const wgpu::RenderPassEncoder& pass) = 0;
    // Draw blended objects that the ship can be behind or in, and screen effects. The App calls
    // this after it draws the ship.
    virtual void DrawAfterShip(const wgpu::RenderPassEncoder& /*pass*/) {}
    // The occlusion query set of the main pass, or null. The scene uses it in
    // DrawOcclusionQueries().
    virtual wgpu::QuerySet OcclusionQuerySet() const { return nullptr; }
    // Draw objects in occlusion queries. The App calls this in the main pass, after it draws the
    // ship and before DrawAfterShip(), so the depth buffer has all of the opaque objects.
    virtual void DrawOcclusionQueries(const wgpu::RenderPassEncoder& /*pass*/) {}
    // Record commands that use the results of the main pass, for example ResolveQuerySet() or
    // passes that read the scene image. The App calls this after the main pass and before the post
    // pass. sceneView is the image of the main pass.
    virtual void AfterMainPass(const wgpu::CommandEncoder& /*encoder*/,
                               const wgpu::TextureView& /*sceneView*/) {}
    // False when the App must not draw the ship in this frame.
    virtual bool ShipVisible() const { return true; }
    // Draw screen effects that read the image of the scene, for example water on the camera lens.
    // The App calls this in a second pass, after it copies the scene image to the output. The pass
    // has no depth buffer. sceneView has the same size and format as the output.
    virtual void DrawPost(const wgpu::RenderPassEncoder& /*pass*/,
                          const wgpu::TextureView& /*sceneView*/) {}

  private:
    SceneProperties properties_;
};

using SceneFactory = std::function<std::unique_ptr<Scene>(const SharedObjects& shared)>;

// The benchmark scenes, in the order that they play (scenes.cpp). To add a scene, write a file
// with a create function that returns a Scene, and add the function to this list.
std::vector<SceneFactory> BenchmarkScenes();

// The create functions of the scenes.
std::unique_ptr<Scene> CreateTerrainScene(const SharedObjects& shared);

}  // namespace hackathon
