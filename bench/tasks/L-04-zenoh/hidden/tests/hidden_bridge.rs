use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use serde_json::Value;
use telemetry_bridge::{encode_frame, Bridge, BridgeConfig, Counters};

static PORT: AtomicU16 = AtomicU16::new(0);

fn port() -> u16 {
    let _ = PORT.compare_exchange(0, 20000 + (std::process::id() % 20000) as u16, Ordering::SeqCst, Ordering::SeqCst);
    PORT.fetch_add(1, Ordering::SeqCst)
}

fn cfg(json: &[(&str, String)]) -> zenoh::Config {
    let mut c = zenoh::Config::default();
    c.insert_json5("scouting/multicast/enabled", "false").unwrap();
    for (k, v) in json { c.insert_json5(k, v).unwrap(); }
    c
}

/// A bridge listening on a fresh local port and a client session connected to it.
async fn pair(prefix: &str) -> (Bridge, zenoh::Session) {
    let p = port();
    let bridge = Bridge::start(BridgeConfig {
        zenoh: cfg(&[("mode", r#""peer""#.into()), ("listen/endpoints", format!(r#"["tcp/127.0.0.1:{p}"]"#))]),
        prefix: prefix.to_string(),
    }).await.expect("bridge starts");
    let client = zenoh::open(cfg(&[("mode", r#""peer""#.into()), ("connect/endpoints", format!(r#"["tcp/127.0.0.1:{p}"]"#))])).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    (bridge, client)
}

async fn next_json(sub: &zenoh::pubsub::Subscriber<zenoh::handlers::FifoChannelHandler<zenoh::sample::Sample>>) -> Value {
    let s = tokio::time::timeout(Duration::from_secs(5), sub.recv_async()).await.expect("message within 5 s").unwrap();
    serde_json::from_slice(&s.payload().to_bytes()).expect("JSON payload")
}

async fn wait_counters(b: &Bridge, want: Counters) {
    for _ in 0..50 {
        if b.counters() == want { return; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(b.counters(), want);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn publishes_stats_for_a_valid_frame() {
    let (bridge, c) = pair("t1").await;
    let sub = c.declare_subscriber("t1/sensors/*/stats").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    c.put("t1/sensors/dev-1/raw", encode_frame(42, &[1.0, 2.0, 6.0])).await.unwrap();
    let v = next_json(&sub).await;
    assert_eq!(v["device"], "dev-1");
    assert_eq!(v["ts_us"], 42);
    assert_eq!(v["count"], 3);
    assert_eq!(v["min"].as_f64().unwrap(), 1.0);
    assert_eq!(v["max"].as_f64().unwrap(), 6.0);
    assert!((v["mean"].as_f64().unwrap() - 3.0).abs() < 1e-9);
    wait_counters(&bridge, Counters { frames_ok: 1, frames_dropped: 0 }).await;
    bridge.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stats_go_to_the_device_key() {
    let (bridge, c) = pair("t2").await;
    let sub = c.declare_subscriber("t2/sensors/b/stats").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    c.put("t2/sensors/a/raw", encode_frame(1, &[1.0])).await.unwrap();
    c.put("t2/sensors/b/raw", encode_frame(2, &[2.0])).await.unwrap();
    let v = next_json(&sub).await;
    assert_eq!(v["device"], "b");
    assert_eq!(v["ts_us"], 2);
    bridge.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bad_frames_are_dropped_and_reported() {
    let (bridge, c) = pair("t3").await;
    let errs = c.declare_subscriber("t3/bridge/errors").await.unwrap();
    let stats = c.declare_subscriber("t3/sensors/*/stats").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut bad_crc = encode_frame(1, &[1.0]);
    bad_crc[12] ^= 1;
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("t3/sensors/d1/raw", vec![1, 2, 3], "too_short"),
        ("t3/sensors/d1/raw", bad_crc, "bad_crc"),
        ("t3/sensors/d1/raw", encode_frame(1, &[f32::NAN]), "bad_sample"),
        ("t3/sensors/Bad.Device/raw", encode_frame(1, &[1.0]), "bad_device"),
    ];
    for (key, payload, reason) in cases {
        c.put(key, payload).await.unwrap();
        let v = next_json(&errs).await;
        assert_eq!(v["reason"], reason, "for {key}");
    }
    c.put("t3/sensors/d1/raw", encode_frame(9, &[4.0])).await.unwrap();
    assert_eq!(next_json(&stats).await["ts_us"], 9);
    wait_counters(&bridge, Counters { frames_ok: 1, frames_dropped: 4 }).await;
    bridge.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn error_reports_name_the_device() {
    let (bridge, c) = pair("t4").await;
    let errs = c.declare_subscriber("t4/bridge/errors").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    c.put("t4/sensors/pump_7/raw", vec![0u8; 3]).await.unwrap();
    let v = next_json(&errs).await;
    assert_eq!(v["device"], "pump_7");
    bridge.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn last_value_queryable() {
    let (bridge, c) = pair("t5").await;
    let stats = c.declare_subscriber("t5/sensors/*/stats").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    c.put("t5/sensors/a/raw", encode_frame(1, &[1.0])).await.unwrap();
    c.put("t5/sensors/a/raw", encode_frame(2, &[5.0])).await.unwrap();
    c.put("t5/sensors/b/raw", encode_frame(3, &[7.0])).await.unwrap();
    for _ in 0..3 { next_json(&stats).await; }

    let replies = c.get("t5/sensors/a/last").await.unwrap();
    let mut got = vec![];
    while let Ok(r) = replies.recv_async().await { got.push(serde_json::from_slice::<Value>(&r.result().unwrap().payload().to_bytes()).unwrap()); }
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["ts_us"], 2);
    assert_eq!(got[0]["max"].as_f64().unwrap(), 5.0);

    let replies = c.get("t5/sensors/*/last").await.unwrap();
    let mut devices = vec![];
    while let Ok(r) = replies.recv_async().await {
        let v: Value = serde_json::from_slice(&r.result().unwrap().payload().to_bytes()).unwrap();
        devices.push(v["device"].as_str().unwrap().to_string());
    }
    devices.sort();
    assert_eq!(devices, vec!["a", "b"]);

    let replies = c.get("t5/sensors/nobody/last").await.unwrap();
    let mut n = 0;
    while replies.recv_async().await.is_ok() { n += 1; }
    assert_eq!(n, 0);
    bridge.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prefixes_are_isolated() {
    let (bridge, c) = pair("t6").await;
    let errs = c.declare_subscriber("t6/bridge/errors").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    c.put("other/sensors/x/raw", encode_frame(1, &[1.0])).await.unwrap();
    c.put("t6/sensors/x/raw", vec![9]).await.unwrap();
    next_json(&errs).await;
    wait_counters(&bridge, Counters { frames_ok: 0, frames_dropped: 1 }).await;
    bridge.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn survives_a_flood_of_garbage() {
    let (bridge, c) = pair("t7").await;
    let stats = c.declare_subscriber("t7/sensors/*/stats").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut x: u64 = 0xDEADBEEF;
    for i in 0..500 {
        let bytes: Vec<u8> = (0..(i % 300)).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x as u8 }).collect();
        c.put("t7/sensors/fuzz/raw", bytes).await.unwrap();
    }
    c.put("t7/sensors/fuzz/raw", encode_frame(77, &[1.0])).await.unwrap();
    let mut seen = false;
    for _ in 0..5 { if next_json(&stats).await["ts_us"] == 77 { seen = true; break; } }
    assert!(seen);
    let k = bridge.counters();
    assert_eq!(k.frames_ok + k.frames_dropped, 501);
    bridge.close().await.unwrap();
}
