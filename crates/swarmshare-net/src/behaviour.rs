//! Combined libp2p NetworkBehaviour for SwarmShare.

use libp2p::{
    StreamProtocol,
    gossipsub, identify, kad, mdns,
    request_response::{self, ProtocolSupport},
    swarm::NetworkBehaviour,
};

use crate::protocol::{ChunkRequest, ChunkResponse, ManifestRequest, ManifestResponse};

pub const CHUNK_PROTO: StreamProtocol = StreamProtocol::new("/swarmshare/chunk/1.0.0");
pub const MANIFEST_PROTO: StreamProtocol = StreamProtocol::new("/swarmshare/manifest/1.0.0");
pub const GOSSIP_TOPIC: &str = "swarmshare-files-v1";
pub const KADEMLIA_PROTO: StreamProtocol = StreamProtocol::new("/swarmshare/kad/1.0.0");

#[derive(NetworkBehaviour)]
pub struct SwarmBehaviour {
    pub kademlia: kad::Behaviour<kad::store::MemoryStore>,
    pub gossipsub: gossipsub::Behaviour,
    pub mdns: mdns::tokio::Behaviour,
    pub identify: identify::Behaviour,
    pub chunk_rpc: request_response::cbor::Behaviour<ChunkRequest, ChunkResponse>,
    pub manifest_rpc: request_response::cbor::Behaviour<ManifestRequest, ManifestResponse>,
}

impl SwarmBehaviour {
    pub fn new(
        local_key: &libp2p::identity::Keypair,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let peer_id = local_key.public().to_peer_id();

        // Kademlia with custom protocol name so we don't collide with IPFS.
        let mut kad_cfg = kad::Config::new(KADEMLIA_PROTO);
        kad_cfg.set_query_timeout(std::time::Duration::from_secs(60));
        let store = kad::store::MemoryStore::new(peer_id);
        let mut kademlia = kad::Behaviour::with_config(peer_id, store, kad_cfg);
        kademlia.set_mode(Some(kad::Mode::Server));

        // Gossipsub for file announcements.
        let gossipsub = gossipsub::Behaviour::new(
            gossipsub::MessageAuthenticity::Signed(local_key.clone()),
            gossipsub::ConfigBuilder::default()
                .heartbeat_interval(std::time::Duration::from_secs(1))
                .validation_mode(gossipsub::ValidationMode::Strict)
                .build()
                .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) as Box<dyn std::error::Error + Send + Sync>)?,
        )
        .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) as Box<dyn std::error::Error + Send + Sync>)?;

        let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), peer_id).map_err(
            |e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) as Box<dyn std::error::Error + Send + Sync>,
        )?;

        let identify = identify::Behaviour::new(identify::Config::new(
            "/swarmshare/identify/1.0.0".to_string(),
            local_key.public(),
        ));

        let chunk_rpc = request_response::cbor::Behaviour::new(
            [(CHUNK_PROTO, ProtocolSupport::Full)],
            request_response::Config::default(),
        );
        let manifest_rpc = request_response::cbor::Behaviour::new(
            [(MANIFEST_PROTO, ProtocolSupport::Full)],
            request_response::Config::default(),
        );

        Ok(Self {
            kademlia,
            gossipsub,
            mdns,
            identify,
            chunk_rpc,
            manifest_rpc,
        })
    }
}
