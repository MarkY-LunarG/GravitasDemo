// The platform code that the desktop and the browser targets share.

#include "platform/platform.h"

#define GLFW_INCLUDE_NONE
#include <GLFW/glfw3.h>

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <iterator>

namespace hackathon {

namespace {

void OnGlfwError(int code, const char* description) {
    std::fprintf(stderr, "GLFW error %d: %s\n", code, description);
}

template <typename T>
bool Contains(const T* values, size_t count, T value) {
    return std::find(values, values + count, value) != values + count;
}

}  // namespace

std::unique_ptr<Platform> Platform::Create(const char* title, uint32_t width, uint32_t height,
                                           PlatformEvents events) {
    glfwSetErrorCallback(OnGlfwError);
    if (!glfwInit()) {
        ShowMessage("GLFW cannot start");
        return nullptr;
    }

    std::unique_ptr<Platform> platform(new Platform());
    platform->events_ = std::move(events);

    // WebGPU draws into the window, so GLFW must not make an OpenGL or WebGL context.
    glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);
    glfwWindowHint(GLFW_RESIZABLE, GLFW_TRUE);
    platform->window_ =
        glfwCreateWindow(static_cast<int>(width), static_cast<int>(height), title, nullptr, nullptr);
    if (!platform->window_) {
        ShowMessage("GLFW cannot make a window");
        return nullptr;
    }
    glfwSetWindowUserPointer(platform->window_, platform.get());
    glfwSetKeyCallback(platform->window_, OnKey);
    platform->InstallPointerCallbacks();

    platform->instance_ = wgpu::CreateInstance();
    if (!platform->instance_) {
        ShowMessage("WebGPU is not available");
        return nullptr;
    }
    if (!platform->CreateSurface()) {
        return nullptr;
    }
    return platform;
}

Platform::~Platform() {
    // Release the surface before the device in configuration_: the swap chain of the surface uses
    // the device until the surface is unconfigured.
    if (configured_) {
        surface_.Unconfigure();
    }
    surface_ = nullptr;
    configuration_ = {};
    instance_ = nullptr;
    if (window_) {
        glfwDestroyWindow(window_);
    }
    glfwTerminate();
}

bool Platform::ConfigureSurface(const wgpu::Adapter& adapter, const wgpu::Device& device) {
    wgpu::SurfaceCapabilities capabilities;
    if (surface_.GetCapabilities(adapter, &capabilities) != wgpu::Status::Success ||
        capabilities.formatCount == 0) {
        ShowMessage("The surface has no formats for this adapter");
        return false;
    }

    // The browser lists its preferred format first. On the desktop, use an 8-bit format with no
    // sRGB encoding, as the TypeScript desktop target does.
    wgpu::TextureFormat format = capabilities.formats[0];
#ifndef __EMSCRIPTEN__
    if (Contains(capabilities.formats, capabilities.formatCount, wgpu::TextureFormat::BGRA8Unorm)) {
        format = wgpu::TextureFormat::BGRA8Unorm;
    }
#endif

    // Mailbox does not wait for the display refresh, so the frame rate of the benchmark is not
    // limited to the refresh rate, and the image does not tear.
    wgpu::PresentMode presentMode = wgpu::PresentMode::Fifo;
    if (Contains(capabilities.presentModes, capabilities.presentModeCount,
                 wgpu::PresentMode::Mailbox)) {
        presentMode = wgpu::PresentMode::Mailbox;
    } else {
#ifndef __EMSCRIPTEN__
        std::fprintf(stderr,
                     "The mailbox present mode is not available, so the frame rate is limited to "
                     "the display refresh rate.\n");
#endif
    }

    wgpu::CompositeAlphaMode alphaMode = capabilities.alphaModeCount > 0
                                             ? capabilities.alphaModes[0]
                                             : wgpu::CompositeAlphaMode::Auto;
    if (Contains(capabilities.alphaModes, capabilities.alphaModeCount,
                 wgpu::CompositeAlphaMode::Opaque)) {
        alphaMode = wgpu::CompositeAlphaMode::Opaque;
    }

    configuration_ = {
        .device = device,
        .format = format,
        .usage = wgpu::TextureUsage::RenderAttachment,
        .width = 0,
        .height = 0,
        .alphaMode = alphaMode,
        .presentMode = presentMode,
    };
    // AcquireFrame() configures the surface when it knows the size.
    return true;
}

wgpu::TextureView Platform::AcquireFrame(PixelSize& size) {
    size = CurrentPixelSize();
    if (size.width == 0 || size.height == 0 || !configuration_.device) {
        return nullptr;
    }
    if (reconfigure_ || size.width != configuration_.width ||
        size.height != configuration_.height) {
        configuration_.width = size.width;
        configuration_.height = size.height;
        surface_.Configure(&configuration_);
        configured_ = true;
        reconfigure_ = false;
    }

    wgpu::SurfaceTexture surfaceTexture;
    surface_.GetCurrentTexture(&surfaceTexture);
    switch (surfaceTexture.status) {
        case wgpu::SurfaceGetCurrentTextureStatus::SuccessOptimal:
        case wgpu::SurfaceGetCurrentTextureStatus::SuccessSuboptimal:
            return surfaceTexture.texture.CreateView();
        case wgpu::SurfaceGetCurrentTextureStatus::Outdated:
        case wgpu::SurfaceGetCurrentTextureStatus::Lost:
            // Configure the surface again for the next frame.
            reconfigure_ = true;
            return nullptr;
        case wgpu::SurfaceGetCurrentTextureStatus::Timeout:
        case wgpu::SurfaceGetCurrentTextureStatus::Error:
            return nullptr;
    }
    return nullptr;
}

double Platform::NowSeconds() const {
    return glfwGetTime();
}

bool Platform::CloseRequested() const {
    return glfwWindowShouldClose(window_) != 0;
}

bool Platform::ReadAsset(std::string_view path, std::vector<uint8_t>& contents) const {
    const std::string fullPath = AssetDirectory() + std::string(path);
    std::ifstream file(fullPath, std::ios::binary);
    if (!file) {
        ShowMessage("Cannot read " + fullPath);
        return false;
    }
    contents.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    return true;
}

void Platform::OnKey(GLFWwindow* window, int key, int /*scancode*/, int action, int /*mods*/) {
    // Ignore the repeats of a held key.
    if (action != GLFW_PRESS) {
        return;
    }
    auto* platform = static_cast<Platform*>(glfwGetWindowUserPointer(window));
    if (!platform->events_.onKeyDown) {
        return;
    }
    switch (key) {
        case GLFW_KEY_W:
            platform->events_.onKeyDown(Key::W);
            break;
        case GLFW_KEY_N:
            platform->events_.onKeyDown(Key::N);
            break;
        case GLFW_KEY_ESCAPE:
            platform->events_.onKeyDown(Key::Escape);
            break;
        default:
            break;
    }
}

}  // namespace hackathon
