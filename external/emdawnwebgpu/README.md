# Vendored emdawnwebgpu port

`emdawnwebgpu.remoteport.py` pins the version of emdawnwebgpu that the browser target links
against.
Emdawnwebgpu is the Dawn implementation of `webgpu.h` for Emscripten, on top of the WebGPU API of
the browser.

The file is a copy of `external/emdawnwebgpu/emdawnwebgpu.remoteport.py` in Premium-GFXR.
It is from Dawn `01940842b667a7812d0e4ca0ef4367fbec294241`.

Emscripten has its own copy of this file, so `--use-port=emdawnwebgpu` also works.
But that copy changes when emsdk changes.
The vendored copy makes a change of the WebGPU implementation a reviewed change in this
repository.

To update, copy the file again from Premium-GFXR, so that both repositories use the same version.
