// Give the content view of a Cocoa window a CAMetalLayer, for a WebGPU surface on macOS.
// From webgpu-test-apps (common/MetalUtils.mm, LunarG).

#import <Cocoa/Cocoa.h>
#import <QuartzCore/CAMetalLayer.h>

extern "C" void* GetMetalLayer(void* nativeWindow) {
    NSWindow* window = (__bridge NSWindow*)nativeWindow;
    NSView* view = [window contentView];
    [view setWantsLayer:YES];
    CAMetalLayer* metalLayer = [CAMetalLayer layer];
    [view setLayer:metalLayer];
    return metalLayer;
}
