// The entry point of both targets: read the options, make the window and the WebGPU device, and
// run the frames of the App. platform/ has the code that is different for the desktop and the
// browser.

#include "app/app.h"
#include "platform/gpu_init.h"
#include "platform/options.h"
#include "platform/platform.h"
#include "util/screenshot.h"

#include <stb_image.h>

#include <algorithm>
#include <cstdio>
#include <memory>
#include <string>

namespace hackathon {
namespace {

constexpr uint32_t kWidth = 1920;
constexpr uint32_t kHeight = 1080;
constexpr const char* kShipModel = "lunarg-ship/lunarg_ship.glb";
#ifdef __EMSCRIPTEN__
// A frame can come after a long pause, for example when the tab was hidden. Limit the time step of
// the animation, so that it does not jump. The benchmark result uses the real time.
constexpr double kMaxAnimationStep = 0.1;
#endif

// All objects of a run. The main loop owns it, because in the browser main() returns before the
// first frame. The members are released in reverse order: the App, the device, and then the
// surface, the instance, and the window.
class Program {
  public:
    explicit Program(const Options& options) : options_(options) {}

    bool Start() {
        PlatformEvents events;
        events.onKeyDown = [this](Key key) { OnKey(key); };
        events.onPointerMove = [this](float x, float y) {
            if (app_) {
                app_->PointerMove(x, y);
            }
        };
        events.onClick = [this](float x, float y) {
            if (app_) {
                app_->Click(x, y);
            }
        };
        platform_ = Platform::Create("Gravitas Demo", kWidth, kHeight, std::move(events));
        if (!platform_) {
            return false;
        }

        std::vector<uint8_t> modelFile;
        std::string error;
        if (!platform_->ReadAsset(kShipModel, modelFile)) {
            return false;
        }
        if (!ParseGlb(modelFile, shipModel_, error)) {
            Platform::ShowMessage(std::string(kShipModel) + ": " + error);
            return false;
        }
        if (!ReadImage(kIntroColorLogoFile, introImages_.colorLogo) ||
            !ReadImage(kIntroNeonFile, introImages_.neon) ||
            !ReadImage(kIntroNeonTubeFile, introImages_.neonTube)) {
            return false;
        }

        gpu_ = std::make_unique<GpuInit>(platform_->Instance(), platform_->Surface());
        return true;
    }

    // One pass of the main loop. Returns false to stop.
    bool Frame() {
        // Run the WebGPU callbacks that are ready, on this thread.
        platform_->Instance().ProcessEvents();
        if (exitRequested_ || platform_->CloseRequested()) {
            return false;
        }
        if (DeviceLost()) {
            Platform::ShowMessage("The WebGPU device is lost, so the benchmark has stopped.");
            return false;
        }

        switch (gpu_->GetState()) {
            case GpuInit::State::RequestingAdapter:
            case GpuInit::State::RequestingDevice:
                return true;
            case GpuInit::State::Failed:
                Platform::ShowMessage(gpu_->Error());
                return false;
            case GpuInit::State::Ready:
                break;
        }
        if (!app_ && !StartApp()) {
            return false;
        }

        const double now = platform_->NowSeconds();
        const double realSeconds = now - previousTime_;
        previousTime_ = now;
        double animationSeconds = options_.fixedStep > 0.0 ? options_.fixedStep : realSeconds;
#ifdef __EMSCRIPTEN__
        animationSeconds = std::min(animationSeconds, kMaxAnimationStep);
#endif

        PixelSize size;
        const wgpu::TextureView view = platform_->AcquireFrame(size);
        if (!view) {
            return true;
        }
        app_->Frame(animationSeconds, realSeconds, view, size.width, size.height);
        ++frameCount_;
        if (std::find(options_.screenshotFrames.begin(), options_.screenshotFrames.end(),
                      frameCount_) != options_.screenshotFrames.end()) {
            screenshot_.Capture(gpu_->Device(), platform_->CurrentTexture(),
                                "screenshot_" + std::to_string(frameCount_) + ".png");
        }
        platform_->Present();

        if (app_->ExitRequested() || (options_.exitOnFinish && app_->Finished())) {
            return false;
        }
        // Continue until the screenshots are written, also after the last frame.
        return options_.frames == 0 || frameCount_ < options_.frames || screenshot_.Pending();
    }

  private:
    bool StartApp() {
        if (!platform_->ConfigureSurface(gpu_->Adapter(), gpu_->Device(),
                                         !options_.screenshotFrames.empty())) {
            return false;
        }
        std::string error;
        app_ = App::Create(gpu_->Device(), platform_->SurfaceFormat(), std::move(shipModel_),
                           &introImages_, error);
        // The App has made its textures, so the image data is not necessary any more.
        introImages_ = {};
        if (!app_) {
            Platform::ShowMessage(error);
            return false;
        }
        app_->JumpToScene(options_.scene);
        previousTime_ = platform_->NowSeconds();
        return true;
    }

    // Read and decode a PNG image below assets/ to RGBA, with no premultiplied alpha.
    bool ReadImage(const char* path, RgbaImage& image) const {
        std::vector<uint8_t> file;
        if (!platform_->ReadAsset(path, file)) {
            return false;
        }
        int width = 0;
        int height = 0;
        int channels = 0;
        stbi_uc* pixels = stbi_load_from_memory(file.data(), static_cast<int>(file.size()), &width,
                                                &height, &channels, 4);
        if (!pixels) {
            Platform::ShowMessage(std::string("Cannot decode ") + path + ": " +
                                  stbi_failure_reason());
            return false;
        }
        image.width = static_cast<uint32_t>(width);
        image.height = static_cast<uint32_t>(height);
        image.data.assign(pixels, pixels + size_t{image.width} * image.height * 4);
        stbi_image_free(pixels);
        return true;
    }

    void OnKey(Key key) {
        switch (key) {
            case Key::Escape:
                // The browser target has no Esc key: a page does not close itself.
#ifndef __EMSCRIPTEN__
                std::printf("Esc pressed.\n");
                exitRequested_ = true;
#endif
                break;
            case Key::W:
                if (app_) {
                    app_->ToggleTerrainRenderMode();
                }
                break;
            case Key::N:
                if (app_) {
                    app_->NextScene();
                }
                break;
        }
    }

    Options options_;
    std::unique_ptr<Platform> platform_;
    std::unique_ptr<GpuInit> gpu_;
    Screenshot screenshot_;
    // The ship model, from Start() until the App takes it.
    GltfModel shipModel_;
    IntroImages introImages_;
    std::unique_ptr<App> app_;
    double previousTime_ = 0.0;
    uint64_t frameCount_ = 0;
    bool exitRequested_ = false;
};

}  // namespace
}  // namespace hackathon

int main(int argc, char** argv) {
    using namespace hackathon;

    // Write each log line at once, also when stdout is a pipe or a file.
    std::setvbuf(stdout, nullptr, _IOLBF, 0);

    Options options;
    std::string error;
    if (!ParseOptions(OptionArguments(argc, argv), options, error)) {
        Platform::ShowMessage(error);
        return 1;
    }

    auto program = std::make_shared<Program>(options);
    if (!program->Start()) {
        return 1;
    }
    RunMainLoop([program] { return program->Frame(); },
                [program]() mutable {
#ifdef __EMSCRIPTEN__
                    // A page cannot close itself, so tell the user.
                    Platform::ShowMessage("The benchmark has stopped. You can close this page.");
#else
                    std::printf("The benchmark has stopped.\n");
#endif
                    program.reset();
                });
    return 0;
}
