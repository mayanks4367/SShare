//! Shared SShare protocol types (dependency-light: serde only).
//!
//! - [`signaling`]: WebSocket signaling message envelope (mirrors
//!   `signaling/PROTOCOL.md` v1 and `SignalingClient`).
//! - [`web`]: browser-facing transfer manifest + descriptors served by the
//!   Rust HTTP gateway. File bytes never appear in any of these types.
//! - [`state`]: the transfer state model shared by CLI, web and native UIs.

pub mod signaling;
pub mod state;
pub mod web;

pub use signaling::{
    ClientMessage, ErrorCode, IceCandidatePayload, PeerInfo, Role, SdpPayload, ServerMessage,
    validate_client_message,
};
pub use state::TransferState;
pub use web::{TransferDescriptor, WebManifest};
