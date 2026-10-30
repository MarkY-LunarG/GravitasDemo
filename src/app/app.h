// The benchmark: a sequence of scenes with the LunarG ship, the sun, and the camera. Each scene is
// in its own file in src/app/scenes/, and scenes.cpp gives their order. The App owns the objects
// that all scenes share: the terrain, the ship, the sun, the camera, and the fade. A short fade
// through black goes from one scene to the next. The ship engines run in all scenes.
// The camera follows a path that repeats: it moves around the ship to the left, then to the
// right, and then back to the center.
//
// The App does not know about the window or the target. main.cpp makes the device, loads the ship
// model, sends key and pointer events to the App, and calls Frame() once for each frame.
//
// With the intro images, the intro scene comes before the benchmark scenes. After the last scene,
// the App draws the results page, which has an Exit button.

#pragma once

#include "app/intro_logo.h"
#include "app/results_page.h"
#include "app/scenes/scene.h"
#include "util/gltf.h"
#include "util/mat4.h"

#include <webgpu/webgpu_cpp.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace hackathon {

class Blit;
class DirectionalLight;
class Fade;
class GpuTimer;
class Ship;
class Terrain;

class App {
  public:
    // format is the format of the texture views that Frame() draws into. With introImages, the
    // intro scene comes before the benchmark scenes. Returns null and writes an error if the ship
    // model is not correct.
    static std::unique_ptr<App> Create(const wgpu::Device& device, wgpu::TextureFormat format,
                                       GltfModel shipModel, const IntroImages* introImages,
                                       std::string& error);
    ~App();
    App(const App&) = delete;
    App& operator=(const App&) = delete;

    // The name of the current benchmark scene.
    const std::string& SceneName() const;
    // The number of benchmark scenes.
    size_t SceneCount() const { return benchmarkScenes_.size(); }
    // True after the end of the last scene, when all of the results are written.
    bool Finished() const { return finalStatsReported_ && pendingReports_ == 0; }
    // True after a click on the Exit button of the results page. The application can then stop.
    bool ExitRequested() const { return exitPressed_; }
    const std::vector<SceneResult>& Results() const { return results_; }

    // Give the position of the mouse pointer in pixels of the view, from the upper left.
    void PointerMove(float x, float y);
    // Give a click of the main mouse button at a position in pixels of the view.
    void Click(float x, float y);

    // Go to the start of a benchmark scene. The scene numbers start at 1, and the intro has no
    // number. Scene 0 is the first scene, which is the intro if there is one.
    void JumpToScene(int sceneNumber);
    // Go to the start of the next scene, or to the first scene after the last scene.
    void NextScene();
    void ToggleTerrainRenderMode();

    // Advance the current scene and the ship by animationSeconds, and draw them into colorView.
    // width and height are the size of colorView in pixels. statsSeconds is the real time of the
    // frame, for the benchmark result. It is different from animationSeconds when the target limits
    // the time step or uses a fixed time step.
    void Frame(double animationSeconds, double statsSeconds, const wgpu::TextureView& colorView,
               uint32_t width, uint32_t height);

  private:
    struct SceneStats {
        uint64_t frames = 0;
        double seconds = 0.0;
    };

    struct CameraResult {
        Mat4 viewProjection;
        Vec3 cameraPosition;
    };

    App(const wgpu::Device& device, wgpu::TextureFormat format);
    bool Initialize(GltfModel shipModel, const IntroImages* introImages, std::string& error);

    bool PastEnd() const;
    void JumpToIndex(size_t index);
    CameraResult UpdateCamera(double aspect, std::optional<double> fixedAngle, double lookAhead);
    void Render(const wgpu::CommandEncoder& encoder, const wgpu::TextureView& colorView,
                uint32_t width, uint32_t height, Scene& scene, double fade);
    void DrawResults(const wgpu::TextureView& colorView, uint32_t width, uint32_t height);
    void ReportStats(const Scene& scene);
    void PlaceShip(const Vec3& offset = {0.0, 0.0, 0.0}, const ShipTurn& turn = {});

    wgpu::Device device_;
    wgpu::TextureFormat format_;
    // Null if the device cannot write timestamps. Then the results have no GPU time.
    std::unique_ptr<GpuTimer> gpuTimer_;
    SceneStats stats_;
    // The number of results that wait for their GPU time.
    int pendingReports_ = 0;
    std::unique_ptr<DirectionalLight> sun_;
    // The sun of the scenes that do not have their own sun.
    SceneSun defaultSun_;
    std::unique_ptr<Terrain> terrain_;
    std::unique_ptr<Ship> ship_;
    std::unique_ptr<Fade> fade_;
    std::unique_ptr<Blit> blit_;
    std::unique_ptr<ResultsPage> resultsPage_;
    std::vector<std::unique_ptr<Scene>> scenes_;
    // The scenes of the benchmark: scenes_ with no intro.
    std::vector<Scene*> benchmarkScenes_;
    // The scene draws into this texture. Then a second pass copies it to the output, and screen
    // effects of the scene can read it.
    wgpu::Texture sceneTexture_;
    wgpu::TextureView sceneView_;
    wgpu::Texture depthTexture_;
    // The view of depthTexture_. It is made one time for each depth texture, not in each frame.
    wgpu::TextureView depthView_;
    uint32_t targetWidth_ = 0;
    uint32_t targetHeight_ = 0;
    Scene* currentScene_ = nullptr;
    // The time in seconds since the first frame. The camera path and the scene sequence use it.
    double elapsed_ = 0.0;
    // True after Frame() reports the stats of the last scene at its end.
    bool finalStatsReported_ = false;
    // The result of each scene, in order, for the results page.
    std::vector<SceneResult> results_;
    bool exitPressed_ = false;
};

}  // namespace hackathon
