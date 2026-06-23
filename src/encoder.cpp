// Embind glue exposing libxaac's AAC-LC encoder to JS as `AacEncoder`.
//
// This is the thin native surface: construct with (sampleRate, channels,
// bitrate), feed Float32 PCM one 1024-sample frame at a time, get raw AAC access
// units back. The MP4 container is built in JS (src/mp4.js) so this stays a pure
// codec shim.
//
// libxaac's encoder is driven through its ixheaace_* API (see the vendored
// encoder/ tree + LIBXAAC-Enc-API.pdf). The exact init/process calls are wired in
// scripts/vendor-libxaac.sh's pinned version; if upstream shifts the API, update
// here. AOT is forced to 2 (AAC-LC) and SBR/PS off for plain LC output.

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <vector>
#include <cstdint>
#include <stdexcept>

// libxaac encoder public headers (paths resolved by build.sh include dirs).
extern "C" {
#include "ixheaace_api.h"
}

using namespace emscripten;

namespace {

constexpr int kFrameSize = 1024; // AAC-LC samples per channel per frame

class AacEncoder {
 public:
  AacEncoder(int sample_rate, int channels, int bitrate)
      : sample_rate_(sample_rate), channels_(channels), bitrate_(bitrate) {
    init_();
  }

  ~AacEncoder() { destroy_(); }

  int frameSize() const { return kFrameSize; }

  int encoderDelaySamples() const { return encoder_delay_; }

  // Encode one frame. `frames` is a JS array of Float32Array (one per channel);
  // `validSamples` is how many samples in this (possibly final, short) frame are
  // real. Returns a Uint8Array view of the access unit (may be empty if the
  // encoder is still priming).
  val encodeFrame(val frames, int validSamples) {
    fill_input_(frames, validSamples);
    int au_bytes = process_();
    return view_(out_buf_.data(), au_bytes);
  }

  // Drain buffered frames at end-of-stream. Returns one AU per call, empty when
  // fully flushed.
  val flush() {
    int au_bytes = drain_();
    return view_(out_buf_.data(), au_bytes);
  }

 private:
  // --- the following are filled in against the pinned libxaac encoder API ---
  void init_();      // ixheaace_*_init, force AOT 2 / SBR off, query delay
  void destroy_();   // ixheaace_*_delete
  int process_();    // one encode call, returns AU byte length
  int drain_();      // end-of-stream flush, returns AU byte length
  // -------------------------------------------------------------------------

  void fill_input_(val frames, int validSamples) {
    in_buf_.assign(static_cast<size_t>(kFrameSize) * channels_, 0.0f);
    for (int c = 0; c < channels_; ++c) {
      val ch = frames[c];
      unsigned len = ch["length"].as<unsigned>();
      unsigned take = static_cast<unsigned>(validSamples) < len
                          ? static_cast<unsigned>(validSamples)
                          : len;
      // interleave into in_buf_ (libxaac wants interleaved PCM)
      for (unsigned i = 0; i < take; ++i) {
        in_buf_[i * channels_ + c] = ch[i].as<float>();
      }
    }
  }

  static val view_(const uint8_t* p, int n) {
    return val(typed_memory_view(static_cast<size_t>(n > 0 ? n : 0), p));
  }

  int sample_rate_;
  int channels_;
  int bitrate_;
  int encoder_delay_ = 0;

  std::vector<float> in_buf_;
  std::vector<uint8_t> out_buf_;

  void* handle_ = nullptr; // libxaac encoder handle
};

} // namespace

EMSCRIPTEN_BINDINGS(libxaac_wasm) {
  class_<AacEncoder>("AacEncoder")
      .constructor<int, int, int>()
      .function("frameSize", &AacEncoder::frameSize)
      .function("encoderDelaySamples", &AacEncoder::encoderDelaySamples)
      .function("encodeFrame", &AacEncoder::encodeFrame)
      .function("flush", &AacEncoder::flush);
}
