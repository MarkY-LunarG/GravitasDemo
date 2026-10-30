#include "platform/gpu_init.h"

#include <atomic>
#include <cstdio>
#include <string_view>

namespace hackathon {

namespace {

std::atomic<bool> gDeviceLost = false;

std::string ToString(wgpu::StringView message) {
    return std::string(std::string_view(message));
}

}  // namespace

bool DeviceLost() {
    return gDeviceLost.load();
}

GpuInit::GpuInit(const wgpu::Instance& instance, const wgpu::Surface& surface)
    : shared_(std::make_shared<Shared>()) {
    wgpu::RequestAdapterOptions options;
    options.compatibleSurface = surface;
    options.powerPreference = wgpu::PowerPreference::HighPerformance;
    instance.RequestAdapter(
        &options, wgpu::CallbackMode::AllowProcessEvents,
        [shared = shared_](wgpu::RequestAdapterStatus status, wgpu::Adapter adapter,
                           wgpu::StringView message) {
            if (status != wgpu::RequestAdapterStatus::Success || !adapter) {
                shared->error = "No WebGPU adapter is available: " + ToString(message);
                shared->state = State::Failed;
                return;
            }
            shared->adapter = std::move(adapter);
            shared->state = State::RequestingDevice;
            RequestDevice(shared);
        });
}

void GpuInit::RequestDevice(const std::shared_ptr<Shared>& shared) {
    // The benchmark measures the GPU time of each frame when the adapter can write timestamps.
    const wgpu::FeatureName timestampQuery = wgpu::FeatureName::TimestampQuery;
    wgpu::DeviceDescriptor descriptor;
    if (shared->adapter.HasFeature(timestampQuery)) {
        descriptor.requiredFeatureCount = 1;
        descriptor.requiredFeatures = &timestampQuery;
    }
    descriptor.SetDeviceLostCallback(
        wgpu::CallbackMode::AllowProcessEvents,
        [](const wgpu::Device&, wgpu::DeviceLostReason reason, wgpu::StringView message) {
            // The release of the device and the release of the instance are not errors.
            if (reason == wgpu::DeviceLostReason::Destroyed ||
                reason == wgpu::DeviceLostReason::CallbackCancelled) {
                return;
            }
            gDeviceLost = true;
            std::fprintf(stderr, "WebGPU device lost: %s\n", ToString(message).c_str());
        });
    descriptor.SetUncapturedErrorCallback(
        [](const wgpu::Device&, wgpu::ErrorType, wgpu::StringView message) {
            std::fprintf(stderr, "WebGPU error: %s\n", ToString(message).c_str());
        });

    shared->adapter.RequestDevice(
        &descriptor, wgpu::CallbackMode::AllowProcessEvents,
        [shared](wgpu::RequestDeviceStatus status, wgpu::Device device, wgpu::StringView message) {
            if (status != wgpu::RequestDeviceStatus::Success || !device) {
                shared->error = "Cannot make a WebGPU device: " + ToString(message);
                shared->state = State::Failed;
                return;
            }
            shared->device = std::move(device);
            shared->state = State::Ready;
        });
}

}  // namespace hackathon
