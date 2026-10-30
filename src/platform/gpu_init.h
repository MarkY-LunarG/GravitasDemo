// Get the WebGPU adapter and device with no blocking call. The callbacks use
// CallbackMode::AllowProcessEvents, so they run only inside Instance::ProcessEvents(), on the
// thread of the main loop. Call ProcessEvents() one time in each loop pass until the state is
// Ready or Failed.

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <memory>
#include <string>

namespace hackathon {

class GpuInit {
  public:
    enum class State { RequestingAdapter, RequestingDevice, Ready, Failed };

    GpuInit(const wgpu::Instance& instance, const wgpu::Surface& surface);

    State GetState() const { return shared_->state; }
    const std::string& Error() const { return shared_->error; }
    const wgpu::Adapter& Adapter() const { return shared_->adapter; }
    const wgpu::Device& Device() const { return shared_->device; }

  private:
    // The callbacks keep the state alive. A callback can run after this object is destroyed: the
    // instance cancels the callbacks that are not complete when it is released.
    struct Shared {
        State state = State::RequestingAdapter;
        std::string error;
        wgpu::Adapter adapter;
        wgpu::Device device;
    };

    static void RequestDevice(const std::shared_ptr<Shared>& shared);

    std::shared_ptr<Shared> shared_;
};

// True after the device is lost for a reason other than its release. The device lost callback and
// the uncaptured error callback write only this flag and stderr, so they are safe on any thread.
bool DeviceLost();

}  // namespace hackathon
