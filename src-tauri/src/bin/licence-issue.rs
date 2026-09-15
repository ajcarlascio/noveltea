//! Issuing tool. Not shipped: `required-features = ["issuing"]` keeps it out of the app.
//!
//! Two jobs, and both stay on the seller's machine. `keygen` makes the pair whose public
//! half is compiled into the app; `issue` signs a licence with the private half. The app
//! binary contains no signing key and no code path that wants one.
//!
//!   cargo run --features issuing --bin licence-issue -- keygen
//!   cargo run --features issuing --bin licence-issue -- issue \
//!       --key ~/.noveltea-licence.key --name "Jane Smith" --max-major 1

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{SigningKey, SECRET_KEY_LENGTH};
use noveltea_lib::licence::{sign, Licence};

fn arg(name: &str) -> Option<String> {
    let mut args = std::env::args();
    while let Some(found) = args.next() {
        if found == name {
            return args.next();
        }
    }
    None
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("keygen") => keygen(),
        Some("issue") => issue(),
        _ => {
            eprintln!("usage: licence-issue keygen");
            eprintln!("       licence-issue issue --key <path> --name <name> [--max-major N] [--id ID]");
            std::process::exit(2);
        }
    }
}

/// Writes a private key and prints the public half to paste into `licence.rs`.
///
/// The private key goes to a file rather than the terminal so it does not end up in a
/// shell history, and is written with owner-only permissions.
fn keygen() {
    let path = arg("--out").unwrap_or_else(|| {
        format!("{}/.noveltea-licence.key", std::env::var("HOME").unwrap_or_default())
    });

    // Read from the OS rather than a crate RNG, so this depends on nothing but std.
    // `read_exact`, never `fs::read`: /dev/urandom has no end, so reading the whole
    // "file" never returns and the tool hangs instead of making a key.
    let mut secret = [0u8; SECRET_KEY_LENGTH];
    if let Err(error) = std::fs::File::open("/dev/urandom")
        .and_then(|mut source| std::io::Read::read_exact(&mut source, &mut secret))
    {
        eprintln!("could not read /dev/urandom ({error}); refusing to invent a key");
        std::process::exit(1);
    }

    let signing = SigningKey::from_bytes(&secret);
    let encoded = URL_SAFE_NO_PAD.encode(secret);
    std::fs::write(&path, format!("{encoded}\n")).expect("write private key");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    println!("private key written to {path} — keep it, and keep it secret");
    println!();
    println!("paste this into src/licence.rs as PUBLIC_KEY:");
    println!("{}", URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()));
}

fn issue() {
    let path = arg("--key").expect("--key <path to private key>");
    let name = arg("--name").expect("--name <buyer name>");
    let max_major: u32 = arg("--max-major").unwrap_or_else(|| "1".into()).parse().expect("--max-major");
    let id = arg("--id").unwrap_or_else(|| {
        // Short and unique enough to find a sale by; not a secret and not a uuid, because
        // it is read aloud in support conversations.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{nanos:x}")
    });
    let issued = arg("--issued").unwrap_or_else(|| "unknown".into());

    let raw = std::fs::read_to_string(&path).expect("read private key");
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.trim())
        .ok()
        .and_then(|b| <[u8; SECRET_KEY_LENGTH]>::try_from(b).ok())
        .expect("private key is not a NovelTea signing key");

    let licence = Licence { id, name, max_major, issued };
    println!("{}", sign(&licence, &SigningKey::from_bytes(&bytes)));
}
