Build a Rust library crate, `telemetry_bridge`, that turns raw sensor frames arriving over [Zenoh](https://zenoh.io) into statistics. The crate and its dependencies (`zenoh` 1.10.1, `tokio`, `serde`, `serde_json`, `crc32fast`) are already set up in `Cargo.toml`; keep them. Speed matters: the bridge will be measured for latency and throughput.

## Frame format
All integers are little-endian.

| Bytes | Field |
|---|---|
| 0 | version, must be `1` |
| 1–8 | `timestamp_us`: u64 |
| 9–10 | `count`: u16, number of samples, 1 to 256 |
| 11 … | `count` samples, each an `f32` |
| last 4 | CRC-32 (IEEE, as `crc32fast::hash`) of every byte before it, as u32 |

The public API, exactly as named:

```rust
pub struct Frame { pub timestamp_us: u64, pub samples: Vec<f32> }
pub enum FrameError { TooShort, BadVersion, BadLength, BadCount, BadCrc, BadSample } // derive Debug, Clone, Copy, PartialEq, Eq
impl FrameError { pub fn reason(&self) -> &'static str } // "too_short", "bad_version", "bad_length", "bad_count", "bad_crc", "bad_sample"
pub fn encode_frame(timestamp_us: u64, samples: &[f32]) -> Vec<u8>;
pub fn decode_frame(bytes: &[u8]) -> Result<Frame, FrameError>;
```

`decode_frame` checks, in this order: fewer than 15 bytes → `TooShort`; version not 1 → `BadVersion`; count 0 or over 256 → `BadCount`; total length not `15 + 4 × count` → `BadLength`; CRC mismatch → `BadCrc`; any sample NaN or infinite → `BadSample`. It must never panic, whatever the input. `encode_frame` writes the format above (it is used by tests and does not need to check its input).

## Bridge

```rust
pub struct BridgeConfig { pub zenoh: zenoh::Config, pub prefix: String }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counters { pub frames_ok: u64, pub frames_dropped: u64 }
pub struct Bridge { /* … */ }
impl Bridge {
    pub async fn start(cfg: BridgeConfig) -> Result<Bridge, BridgeError>; // opens its own Zenoh session with cfg.zenoh
    pub fn counters(&self) -> Counters;
    pub async fn close(self) -> Result<(), BridgeError>;
}
```
`BridgeError` is your own error type and must implement `std::error::Error`. The bridge runs on the caller's Tokio runtime (multi-threaded).

With prefix `P`:
- It subscribes to `P/sensors/*/raw`. The `*` part is the device id, which must be 1 to 32 characters of `a-z 0-9 _ -`.
- For each valid frame from a valid device it publishes, as soon as possible, a JSON object to `P/sensors/<device>/stats`: `{"device": "<device>", "ts_us": <timestamp_us>, "count": <n>, "min": <f64>, "max": <f64>, "mean": <f64>}`, and counts it in `frames_ok`.
- Anything else is dropped, counted in `frames_dropped`, and reported as JSON to `P/bridge/errors`: `{"device": "<device as received>", "reason": "<reason>"}` where reason is one of the `FrameError` reasons or `"bad_device"`.
- It declares a queryable on `P/sensors/*/last` that replies with the latest stats JSON of every known device matching the query, one reply per device, on key `P/sensors/<device>/last`. Devices with no valid frame yet give no reply.
- Frames outside the prefix are ignored and not counted.

No other public items are required. Tests are Rust integration tests in `tests/`, run with `cargo test --release`.
