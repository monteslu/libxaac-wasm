// Embind glue exposing libxaac's AAC-LC encoder to JS as `AacEncoder`.
//
// API surface (verified against ittiam-systems/libxaac encoder/ixheaace_api.h and
// the reference driver test/encoder/ixheaace_testbench.c):
//
//   IA_ERRORCODE ixheaace_create (pVOID in_cfg, pVOID out_cfg);
//   IA_ERRORCODE ixheaace_process(pVOID handle, pVOID in_cfg, pVOID out_cfg);
//   IA_ERRORCODE ixheaace_delete (pVOID out_cfg);
//
// Buffer model (from the testbench): the library OWNS its I/O buffers. After
// create(), read them from out_cfg.mem_info_table[IA_MEMTYPE_INPUT/OUTPUT].mem_ptr.
// Each process() call consumes exactly `out_cfg.input_size` bytes of INTERLEAVED
// 16-bit PCM from the input buffer and writes `out_cfg.i_out_bytes` of raw AAC into
// the output buffer. With i_use_es = 1, create() emits the AudioSpecificConfig as a
// one-time header (out_cfg.i_out_bytes) before the first audio frame; we capture it
// and hand it to the JS MP4 wrapper as the esds DSI.
//
// Config defaults mirror the testbench's AAC-LC path: aot = AOT_AAC_LC (2),
// i_use_es = 1 (raw ES, not ADTS), ui_pcm_wd_sz = 16, no MPS/SBR/USAC.

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <stdexcept>

extern "C" {
// Include order mirrors the upstream reference driver
// (test/encoder/ixheaace_testbench.c): base integer typedefs (WORD32, pVOID, ...)
// and the USAC constants must precede the public API header.
#include "ixheaac_type_def.h"
#include "iusace_cnst.h"
#include "ixheaace_api.h"
}

using namespace emscripten;

namespace {

// libxaac wants malloc/free hooks on the output config. Plain wrappers; the
// alignment arg is advisory on wasm (linear memory, 8-byte aligned malloc).
void* xaac_malloc(uint32_t /*alignment*/, uint32_t size) { return malloc(size); }
void xaac_free(void* p) { free(p); }

class AacEncoder {
 public:
  AacEncoder(int sample_rate, int channels, int bitrate)
      : sample_rate_(sample_rate), channels_(channels), bitrate_(bitrate) {
    if (channels < 1 || channels > 2) throw std::runtime_error("channels must be 1 or 2");

    memset(&user_cfg_, 0, sizeof(user_cfg_));
    ixheaace_input_config* in = &user_cfg_.input_config;
    ixheaace_output_config* out = &user_cfg_.output_config;

    // ---- input config (AAC-LC, raw ES) ----
    in->aot = AOT_AAC_LC;
    in->i_samp_freq = sample_rate;
    in->i_native_samp_freq = sample_rate;
    in->i_channels = channels;
    in->i_channels_mask = 0;
    in->ui_pcm_wd_sz = 16;       // 16-bit interleaved PCM
    in->i_use_adts = 0;          // not ADTS...
    in->i_use_es = 1;            // ...raw ES (ASC emitted once at create)
    in->esbr_flag = 0;
    in->i_use_mps = 0;
    in->i_mps_tree_config = -1;
    in->usac_en = 0;
    in->cplx_pred = 0;
    in->frame_cmd_flag = 0;
    in->out_bytes_flag = 0;
    in->user_tns_flag = 0;
    in->user_esbr_flag = 0;
    in->aac_config.bitrate = bitrate;
    in->i_bitrate = bitrate;
    in->aac_config.use_tns = 1;        // TNS on (typical AAC-LC quality)
    in->aac_config.full_bandwidth = 0;
    in->aac_config.bitreservoir_size = -1; // library default
    in->use_delay_adjustment = 0;

    // ---- output config (memory hooks) ----
    out->malloc_xheaace = &xaac_malloc;
    out->free_xheaace = &xaac_free;

    IA_ERRORCODE err = ixheaace_create((pVOID)in, (pVOID)out);
    if (err) throw std::runtime_error("ixheaace_create failed: " + std::to_string(err));
    created_ = true;

    handle_ = out->pv_ia_process_api_obj;
    in_buf_ = (uint8_t*)out->mem_info_table[IA_MEMTYPE_INPUT].mem_ptr;
    out_buf_ = (uint8_t*)out->mem_info_table[IA_MEMTYPE_OUTPUT].mem_ptr;
    input_size_ = out->input_size;                       // PCM bytes per process()
    samples_per_frame_ = input_size_ / (2 * channels_);  // 16-bit -> 2 bytes/sample

    // With i_use_es, create() leaves the ASC header in the output buffer.
    if (out->i_out_bytes > 0) {
      asc_.assign(out_buf_, out_buf_ + out->i_out_bytes);
    }
  }

