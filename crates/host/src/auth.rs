use sha2::{Digest, Sha256};

pub fn token() -> String { format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()) }

pub fn hash(token: &str) -> String { format!("{:x}", Sha256::digest(token.as_bytes())) }
