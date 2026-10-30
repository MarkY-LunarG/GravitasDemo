// The platform code of the desktop target.

#include "platform/platform.h"

#if defined(_WIN32)
#include <windows.h>
#define GLFW_EXPOSE_NATIVE_WIN32
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#define GLFW_EXPOSE_NATIVE_COCOA
#else
#include <unistd.h>
#if defined(HACKATHON_HAVE_X11)
#define GLFW_EXPOSE_NATIVE_X11
#endif
#if defined(HACKATHON_HAVE_WAYLAND)
#define GLFW_EXPOSE_NATIVE_WAYLAND
#endif
#endif

#define GLFW_INCLUDE_NONE
#include <GLFW/glfw3.h>
// On Linux, this includes <X11/Xlib.h>, which defines macros such as None and Success. Include it
// after webgpu_cpp.h (from platform.h), and keep it in this file only.
#include <GLFW/glfw3native.h>

#include <cstdio>
#include <filesystem>

#if defined(__APPLE__)
extern "C" void* GetMetalLayer(void* nativeWindow);
#endif

namespace hackathon {

bool Platform::CreateSurface() {
    wgpu::SurfaceDescriptor descriptor;
#if defined(_WIN32)
    wgpu::SurfaceSourceWindowsHWND source;
    source.hinstance = GetModuleHandle(nullptr);
    source.hwnd = glfwGetWin32Window(window_);
    descriptor.nextInChain = &source;
    surface_ = instance_.CreateSurface(&descriptor);
#elif defined(__APPLE__)
    wgpu::SurfaceSourceMetalLayer source;
    source.layer = GetMetalLayer(glfwGetCocoaWindow(window_));
    descriptor.nextInChain = &source;
    surface_ = instance_.CreateSurface(&descriptor);
#else
    // GLFW selects X11 or Wayland at run time.
    switch (glfwGetPlatform()) {
#if defined(HACKATHON_HAVE_WAYLAND)
        case GLFW_PLATFORM_WAYLAND: {
            wgpu::SurfaceSourceWaylandSurface source;
            source.display = glfwGetWaylandDisplay();
            source.surface = glfwGetWaylandWindow(window_);
            descriptor.nextInChain = &source;
            surface_ = instance_.CreateSurface(&descriptor);
            break;
        }
#endif
#if defined(HACKATHON_HAVE_X11)
        case GLFW_PLATFORM_X11: {
            wgpu::SurfaceSourceXlibWindow source;
            source.display = glfwGetX11Display();
            source.window = glfwGetX11Window(window_);
            descriptor.nextInChain = &source;
            surface_ = instance_.CreateSurface(&descriptor);
            break;
        }
#endif
        default:
            break;
    }
#endif
    if (!surface_) {
        ShowMessage("Cannot make a WebGPU surface for the window");
        return false;
    }
    return true;
}

void Platform::InstallPointerCallbacks() {
    // GLFW gives the pointer position in window coordinates. The surface has the size of the
    // framebuffer, which is larger on a high-density display.
    glfwSetCursorPosCallback(window_, [](GLFWwindow* window, double x, double y) {
        auto* platform = static_cast<Platform*>(glfwGetWindowUserPointer(window));
        if (!platform->events_.onPointerMove) {
            return;
        }
        int windowWidth = 0;
        int windowHeight = 0;
        int pixelWidth = 0;
        int pixelHeight = 0;
        glfwGetWindowSize(window, &windowWidth, &windowHeight);
        glfwGetFramebufferSize(window, &pixelWidth, &pixelHeight);
        if (windowWidth > 0 && windowHeight > 0) {
            platform->events_.onPointerMove(static_cast<float>(x * pixelWidth / windowWidth),
                                            static_cast<float>(y * pixelHeight / windowHeight));
        }
    });
    glfwSetMouseButtonCallback(window_, [](GLFWwindow* window, int button, int action, int) {
        auto* platform = static_cast<Platform*>(glfwGetWindowUserPointer(window));
        if (button != GLFW_MOUSE_BUTTON_LEFT || action != GLFW_PRESS ||
            !platform->events_.onClick) {
            return;
        }
        double x = 0.0;
        double y = 0.0;
        int windowWidth = 0;
        int windowHeight = 0;
        int pixelWidth = 0;
        int pixelHeight = 0;
        glfwGetCursorPos(window, &x, &y);
        glfwGetWindowSize(window, &windowWidth, &windowHeight);
        glfwGetFramebufferSize(window, &pixelWidth, &pixelHeight);
        if (windowWidth > 0 && windowHeight > 0) {
            platform->events_.onClick(static_cast<float>(x * pixelWidth / windowWidth),
                                      static_cast<float>(y * pixelHeight / windowHeight));
        }
    });
}

PixelSize Platform::CurrentPixelSize() {
    int width = 0;
    int height = 0;
    glfwGetFramebufferSize(window_, &width, &height);
    return {static_cast<uint32_t>(width), static_cast<uint32_t>(height)};
}

void Platform::Present() { surface_.Present(); }

// The assets are in assets/ next to the executable. CMake copies them there after each build.
std::string Platform::AssetDirectory() const {
    std::filesystem::path executable;
#if defined(_WIN32)
    wchar_t buffer[MAX_PATH];
    const DWORD length = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    executable = std::filesystem::path(std::wstring(buffer, length));
#elif defined(__APPLE__)
    char buffer[4096];
    uint32_t size = sizeof(buffer);
    if (_NSGetExecutablePath(buffer, &size) == 0) {
        executable = std::filesystem::canonical(buffer);
    }
#else
    std::error_code error;
    executable = std::filesystem::read_symlink("/proc/self/exe", error);
#endif
    return (executable.parent_path() / "assets").string() + "/";
}

void Platform::ShowMessage(const std::string& message) {
    std::fprintf(stderr, "%s\n", message.c_str());
}

void RunMainLoop(std::function<bool()> frame, std::function<void()> exit) {
    while (true) {
        glfwPollEvents();
        if (!frame()) {
            break;
        }
    }
    exit();
}

std::vector<std::string> OptionArguments(int argc, char** argv) {
    return std::vector<std::string>(argv + 1, argv + argc);
}

}  // namespace hackathon
