#include "app/gpu_timer.h"

#include "shaders.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <cstdio>
#include <cstring>

namespace hackathon {

namespace {

// The total: the time in nanoseconds (low and high 32 bits), the number of measured frames, and
// one unused word.
constexpr uint32_t kTotalWords = 4;

}  // namespace

std::unique_ptr<GpuTimer> GpuTimer::Create(const wgpu::Device& device) {
    if (!device.HasFeature(wgpu::FeatureName::TimestampQuery)) {
        return nullptr;
    }
    return std::unique_ptr<GpuTimer>(new GpuTimer(device));
}

GpuTimer::GpuTimer(const wgpu::Device& device) : device_(device) {
    const wgpu::QuerySetDescriptor querySetDescriptor = {.type = wgpu::QueryType::Timestamp,
                                                         .count = 2};
    querySet_ = device.CreateQuerySet(&querySetDescriptor);
    // The query set gives its own type and count, so the buffer fits the query set.
    if (querySet_.GetType() != wgpu::QueryType::Timestamp) {
        std::fprintf(stderr, "Expected a timestamp query set\n");
    }
    timestampWrites_ = {
        .querySet = querySet_, .beginningOfPassWriteIndex = 0, .endOfPassWriteIndex = 1};
    // Each timestamp is a 64-bit value in nanoseconds.
    timestampBuffer_ = CreateBuffer(device, querySet_.GetCount() * sizeof(uint64_t),
                                    wgpu::BufferUsage::QueryResolve | wgpu::BufferUsage::Storage);
    // A new buffer contains zeros, so the total starts at 0.
    totalBuffer_ = CreateBuffer(
        device, kTotalWords * sizeof(uint32_t),
        wgpu::BufferUsage::Storage | wgpu::BufferUsage::CopySrc | wgpu::BufferUsage::CopyDst);

    WgslConstants constants;
    constants.U32("TOTAL_WORDS", kTotalWords);
    const std::string code = JoinWgsl({constants.Text(), shaders::kGpuTimer});
    const wgpu::ComputePipelineDescriptor pipelineDescriptor = {
        .compute = {.module = CreateShaderModule(device, code, "gpu timer"),
                    .entryPoint = "cs_add"},
    };
    pipeline_ = device.CreateComputePipeline(&pipelineDescriptor);
    const wgpu::BindGroupEntry entries[] = {
        {.binding = 0, .buffer = timestampBuffer_},
        {.binding = 1, .buffer = totalBuffer_},
    };
    const wgpu::BindGroupDescriptor bindGroupDescriptor = {
        .layout = pipeline_.GetBindGroupLayout(0), .entryCount = 2, .entries = entries};
    bindGroup_ = device.CreateBindGroup(&bindGroupDescriptor);
}

void GpuTimer::Resolve(const wgpu::CommandEncoder& encoder) const {
    encoder.ResolveQuerySet(querySet_, 0, querySet_.GetCount(), timestampBuffer_, 0);
    const wgpu::ComputePassEncoder pass = encoder.BeginComputePass();
    pass.SetPipeline(pipeline_);
    pass.SetBindGroup(0, bindGroup_);
    pass.DispatchWorkgroups(1);
    pass.End();
}

void GpuTimer::DiscardTotal() const {
    const wgpu::CommandEncoder encoder = device_.CreateCommandEncoder();
    encoder.ClearBuffer(totalBuffer_);
    const wgpu::CommandBuffer commands = encoder.Finish();
    device_.GetQueue().Submit(1, &commands);
}

void GpuTimer::ReadTotal(std::function<void(double, uint32_t)> onTotal) {
    wgpu::Buffer buffer;
    if (!readState_->freeBuffers.empty()) {
        buffer = std::move(readState_->freeBuffers.back());
        readState_->freeBuffers.pop_back();
    } else {
        buffer = CreateBuffer(device_, totalBuffer_.GetSize(),
                              wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead);
    }
    const wgpu::CommandEncoder encoder = device_.CreateCommandEncoder();
    encoder.CopyBufferToBuffer(totalBuffer_, 0, buffer, 0, buffer.GetSize());
    encoder.ClearBuffer(totalBuffer_);
    const wgpu::CommandBuffer commands = encoder.Finish();
    device_.GetQueue().Submit(1, &commands);

    buffer.MapAsync(
        wgpu::MapMode::Read, 0, buffer.GetSize(), wgpu::CallbackMode::AllowProcessEvents,
        [state = readState_, buffer, onTotal = std::move(onTotal)](wgpu::MapAsyncStatus status,
                                                                   wgpu::StringView) {
            // The instance cancels the callback when it is released. Then the App is gone, so do
            // nothing.
            if (status == wgpu::MapAsyncStatus::CallbackCancelled) {
                return;
            }
            if (status != wgpu::MapAsyncStatus::Success) {
                state->freeBuffers.push_back(buffer);
                onTotal(0.0, 0);
                return;
            }
            uint32_t total[kTotalWords];
            std::memcpy(total, buffer.GetConstMappedRange(0, sizeof(total)), sizeof(total));
            buffer.Unmap();
            state->freeBuffers.push_back(buffer);
            onTotal((total[1] * 4294967296.0 + total[0]) / 1e6, total[2]);
        });
}

}  // namespace hackathon
