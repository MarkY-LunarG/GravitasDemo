// The results page: after the last scene, a table of the benchmark result of each scene (the
// scene, the total number of frames, and the frames per second), and an Exit button. The table has
// a row for each scene of the benchmark. A scene that did not run (for example, when the benchmark
// starts at a later scene) shows "not run".
//
// The page has its own small font: 5 x 7 pixel glyphs, which a storage buffer holds as bit masks.
// Each text character and each rectangle (the background of a row or the button, or a line) is
// one instance of a quad. The fragment shader of a character tests the bit of its glyph pixel, so
// the text has sharp pixels at an integer scale.

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace hackathon {

// The result of one scene.
struct SceneResult {
    // The scene number, from 1.
    int number;
    std::string name;
    uint64_t frames;
    double seconds;
};

class ResultsPage {
  public:
    ResultsPage(const wgpu::Device& device, wgpu::TextureFormat format);

    // Set the position of the mouse pointer in pixels, for the highlight of the button.
    void SetPointer(float x, float y) { pointer_ = {x, y}; }
    // True if the point (in pixels) is on the Exit button.
    bool IsOnExitButton(double x, double y) const;

    // Draw the page into colorView. width and height are its size in pixels. sceneNames has the
    // names of all of the scenes, in order. results has the result of each scene that ran.
    void Draw(const wgpu::CommandEncoder& encoder, const wgpu::TextureView& colorView,
              uint32_t width, uint32_t height, const std::vector<std::string>& sceneNames,
              const std::vector<SceneResult>& results);

  private:
    using Color = std::array<double, 4>;
    struct Rect {
        double x;
        double y;
        double width;
        double height;
    };

    void Layout(uint32_t width, uint32_t height, const std::vector<std::string>& sceneNames,
                const std::vector<SceneResult>& results);
    void Text(std::string_view text, double x, double y, double scale, const Color& color);
    void AddRect(const Rect& rect, const Color& color);
    void AddQuad(const Rect& rect, const Color& color, uint32_t glyph);

    wgpu::Device device_;
    wgpu::Buffer uniformBuffer_;
    wgpu::Buffer quadBuffer_;
    wgpu::BindGroup bindGroup_;
    wgpu::RenderPipeline pipeline_;
    std::vector<float> quads_;
    size_t quadCount_ = 0;
    // The Exit button in pixels, from the last layout.
    Rect button_ = {0, 0, 0, 0};
    std::array<double, 2> pointer_ = {-1.0, -1.0};
};

}  // namespace hackathon
