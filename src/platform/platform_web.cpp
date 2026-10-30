// The platform code of the browser target.

#include "platform/platform.h"

#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

#define GLFW_INCLUDE_NONE
#include <GLFW/glfw3.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <sstream>

namespace hackathon {

namespace {

constexpr const char* kCanvas = "#canvas";

// The size of the canvas in device pixels: its CSS size times the device pixel ratio, so that the
// image is sharp on a high-density display.
PixelSize CanvasTargetSize() {
    double cssWidth = 0.0;
    double cssHeight = 0.0;
    emscripten_get_element_css_size(kCanvas, &cssWidth, &cssHeight);
    const double ratio = emscripten_get_device_pixel_ratio();
    return {static_cast<uint32_t>(std::max(1.0, std::round(cssWidth * ratio))),
            static_cast<uint32_t>(std::max(1.0, std::round(cssHeight * ratio)))};
}

// Convert a position in CSS pixels of the canvas to pixels of the surface.
void CssToPixels(double cssX, double cssY, float& x, float& y) {
    double cssWidth = 0.0;
    double cssHeight = 0.0;
    int pixelWidth = 0;
    int pixelHeight = 0;
    emscripten_get_element_css_size(kCanvas, &cssWidth, &cssHeight);
    emscripten_get_canvas_element_size(kCanvas, &pixelWidth, &pixelHeight);
    x = cssWidth > 0.0 ? static_cast<float>(cssX * pixelWidth / cssWidth) : 0.0f;
    y = cssHeight > 0.0 ? static_cast<float>(cssY * pixelHeight / cssHeight) : 0.0f;
}

struct MainLoop {
    std::function<bool()> frame;
    std::function<void()> exit;
};

MainLoop& GetMainLoop() {
    static MainLoop mainLoop;
    return mainLoop;
}

void RunFrame() {
    MainLoop& mainLoop = GetMainLoop();
    if (mainLoop.frame()) {
        return;
    }
    emscripten_cancel_main_loop();
    // Move the functions out first: exit() can release the objects that frame() uses.
    std::function<void()> exit = std::move(mainLoop.exit);
    mainLoop = {};
    exit();
}

}  // namespace

bool Platform::CreateSurface() {
    // glfwCreateWindow() can give the canvas a fixed CSS size. The page sets the CSS size, and
    // CurrentPixelSize() sets the size in pixels.
    EM_ASM({
        const canvas = document.querySelector(UTF8ToString($0));
        canvas.style.removeProperty('width');
        canvas.style.removeProperty('height');
    }, kCanvas);

    wgpu::EmscriptenSurfaceSourceCanvasHTMLSelector source;
    source.selector = kCanvas;
    wgpu::SurfaceDescriptor descriptor;
    descriptor.nextInChain = &source;
    surface_ = instance_.CreateSurface(&descriptor);
    if (!surface_) {
        ShowMessage("Cannot make a WebGPU surface for the canvas");
        return false;
    }
    return true;
}

void Platform::InstallPointerCallbacks() {
    // The HTML5 events give the position in CSS pixels of the canvas, which converts exactly to
    // pixels of the surface. GLFW still handles the keys.
    emscripten_set_mousemove_callback(
        kCanvas, this, false, [](int, const EmscriptenMouseEvent* event, void* userData) -> bool {
            auto* platform = static_cast<Platform*>(userData);
            if (platform->events_.onPointerMove) {
                float x = 0.0f;
                float y = 0.0f;
                CssToPixels(event->targetX, event->targetY, x, y);
                platform->events_.onPointerMove(x, y);
            }
            return false;
        });
    emscripten_set_mousedown_callback(
        kCanvas, this, false, [](int, const EmscriptenMouseEvent* event, void* userData) -> bool {
            auto* platform = static_cast<Platform*>(userData);
            if (event->button == 0 && platform->events_.onClick) {
                float x = 0.0f;
                float y = 0.0f;
                CssToPixels(event->targetX, event->targetY, x, y);
                platform->events_.onClick(x, y);
            }
            return false;
        });
}

PixelSize Platform::CurrentPixelSize() {
    const PixelSize target = CanvasTargetSize();
    int width = 0;
    int height = 0;
    emscripten_get_canvas_element_size(kCanvas, &width, &height);
    if (static_cast<uint32_t>(width) != target.width ||
        static_cast<uint32_t>(height) != target.height) {
        emscripten_set_canvas_element_size(kCanvas, static_cast<int>(target.width),
                                           static_cast<int>(target.height));
    }
    return target;
}

void Platform::Present() {
    // The browser shows the canvas after each requestAnimationFrame callback.
    // wgpuSurfacePresent is not available in the browser.
}

// --preload-file puts the assets in /assets of the virtual file system.
std::string Platform::AssetDirectory() const {
    return "/assets/";
}

void Platform::ShowMessage(const std::string& message) {
    std::fprintf(stderr, "%s\n", message.c_str());
    EM_ASM({
        const element = document.getElementById('error');
        if (element) {
            element.textContent = UTF8ToString($0);
            element.hidden = false;
        }
    }, message.c_str());
}

void RunMainLoop(std::function<bool()> frame, std::function<void()> exit) {
    GetMainLoop() = {std::move(frame), std::move(exit)};
    // A frame rate of 0 uses requestAnimationFrame. With no simulated infinite loop, this returns,
    // and main() can return.
    emscripten_set_main_loop(RunFrame, 0, false);
}

std::vector<std::string> OptionArguments(int /*argc*/, char** /*argv*/) {
    // "?scene=3&exitOnFinish" becomes "--scene=3" and "--exit-on-finish": a capital letter in a
    // name becomes "-" and the lowercase letter.
    const char* query = emscripten_run_script_string(
        "new URLSearchParams(location.search).toString()");
    std::vector<std::string> arguments;
    std::stringstream stream(query ? query : "");
    std::string item;
    while (std::getline(stream, item, '&')) {
        if (item.empty()) {
            continue;
        }
        const size_t equals = item.find('=');
        const std::string name = item.substr(0, equals);
        std::string value = equals == std::string::npos ? "" : item.substr(equals + 1);
        std::string argument = "--";
        for (char c : name) {
            if (c >= 'A' && c <= 'Z') {
                argument += '-';
                argument += static_cast<char>(c - 'A' + 'a');
            } else {
                argument += c;
            }
        }
        // URLSearchParams gives "name=" for a name with no value.
        if (!value.empty()) {
            argument += "=" + value;
        }
        arguments.push_back(argument);
    }
    return arguments;
}

}  // namespace hackathon
