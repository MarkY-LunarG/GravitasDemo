// The benchmark application. It draws one frame into a texture view of the surface. It does not
// know about the window or the target.
//
// Milestone 1 of the port: the frame is only a clear, with a color that changes over time, so
// that a capture and its replay show different frames.

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstdint>

namespace hackathon {

class App {
  public:
    // format is the format of the texture views that Frame() draws into.
    App(const wgpu::Device& device, wgpu::TextureFormat format);

    // Advance the animation by a time step in seconds, and draw into colorView. width and height
    // are the size of colorView in pixels.
    void Frame(double seconds, const wgpu::TextureView& colorView, uint32_t width, uint32_t height);

    void PointerMove(float x, float y);
    void Click(float x, float y);

  private:
    wgpu::Device device_;
    double elapsed_ = 0.0;
};

}  // namespace hackathon
