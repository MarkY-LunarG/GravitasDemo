#include "app/app.h"

#include "app/blit.h"
#include "app/fade.h"
#include "app/gpu_timer.h"
#include "app/light.h"
#include "app/ship.h"
#include "app/terrain.h"
#include "util/format.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
#include <numbers>

namespace hackathon {

namespace {

constexpr double kPi = std::numbers::pi;

// All world units are meters. The camera is above the point (kCameraCorner, kCameraCorner), and
// its heading is toward the origin. The terrain grid is a sector around the point below the camera.
constexpr double kCameraCorner = -12500.0;
constexpr double kEyeHeight = 500.0;
// The camera looks horizontally toward the origin, then tilts down by this angle.
// At -10 degrees, the terrain fills approximately the bottom two thirds of the window.
constexpr double kCameraPitch = -10.0 * kPi / 180.0;
constexpr double kFieldOfViewY = 45.0 * kPi / 180.0;
constexpr double kNearPlane = 1.0;
// The terrain grid ends at kTerrainRadius, so the far plane does not need to be farther away.
constexpr double kFarPlane = kTerrainRadius;

// All pipelines that draw in the main render pass must use this depth format.
constexpr wgpu::TextureFormat kDepthFormat = wgpu::TextureFormat::Depth24Plus;

// During an engine boost, things that move past the ship (for example the terrain features and
// the asteroids) move up to kBoostSpeedScale times faster.
constexpr double kBoostSpeedScale = 2.0;

// The sun is a directional light. This is the sun position in the view space of a level camera
// (pitch 0), where the camera is at the origin and looks along -Z, +X is to the right, and +Y is
// up. The level view keeps the sun 45 degrees above the horizon for all values of kCameraPitch.
// The sun is in front of the camera, 45 degrees to the left of the view direction, and
// 45 degrees above the horizon: the height is equal to the horizontal distance, 9000 * sqrt(2).
// Only the direction to this point is important, because the sun is infinitely far away.
constexpr Vec3 kSunViewPosition = {-9000.0, 9000.0 * std::numbers::sqrt2, -9000.0};
// A bright sun and a dim ambient term give high contrast: slopes that face away from the sun
// are dark. Increase kAmbientColor for softer shadows.
constexpr Vec3 kSunColor = {1.0, 1.0, 1.0};
constexpr Vec3 kAmbientColor = {0.0, 0.0, 0.0};

// The distance from the camera to the center of the ship, along the center of the view.
// The ship is 50 m tall, so at 250 m it fills approximately one quarter of the window height.
constexpr double kShipDistance = 250.0;

constexpr Vec3 kEye = {kCameraCorner, kEyeHeight, kCameraCorner};
// The horizontal unit vector from the camera toward the origin.
const Vec3 kHeading = {-kEye[0] / std::hypot(kEye[0], kEye[2]), 0.0,
                       -kEye[2] / std::hypot(kEye[0], kEye[2])};

// The unit vector along the center of the view. The heading is toward the origin, and the pitch
// tilts it up or down.
Vec3 ViewDirection(double pitch) {
    return {kHeading[0] * std::cos(pitch), std::sin(pitch), kHeading[2] * std::cos(pitch)};
}

// The view of the camera at its start position. The sun direction uses the level view (pitch 0).
Mat4 ComputeView(double pitch) {
    const Vec3 forward = ViewDirection(pitch);
    return LookAt(kEye, {kEye[0] + forward[0], kEye[1] + forward[1], kEye[2] + forward[2]},
                  {0.0, 1.0, 0.0});
}

// The world position of the ship center: on the center of the start view, kShipDistance from the
// camera.
const Vec3 kShipCenter = {
    kEye[0] + ViewDirection(kCameraPitch)[0] * kShipDistance,
    kEye[1] + ViewDirection(kCameraPitch)[1] * kShipDistance,
    kEye[2] + ViewDirection(kCameraPitch)[2] * kShipDistance,
};

// The camera path. The camera moves on a horizontal circle around the ship center, at its start
// distance and height, and always looks at the ship center. The path repeats every
// kCameraPathPeriod seconds. Each key is {time in seconds, angle}, where the angle is a fraction
// of kCameraOrbitAngle: 1 is to the left of the start position, and -1 is to the right.
// Between two keys, the angle changes along a smooth curve.
constexpr double kCameraOrbitAngle = 20.0 * kPi / 180.0;
constexpr double kCameraPathPeriod = 20.0;
constexpr std::array<std::array<double, 2>, 8> kCameraPath = {{
    {0, 0},
    {3, 0},
    {5, 1},
    {9, 1},
    {12, -1},
    {16, -1},
    {18, 0},
    {20, 0},
}};

// The orbit angle of the camera, in radians, at a time in seconds.
double CameraOrbitAngle(double seconds) {
    const double time = std::fmod(seconds, kCameraPathPeriod);
    for (size_t key = 1; key < kCameraPath.size(); ++key) {
        const auto [endTime, endAngle] = kCameraPath[key];
        if (time <= endTime) {
            const auto [startTime, startAngle] = kCameraPath[key - 1];
            const double fraction = (time - startTime) / (endTime - startTime);
            const double smooth = fraction * fraction * (3 - 2 * fraction);
            return (startAngle + (endAngle - startAngle) * smooth) * kCameraOrbitAngle;
        }
    }
    return 0.0;
}

// The camera position at an orbit angle. Positive angles move the camera to its left.
Vec3 CameraEye(double angle) {
    const double distance = std::hypot(kEye[0] - kShipCenter[0], kEye[2] - kShipCenter[2]);
    // The horizontal unit vector to the left of the start heading.
    const Vec3 left = {kHeading[2], 0.0, -kHeading[0]};
    return {
        kShipCenter[0] + (-kHeading[0] * std::cos(angle) + left[0] * std::sin(angle)) * distance,
        kEye[1],
        kShipCenter[2] + (-kHeading[2] * std::cos(angle) + left[2] * std::sin(angle)) * distance,
    };
}

// The horizontal unit vector to the right of the start heading.
const Vec3 kRight = {-kHeading[2], 0.0, kHeading[0]};

Mat4 ComputeProjection(double aspect) {
    return Perspective(kFieldOfViewY, aspect, kNearPlane, kFarPlane);
}

// The fade to black takes kTransitionFadeTime seconds before the end of a scene, and the fade
// from black takes the same time after the start of the next scene.
constexpr double kTransitionFadeTime = 0.5;

struct ScenePosition {
    Scene* scene;
    double start;
    double fade;
};

// The scene at a time in seconds, the start time of the scene, and the amount of the fade to black
// at that time (0 to 1). A last scene with a finite duration fades to black at its end. After the
// last scene ends, it continues, but stays black.
ScenePosition SceneAt(const std::vector<std::unique_ptr<Scene>>& scenes, double seconds) {
    double start = 0.0;
    for (size_t index = 0; index < scenes.size(); ++index) {
        Scene* scene = scenes[index].get();
        const double duration = scene->Properties().duration;
        const double end = start + duration;
        if (seconds < end || index == scenes.size() - 1) {
            double fade = 0.0;
            if (index > 0) {
                fade = std::max(fade, 1 - (seconds - start) / kTransitionFadeTime);
            }
            if (index < scenes.size() - 1 || !std::isinf(duration)) {
                fade = std::max(fade, 1 - (end - seconds) / kTransitionFadeTime);
            }
            return {scene, start, std::max(0.0, std::min(1.0, fade))};
        }
        start = end;
    }
    return {scenes.back().get(), start, 0.0};
}

// A scene writes its result when it ends. A scene with no end writes its result after this many
// seconds, and again after each interval.
constexpr double kStatsInterval = 20.0;

}  // namespace

std::unique_ptr<App> App::Create(const wgpu::Device& device, wgpu::TextureFormat format,
                                 GltfModel shipModel, const IntroImages* introImages,
                                 std::string& error) {
    std::unique_ptr<App> app(new App(device, format));
    if (!app->Initialize(std::move(shipModel), introImages, error)) {
        return nullptr;
    }
    return app;
}

App::App(const wgpu::Device& device, wgpu::TextureFormat format)
    : device_(device), format_(format) {}

App::~App() = default;

bool App::Initialize(GltfModel shipModel, const IntroImages* introImages, std::string& error) {
    gpuTimer_ = GpuTimer::Create(device_);
    // All objects in all scenes use this one light. A scene can change its direction and colors.
    defaultSun_ = {
        .direction = ViewToWorldDirection(ComputeView(0.0), kSunViewPosition),
        .color = kSunColor,
        .ambient = kAmbientColor,
    };
    sun_ = std::make_unique<DirectionalLight>(device_, defaultSun_.direction, kSunColor,
                                              kAmbientColor);
    terrain_ = std::make_unique<Terrain>(device_, format_, kDepthFormat, *sun_);
    ship_ = Ship::Create(device_, format_, kDepthFormat, *sun_, std::move(shipModel), error);
    if (!ship_) {
        return false;
    }
    PlaceShip();
    fade_ = std::make_unique<Fade>(device_, format_, kDepthFormat);
    blit_ = std::make_unique<Blit>(device_, format_);
    resultsPage_ = std::make_unique<ResultsPage>(device_, format_);

    const SharedObjects shared = {
        .device = device_,
        .format = format_,
        .depthFormat = kDepthFormat,
        .sun = sun_.get(),
        .terrain = terrain_.get(),
        .ship = ship_.get(),
        .shipCenter = kShipCenter,
        .heading = kHeading,
        .cameraStart = CameraEye(0.0),
        .moveShip = [this](const Vec3& offset, const ShipTurn& turn) { PlaceShip(offset, turn); },
    };
    if (introImages) {
        scenes_.push_back(CreateIntroScene(shared, *introImages));
    }
    for (const SceneFactory& createScene : BenchmarkScenes()) {
        scenes_.push_back(createScene(shared));
    }
    for (const auto& scene : scenes_) {
        if (scene->Properties().benchmark) {
            benchmarkScenes_.push_back(scene.get());
        }
    }
    return true;
}

// Put the ship center at offset from kShipCenter, along kRight, up, and kHeading, in meters, and
// turn the ship around its center. Without a turn, the ship is level, and its front (+Z) points
// along kHeading. In the model, +X is to the left of the ship, +Y is up, and +Z is the front.
void App::PlaceShip(const Vec3& offset, const ShipTurn& turn) {
    const Quat heading = QuatFromAxisAngle({0.0, 1.0, 0.0}, std::atan2(kHeading[0], kHeading[2]));
    // A turn of the nose to the right is a negative rotation around +Y, because +X is to the left.
    // A raise of the nose is a negative rotation around +X. A positive rotation around +Z moves the
    // top of the ship to its right.
    const Quat local = QuatMultiply(QuatFromAxisAngle({0.0, 1.0, 0.0}, -turn.yaw),
                                    QuatMultiply(QuatFromAxisAngle({1.0, 0.0, 0.0}, -turn.pitch),
                                                 QuatFromAxisAngle({0.0, 0.0, 1.0}, turn.roll)));
    const Quat rotation = QuatMultiply(heading, local);
    const Vec3 rotatedCenter =
        TransformPoint(Compose({0.0, 0.0, 0.0}, rotation, {1.0, 1.0, 1.0}), ship_->Center());
    Vec3 position;
    for (size_t i = 0; i < 3; ++i) {
        position[i] = kShipCenter[i] + kRight[i] * offset[0] + (i == 1 ? offset[1] : 0.0) +
                      kHeading[i] * offset[2];
    }
    ship_->SetPlacement({position[0] - rotatedCenter[0], position[1] - rotatedCenter[1],
                         position[2] - rotatedCenter[2]},
                        rotation);
}

const std::string& App::SceneName() const {
    return SceneAt(scenes_, elapsed_).scene->Properties().name;
}

void App::PointerMove(float x, float y) { resultsPage_->SetPointer(x, y); }

void App::Click(float x, float y) {
    if (Finished() && resultsPage_->IsOnExitButton(x, y)) {
        exitPressed_ = true;
    }
}

bool App::PastEnd() const {
    double total = 0.0;
    for (const auto& scene : scenes_) {
        total += scene->Properties().duration;
    }
    return elapsed_ >= total;
}

void App::JumpToScene(int sceneNumber) {
    const int number = std::min(static_cast<int>(benchmarkScenes_.size()), sceneNumber);
    size_t index = 0;
    if (number >= 1) {
        const Scene* target = benchmarkScenes_[number - 1];
        while (scenes_[index].get() != target) {
            ++index;
        }
    }
    JumpToIndex(index);
}

void App::NextScene() {
    size_t index = 0;
    if (currentScene_) {
        while (scenes_[index].get() != currentScene_) {
            ++index;
        }
    }
    JumpToIndex((index + 1) % scenes_.size());
}

// Go to the start of the scene at an index of scenes_. The scene starts as after a normal
// transition: the ship is at its start position, and the scene time is 0.
void App::JumpToIndex(size_t index) {
    elapsed_ = 0.0;
    for (size_t i = 0; i < index; ++i) {
        elapsed_ += scenes_[i]->Properties().duration;
    }
    // Start just after the fade from black.
    elapsed_ += index > 0 ? kTransitionFadeTime : 0.0;
}

void App::ToggleTerrainRenderMode() {
    terrain_->SetRenderMode(terrain_->RenderMode() == TerrainRenderMode::Solid
                                ? TerrainRenderMode::Wireframe
                                : TerrainRenderMode::Solid);
}

void App::Frame(double animationSeconds, double statsSeconds, const wgpu::TextureView& colorView,
                uint32_t width, uint32_t height) {
    elapsed_ += animationSeconds;
    if (PastEnd()) {
        if (!finalStatsReported_ && currentScene_) {
            ReportStats(*currentScene_);
        }
        finalStatsReported_ = true;
    }
    if (Finished()) {
        DrawResults(colorView, width, height);
        return;
    }
    const ScenePosition position = SceneAt(scenes_, elapsed_);
    Scene& scene = *position.scene;
    const SceneProperties& properties = scene.Properties();
    // Each scene starts with the ship at its start position, with no boost and no heat.
    if (&scene != currentScene_) {
        if (currentScene_) {
            ReportStats(*currentScene_);
        }
        currentScene_ = &scene;
        PlaceShip();
        ship_->SetBoost(false);
        ship_->SetHeat(0.0);
        ship_->ResetEngines(properties.engines);
        const SceneSun& sceneSun = properties.sun ? *properties.sun : defaultSun_;
        sun_->SetDirection(sceneSun.direction);
        sun_->SetColors(sceneSun.color, sceneSun.ambient);
        terrain_->SetStyle(properties.terrainStyle ? *properties.terrainStyle
                                                   : kDefaultTerrainStyle);
    } else if (std::isinf(properties.duration) && stats_.seconds >= kStatsInterval) {
        ReportStats(scene);
    }
    stats_.frames += 1;
    stats_.seconds += statsSeconds;
    const CameraResult camera = UpdateCamera(static_cast<double>(width) / height,
                                             properties.cameraAngle, properties.cameraLookAhead);
    ship_->Update(animationSeconds);
    const wgpu::CommandEncoder encoder = device_.CreateCommandEncoder();
    scene.Update({
        .seconds = animationSeconds,
        .sceneTime = elapsed_ - position.start,
        // The boost level changes smoothly, so the speed also changes smoothly.
        .speedScale = 1 + (kBoostSpeedScale - 1) * ship_->BoostLevel(),
        .viewProjection = camera.viewProjection,
        .cameraPosition = camera.cameraPosition,
        .width = width,
        .height = height,
        .encoder = encoder,
    });
    Render(encoder, colorView, width, height, scene, position.fade);
}

// Move the camera along its path, or put it at a fixed angle around the ship (in degrees). The
// camera looks at a point lookAhead meters in front of the start position of the ship. Then give
// the camera to the shared objects. The terrain grid follows the camera, so that the grid always
// covers the view.
App::CameraResult App::UpdateCamera(double aspect, std::optional<double> fixedAngle,
                                    double lookAhead) {
    const Vec3 eye = CameraEye(fixedAngle ? *fixedAngle * kPi / 180.0 : CameraOrbitAngle(elapsed_));
    const Vec3 target = {
        kShipCenter[0] + kHeading[0] * lookAhead,
        kShipCenter[1] + kHeading[1] * lookAhead,
        kShipCenter[2] + kHeading[2] * lookAhead,
    };
    const Vec3 toTarget = {target[0] - eye[0], 0.0, target[2] - eye[2]};
    const double length = std::hypot(toTarget[0], toTarget[2]);
    terrain_->SetGridCenter(eye, {toTarget[0] / length, 0.0, toTarget[2] / length});
    const Mat4 view = LookAt(eye, target, {0.0, 1.0, 0.0});
    const Mat4 projection = ComputeProjection(aspect);
    const Mat4 viewProjection = Multiply(projection, view);
    terrain_->SetViewProjection(viewProjection);
    ship_->SetCamera(view, projection);
    return {viewProjection, eye};
}

void App::Render(const wgpu::CommandEncoder& encoder, const wgpu::TextureView& colorView,
                 uint32_t width, uint32_t height, Scene& scene, double fade) {
    // The depth texture and the scene texture must have the same size as the output.
    if (!depthTexture_ || targetWidth_ != width || targetHeight_ != height) {
        if (depthTexture_) {
            depthTexture_.Destroy();
            sceneTexture_.Destroy();
        }
        targetWidth_ = width;
        targetHeight_ = height;
        const wgpu::TextureDescriptor depthDescriptor = {
            .usage = wgpu::TextureUsage::RenderAttachment,
            .size = {width, height, 1},
            .format = kDepthFormat,
        };
        depthTexture_ = device_.CreateTexture(&depthDescriptor);
        depthView_ = depthTexture_.CreateView();
        const wgpu::TextureDescriptor sceneDescriptor = {
            .usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding,
            .size = {width, height, 1},
            .format = format_,
        };
        sceneTexture_ = device_.CreateTexture(&sceneDescriptor);
        sceneView_ = sceneTexture_.CreateView();
    }

    const wgpu::RenderPassColorAttachment colorAttachment = {
        .view = sceneView_,
        .loadOp = wgpu::LoadOp::Clear,
        .storeOp = wgpu::StoreOp::Store,
        .clearValue = {0.0, 0.0, 0.0, 1.0},
    };
    const wgpu::RenderPassDepthStencilAttachment depthAttachment = {
        .view = depthView_,
        .depthLoadOp = wgpu::LoadOp::Clear,
        .depthStoreOp = wgpu::StoreOp::Discard,
        .depthClearValue = 1.0f,
    };
    const wgpu::RenderPassDescriptor passDescriptor = {
        .colorAttachmentCount = 1,
        .colorAttachments = &colorAttachment,
        .depthStencilAttachment = &depthAttachment,
        .occlusionQuerySet = scene.OcclusionQuerySet(),
        .timestampWrites = gpuTimer_ ? gpuTimer_->TimestampWrites() : nullptr,
    };
    const wgpu::RenderPassEncoder pass = encoder.BeginRenderPass(&passDescriptor);
    // The ship goes after the opaque scene objects, because its flames and glow are blended and
    // do not write depth. Objects that draw after them would cover them. Blended scene objects that
    // the ship can fly through, and screen effects, go after the ship.
    scene.Draw(pass);
    if (scene.ShipVisible()) {
        ship_->Draw(pass);
    }
    scene.DrawOcclusionQueries(pass);
    scene.DrawAfterShip(pass);
    fade_->Draw(pass, fade);
    pass.End();
    scene.AfterMainPass(encoder, sceneView_);

    // Copy the scene to the output, and then draw the screen effects that read the scene image.
    const wgpu::RenderPassColorAttachment postAttachment = {
        .view = colorView,
        .loadOp = wgpu::LoadOp::Clear,
        .storeOp = wgpu::StoreOp::Store,
        .clearValue = {0.0, 0.0, 0.0, 1.0},
    };
    const wgpu::RenderPassDescriptor postDescriptor = {.colorAttachmentCount = 1,
                                                       .colorAttachments = &postAttachment};
    const wgpu::RenderPassEncoder post = encoder.BeginRenderPass(&postDescriptor);
    blit_->Draw(post, sceneView_);
    scene.DrawPost(post, sceneView_);
    post.End();
    if (gpuTimer_) {
        gpuTimer_->Resolve(encoder);
    }
    const wgpu::CommandBuffer commands = encoder.Finish();
    device_.GetQueue().Submit(1, &commands);
}

// After the last scene: the results page.
void App::DrawResults(const wgpu::TextureView& colorView, uint32_t width, uint32_t height) {
    std::vector<std::string> sceneNames;
    for (const Scene* scene : benchmarkScenes_) {
        sceneNames.push_back(scene->Properties().name);
    }
    const wgpu::CommandEncoder encoder = device_.CreateCommandEncoder();
    resultsPage_->Draw(encoder, colorView, width, height, sceneNames, results_);
    const wgpu::CommandBuffer commands = encoder.Finish();
    device_.GetQueue().Submit(1, &commands);
}

// Write the benchmark result of a scene to stdout, and start new stats. With a GPU timer, the
// result is written when the GPU time of the submitted frames of the scene is available.
void App::ReportStats(const Scene& scene) {
    const SceneStats stats = stats_;
    const double fps = stats.seconds > 0.0 ? stats.frames / stats.seconds : 0.0;
    const std::string name = scene.Properties().name;
    auto write = [name, stats, fps](const std::string& gpu) {
        std::printf("Scene \"%s\": %llu frames in %s s, %s fps%s\n", name.c_str(),
                    static_cast<unsigned long long>(stats.frames), ToFixed1(stats.seconds).c_str(),
                    ToFixed1(fps).c_str(), gpu.c_str());
    };
    stats_ = {};
    // A scene that is not part of the benchmark (the intro) has no result. Its GPU time does not go
    // to the next scene.
    if (!scene.Properties().benchmark) {
        if (gpuTimer_) {
            gpuTimer_->DiscardTotal();
        }
        return;
    }
    const auto found = std::find(benchmarkScenes_.begin(), benchmarkScenes_.end(), &scene);
    results_.push_back({static_cast<int>(found - benchmarkScenes_.begin()) + 1, name, stats.frames,
                        stats.seconds});
    if (!gpuTimer_) {
        write("");
        return;
    }
    pendingReports_ += 1;
    gpuTimer_->ReadTotal([this, write](double milliseconds, uint32_t gpuFrames) {
        pendingReports_ -= 1;
        write(gpuFrames > 0 ? ", GPU render pass " + ToFixed2(milliseconds / gpuFrames) + " ms"
                            : std::string());
    });
}

}  // namespace hackathon
