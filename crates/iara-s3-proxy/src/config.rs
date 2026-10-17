//! Command-line options and the keys file.

use serde::Deserialize;
use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

/// Usage text printed for `--help` and after a bad command line.
pub const USAGE: &str = "\
usage: iara-s3-proxy --endpoint <url> --bucket <name> --keys-file <path> [options]

  --endpoint <url>     S3 endpoint, e.g. https://<account>.r2.cloudflarestorage.com
  --bucket <name>      the only bucket the proxy serves
  --keys-file <path>   JSON {\"access_key_id\": ..., \"secret_access_key\": ..., \"session_token\": ...}
                       (session_token optional); must not be readable by group/others
  --listen <addr>      loopback ip:port to listen on (default 127.0.0.1:9000)
  --region <name>      signing region (default auto)

The keys are re-read on SIGHUP. They are never taken from argv or the environment.";

/// A configuration problem; the message is shown to the operator as is.
#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

fn err<T>(msg: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(msg.into()))
}

/// The upstream S3 endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// `https` or `http`.
    pub scheme: String,
    /// `host[:port]` as used in the request URI.
    pub authority: String,
    /// The `Host` header value (the authority without a default port); this is what gets signed.
    pub host_header: String,
}

impl Endpoint {
    /// Parses `scheme://host[:port][/]`.
    pub fn parse(url: &str) -> Result<Endpoint, ConfigError> {
        let uri: hyper::Uri = url
            .parse()
            .map_err(|e| ConfigError(format!("--endpoint {url:?} is not a valid URL: {e}")))?;
        let scheme = match uri.scheme_str() {
            Some(s @ ("http" | "https")) => s.to_string(),
            _ => return err(format!("--endpoint {url:?} must start with https:// (or http://)")),
        };
        let authority = match uri.authority() {
            Some(a) if !a.as_str().contains('@') => a.clone(),
            Some(_) => return err("--endpoint must not contain credentials"),
            None => return err(format!("--endpoint {url:?} has no host")),
        };
        let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
        if path_and_query != "/" {
            return err("--endpoint must be just scheme://host[:port], without a path or query");
        }
        let default_port = if scheme == "https" { 443 } else { 80 };
        let host_header = match authority.port_u16() {
            Some(p) if p == default_port => authority.host().to_string(),
            _ => authority.as_str().to_string(),
        };
        Ok(Endpoint {
            scheme,
            authority: authority.as_str().to_string(),
            host_header,
        })
    }
}

/// Validated settings of one proxy run.
#[derive(Debug, Clone)]
pub struct Config {
    pub listen: SocketAddr,
    pub endpoint: Endpoint,
    pub bucket: String,
    pub region: String,
    pub keys_file: PathBuf,
}

/// What the command line asked for.
#[derive(Debug)]
pub enum Command {
    Run(Config),
    Help,
}

fn check_bucket(bucket: &str) -> Result<(), ConfigError> {
    let ok = !bucket.is_empty()
        && bucket
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'));
    if ok {
        Ok(())
    } else {
        err(format!("--bucket {bucket:?} is not a valid bucket name"))
    }
}

/// Parses the arguments after the program name.
pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Result<Command, ConfigError> {
    let mut listen = None;
    let (mut endpoint, mut bucket, mut region, mut keys_file) = (None, None, None, None);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "-h" || arg == "--help" {
            return Ok(Command::Help);
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg, None),
        };
        let slot = match flag.as_str() {
            "--listen" => &mut listen,
            "--endpoint" => &mut endpoint,
            "--bucket" => &mut bucket,
            "--region" => &mut region,
            "--keys-file" => &mut keys_file,
            other => return err(format!("unknown option {other:?} (keys are only read from --keys-file)")),
        };
        let value = match inline.or_else(|| args.next()) {
            Some(v) => v,
            None => return err(format!("{flag} needs a value")),
        };
        if slot.replace(value).is_some() {
            return err(format!("{flag} given twice"));
        }
    }
    let need = |v: Option<String>, flag: &str| v.ok_or_else(|| ConfigError(format!("missing {flag}")));
    let listen = listen.unwrap_or_else(|| "127.0.0.1:9000".to_string());
    let listen: SocketAddr = listen
        .parse()
        .map_err(|_| ConfigError(format!("--listen {listen:?} must be an ip:port such as 127.0.0.1:9000")))?;
    if !listen.ip().is_loopback() {
        return err(format!("--listen {listen} is not a loopback address; the proxy only listens on 127.0.0.1 or ::1"));
    }
    let bucket = need(bucket, "--bucket")?;
    check_bucket(&bucket)?;
    Ok(Command::Run(Config {
        listen,
        endpoint: Endpoint::parse(&need(endpoint, "--endpoint")?)?,
        bucket,
        region: region.unwrap_or_else(|| "auto".to_string()),
        keys_file: PathBuf::from(need(keys_file, "--keys-file")?),
    }))
}

