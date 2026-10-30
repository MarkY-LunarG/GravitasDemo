// The entry point of both targets: read the options, make the window and the WebGPU device, and
// run the frames of the App. platform/ has the code that is different for the desktop and the
// browser.

#include "app/app.h"
#include "platform/gpu_init.h"
#include "platform/options.h"
#include "platform/platform.h"

#include <cstdio>
#include <memory>

namespace hackathon {
namespace {

constexpr uint32_t kWidth = 1920;
constexpr uint32_t kHeight = 1080;
constexpr const char* kShipModel = "lunarg-ship/lunarg_ship.glb";

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
        platform_ = Platform::Create("WebGPU Hackathon", kWidth, kHeight, std::move(events));
        if (!platform_) {
            return false;
        }

        // Milestone 1 reads one asset, to check the asset copy on the desktop and the preload in
        // the browser.
        std::vector<uint8_t> model;
        if (!platform_->ReadAsset(kShipModel, model)) {
            return false;
        }
        std::printf("Read %s: %zu bytes\n", kShipModel, model.size());

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
        const double seconds = options_.fixedStep > 0.0 ? options_.fixedStep : now - previousTime_;
        previousTime_ = now;

        PixelSize size;
        const wgpu::TextureView view = platform_->AcquireFrame(size);
        if (!view) {
            return true;
        }
        app_->Frame(seconds, view, size.width, size.height);
        platform_->Present();

        ++frameCount_;
        return options_.frames == 0 || frameCount_ < options_.frames;
    }

  private:
    bool StartApp() {
        if (!platform_->ConfigureSurface(gpu_->Adapter(), gpu_->Device())) {
            return false;
        }
        app_ = std::make_unique<App>(gpu_->Device(), platform_->SurfaceFormat());
        previousTime_ = platform_->NowSeconds();
        return true;
    }

    void OnKey(Key key) {
#ifndef __EMSCRIPTEN__
        if (key == Key::Escape) {
            std::printf("Esc pressed.\n");
            exitRequested_ = true;
        }
#else
        (void)key;
#endif
    }

    Options options_;
    std::unique_ptr<Platform> platform_;
    std::unique_ptr<GpuInit> gpu_;
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
                    std::printf("The benchmark has stopped.\n");
                    program.reset();
                });
    return 0;
}
