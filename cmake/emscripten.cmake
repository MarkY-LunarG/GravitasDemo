# The settings of the browser target. The Emscripten toolchain file sets EMSCRIPTEN.

# wasm64 is the default. The emscripten-wasm32-* presets set this to OFF for browsers with no
# Memory64.
option(HACKATHON_WASM64 "Build a wasm64 (Memory64) module" ON)

# The vendored port file pins the version of emdawnwebgpu. The file is a copy of the one in
# Premium-GFXR (external/emdawnwebgpu), so that an emsdk update cannot change it.
set(HACKATHON_EMDAWNWEBGPU_PORT
    "${CMAKE_CURRENT_LIST_DIR}/../external/emdawnwebgpu/emdawnwebgpu.remoteport.py")

function(hackathon_configure_web_target target)
    set(flags "--use-port=${HACKATHON_EMDAWNWEBGPU_PORT}")
    if (HACKATHON_WASM64)
        list(APPEND flags -sMEMORY64=1)
    endif()
    target_compile_options(${target} PRIVATE ${flags})

    target_link_options(${target} PRIVATE
        ${flags}
        -sUSE_GLFW=3
        -sALLOW_MEMORY_GROWTH=1
        -sENVIRONMENT=web
        "--shell-file=${CMAKE_SOURCE_DIR}/web/shell.html"
    )
    foreach(asset IN LISTS HACKATHON_ASSETS)
        target_link_options(${target} PRIVATE
            "--preload-file=${CMAKE_SOURCE_DIR}/assets/${asset}@/assets/${asset}")
    endforeach()
    set_property(TARGET ${target} APPEND PROPERTY LINK_DEPENDS
        "${CMAKE_SOURCE_DIR}/web/shell.html")

    # The output is index.html, index.js, index.wasm, and index.data.
    set_target_properties(${target} PROPERTIES OUTPUT_NAME index SUFFIX ".html")
endfunction()
