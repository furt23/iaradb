use iara_s3_proxy::config::{load_keys, parse_args, Command, USAGE};
use iara_s3_proxy::proxy::Proxy;
use iara_s3_proxy::server::serve;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::net::TcpListener;

/// Re-reads the keys file on every SIGHUP, keeping the old keys when the new file is bad.
#[cfg(unix)]
fn reload_on_sighup(proxy: Arc<Proxy>) -> std::io::Result<()> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut hup = signal(SignalKind::hangup())?;
    tokio::spawn(async move {
        while hup.recv().await.is_some() {
            match proxy.reload_keys() {
                Ok(()) => eprintln!("keys reloaded"),
                Err(e) => eprintln!("keys reload failed, keeping the previous keys: {e}"),
            }
        }
    });
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    let config = match parse_args(std::env::args().skip(1)) {
        Ok(Command::Run(config)) => config,
        Ok(Command::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("iara-s3-proxy: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let keys = match load_keys(&config.keys_file) {
        Ok(keys) => keys,
        Err(e) => {
            eprintln!("iara-s3-proxy: {e}");
            return ExitCode::FAILURE;
        }
    };
    let listener = match TcpListener::bind(config.listen).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("iara-s3-proxy: cannot listen on {}: {e}", config.listen);
            return ExitCode::FAILURE;
        }
    };
    let proxy = Arc::new(Proxy::new(&config, keys));
    #[cfg(unix)]
    if let Err(e) = reload_on_sighup(proxy.clone()) {
        eprintln!("iara-s3-proxy: cannot install the SIGHUP handler: {e}");
        return ExitCode::FAILURE;
    }
    eprintln!(
        "listening on {}, serving s3://{} through {} (region {})",
        config.listen, config.bucket, config.endpoint.authority, config.region
    );
    serve(listener, proxy).await;
    ExitCode::SUCCESS
}
