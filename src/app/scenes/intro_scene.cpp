// Scene: the intro, before the benchmark. It is not part of the benchmark results.
//
// Timeline, in seconds from the start of the scene:
// - 0 to 3: the LunarG color logo on black.
// - 3 to 4.5: the color logo blends into the neon logo.
// - 4.5 to 6.5: the neon logo becomes brighter, with a bloom filter, and changes to the neon tube
//   logo.
// - 6.5 to 10: the neon tubes flicker on and off, as tubes that fail, and the bloom increases.
// - 10: a white flash. The G tube goes out (it is unlit glass), and the ship is in its place, at
//   the same size, with its front to the left, so its ring is on the G. A light from the camera
//   side lights the ship at approximately half brightness.
// - 10 to 13.5: the engines ignite, and the ship flies off to the left.
// - 12 to 12.6: as the ship goes away, the G tube flickers and comes on again.
// - 13.5 to 14: the App fades the image to black, and the benchmark starts.

#include "app/bloom.h"
#include "app/intro_logo.h"
#include "app/scenes/scene.h"
#include "app/ship.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace hackathon {

namespace {

constexpr double kDuration = 14;
constexpr double kColorEnd = 3;
constexpr double kNeonEnd = 4.5;
constexpr double kTubeEnd = 6.5;
constexpr double kFlashTime = 10;
// The flash comes up in kFlashRise seconds and goes away in kFlashFall seconds.
constexpr double kFlashRise = 0.06;
constexpr double kFlashFall = 0.3;
// After the flash: the engines ignite, and then the ship flies away.
constexpr double kIgniteTime = 10.6;
constexpr double kFlyStart = 11.2;
// The ship faces the left of the screen (the heading is to the right).
constexpr double kShipYaw = std::numbers::pi;
// The ring is not at the center of the ship box: the hull and the engines go out behind it. This
// moves the ship to the right (as a fraction of its height), so the ring is on the G.
constexpr double kRingOffset = 0.11;
// The G tube comes on again in this time, with a flicker.
constexpr double kRelightStart = 12;
constexpr double kRelightEnd = 12.6;
// The light of the intro: from the camera side (the right of the ship), a little from above and in
// front. Its color and ambient color light the ship at approximately half brightness.
constexpr Vec3 kLightColor = {0.34, 0.34, 0.37};
constexpr Vec3 kLightAmbient = {0.09, 0.09, 0.1};
// The acceleration of the ship to the left, as a fraction of its distance from the camera in each
// second squared. With 0.8, the ship leaves the screen approximately 2 seconds after it starts.
constexpr double kFlyAcceleration = 0.8;
// The flicker changes state kFlickerRate times in each second. The chance that a tube is off goes
// from kFailStart to kFailEnd during the flicker.
constexpr double kFlickerRate = 14;
constexpr double kFailStart = 0.04;
constexpr double kFailEnd = 0.4;
constexpr uint32_t kRandomSeed = 4242;

double Smoothstep(double edge0, double edge1, double x) {
    const double t = std::min(std::max((x - edge0) / (edge1 - edge0), 0.0), 1.0);
    return t * t * (3 - 2 * t);
}

// A random value from 0 to 1 for two integers, the same each time. The 32-bit operations wrap as
// Math.imul() does in the TypeScript version.
double Hash(int64_t a, int64_t b) {
    uint32_t x = static_cast<uint32_t>(a + kRandomSeed) * 0x9e3779b1u ^
                 static_cast<uint32_t>(b + 1) * 0x85ebca6bu;
    x = (x ^ (x >> 15)) * 0x2c1b3c6du;
    x = (x ^ (x >> 12)) * 0x297a2d39u;
    return static_cast<double>(x ^ (x >> 15)) / 4294967296.0;
}

// The brightness of each tube during the flicker. A tube is on, off, or dim, and the G fails most.
// All tubes have a small fast hum.
std::array<double, kTubeCount> TubeLevels(double t) {
    const double fail = kFailStart + (kFailEnd - kFailStart) * Smoothstep(kTubeEnd, kFlashTime, t);
    const int64_t step = static_cast<int64_t>(std::floor(t * kFlickerRate));
    std::array<double, kTubeCount> levels;
    for (size_t tube = 0; tube < kTubeCount; ++tube) {
        const double chance = tube == kGTube ? std::min(0.85, fail * 1.8) : fail;
        const double value = Hash(static_cast<int64_t>(tube), step);
        double level = 1;
        if (value < chance * 0.6) {
            level = 0;
        } else if (value < chance) {
            level = 0.35;
        }
        const double hum = 1 - 0.06 * (0.5 + 0.5 * std::sin(t * 2 * std::numbers::pi * 60 +
                                                            static_cast<double>(tube)));
        levels[tube] = level * hum;
    }
    return levels;
}

// The NDC position (x and y) of a world point, and its w.
std::array<double, 3> Project(const Mat4& m, const Vec3& p) {
    const double x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const double y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const double w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return {x / w, y / w, w};
}

// The world point at an NDC position and an NDC depth.
Vec3 Unproject(const Mat4& m, double x, double y, double z) {
    const double w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return {
        (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
        (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
        (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    };
}

Vec3 LightDirection(const Vec3& heading) {
    const Vec3 right = {-heading[2], 0.0, heading[0]};
    Vec3 toLight;
    for (size_t i = 0; i < 3; ++i) {
        toLight[i] = right[i] * 0.8 + heading[i] * 0.3 + (i == 1 ? 0.5 : 0.0);
    }
    const double length = std::hypot(toLight[0], toLight[1], toLight[2]);
    return {toLight[0] / length, toLight[1] / length, toLight[2] / length};
}

class IntroScene : public Scene {
  public:
    IntroScene(const SharedObjects& shared, const IntroImages& images)
        : Scene({.name = "Intro",
                 .duration = kDuration,
                 .benchmark = false,
                 .engines = false,
                 .cameraAngle = -90.0,
                 .sun = SceneSun{.direction = LightDirection(shared.heading),
                                 .color = kLightColor,
                                 .ambient = kLightAmbient}}),
          shared_(shared),
          right_({-shared.heading[2], 0.0, shared.heading[0]}),
          logo_(shared.device, shared.format, shared.depthFormat, images),
          bloom_(shared.device, shared.format) {}

    void Update(const FrameInfo& frame) override {
        const double t = frame.sceneTime;
        time_ = t;
        width_ = frame.width;
        height_ = frame.height;
        const double colorToNeon = Smoothstep(kColorEnd, kNeonEnd, t);
        const double neonToTube = Smoothstep(kNeonEnd, kTubeEnd, t);
        const bool afterFlash = t >= kFlashTime;
        const bool flicker = t >= kTubeEnd && !afterFlash;
        std::array<double, kTubeCount> tubes;
        if (flicker) {
            tubes = TubeLevels(t);
        } else {
            tubes.fill(1.0);
        }
        // The G is off from the flash until the ship goes away. Then it flickers and comes on.
        if (afterFlash && t < kRelightEnd) {
            const int64_t step = static_cast<int64_t>(std::floor(t * kFlickerRate * 1.5));
            const double on = Smoothstep(kRelightStart, kRelightEnd, t);
            tubes[kGTube] = t >= kRelightStart && Hash(static_cast<int64_t>(kGTube) + 100, step) <
                                                      0.25 + 0.75 * on
                                ? 1.0
                                : 0.0;
        }
        double mean = 0.0;
        for (const double tube : tubes) {
            mean += tube;
        }
        mean /= kTubeCount;
        double flash = 0.0;
        if (t < kFlashTime) {
            flash = 0.0;
        } else if (t < kFlashTime + kFlashRise) {
            flash = (t - kFlashTime) / kFlashRise;
        } else {
            flash =
                1 - Smoothstep(kFlashTime + kFlashRise, kFlashTime + kFlashRise + kFlashFall, t);
        }
        logo_.Update({.colorToNeon = colorToNeon,
                      .neonToTube = neonToTube,
                      .brightness = 1 + 0.3 * neonToTube,
                      .panel = 1,
                      .tubes = tubes,
                      .flash = flash},
                     frame.width, frame.height);

        // The bloom: none on the color logo, then more as the neon logo becomes brighter, more in
        // the flicker, and a peak at the flash.
        bloomThreshold_ = 0.6;
        bloomIntensity_ = 0.3 * colorToNeon + 0.4 * neonToTube +
                          0.4 * Smoothstep(kTubeEnd, kFlashTime, t) * (flicker ? mean : 1) +
                          2.5 * flash;

        // The ship: in the place of the G after the flash, then it turns around and flies away.
        // As in the TypeScript version, the engines ignite only the first time the intro plays.
        if (afterFlash && !enginesOn_ && t >= kIgniteTime) {
            enginesOn_ = true;
            shared_.ship->SetEnginesOn(true);
        }
        if (t >= kFlyStart) {
            shared_.ship->SetBoost(true);
        }
        const double fly = std::max(0.0, t - kFlyStart);
        PlaceShipOnG(frame.viewProjection, frame.cameraPosition,
                     0.5 * kFlyAcceleration * fly * fly);
    }

    void Draw(const wgpu::RenderPassEncoder& pass) override { logo_.Draw(pass); }

    bool ShipVisible() const override { return time_ >= kFlashTime; }

    void AfterMainPass(const wgpu::CommandEncoder& encoder,
                       const wgpu::TextureView& sceneView) override {
        bloom_.Render(encoder, sceneView, width_, height_, bloomThreshold_, bloomIntensity_);
    }

    void DrawPost(const wgpu::RenderPassEncoder& pass,
                  const wgpu::TextureView& /*sceneView*/) override {
        bloom_.Draw(pass);
    }

  private:
    // Put the ship where the G is, at the same height on the screen, with its front to the left.
    // flyOffset moves it to the left, as a fraction of its distance from the camera.
    void PlaceShipOnG(const Mat4& viewProjection, const Vec3& cameraPosition, double flyOffset) {
        const Ship& ship = *shared_.ship;
        const std::array<double, 2> screen = logo_.ToScreen(kGCenter[0], kGCenter[1]);
        const double x = (screen[0] / width_) * 2 - 1;
        const double y = 1 - (screen[1] / height_) * 2;
        const double targetHeight = (2 * kGHeight * logo_.ScreenScale()) / height_;
        // The ray from the camera through the G.
        const Mat4 inverse = Invert(viewProjection);
        const Vec3 farPoint = Unproject(inverse, x, y, 1);
        const Vec3 toFar = {farPoint[0] - cameraPosition[0], farPoint[1] - cameraPosition[1],
                            farPoint[2] - cameraPosition[2]};
        const double length = std::hypot(toFar[0], toFar[1], toFar[2]);
        const Vec3 direction = {toFar[0] / length, toFar[1] / length, toFar[2] / length};
        // The screen height of the ship is inversely proportional to its distance. Measure it at a
        // reference distance, and then move the ship to the distance of the G height.
        const double reference = 1000;
        auto at = [&](double distance) {
            return Vec3{cameraPosition[0] + direction[0] * distance,
                        cameraPosition[1] + direction[1] * distance,
                        cameraPosition[2] + direction[2] * distance};
        };
        const Vec3 point = at(reference);
        const Vec3 top = {point[0], point[1] + ship.Height(), point[2]};
        const double referenceHeight =
            std::abs(Project(viewProjection, top)[1] - Project(viewProjection, point)[1]);
        const double distance = (reference * referenceHeight) / targetHeight;
        const Vec3 position = at(distance);
        const Vec3 delta = {position[0] - shared_.shipCenter[0],
                            position[1] - shared_.shipCenter[1],
                            position[2] - shared_.shipCenter[2]};
        const double along = delta[0] * shared_.heading[0] + delta[2] * shared_.heading[2];
        const double across = delta[0] * right_[0] + delta[2] * right_[2];
        const double ringShift = kRingOffset * ship.Height();
        shared_.moveShip({across, delta[1], along + ringShift - flyOffset * distance},
                         {.yaw = kShipYaw, .pitch = 0, .roll = 0});
    }

    SharedObjects shared_;
    Vec3 right_;
    IntroLogo logo_;
    Bloom bloom_;
    double time_ = 0.0;
    uint32_t width_ = 1;
    uint32_t height_ = 1;
    double bloomThreshold_ = 1.0;
    double bloomIntensity_ = 0.0;
    bool enginesOn_ = false;
};

}  // namespace

std::unique_ptr<Scene> CreateIntroScene(const SharedObjects& shared, const IntroImages& images) {
    return std::make_unique<IntroScene>(shared, images);
}

}  // namespace hackathon
