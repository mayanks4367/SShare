//! WebSocket signaling message types (protocol v1).
//!
//! Wire-compatible with `signaling/src/protocol.ts`: JSON text frames with a
//! `type` discriminator in UPPER_SNAKE_CASE and camelCase fields. Validation
//! mirrors the Node service so a Rust client/server enforces identical rules.

use serde::{Deserialize, Serialize};

/// Client -> server message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    CreateRoom {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_peers: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttl_sec: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    JoinRoom {
        room: String,
        role: Role,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Offer {
        room: String,
        sdp: SdpPayload,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Answer {
        room: String,
        sdp: SdpPayload,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    IceCandidate {
        room: String,
        candidate: IceCandidatePayload,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Leave {
        room: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TransferReady {
        room: String,
        #[serde(flatten, default)]
        descriptor: TransferDescriptorBody,
    },
    #[serde(rename_all = "camelCase")]
    TransferComplete {
        room: String,
        #[serde(flatten, default)]
        descriptor: TransferDescriptorBody,
    },
}

/// Server -> client message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ServerMessage {
    #[serde(rename_all = "camelCase")]
    Welcome {
        #[serde(rename = "clientId")]
        client_id: String,
    },
    #[serde(rename_all = "camelCase")]
    RoomCreated {
        room: String,
        #[serde(rename = "expiresAt")]
        expires_at: u64,
        #[serde(rename = "maxPeers")]
        max_peers: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Joined {
        room: String,
        #[serde(rename = "clientId")]
        client_id: String,
        peers: Vec<PeerInfo>,
        #[serde(rename = "expiresAt")]
        expires_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PeerJoined {
        room: String,
        peer: PeerInfo,
    },
    #[serde(rename_all = "camelCase")]
    Offer {
        room: String,
        from: String,
        sdp: SdpPayload,
    },
    #[serde(rename_all = "camelCase")]
    Answer {
        room: String,
        from: String,
        sdp: SdpPayload,
    },
    #[serde(rename_all = "camelCase")]
    IceCandidate {
        room: String,
        from: String,
        candidate: IceCandidatePayload,
    },
    #[serde(rename_all = "camelCase")]
    PeerLeft {
        room: String,
        peer: String,
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    Left {
        room: String,
    },
    #[serde(rename_all = "camelCase")]
    TransferReady {
        room: String,
        from: String,
        #[serde(flatten, default)]
        descriptor: TransferDescriptorBody,
    },
    #[serde(rename_all = "camelCase")]
    TransferComplete {
        room: String,
        from: String,
        #[serde(flatten, default)]
        descriptor: TransferDescriptorBody,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        code: ErrorCode,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Sender,
    Receiver,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SdpPayload {
    /// "offer" | "answer" on the wire (`type` is a Rust keyword).
    #[serde(rename = "type")]
    pub sdp_type: String,
    pub sdp: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IceCandidatePayload {
    pub candidate: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "sdpMid")]
    pub sdp_mid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "sdpMLineIndex")]
    pub sdp_m_line_index: Option<u32>,
}

/// Optional transfer header fields (metadata only — never file bytes).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferDescriptorBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "transferId")]
    pub transfer_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "fileName")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "fileSize")]
    pub file_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunks: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerInfo {
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub role: Role,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidJson,
    UnknownType,
    ValidationError,
    RoomNotFound,
    RoomExpired,
    RoomFull,
    NotInRoom,
    RateLimited,
    PayloadTooLarge,
}

// ---------------------------------------------------------------------------
// Validation (mirrors signaling/src/protocol.ts validateClientMessage)
// ---------------------------------------------------------------------------

/// Message keys that must never appear: file bytes are forbidden on signaling.
const FORBIDDEN_KEYS: &[&str] = &[
    "data", "chunk", "chunks_blob", "blob", "bytes", "payload", "fileData", "buffer",
];

pub const MAX_MESSAGE_BYTES: usize = 128 * 1024;
pub const MAX_SDP_BYTES: usize = 64 * 1024;
pub const MIN_SDP_BYTES: usize = 32;
pub const MAX_CANDIDATE_BYTES: usize = 4096;
pub const MAX_FILENAME_LEN: usize = 255;
pub const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024 * 1024;
pub const MAX_TRANSFER_ID_LEN: usize = 64;

pub fn valid_room_id(room: &str) -> bool {
    let len = room.len();
    (3..=32).contains(&len)
        && room
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
}

/// Validate a *parsed* client message (already size-checked JSON).
/// Returns `Ok(())` or a human-readable reason for an ERROR frame.
pub fn validate_client_message(msg: &serde_json::Value) -> Result<(), String> {
    let obj = msg
        .as_object()
        .ok_or_else(|| "message must be a JSON object".to_string())?;
    for k in obj.keys() {
        if FORBIDDEN_KEYS.contains(&k.as_str()) {
            return Err("file bytes are forbidden on the signaling channel".to_string());
        }
    }
    let t = obj
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing message type".to_string())?;

    // Structural parse first: unknown shapes fail here.
    let parsed: Result<ClientMessage, _> = serde_json::from_value(msg.clone());
    let parsed = parsed.map_err(|e| format!("invalid {}: {}", t, e))?;

    match parsed {
        ClientMessage::CreateRoom { max_peers, ttl_sec, .. } => {
            if let Some(n) = max_peers {
                if !(2..=8).contains(&n) {
                    return Err("maxPeers must be an integer 2..8".to_string());
                }
            }
            if let Some(s) = ttl_sec {
                if !(60..=4 * 3600).contains(&s) {
                    return Err("ttlSec must be an integer 60..14400".to_string());
                }
            }
            Ok(())
        }
        ClientMessage::JoinRoom { room, .. } => {
            if !valid_room_id(&room) {
                return Err("room must match /^[A-Z0-9-]{3,32}$/".to_string());
            }
            Ok(())
        }
        ClientMessage::Offer { room, sdp, .. } | ClientMessage::Answer { room, sdp, .. } => {
            if !valid_room_id(&room) {
                return Err("room must match /^[A-Z0-9-]{3,32}$/".to_string());
            }
            check_sdp(&sdp)
        }
        ClientMessage::IceCandidate { room, candidate, .. } => {
            if !valid_room_id(&room) {
                return Err("room must match /^[A-Z0-9-]{3,32}$/".to_string());
            }
            if candidate.candidate.is_empty() {
                return Err("candidate.candidate must be a non-empty string".to_string());
            }
            if candidate.candidate.len() > MAX_CANDIDATE_BYTES {
                return Err(format!("candidate.candidate must be <= {} chars", MAX_CANDIDATE_BYTES));
            }
            Ok(())
        }
        ClientMessage::Leave { room, .. } => {
            if !valid_room_id(&room) {
                return Err("room must match /^[A-Z0-9-]{3,32}$/".to_string());
            }
            Ok(())
        }
        ClientMessage::TransferReady { room, descriptor }
        | ClientMessage::TransferComplete { room, descriptor } => {
            if !valid_room_id(&room) {
                return Err("room must match /^[A-Z0-9-]{3,32}$/".to_string());
            }
            check_descriptor(&descriptor)
        }
    }
}

fn check_sdp(sdp: &SdpPayload) -> Result<(), String> {
    if sdp.sdp_type != "offer" && sdp.sdp_type != "answer" {
        return Err("sdp.type must be offer|answer".to_string());
    }
    if sdp.sdp.len() < MIN_SDP_BYTES || sdp.sdp.len() > MAX_SDP_BYTES {
        return Err(format!("sdp.sdp must be {}..{} chars", MIN_SDP_BYTES, MAX_SDP_BYTES));
    }
    if !sdp.sdp.starts_with("v=") {
        return Err("sdp.sdp must start with v=".to_string());
    }
    Ok(())
}

fn check_descriptor(d: &TransferDescriptorBody) -> Result<(), String> {
    if let Some(id) = &d.transfer_id {
        if id.is_empty() || id.len() > MAX_TRANSFER_ID_LEN {
            return Err("transferId must be a non-empty string <= 64 chars".to_string());
        }
    }
    if let Some(name) = &d.file_name {
        if name.is_empty() || name.len() > MAX_FILENAME_LEN {
            return Err("fileName must be 1..255 chars".to_string());
        }
    }
    if let Some(size) = d.file_size {
        if size > MAX_FILE_SIZE {
            return Err("fileSize must be a number in range".to_string());
        }
    }
    if let Some(chunks) = d.chunks {
        if chunks == 0 || chunks > 1_000_000 {
            return Err("chunks must be an integer in range".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_compat_with_node_protocol() {
        // CREATE_ROOM serializes exactly like the Node/TS client sends.
        let m = ClientMessage::CreateRoom { request_id: Some("r1".into()), max_peers: None, ttl_sec: None };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["type"], json!("CREATE_ROOM"));
        assert_eq!(v["requestId"], json!("r1"));

        // JOINED parses the Node server shape.
        let joined: ServerMessage = serde_json::from_value(json!({
            "type": "JOINED", "room": "SS-ABC123", "clientId": "c1",
            "peers": [{"clientId": "c2", "role": "sender"}],
            "expiresAt": 123
        }))
        .unwrap();
        match joined {
            ServerMessage::Joined { peers, .. } => {
                assert_eq!(peers.len(), 1);
                assert_eq!(peers[0].role, Role::Sender);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn validation_mirrors_node_rules() {
        let sdp = format!("v={}", "0\r\n".repeat(20));
        assert!(validate_client_message(&json!({"type": "CREATE_ROOM"})).is_ok());
        assert!(validate_client_message(&json!({"type": "CREATE_ROOM", "maxPeers": 99})).is_err());
        assert!(validate_client_message(&json!({"type": "JOIN_ROOM", "room": "SS-ABC123", "role": "sender"})).is_ok());
        assert!(validate_client_message(&json!({"type": "JOIN_ROOM", "room": "!!!", "role": "sender"})).is_err());
        assert!(validate_client_message(&json!({"type": "OFFER", "room": "SS-ABC123", "sdp": {"type": "offer", "sdp": sdp}})).is_ok());
        assert!(validate_client_message(&json!({"type": "OFFER", "room": "SS-ABC123", "sdp": {"type": "offer", "sdp": "x"}})).is_err());
        // File bytes forbidden...
        assert!(validate_client_message(&json!({"type": "TRANSFER_READY", "room": "SS-ABC123", "data": "AAA"})).is_err());
        // ...but metadata headers fine.
        assert!(validate_client_message(&json!({
            "type": "TRANSFER_READY", "room": "SS-ABC123",
            "transferId": "SS-X", "fileName": "a.bin", "fileSize": 10, "chunks": 1
        }))
        .is_ok());
        assert!(validate_client_message(&json!({"type": "NOPE"})).is_err());
    }
}
