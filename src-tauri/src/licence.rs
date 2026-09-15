//! Licence keys: the format, and the two things done to it.
//!
//! A key is a signed statement of three facts — who bought it, which id it is, and the
//! highest major version it covers. It is verified offline, on the device, against a
//! public key compiled into the binary. There is no activation server and no call home:
//! an app that stops working when a licence server is unreachable is not a local-first
//! app, whatever else it does.
//!
//! **There is no clock in a key.** No expiry, no issue-date check, no offline grace
//! period. A key covers major versions up to a bound and does so forever, which is what
//! "Purchase NovelTea 1.0" means. That removes clock skew, timezone handling and the
//! whole class of bug where an author's laptop battery dies and their software stops
//! working. The date is recorded for support and is never compared to anything.
//!
//! Signing lives here too, next to verification, so the issuer and the verifier can
//! never drift into disagreeing about the format — the round trip is one test away
//! rather than one repository away. The private key is not in this repository and the
//! app never has one; `sign` takes it as an argument and only the issuing tool calls it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Marks the format so a later one can be told apart rather than guessed at.
const PREFIX: &str = "NT1";

/// The public half of the licensing key pair, base64url, no padding.
///
/// Compiled in, so a key can be checked with no network. Replacing it invalidates every
/// key ever issued, which is why it is a constant and not a setting.
pub const PUBLIC_KEY: &str = "oRowaBOI69kWQKM7ZbUYvH634pb1N9zoNLQCQw-I8lo";

/// What a key says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Licence {
    /// The licence's own id, for support to find the sale.
    pub id: String,
    /// Who bought it. Shown in About — a mild deterrent, because people do not post a
    /// key with their own name on it, and no contact details to leak.
    pub name: String,
    /// The highest major version this key covers, inclusive.
    #[serde(rename = "max")]
    pub max_major: u32,
    /// The day it was issued, for support. Never compared against anything.
    #[serde(rename = "iss")]
    pub issued: String,
}

/// Why a key was not accepted.
///
/// Separated from "this key is fine but does not cover this version", which is not an
/// error at all — see [`Status`]. An author whose key is simply older should not be told
/// their key is invalid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invalid {
    /// Not a NovelTea key at all — usually a partial paste.
    Malformed,
    /// Well-formed, but not signed by us. A tampered payload lands here.
    BadSignature,
}

impl Invalid {
    /// What to show an author. Both cases are things they can act on.
    pub fn message(&self) -> &'static str {
        match self {
            Invalid::Malformed => {
                "That does not look like a NovelTea key. Copy the whole line, including \
                 the NT1 at the start."
            }
            Invalid::BadSignature => {
                "That key could not be verified. If you typed it by hand, paste it \
                 instead; otherwise ask where you bought it for a replacement."
            }
        }
    }
}

/// Where a valid key stands against the version that is running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// Licensed for this version.
    Covers(Licence),
    /// A real key, for an earlier major version than this build.
    ///
    /// Deliberately not an error. The key is genuine and the purchase was real; it
    /// simply does not reach this version, and the interface says so in those terms.
    TooOld { licence: Licence, running: u32 },
}

/// Encodes and signs a licence. Only the issuing tool calls this.
pub fn sign(licence: &Licence, key: &SigningKey) -> String {
    let payload = serde_json::to_vec(licence).expect("a Licence always serialises");
    let signature = key.sign(&payload);
    format!(
        "{PREFIX}.{}.{}",
        URL_SAFE_NO_PAD.encode(&payload),
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}

/// Checks a key against a public key and returns what it says.
///
/// The signature is verified over the payload **bytes as they arrived**, never over
/// re-serialised JSON. Round-tripping through a struct first would let two encodings of
/// the same data verify differently — a key that works on one build and not the next.
pub fn verify(key: &str, public_key: &str) -> Result<Licence, Invalid> {
    let mut parts = key.trim().split('.');
    let (Some(PREFIX), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Invalid::Malformed);
    };

    let payload = URL_SAFE_NO_PAD.decode(payload).map_err(|_| Invalid::Malformed)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| Invalid::Malformed)?;
    let signature: [u8; 64] = signature.try_into().map_err(|_| Invalid::Malformed)?;

    let verifying = URL_SAFE_NO_PAD
        .decode(public_key)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .and_then(|bytes| VerifyingKey::from_bytes(&bytes).ok())
        .ok_or(Invalid::Malformed)?;

    verifying
        .verify(&payload, &Signature::from_bytes(&signature))
        .map_err(|_| Invalid::BadSignature)?;

    // Only now is the payload trusted enough to parse. Parsing first would run the JSON
    // reader over attacker-supplied bytes for no reason.
    serde_json::from_slice(&payload).map_err(|_| Invalid::Malformed)
}

/// The major version of a `1.2.3` string, or 0 if it cannot be read.
///
/// Zero is the safe answer: it is below every bound a key can carry, so an unreadable
/// version means a key covers this build rather than locking someone out of one they
/// paid for.
pub fn major_of(version: &str) -> u32 {
    version
        .split('.')
        .next()
        .and_then(|major| major.parse().ok())
        .unwrap_or(0)
}

