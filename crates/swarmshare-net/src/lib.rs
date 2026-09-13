//! SwarmShare Net — libp2p node with:
//! - Kademlia DHT (providers + manifest/search records)
//! - Gossipsub (live file announcements + HAVE/WANT chatter)
//! - mDNS (zero-config LAN discovery) + Identify
//! - Request-Response (chunk exchange, CBOR codec)
//! - Transports: TCP + QUIC (UDP) + DNS, Noise encryption, Yamux muxing

pub mod behaviour;
pub mod node;
pub mod protocol;

pub use node::{Client, EventLoop, Node, NodeEvent, new_node, parse_peer_addr};
pub use protocol::{ChunkRequest, ChunkResponse, ManifestRequest, ManifestResponse};