  ~AacEncoder() { destroy_(); }

  // Samples (per channel) the encoder ingests per process() call (1024 for LC).
  int frameSize() const { return samples_per_frame_; }

  // The one-time AudioSpecificConfig (esds decoder-specific info). Empty if none.
  val audioSpecificConfig() const {
    return val(typed_memory_view(asc_.size(), asc_.data()));
  }

  // AAC-LC encoder/priming delay in samples. libxaac LC introduces one frame
  // (1024 samples) of algorithmic delay before the first valid output; the muxer
  // compensates with this value. (1105 is ffmpeg's native encoder; libxaac = 1024.)
  int encoderDelaySamples() const { return samples_per_frame_; }

  // Encode one frame. `frames` is a JS array of Float32Array (one per channel);
  // short final frames are zero-padded. Returns a view of this frame's raw AAC
  // access unit (empty while the encoder is priming).
  val encodeFrame(val frames, int validSamples) {
    fillInterleaved_(frames, validSamples);
    user_cfg_.output_config.i_out_bytes = 0;
    IA_ERRORCODE err = ixheaace_process(handle_, (pVOID)&user_cfg_.input_config,
                                        (pVOID)&user_cfg_.output_config);
    if (err) throw std::runtime_error("ixheaace_process failed: " + std::to_string(err));
    int n = user_cfg_.output_config.i_out_bytes;
    return val(typed_memory_view(n > 0 ? (size_t)n : 0, out_buf_));
  }

 private:
  void destroy_() {
    if (created_) {
      ixheaace_delete((pVOID)&user_cfg_.output_config);
      created_ = false;
    }
  }

  // Planar Float32 [-1,1] -> interleaved WORD16 in the library's input buffer,
  // zero-padding a short final frame.
  void fillInterleaved_(val frames, int validSamples) {
    memset(in_buf_, 0, input_size_);
    int16_t* dst = reinterpret_cast<int16_t*>(in_buf_);
    for (int c = 0; c < channels_; ++c) {
      val ch = frames[c];
      unsigned len = ch["length"].as<unsigned>();
      unsigned take = (unsigned)validSamples < len ? (unsigned)validSamples : len;
      if ((int)take > samples_per_frame_) take = (unsigned)samples_per_frame_;
      for (unsigned i = 0; i < take; ++i) {
        float f = ch[i].as<float>();
        if (f > 1.0f) f = 1.0f; else if (f < -1.0f) f = -1.0f;
        dst[i * channels_ + c] = (int16_t)(f < 0 ? f * 32768.0f : f * 32767.0f);
      }
    }
  }

  int sample_rate_;
  int channels_;
  int bitrate_;

  ixheaace_user_config_struct user_cfg_;
  bool created_ = false;
  void* handle_ = nullptr;
  uint8_t* in_buf_ = nullptr;
  uint8_t* out_buf_ = nullptr;
  int input_size_ = 0;
  int samples_per_frame_ = 0;
  std::vector<uint8_t> asc_;
};

}  // namespace

EMSCRIPTEN_BINDINGS(libxaac_wasm) {
  class_<AacEncoder>("AacEncoder")
      .constructor<int, int, int>()
      .function("frameSize", &AacEncoder::frameSize)
      .function("audioSpecificConfig", &AacEncoder::audioSpecificConfig)
      .function("encoderDelaySamples", &AacEncoder::encoderDelaySamples)
      .function("encodeFrame", &AacEncoder::encodeFrame);
}