/// Verifies a key and places it against the running version.
pub fn status(key: &str, public_key: &str, running_version: &str) -> Result<Status, Invalid> {
    let licence = verify(key, public_key)?;
    let running = major_of(running_version);
    Ok(if running <= licence.max_major {
        Status::Covers(licence)
    } else {
        Status::TooOld { licence, running }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SECRET_KEY_LENGTH;

    fn keys() -> (SigningKey, String) {
        // A fixed key, so the tests are deterministic and a failure is about the format
        // rather than about which key today's run happened to make.
        let signing = SigningKey::from_bytes(&[7u8; SECRET_KEY_LENGTH]);
        let public = URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes());
        (signing, public)
    }

    fn licence() -> Licence {
        Licence {
            id: "3f2a".into(),
            name: "Jane Smith".into(),
            max_major: 1,
            issued: "2026-08-28".into(),
        }
    }

    #[test]
    fn the_embedded_public_key_is_a_real_ed25519_key() {
        // Catches the paste error: a truncated or mistyped PUBLIC_KEY would refuse every
        // key ever issued, and would do it only once a customer tried one.
        let bytes = URL_SAFE_NO_PAD.decode(PUBLIC_KEY).expect("PUBLIC_KEY is not base64url");
        let bytes: [u8; 32] = bytes.try_into().expect("PUBLIC_KEY is not 32 bytes");
        VerifyingKey::from_bytes(&bytes).expect("PUBLIC_KEY is not a valid Ed25519 key");
    }

    #[test]
    fn the_embedded_public_key_matches_the_signing_key() {
        // The check that a released build must not ship without, and the one that cannot
        // live here as a fixture: a valid key committed to a public repository is a free
        // licence. So the key comes from the environment, and the test is a no-op unless
        // someone supplies one.
        //
        //   NOVELTEA_TEST_LICENCE="$(licence-issue issue --key ... --name Test)" cargo test
        let Ok(key) = std::env::var("NOVELTEA_TEST_LICENCE") else { return };
        match verify(&key, PUBLIC_KEY) {
            Ok(held) => assert!(!held.name.is_empty(), "a licence must name its holder"),
            Err(reason) => panic!("the embedded public key rejects a real key: {reason:?}"),
        }
    }

    #[test]
    fn a_signed_key_verifies_and_says_what_it_said() {
        let (signing, public) = keys();
        let key = sign(&licence(), &signing);
        assert_eq!(verify(&key, &public), Ok(licence()));
    }

    #[test]
    fn a_key_signed_by_someone_else_is_refused() {
        let (_, public) = keys();
        let impostor = SigningKey::from_bytes(&[9u8; SECRET_KEY_LENGTH]);
        let key = sign(&licence(), &impostor);
        assert_eq!(verify(&key, &public), Err(Invalid::BadSignature));
    }

    #[test]
    fn editing_the_payload_breaks_the_signature() {
        // The whole point. Someone who edits "max":1 to "max":99 in a real key must not
        // get a real licence out of it.
        let (signing, public) = keys();
        let key = sign(&licence(), &signing);

        let mut parts: Vec<&str> = key.split('.').collect();
        let mut payload: Licence =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        payload.max_major = 99;
        let forged = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        parts[1] = &forged;

        assert_eq!(verify(&parts.join("."), &public), Err(Invalid::BadSignature));
    }

    #[test]
    fn rubbish_is_malformed_rather_than_a_bad_signature() {
        // The two are told apart because the advice differs: a partial paste is fixed by
        // pasting again, a bad signature by asking for a replacement.
        let (_, public) = keys();
        for bad in ["", "NT1", "NT1.a", "NT2.a.b", "hello", "NT1.!!.!!", "NT1.a.b.c"] {
            assert_eq!(verify(bad, &public), Err(Invalid::Malformed), "{bad}");
        }
    }

    #[test]
    fn surrounding_whitespace_is_forgiven() {
        // People paste from an email, and an email adds a newline.
        let (signing, public) = keys();
        let key = sign(&licence(), &signing);
        assert_eq!(verify(&format!("  {key}\n"), &public), Ok(licence()));
    }

    #[test]
    fn a_key_covers_every_major_version_up_to_its_bound() {
        let (signing, public) = keys();
        let key = sign(&licence(), &signing);

        for version in ["0.1.0", "1.0.0", "1.9.4"] {
            assert!(
                matches!(status(&key, &public, version), Ok(Status::Covers(_))),
                "{version} should be covered by a max_major of 1"
            );
        }
    }

    #[test]
    fn a_real_key_for_an_older_version_is_not_an_error() {
        // It is a genuine purchase that does not reach this build. Reporting it as an
        // invalid key would tell an author their licence is fake, which it is not.
        let (signing, public) = keys();
        let key = sign(&licence(), &signing);

        match status(&key, &public, "2.0.0") {
            Ok(Status::TooOld { licence: held, running }) => {
                assert_eq!(held.name, "Jane Smith");
                assert_eq!(running, 2);
            }
            other => panic!("expected TooOld, got {other:?}"),
        }
    }

    #[test]
    fn an_unreadable_version_is_treated_as_covered() {
        // Zero is below every bound a key can carry. The failure this avoids is locking
        // someone out of software they paid for because a version string was odd.
        let (signing, public) = keys();
        let key = sign(&licence(), &signing);
        assert!(matches!(status(&key, &public, "not-a-version"), Ok(Status::Covers(_))));
        assert_eq!(major_of("not-a-version"), 0);
    }
}
