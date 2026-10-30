#include "app/results_page.h"

#include "shaders.h"
#include "util/format.h"
#include "util/gpu.h"
#include "util/shader_builder.h"

#include <algorithm>
#include <cmath>

namespace hackathon {

namespace {

// The glyphs: 7 rows of 5 pixels, '#' is on. A character that is not here shows as a box. The
// digits are first, then the other characters, as Object.keys() gave them in the earlier
// TypeScript version.
struct Glyph {
    char character;
    const char* pattern;
};
// clang-format off
constexpr Glyph kGlyphs[] = {
    {'0', ".###. #...# #..## #.#.# ##..# #...# .###."},
    {'1', "..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###."},
    {'2', ".###. #...# ....# ...#. ..#.. .#... #####"},
    {'3', "##### ...#. ..#.. ...#. ....# #...# .###."},
    {'4', "...#. ..##. .#.#. #..#. ##### ...#. ...#."},
    {'5', "##### #.... ####. ....# ....# #...# .###."},
    {'6', "..##. .#... #.... ####. #...# #...# .###."},
    {'7', "##### ....# ...#. ..#.. .#... .#... .#..."},
    {'8', ".###. #...# #...# .###. #...# #...# .###."},
    {'9', ".###. #...# #...# .#### ....# ...#. .##.."},
    {' ', "..... ..... ..... ..... ..... ..... ....."},
    {'A', ".###. #...# #...# ##### #...# #...# #...#"},
    {'B', "####. #...# #...# ####. #...# #...# ####."},
    {'C', ".###. #...# #.... #.... #.... #...# .###."},
    {'D', "###.. #..#. #...# #...# #...# #..#. ###.."},
    {'E', "##### #.... #.... ####. #.... #.... #####"},
    {'F', "##### #.... #.... ####. #.... #.... #...."},
    {'G', ".###. #...# #.... #.### #...# #...# .####"},
    {'H', "#...# #...# #...# ##### #...# #...# #...#"},
    {'I', ".###. ..#.. ..#.. ..#.. ..#.. ..#.. .###."},
    {'J', "..### ...#. ...#. ...#. ...#. #..#. .##.."},
    {'K', "#...# #..#. #.#.. ##... #.#.. #..#. #...#"},
    {'L', "#.... #.... #.... #.... #.... #.... #####"},
    {'M', "#...# ##.## #.#.# #.#.# #...# #...# #...#"},
    {'N', "#...# #...# ##..# #.#.# #..## #...# #...#"},
    {'O', ".###. #...# #...# #...# #...# #...# .###."},
    {'P', "####. #...# #...# ####. #.... #.... #...."},
    {'Q', ".###. #...# #...# #...# #.#.# #..#. .##.#"},
    {'R', "####. #...# #...# ####. #.#.. #..#. #...#"},
    {'S', ".#### #.... #.... .###. ....# ....# ####."},
    {'T', "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#.."},
    {'U', "#...# #...# #...# #...# #...# #...# .###."},
    {'V', "#...# #...# #...# #...# #...# .#.#. ..#.."},
    {'W', "#...# #...# #...# #.#.# #.#.# #.#.# .#.#."},
    {'X', "#...# #...# .#.#. ..#.. .#.#. #...# #...#"},
    {'Y', "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#.."},
    {'Z', "##### ....# ...#. ..#.. .#... #.... #####"},
    {'a', "..... ..... .###. ....# .#### #...# .####"},
    {'b', "#.... #.... #.##. ##..# #...# #...# ####."},
    {'c', "..... ..... .###. #.... #.... #...# .###."},
    {'d', "....# ....# .##.# #..## #...# #...# .####"},
    {'e', "..... ..... .###. #...# ##### #.... .###."},
    {'f', "..##. .#..# .#... ###.. .#... .#... .#..."},
    {'g', "..... .#### #...# #...# .#### ....# .###."},
    {'h', "#.... #.... #.##. ##..# #...# #...# #...#"},
    {'i', "..#.. ..... .##.. ..#.. ..#.. ..#.. .###."},
    {'j', "...#. ..... ..##. ...#. ...#. #..#. .##.."},
    {'k', "#.... #.... #..#. #.#.. ##... #.#.. #..#."},
    {'l', ".##.. ..#.. ..#.. ..#.. ..#.. ..#.. .###."},
    {'m', "..... ..... ##.#. #.#.# #.#.# #...# #...#"},
    {'n', "..... ..... #.##. ##..# #...# #...# #...#"},
    {'o', "..... ..... .###. #...# #...# #...# .###."},
    {'p', "..... ..... ####. #...# ####. #.... #...."},
    {'q', "..... ..... .##.# #..## .#### ....# ....#"},
    {'r', "..... ..... #.##. ##..# #.... #.... #...."},
    {'s', "..... ..... .###. #.... .###. ....# ####."},
    {'t', ".#... .#... ###.. .#... .#... .#..# ..##."},
    {'u', "..... ..... #...# #...# #...# #..## .##.#"},
    {'v', "..... ..... #...# #...# #...# .#.#. ..#.."},
    {'w', "..... ..... #...# #...# #.#.# #.#.# .#.#."},
    {'x', "..... ..... #...# .#.#. ..#.. .#.#. #...#"},
    {'y', "..... ..... #...# #...# .#### ....# .###."},
    {'z', "..... ..... ##### ...#. ..#.. .#... #####"},
    {'.', "..... ..... ..... ..... ..... .##.. .##.."},
    {',', "..... ..... ..... ..... .##.. ..#.. .#..."},
    {':', "..... .##.. .##.. ..... .##.. .##.. ....."},
    {'-', "..... ..... ..... ##### ..... ..... ....."},
    {'(', "...#. ..#.. .#... .#... .#... ..#.. ...#."},
    {')', ".#... ..#.. ...#. ...#. ...#. ..#.. .#..."},
    {'/', "..... ....# ...#. ..#.. .#... #.... ....."},
    {'%', "##... ##..# ...#. ..#.. .#... #..## ...##"},
    {'\'', "..#.. ..#.. ..... ..... ..... ..... ....."},
    {'"', ".#.#. .#.#. ..... ..... ..... ..... ....."},
    {'!', "..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#.."},
    {'?', ".###. #...# ....# ...#. ..#.. ..... ..#.."},
    {'+', "..... ..#.. ..#.. ##### ..#.. ..#.. ....."},
    {'=', "..... ..... ##### ..... ##### ..... ....."},
    {'_', "..... ..... ..... ..... ..... ..... #####"},
};
// clang-format on
constexpr const char* kBoxGlyph = "##### #...# #...# #...# #...# #...# #####";
constexpr uint32_t kGlyphRows = 7;
constexpr uint32_t kGlyphColumns = 5;
// A character cell is one pixel wider and taller than a glyph, for the space between characters.
constexpr uint32_t kCellWidth = kGlyphColumns + 1;
constexpr uint32_t kCellHeight = kGlyphRows + 1;

constexpr uint32_t kCharacterCount = std::size(kGlyphs);
// The glyph index of a rectangle with no glyph, and of a character that is not in kGlyphs.
constexpr uint32_t kSolid = kCharacterCount + 1;
constexpr uint32_t kBox = kCharacterCount;

// The padding in a table cell and around the page, and the space above and below the text of a
// row, in glyph pixels.
constexpr double kPadding = 8;
constexpr double kRowSpace = 6;

// The quads: x, y, width, and height in pixels (from the upper left), the color, and the glyph.
constexpr size_t kInstanceFloats = 12;
constexpr size_t kMaxInstances = 4096;

// The colors.
constexpr std::array<double, 4> kBackground = {0.04, 0.05, 0.07, 1};
constexpr std::array<double, 4> kTitleColor = {1.0, 0.85, 0.55, 1};
constexpr std::array<double, 4> kTextColor = {0.9, 0.9, 0.92, 1};
constexpr std::array<double, 4> kHeaderColor = {0.7, 0.78, 0.9, 1};
constexpr std::array<double, 4> kHeaderBackground = {0.12, 0.15, 0.2, 1};
constexpr std::array<double, 4> kRowBackground = {0.08, 0.09, 0.12, 1};
constexpr std::array<double, 4> kLineColor = {0.25, 0.28, 0.34, 1};
constexpr std::array<double, 4> kButtonColor = {0.2, 0.3, 0.45, 1};
constexpr std::array<double, 4> kButtonHoverColor = {0.3, 0.45, 0.65, 1};

// JavaScript Math.round(): a value halfway between two integers goes up.
double JsRound(double value) { return std::floor(value + 0.5); }

// The width of a text in pixels, with no space after the last character.
double TextWidth(std::string_view text, double scale) {
    return text.empty() ? 0.0 : (text.size() * kCellWidth - 1.0) * scale;
}

// The bit masks of the glyphs, in the order of kGlyphs, then the box.
std::vector<uint32_t> GlyphBits() {
    std::vector<const char*> patterns;
    for (const Glyph& glyph : kGlyphs) {
        patterns.push_back(glyph.pattern);
    }
    patterns.push_back(kBoxGlyph);
    std::vector<uint32_t> bits;
    for (const char* pattern : patterns) {
        uint32_t value = 0;
        for (const char* pixel = pattern;; ++pixel) {
            if (*pixel == ' ' || *pixel == '\0') {
                bits.push_back(value);
                value = 0;
                if (*pixel == '\0') {
                    break;
                }
                continue;
            }
            value = (value << 1) | (*pixel == '#' ? 1u : 0u);
        }
    }
    return bits;
}

}  // namespace

ResultsPage::ResultsPage(const wgpu::Device& device, wgpu::TextureFormat format)
    : device_(device), quads_(kMaxInstances * kInstanceFloats, 0.0f) {
    uniformBuffer_ = CreateBuffer(device, 4 * sizeof(float),
                                  wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst);
    quadBuffer_ = CreateBuffer(device, quads_.size() * sizeof(float),
                               wgpu::BufferUsage::Storage | wgpu::BufferUsage::CopyDst);
    const wgpu::Buffer glyphBuffer =
        CreateBufferWithData(device, GlyphBits(), wgpu::BufferUsage::Storage);
    WgslConstants constants;
    constants.AbstractInt("GLYPH_ROWS", kGlyphRows)
        .AbstractInt("GLYPH_COLUMNS", kGlyphColumns)
        .AbstractInt("SOLID", kSolid);
    const wgpu::ShaderModule module = CreateShaderModule(
        device, JoinWgsl({constants.Text(), shaders::kResultsPage}), "results page");
    const wgpu::ColorTargetState target = {.format = format};
    const wgpu::FragmentState fragment = {
        .module = module, .entryPoint = "fs_quad", .targetCount = 1, .targets = &target};
    const wgpu::RenderPipelineDescriptor descriptor = {
        .vertex = {.module = module, .entryPoint = "vs_quad"},
        .primitive = {.topology = wgpu::PrimitiveTopology::TriangleList},
        .fragment = &fragment,
    };
    pipeline_ = device.CreateRenderPipeline(&descriptor);
    const wgpu::BindGroupEntry entries[] = {
        {.binding = 0, .buffer = uniformBuffer_},
        {.binding = 1, .buffer = quadBuffer_},
        {.binding = 2, .buffer = glyphBuffer},
    };
    const wgpu::BindGroupDescriptor bindGroupDescriptor = {
        .layout = pipeline_.GetBindGroupLayout(0), .entryCount = 3, .entries = entries};
    bindGroup_ = device.CreateBindGroup(&bindGroupDescriptor);
}

bool ResultsPage::IsOnExitButton(double x, double y) const {
    return x >= button_.x && x < button_.x + button_.width && y >= button_.y &&
           y < button_.y + button_.height;
}

void ResultsPage::Draw(const wgpu::CommandEncoder& encoder, const wgpu::TextureView& colorView,
                       uint32_t width, uint32_t height, const std::vector<std::string>& sceneNames,
                       const std::vector<SceneResult>& results) {
    Layout(width, height, sceneNames, results);
    const std::array<float, 4> size = {static_cast<float>(width), static_cast<float>(height), 0.0f,
                                       0.0f};
    WriteBuffer(device_, uniformBuffer_, 0, size.data(), size.size());
    WriteBuffer(device_, quadBuffer_, 0, quads_.data(), quadCount_ * kInstanceFloats);
    const wgpu::RenderPassColorAttachment attachment = {
        .view = colorView,
        .loadOp = wgpu::LoadOp::Clear,
        .storeOp = wgpu::StoreOp::Store,
        .clearValue = {kBackground[0], kBackground[1], kBackground[2], 1.0},
    };
    const wgpu::RenderPassDescriptor descriptor = {.colorAttachmentCount = 1,
                                                   .colorAttachments = &attachment};
    const wgpu::RenderPassEncoder pass = encoder.BeginRenderPass(&descriptor);
    pass.SetPipeline(pipeline_);
    pass.SetBindGroup(0, bindGroup_);
    pass.Draw(6, static_cast<uint32_t>(quadCount_));
    pass.End();
}

// Make the quads of the page: the title, the table, and the button.
void ResultsPage::Layout(uint32_t width, uint32_t height,
                         const std::vector<std::string>& sceneNames,
                         const std::vector<SceneResult>& results) {
    quadCount_ = 0;

    const std::array<std::string, 3> headers = {"Scene", "Total frames", "Frames per second"};
    // One row for each scene. If a scene has more than one result (for example, after the N key
    // goes back to it), the row has the sum of its frames and its time.
    std::vector<std::array<std::string, 3>> rows;
    for (size_t index = 0; index < sceneNames.size(); ++index) {
        const std::string label = "Scene " + std::to_string(index + 1) + ": " + sceneNames[index];
        uint64_t frames = 0;
        double seconds = 0.0;
        bool ran = false;
        for (const SceneResult& result : results) {
            if (result.number == static_cast<int>(index + 1)) {
                frames += result.frames;
                seconds += result.seconds;
                ran = true;
            }
        }
        if (!ran) {
            rows.push_back({label, "not run", "not run"});
        } else {
            rows.push_back(
                {label, std::to_string(frames), ToFixed1(seconds > 0 ? frames / seconds : 0.0)});
        }
    }
    const std::string title = "Benchmark results";

    // The size of one glyph pixel in screen pixels. It is an integer, so the text is sharp. It is
    // the largest scale at which the page fits in the view, with a margin of one padding at each
    // side. All sizes of the page are proportional to the scale, so measure them at scale 1.
    // The title has twice the scale of the table.
    double tableUnits = 0.0;
    for (size_t column = 0; column < 3; ++column) {
        double widest = TextWidth(headers[column], 1.0);
        for (const auto& row : rows) {
            widest = std::max(widest, TextWidth(row[column], 1.0));
        }
        tableUnits += widest + 2 * kPadding;
    }
    const double widthUnits = std::max(tableUnits, TextWidth(title, 2.0)) + 2 * kPadding;
    const double rowUnits = kCellHeight + kRowSpace;
    const double heightUnits = kCellHeight * 2 + 3 * rowUnits + rowUnits * (rows.size() + 1) +
                               3 * rowUnits + rowUnits + 2 + 2 * kPadding;
    const double scale =
        std::max(1.0, std::floor(std::min(width / widthUnits, height / heightUnits)));
    const double titleScale = scale * 2;
    const double rowHeight = rowUnits * scale;
    const double padding = kPadding * scale;

    // The width of each column: the widest text, and padding at the two sides.
    std::array<double, 3> columnWidths;
    for (size_t column = 0; column < 3; ++column) {
        double widest = TextWidth(headers[column], scale);
        for (const auto& row : rows) {
            widest = std::max(widest, TextWidth(row[column], scale));
        }
        columnWidths[column] = widest + 2 * padding;
    }
    const double tableWidth = columnWidths[0] + columnWidths[1] + columnWidths[2];
    const double tableHeight = rowHeight * (rows.size() + 1);
    const double titleHeight = kCellHeight * titleScale;
    const double buttonHeight = rowHeight + 2 * scale;
    const double gap = 3 * rowHeight;
    const double total = titleHeight + gap + tableHeight + gap + buttonHeight;
    double y = std::max(padding, JsRound((height - total) / 2));
    const double left = JsRound((width - tableWidth) / 2);

    Text(title, JsRound((width - TextWidth(title, titleScale)) / 2), y, titleScale, kTitleColor);
    y += titleHeight + gap;

    // The header row and the result rows. The scene names go to the left of their column, and the
    // numbers go to the right, so that the digits are in line.
    std::vector<std::array<std::string, 3>> allRows = {headers};
    allRows.insert(allRows.end(), rows.begin(), rows.end());
    for (size_t rowIndex = 0; rowIndex < allRows.size(); ++rowIndex) {
        const bool header = rowIndex == 0;
        AddRect({left, y, tableWidth, rowHeight}, header ? kHeaderBackground : kRowBackground);
        double x = left;
        for (size_t column = 0; column < 3; ++column) {
            const std::string& cell = allRows[rowIndex][column];
            const double textY = y + JsRound((rowHeight - kGlyphRows * scale) / 2);
            const double textX = column == 0
                                     ? x + padding
                                     : x + columnWidths[column] - padding - TextWidth(cell, scale);
            Text(cell, textX, textY, scale, header ? kHeaderColor : kTextColor);
            x += columnWidths[column];
        }
        y += rowHeight;
        AddRect({left, y - 1, tableWidth, std::max(1.0, std::floor(scale / 2))}, kLineColor);
    }

    // The Exit button, below the table in the center.
    y += gap;
    const std::string label = "Exit";
    const double buttonWidth = TextWidth(label, scale) + 12 * scale;
    button_ = {JsRound((width - buttonWidth) / 2), y, buttonWidth, buttonHeight};
    const bool hover = IsOnExitButton(pointer_[0], pointer_[1]);
    AddRect(button_, hover ? kButtonHoverColor : kButtonColor);
    Text(label, button_.x + JsRound((buttonWidth - TextWidth(label, scale)) / 2),
         y + JsRound((buttonHeight - kGlyphRows * scale) / 2), scale, kTextColor);
}

void ResultsPage::Text(std::string_view text, double x, double y, double scale,
                       const Color& color) {
    for (const char character : text) {
        if (character != ' ') {
            uint32_t glyph = kBox;
            for (uint32_t index = 0; index < kCharacterCount; ++index) {
                if (kGlyphs[index].character == character) {
                    glyph = index;
                    break;
                }
            }
            AddQuad({x, y, kGlyphColumns * scale, kGlyphRows * scale}, color, glyph);
        }
        x += kCellWidth * scale;
    }
}

void ResultsPage::AddRect(const Rect& rect, const Color& color) { AddQuad(rect, color, kSolid); }

void ResultsPage::AddQuad(const Rect& rect, const Color& color, uint32_t glyph) {
    if (quadCount_ >= kMaxInstances) {
        return;
    }
    const double values[kInstanceFloats] = {rect.x,      rect.y,   rect.width,
                                            rect.height, color[0], color[1],
                                            color[2],    color[3], static_cast<double>(glyph),
                                            0,           0,        0};
    for (size_t k = 0; k < kInstanceFloats; ++k) {
        quads_[quadCount_ * kInstanceFloats + k] = static_cast<float>(values[k]);
    }
    quadCount_ += 1;
}

}  // namespace hackathon
