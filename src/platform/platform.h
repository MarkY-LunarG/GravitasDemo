// The only interface between the application and the platform: the window, the WebGPU instance and
// surface, input, time, asset files, and the main loop. platform_glfw.cpp has the code that both
// targets share. platform_native.cpp and platform_web.cpp have the code of one target.

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

struct GLFWwindow;

namespace hackathon {

enum class Key { W, N, Escape };

struct PixelSize {
    uint32_t width = 0;
    uint32_t height = 0;

    bool operator==(const PixelSize&) const = default;
};

// The positions are in pixels of the surface, from the upper left.
struct PlatformEvents {
    std::function<void(Key)> onKeyDown;
    std::function<void(float x, float y)> onPointerMove;
    std::function<void(float x, float y)> onClick;
};

class Platform {
  public:
    // Make the window, the WebGPU instance, and the surface. Returns null after an error, which it
    // writes with ShowMessage().
    static std::unique_ptr<Platform> Create(const char* title, uint32_t width, uint32_t height,
                                            PlatformEvents events);
    ~Platform();
    Platform(const Platform&) = delete;
    Platform& operator=(const Platform&) = delete;

    const wgpu::Instance& Instance() const { return instance_; }
    const wgpu::Surface& Surface() const { return surface_; }

    // Configure the surface for a device. Selects the format, the present mode (mailbox if the
    // surface supports it), and the alpha mode. With copySource, the surface textures can also be
    // copied, for screenshots.
    bool ConfigureSurface(const wgpu::Adapter& adapter, const wgpu::Device& device,
                          bool copySource);
    wgpu::TextureFormat SurfaceFormat() const { return configuration_.format; }

    // Get a view of the surface texture of the next frame, and its size. Returns null when no frame
    // can be drawn now, for example when the window is minimized. Configures the surface again when
    // its size changes.
    wgpu::TextureView AcquireFrame(PixelSize& size);
    // The texture of the last AcquireFrame().
    const wgpu::Texture& CurrentTexture() const { return currentTexture_; }
    // Show the frame of the last AcquireFrame(). The browser shows it without a call.
    void Present();

    double NowSeconds() const;
    bool CloseRequested() const;

    // Read a file below assets/. Returns false and writes an error if the file cannot be read.
    bool ReadAsset(std::string_view path, std::vector<uint8_t>& contents) const;

    // Show a message to the user: on the page in the browser, and on stderr on the desktop.
    static void ShowMessage(const std::string& message);

  private:
    Platform() = default;

    // Implemented separately for each target.
    bool CreateSurface();
    void InstallPointerCallbacks();
    PixelSize CurrentPixelSize();
    std::string AssetDirectory() const;

    static void OnKey(GLFWwindow* window, int key, int scancode, int action, int mods);

    GLFWwindow* window_ = nullptr;
    PlatformEvents events_;
    wgpu::Instance instance_;
    wgpu::Surface surface_;
    wgpu::SurfaceConfiguration configuration_ = {};
    wgpu::Texture currentTexture_;
    // True while the surface is configured. The surface must be unconfigured before release.
    bool configured_ = false;
    // True when the next AcquireFrame() must configure the surface again, for example after an
    // outdated surface texture.
    bool reconfigure_ = true;
};

// Call frame() one time for each display frame until it returns false, then call exit() one time.
// On the desktop, this returns after exit(). In the browser, this returns before the first frame,
// and the browser calls frame() from requestAnimationFrame, so the objects that frame() uses must
// not be on the stack of the caller.
void RunMainLoop(std::function<bool()> frame, std::function<void()> exit);

// The options of the run, as "--name=value" strings: the command-line arguments on the desktop,
// and the URL query in the browser ("?scene=3&exitOnFinish" gives "--scene=3", "--exit-on-finish").
std::vector<std::string> OptionArguments(int argc, char** argv);

}  // namespace hackathon
