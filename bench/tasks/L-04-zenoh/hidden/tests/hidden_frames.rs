use telemetry_bridge::{decode_frame, encode_frame, FrameError};

fn crc_fix(mut b: Vec<u8>) -> Vec<u8> {
    let n = b.len();
    let crc = crc32fast::hash(&b[..n - 4]);
    b[n - 4..].copy_from_slice(&crc.to_le_bytes());
    b
}

#[test]
fn round_trip() {
    let b = encode_frame(1_700_000_000_123_456, &[1.5, -2.25, 3.0]);
    assert_eq!(b.len(), 1 + 8 + 2 + 12 + 4);
    assert_eq!(b[0], 1);
    let f = decode_frame(&b).unwrap();
    assert_eq!(f.timestamp_us, 1_700_000_000_123_456);
    assert_eq!(f.samples, vec![1.5, -2.25, 3.0]);
}

#[test]
fn layout_is_little_endian_with_crc32_ieee() {
    let b = encode_frame(0x0102030405060708, &[1.0]);
    assert_eq!(&b[1..9], &[8, 7, 6, 5, 4, 3, 2, 1]);
    assert_eq!(&b[9..11], &[1, 0]);
    assert_eq!(&b[11..15], &1.0f32.to_le_bytes());
    assert_eq!(&b[15..19], &crc32fast::hash(&b[..15]).to_le_bytes());
}

#[test]
fn max_samples_is_256() {
    let ok = encode_frame(1, &vec![0.5; 256]);
    assert_eq!(decode_frame(&ok).unwrap().samples.len(), 256);
    let mut too_many = encode_frame(1, &vec![0.5; 257]);
    too_many = crc_fix(too_many);
    assert_eq!(decode_frame(&too_many), Err(FrameError::BadCount));
}

#[test]
fn rejects_short_and_bad_version() {
    assert_eq!(decode_frame(&[]), Err(FrameError::TooShort));
    assert_eq!(decode_frame(&[1; 14]), Err(FrameError::TooShort));
    let mut b = encode_frame(1, &[1.0]);
    b[0] = 2;
    assert_eq!(decode_frame(&crc_fix(b)), Err(FrameError::BadVersion));
}

#[test]
fn rejects_zero_count_and_wrong_length() {
    let mut zero = vec![1u8; 15];
    zero[9] = 0; zero[10] = 0;
    assert_eq!(decode_frame(&crc_fix(zero)), Err(FrameError::BadCount));
    let mut b = encode_frame(1, &[1.0, 2.0]);
    b[9] = 3; // claims 3 samples, has 2
    assert_eq!(decode_frame(&crc_fix(b)), Err(FrameError::BadLength));
    let mut longer = encode_frame(1, &[1.0]);
    longer.insert(15, 0);
    assert_eq!(decode_frame(&crc_fix(longer)), Err(FrameError::BadLength));
}

#[test]
fn rejects_bad_crc() {
    let mut b = encode_frame(1, &[1.0, 2.0]);
    b[12] ^= 0x40;
    assert_eq!(decode_frame(&b), Err(FrameError::BadCrc));
}

#[test]
fn rejects_nan_and_infinity() {
    assert_eq!(decode_frame(&encode_frame(1, &[1.0, f32::NAN])), Err(FrameError::BadSample));
    assert_eq!(decode_frame(&encode_frame(1, &[f32::INFINITY])), Err(FrameError::BadSample));
    assert_eq!(decode_frame(&encode_frame(1, &[f32::NEG_INFINITY])), Err(FrameError::BadSample));
}

#[test]
fn reason_strings() {
    let all = [
        (FrameError::TooShort, "too_short"), (FrameError::BadVersion, "bad_version"), (FrameError::BadLength, "bad_length"),
        (FrameError::BadCount, "bad_count"), (FrameError::BadCrc, "bad_crc"), (FrameError::BadSample, "bad_sample"),
    ];
    for (e, r) in all { assert_eq!(e.reason(), r); }
}

#[test]
fn never_panics_on_random_bytes() {
    let mut x: u64 = 0x9E3779B97F4A7C15;
    for len in 0..2000usize {
        let bytes: Vec<u8> = (0..(len % 1100)).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x as u8 }).collect();
        let _ = decode_frame(&bytes);
    }
}
