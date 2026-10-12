//! Performance probe, run separately with `--ignored`. Prints one line: PERF {json}.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use telemetry_bridge::{encode_frame, Bridge, BridgeConfig};

fn cfg(json: &[(&str, String)]) -> zenoh::Config {
    let mut c = zenoh::Config::default();
    c.insert_json5("scouting/multicast/enabled", "false").unwrap();
    for (k, v) in json { c.insert_json5(k, v).unwrap(); }
    c
}
fn now_us() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as u64 }
fn pct(v: &mut Vec<u64>, p: f64) -> u64 { v.sort_unstable(); if v.is_empty() { 0 } else { v[((v.len() - 1) as f64 * p).round() as usize] } }

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn perf() {
    let p = 39000 + (std::process::id() % 1000) as u16;
    let bridge = Bridge::start(BridgeConfig {
        zenoh: cfg(&[("mode", r#""peer""#.into()), ("listen/endpoints", format!(r#"["tcp/127.0.0.1:{p}"]"#))]),
        prefix: "perf".into(),
    }).await.unwrap();
    let c = zenoh::open(cfg(&[("mode", r#""peer""#.into()), ("connect/endpoints", format!(r#"["tcp/127.0.0.1:{p}"]"#))])).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 1. Latency at a steady 1000 frames/s, 16 samples each: publish time is carried in ts_us
    let lat = Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
    let l2 = lat.clone();
    let _sub = c.declare_subscriber("perf/sensors/lat/stats").callback(move |s| {
        let v: serde_json::Value = serde_json::from_slice(&s.payload().to_bytes()).unwrap();
        l2.lock().unwrap().push(now_us().saturating_sub(v["ts_us"].as_u64().unwrap()));
    }).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let samples = vec![1.25f32; 16];
    let mut tick = tokio::time::interval(Duration::from_millis(1));
    for _ in 0..3000 {
        tick.tick().await;
        c.put("perf/sensors/lat/raw", encode_frame(now_us(), &samples)).await.unwrap();
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let mut l = lat.lock().unwrap().clone();
    let received = l.len();
    let (p50, p99, max) = (pct(&mut l, 0.5), pct(&mut l, 0.99), l.last().copied().unwrap_or(0));

    // 2. Throughput: 50,000 frames as fast as possible, count stats back within 10 s
    let got = Arc::new(AtomicU64::new(0));
    let g2 = got.clone();
    let _sub2 = c.declare_subscriber("perf/sensors/tp/stats").callback(move |_| { g2.fetch_add(1, Ordering::Relaxed); }).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let frame = encode_frame(1, &samples);
    let start = Instant::now();
    for _ in 0..50_000 { c.put("perf/sensors/tp/raw", frame.clone()).await.unwrap(); }
    let deadline = Instant::now() + Duration::from_secs(10);
    while got.load(Ordering::Relaxed) < 50_000 && Instant::now() < deadline { tokio::time::sleep(Duration::from_millis(20)).await; }
    let secs = start.elapsed().as_secs_f64();
    let tp = got.load(Ordering::Relaxed);

    println!("PERF {}", serde_json::json!({
        "latency_us": { "p50": p50, "p99": p99, "max": max, "sent": 3000, "received": received },
        "throughput": { "sent": 50000, "received": tp, "seconds": secs, "per_second": (tp as f64 / secs).round() },
    }));
    bridge.close().await.unwrap();
}
