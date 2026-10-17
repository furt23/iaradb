//! The real binary: bad configuration, a full request through it, and SIGHUP key reloads.

mod common;

use common::*;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_iara-s3-proxy");

fn run_to_end(args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("spawn iara-s3-proxy")
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// A loopback port nothing listens on right now.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// The child process, killed when dropped.
struct Proxy(Child);

impl Drop for Proxy {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn(listen: SocketAddr, endpoint: &str, keys: &std::path::Path) -> Proxy {
    let child = Command::new(BIN)
        .args(["--listen", &listen.to_string(), "--endpoint", endpoint])
        .args(["--bucket", BUCKET, "--region", "auto", "--keys-file", keys.to_str().unwrap()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn iara-s3-proxy");
    let proxy = Proxy(child);
    let deadline = Instant::now() + Duration::from_secs(20);
    while TcpStream::connect(listen).is_err() {
        assert!(Instant::now() < deadline, "the proxy did not start listening");
        std::thread::sleep(Duration::from_millis(50));
    }
    proxy
}

#[test]
fn help_succeeds_and_documents_the_options() {
    let out = run_to_end(&["--help"]);
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    for flag in ["--listen", "--endpoint", "--bucket", "--region", "--keys-file"] {
        assert!(text.contains(flag), "{flag}");
    }
}

#[test]
fn refuses_a_non_loopback_listen_address() {
    let dir = TempDir::new();
    let keys = dir.path().join("k.json");
    write_keys(&keys, AK, SK, None);
    let out = run_to_end(&[
        "--listen", "0.0.0.0:9000", "--endpoint", "https://acc.r2.cloudflarestorage.com",
        "--bucket", BUCKET, "--keys-file", keys.to_str().unwrap(),
    ]);
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr(&out).contains("loopback"), "{}", stderr(&out));
}

#[test]
fn refuses_keys_on_the_command_line() {
    let out = run_to_end(&["--access-key-id", "AKIA", "--bucket", BUCKET]);
    assert!(!out.status.success());
    assert!(stderr(&out).contains("unknown option"), "{}", stderr(&out));
}

#[test]
fn missing_or_malformed_keys_file_is_a_clear_error() {
    let dir = TempDir::new();
    let missing = dir.path().join("nope.json");
    let args = |keys: &std::path::Path| {
        run_to_end(&[
            "--listen", "127.0.0.1:0", "--endpoint", "https://acc.r2.cloudflarestorage.com",
            "--bucket", BUCKET, "--keys-file", keys.to_str().unwrap(),
        ])
    };
    let out = args(&missing);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("cannot open keys file"), "{}", stderr(&out));

    let bad = dir.path().join("bad.json");
    write_keys(&bad, "", "", None);
    let out = args(&bad);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("non-empty"), "{}", stderr(&out));
}

#[cfg(unix)]
#[test]
fn refuses_to_start_with_a_world_readable_keys_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new();
    let keys = dir.path().join("k.json");
    write_keys(&keys, AK, SK, None);
    for mode in [0o644, 0o640, 0o604] {
        std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(mode)).unwrap();
        let out = run_to_end(&[
            "--listen", "127.0.0.1:0", "--endpoint", "https://acc.r2.cloudflarestorage.com",
            "--bucket", BUCKET, "--keys-file", keys.to_str().unwrap(),
        ]);
        assert_eq!(out.status.code(), Some(1), "mode {mode:o}");
        let err = stderr(&out);
        assert!(err.contains("chmod 600") && !err.contains(SK), "{err}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn serves_a_signed_request_through_the_real_binary() {
    let fake = start_ok_fake().await;
    let dir = TempDir::new();
    let keys = dir.path().join("r2.json");
    write_keys(&keys, AK, SK, None);
    let listen: SocketAddr = format!("127.0.0.1:{}", free_port()).parse().unwrap();
    let _child = spawn(listen, &fake.url(), &keys);

    let got = send(listen, "GET", &format!("/{BUCKET}/data/a.parquet"), &[("range", "bytes=0-3")], "").await;
    assert_eq!(got.status, 200);
    let seen = fake.only();
    seen.assert_signed_ok();
    assert!(seen.signed("range"));

    let got = send(listen, "GET", "/someone-elses-bucket/x", &[], "").await;
    assert_eq!(got.status, 403);
    assert_eq!(fake.seen().len(), 1);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sighup_reloads_the_keys_without_dropping_the_listener() {
    let fake = start_ok_fake().await;
    let dir = TempDir::new();
    let keys = dir.path().join("r2.json");
    write_keys(&keys, AK, SK, None);
    let listen: SocketAddr = format!("127.0.0.1:{}", free_port()).parse().unwrap();
    let child = spawn(listen, &fake.url(), &keys);
    let target = format!("/{BUCKET}/k");
    assert_eq!(send(listen, "GET", &target, &[], "").await.status, 200);

    *fake.keys.lock().unwrap() = ("AKIANEWKEYID0000002".to_string(), "newSecretKey0123456789".to_string());
    write_keys(&keys, "AKIANEWKEYID0000002", "newSecretKey0123456789", None);
    let hup = Command::new("kill").args(["-HUP", &child.0.id().to_string()]).status().unwrap();
    assert!(hup.success());

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if send(listen, "GET", &target, &[], "").await.status == 200 {
            break;
        }
        assert!(Instant::now() < deadline, "the new keys were never picked up");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
