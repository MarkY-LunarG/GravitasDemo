// The LunarG logo of the intro scene: the color logo, the neon logo, and the neon tube logo, all on
// black, which are images in assets/textures/. One full-screen triangle draws the logo. The shader
// mixes the three images, and sets the brightness of each neon tube for the flicker.
//
// The two neon images have the same size (kLogoSize), and the letters are at the same positions.
// The color logo has the same letter size, at kColorLogoOffset in the neon images. The page
// coordinates of the logo are the pixels of the neon images.

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <array>
#include <cstdint>
#include <vector>

namespace hackathon {

// An image with 4 bytes for each pixel and no premultiplied alpha.
struct RgbaImage {
    uint32_t width = 0;
    uint32_t height = 0;
    std::vector<uint8_t> data;
};

// The images of the intro.
struct IntroImages {
    // 2025-LunarG-Color-Logo-with-tagline.png
    RgbaImage colorLogo;
    // LunarG-Logo-Neon-Transparent.png
    RgbaImage neon;
    // LunarG-Logo-NeonTube-Transparent.png
    RgbaImage neonTube;
};

// The file names of the images, below assets/.
inline constexpr const char* kIntroColorLogoFile =
    "textures/2025-LunarG-Color-Logo-with-tagline.png";
inline constexpr const char* kIntroNeonFile = "textures/LunarG-Logo-Neon-Transparent.png";
inline constexpr const char* kIntroNeonTubeFile = "textures/LunarG-Logo-NeonTube-Transparent.png";

// The G of the neon tube image in logo pixels: its center and its height.
inline constexpr std::array<double, 2> kGCenter = {1355.0, 448.0};
inline constexpr double kGHeight = 282.0;

// The tubes that flicker: L, U, N, A, R, the bracket, G, the dot, and the tagline. The shader
// finds the tube of a pixel from its logo position.
inline constexpr size_t kTubeCount = 9;
inline constexpr size_t kGTube = 6;

// The logo state of a frame.
struct LogoState {
    // 0: the color logo. 1: the neon logo.
    double colorToNeon;
    // 0: the neon logo. 1: the neon tube logo.
    double neonToTube;
    // A multiplier of the neon colors, for example above 1 for a brighter logo.
    double brightness;
    // A multiplier of the glow around the tubes.
    double panel;
    // The brightness of each tube, from 0 (off) to 1 (on).
    std::array<double, kTubeCount> tubes;
    // The amount of a white flash over the whole screen.
    double flash;
};

class IntroLogo {
  public:
    // format is the color format of the main pass. The logo does not use the depth buffer, but the
    // pipeline must match the pass.
    IntroLogo(const wgpu::Device& device, wgpu::TextureFormat format,
              wgpu::TextureFormat depthFormat, const IntroImages& images);

    // Set the state of the frame. width and height are the size of the view in pixels.
    void Update(const LogoState& state, uint32_t width, uint32_t height);
    // The screen position in pixels of a logo position (pixels of the neon images), from the last
    // Update().
    std::array<double, 2> ToScreen(double x, double y) const;
    // The screen pixels for each logo pixel, from the last Update().
    double ScreenScale() const { return scale_; }
    void Draw(const wgpu::RenderPassEncoder& pass) const;

  private:
    wgpu::Device device_;
    wgpu::Buffer uniformBuffer_;
    wgpu::BindGroup bindGroup_;
    wgpu::RenderPipeline pipeline_;
    std::array<float, 24> uniforms_ = {};
    // The logo position on the screen, from the last Update().
    std::array<double, 2> origin_ = {0.0, 0.0};
    double scale_ = 1.0;
};

}  // namespace hackathon
