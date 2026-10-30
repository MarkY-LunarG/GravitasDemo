// Write the image of a texture to a PNG file. The texture must have the CopySrc usage and an 8-bit
// RGBA or BGRA format. The copy is asynchronous: the file is written in a later
// Instance::ProcessEvents() call.

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <memory>
#include <string>

namespace hackathon {

class Screenshot {
  public:
    // Copy the texture now, in a command buffer after the commands that are already submitted.
    void Capture(const wgpu::Device& device, const wgpu::Texture& texture, const std::string& path);

    // True from Capture() until the file is written, or the write fails.
    bool Pending() const { return state_->pending; }

  private:
    struct State {
        bool pending = false;
    };
    std::shared_ptr<State> state_ = std::make_shared<State>();
};

}  // namespace hackathon
