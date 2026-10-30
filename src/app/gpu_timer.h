// GPU time of a render pass, from timestamp queries. The device must have the timestamp-query
// feature. The pass writes a timestamp at its start and at its end.
//
// The CPU does not read the timestamps of each frame. After each frame, a small compute pass adds
// the time of the frame to a total on the GPU, so the total has all of the frames. ReadTotal()
// reads the total one time, for example at the end of a scene, and starts a new total. The CPU
// does not wait for the GPU.

#pragma once

#include <webgpu/webgpu_cpp.h>

#include <functional>
#include <memory>
#include <vector>

namespace hackathon {

class GpuTimer {
  public:
    // Make a timer, or return null if the device cannot write timestamps.
    static std::unique_ptr<GpuTimer> Create(const wgpu::Device& device);

    // The timestampWrites of the render pass descriptor.
    const wgpu::PassTimestampWrites* TimestampWrites() const { return &timestampWrites_; }

    // Add the time of the pass to the total. Call this after the pass, before the command buffer is
    // finished.
    void Resolve(const wgpu::CommandEncoder& encoder) const;

    // Start a new total, and do not read the total of the frames that are submitted after the
    // previous call.
    void DiscardTotal() const;

    // Read the total of the frames that are submitted after the previous call, and start a new
    // total. onTotal gets the GPU time in milliseconds and the number of measured frames, after the
    // GPU completes these frames. It runs in Instance::ProcessEvents(). It does not run if the
    // instance is released first.
    void ReadTotal(std::function<void(double milliseconds, uint32_t frames)> onTotal);

  private:
    explicit GpuTimer(const wgpu::Device& device);

    // The callback of a read can come after the GpuTimer is destroyed, so the free buffers are in
    // a state that the callback also owns.
    struct ReadState {
        // Read-back buffers that are not mapped or waiting for a map.
        std::vector<wgpu::Buffer> freeBuffers;
    };

    wgpu::Device device_;
    wgpu::QuerySet querySet_;
    wgpu::PassTimestampWrites timestampWrites_;
    wgpu::Buffer timestampBuffer_;
    wgpu::Buffer totalBuffer_;
    wgpu::ComputePipeline pipeline_;
    wgpu::BindGroup bindGroup_;
    std::shared_ptr<ReadState> readState_ = std::make_shared<ReadState>();
};

}  // namespace hackathon
