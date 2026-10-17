//! The loopback HTTP listener and the per-request log line.

use crate::proxy::Proxy;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;

/// Accepts connections forever and serves each on its own task.
pub async fn serve(listener: TcpListener, proxy: Arc<Proxy>) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                // typically out of file descriptors: back off instead of spinning
                eprintln!("accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let proxy = proxy.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| {
                let proxy = proxy.clone();
                async move {
                    let method = req.method().clone();
                    let path = req.uri().path().to_string();
                    let started = Instant::now();
                    let resp = proxy.handle(req).await;
                    // time to the response headers; the body keeps streaming after this line
                    eprintln!("{method} {path} {} {}ms", resp.status().as_u16(), started.elapsed().as_millis());
                    Ok::<_, Infallible>(resp)
                }
            });
            if let Err(e) = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await {
                if !e.is_incomplete_message() && !e.is_canceled() {
                    eprintln!("connection error: {e}");
                }
            }
        });
    }
}