/// The credentials the proxy signs with.
#[derive(Clone, PartialEq, Eq, Deserialize)]
pub struct Keys {
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default)]
    pub session_token: Option<String>,
}

impl fmt::Debug for Keys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Keys(..)")
    }
}

/// Fails when group or others can access the file (unix); the keys file must be mode 0600 or 0400.
#[cfg(unix)]
fn check_private(file: &std::fs::File, path: &Path) -> Result<(), ConfigError> {
    use std::os::unix::fs::PermissionsExt;
    let meta = file
        .metadata()
        .map_err(|e| ConfigError(format!("cannot stat keys file {}: {e}", path.display())))?;
    if !meta.is_file() {
        return err(format!("keys file {} is not a regular file", path.display()));
    }
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return err(format!(
            "keys file {} has mode {mode:04o}, which lets group/others read it; run: chmod 600 {}",
            path.display(),
            path.display()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_private(_file: &std::fs::File, _path: &Path) -> Result<(), ConfigError> {
    Ok(())
}

/// Reads and validates the keys file (checking its mode on unix before reading the contents).
pub fn load_keys(path: &Path) -> Result<Keys, ConfigError> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| ConfigError(format!("cannot open keys file {}: {e}", path.display())))?;
    check_private(&file, path)?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| ConfigError(format!("cannot read keys file {}: {e}", path.display())))?;
    let mut keys: Keys = serde_json::from_str(&text)
        .map_err(|e| ConfigError(format!("keys file {} is not valid: {e}", path.display())))?;
    if keys.access_key_id.trim().is_empty() || keys.secret_access_key.trim().is_empty() {
        return err(format!(
            "keys file {} needs non-empty access_key_id and secret_access_key",
            path.display()
        ));
    }
    keys.session_token = keys.session_token.filter(|t| !t.is_empty());
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    fn run(s: &str) -> Result<Config, ConfigError> {
        match parse_args(args(s))? {
            Command::Run(c) => Ok(c),
            Command::Help => err("help"),
        }
    }

    const FULL: &str = "--listen 127.0.0.1:9000 --endpoint https://acc.r2.cloudflarestorage.com \
                        --bucket team-data --region auto --keys-file /etc/iara/r2.json";

    #[test]
    fn parses_the_documented_command_line() {
        let c = run(FULL).unwrap();
        assert_eq!(c.listen, "127.0.0.1:9000".parse().unwrap());
        assert_eq!(c.bucket, "team-data");
        assert_eq!(c.region, "auto");
        assert_eq!(c.keys_file, PathBuf::from("/etc/iara/r2.json"));
        assert_eq!(c.endpoint.scheme, "https");
        assert_eq!(c.endpoint.host_header, "acc.r2.cloudflarestorage.com");
    }

    #[test]
    fn defaults_and_equals_syntax() {
        let c = run("--endpoint=http://127.0.0.1:8080 --bucket=b --keys-file=k.json").unwrap();
        assert_eq!(c.listen.to_string(), "127.0.0.1:9000");
        assert_eq!(c.region, "auto");
        assert_eq!(c.endpoint.host_header, "127.0.0.1:8080");
        assert_eq!(c.endpoint.scheme, "http");
    }

    #[test]
    fn refuses_non_loopback_listen() {
        for addr in ["0.0.0.0:9000", "192.168.1.5:9000", "[::]:9000", "10.0.0.1:1"] {
            let e = run(&FULL.replace("127.0.0.1:9000", addr)).unwrap_err();
            assert!(e.0.contains("loopback"), "{addr}: {e}");
        }
        assert!(run(&FULL.replace("127.0.0.1:9000", "[::1]:9000")).is_ok());
        let e = run(&FULL.replace("127.0.0.1:9000", "localhost:9000")).unwrap_err();
        assert!(e.0.contains("ip:port"), "{e}");
    }

    #[test]
    fn rejects_keys_on_the_command_line_and_bad_input() {
        for extra in ["--access-key AKIA", "--secret-access-key x", "--session-token t", "--bogus"] {
            let e = run(&format!("{FULL} {extra}")).unwrap_err();
            assert!(e.0.contains("unknown option"), "{extra}: {e}");
        }
        assert!(run("--bucket b --keys-file k").unwrap_err().0.contains("--endpoint"));
        assert!(run("--endpoint https://h --keys-file k").unwrap_err().0.contains("--bucket"));
        assert!(run("--endpoint https://h --bucket b").unwrap_err().0.contains("--keys-file"));
        assert!(run(&format!("{FULL} --bucket other")).unwrap_err().0.contains("twice"));
        assert!(run("--endpoint https://h --bucket a/b --keys-file k").is_err());
        assert!(run("--endpoint").unwrap_err().0.contains("needs a value"));
        assert!(matches!(parse_args(args("--help")), Ok(Command::Help)));
    }

    #[test]
    fn endpoint_parsing() {
        let e = Endpoint::parse("https://acc.r2.cloudflarestorage.com/").unwrap();
        assert_eq!(e.authority, "acc.r2.cloudflarestorage.com");
        assert_eq!(Endpoint::parse("https://h:443").unwrap().host_header, "h");
        assert_eq!(Endpoint::parse("https://h:9443").unwrap().host_header, "h:9443");
        assert_eq!(Endpoint::parse("http://h:80").unwrap().host_header, "h");
        for bad in ["ftp://h", "h.example.com", "https://u:p@h", "https://h/bucket", "https://h/?x=1", "https://"] {
            assert!(Endpoint::parse(bad).is_err(), "{bad}");
        }
    }

    fn tmp_file(name: &str, content: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("iara-s3-proxy-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        path
    }

    #[test]
    fn loads_keys_with_and_without_a_session_token() {
        let p = tmp_file("a.json", r#"{"access_key_id":"AK","secret_access_key":"SK"}"#);
        let k = load_keys(&p).unwrap();
        assert_eq!((k.access_key_id.as_str(), k.secret_access_key.as_str()), ("AK", "SK"));
        assert_eq!(k.session_token, None);
        let p = tmp_file("b.json", r#"{"access_key_id":"AK","secret_access_key":"SK","session_token":"T","extra":1}"#);
        assert_eq!(load_keys(&p).unwrap().session_token.as_deref(), Some("T"));
        let p = tmp_file("c.json", r#"{"access_key_id":"AK","secret_access_key":"SK","session_token":""}"#);
        assert_eq!(load_keys(&p).unwrap().session_token, None);
    }

    #[test]
    fn rejects_bad_keys_files_without_echoing_secrets() {
        let p = tmp_file("d.json", r#"{"access_key_id":"AK","secret_access_key":""}"#);
        assert!(load_keys(&p).unwrap_err().0.contains("non-empty"));
        let p = tmp_file("e.json", r#"{"access_key_id":"AK","secret_access_key":"TOPSECRET""#);
        let e = load_keys(&p).unwrap_err();
        assert!(!e.0.contains("TOPSECRET"), "{e}");
        let p = tmp_file("f.json", r#"{"access_key_id":"AK"}"#);
        assert!(load_keys(&p).is_err());
        assert!(load_keys(Path::new("/definitely/not/here.json")).unwrap_err().0.contains("cannot open"));
    }

    #[test]
    fn keys_debug_does_not_print_secrets() {
        let k = Keys { access_key_id: "AK".into(), secret_access_key: "SECRET".into(), session_token: Some("TOK".into()) };
        let shown = format!("{k:?}");
        assert!(!shown.contains("SECRET") && !shown.contains("TOK") && !shown.contains("AK"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_keys_file_readable_by_group_or_others() {
        use std::os::unix::fs::PermissionsExt;
        let p = tmp_file("g.json", r#"{"access_key_id":"AK","secret_access_key":"SK"}"#);
        for (mode, ok) in [(0o600, true), (0o400, true), (0o644, false), (0o640, false), (0o604, false), (0o660, false), (0o666, false)] {
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            let r = load_keys(&p);
            assert_eq!(r.is_ok(), ok, "mode {mode:o}: {r:?}");
            if !ok {
                assert!(r.unwrap_err().0.contains("chmod 600"));
            }
        }
    }
}
