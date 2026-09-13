//! Async P2P node: owns the libp2p Swarm, drives DHT + gossip + RPC.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use futures::{
    SinkExt, StreamExt,
    channel::{mpsc, oneshot},
};
use libp2p::{
    Multiaddr, PeerId, Swarm, SwarmBuilder,
    gossipsub::{self, IdentTopic},
    identify, kad,
    mdns,
    multiaddr::Protocol,
    noise,
    request_response::{self, OutboundRequestId, ResponseChannel},
    swarm::SwarmEvent,
    tcp, yamux,
};
use tokio::sync::Mutex;
use tracing::{debug, info};

use swarmshare_core::BlockStore;

use crate::{
    behaviour::{GOSSIP_TOPIC, SwarmBehaviour},
    protocol::{ChunkRequest, ChunkResponse, ManifestRequest, ManifestResponse},
};

/// Events emitted to the application layer.
#[derive(Debug)]
pub enum NodeEvent {
    NewListenAddr(Multiaddr),
    PeerDiscovered(PeerId),
    /// A file announcement seen on gossipsub.
    FileAnnounced {
        file_id: String,
        file_name: String,
        from: PeerId,
    },
    IncomingChunkRequest {
        from: PeerId,
        request: ChunkRequest,
        channel: ResponseChannel<ChunkResponse>,
    },
    IncomingManifestRequest {
        from: PeerId,
        request: ManifestRequest,
        channel: ResponseChannel<ManifestResponse>,
    },
    GossipMessage(String),
}

// ---- client handle ----

#[derive(Clone)]
pub struct Client {
    tx: mpsc::Sender<Command>,
    pub local_peer_id: PeerId,
}

impl Client {
    pub async fn listen(&mut self, addr: Multiaddr) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Listen { addr, reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        rx.await.map_err(|_| anyhow::anyhow!("node gone"))??;
        Ok(())
    }

    pub async fn dial(&mut self, addr: Multiaddr) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Dial { addr, reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        rx.await.map_err(|_| anyhow::anyhow!("node gone"))??;
        Ok(())
    }

    pub async fn add_bootstrap(&mut self, addr: Multiaddr, peer: PeerId) {
        let _ = self
            .tx
            .send(Command::AddBootstrap { addr, peer })
            .await;
    }

    pub async fn bootstrap_dht(&mut self) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::BootstrapDht { reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        rx.await.map_err(|_| anyhow::anyhow!("node gone"))??;
        Ok(())
    }

    /// Announce ourselves as provider for `key` (usually file_id) on the DHT.
    pub async fn start_providing(&mut self, key: String) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::StartProviding { key, reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        rx.await.map_err(|_| anyhow::anyhow!("node gone"))??;
        Ok(())
    }

    pub async fn get_providers(&mut self, key: String) -> anyhow::Result<HashSet<PeerId>> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::GetProviders { key, reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        Ok(rx.await.map_err(|_| anyhow::anyhow!("node gone"))??)
    }

    pub async fn put_record(&mut self, key: String, value: Vec<u8>) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::PutRecord { key, value, reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        rx.await.map_err(|_| anyhow::anyhow!("node gone"))??;
        Ok(())
    }

    pub async fn get_record(&mut self, key: String) -> anyhow::Result<Vec<Vec<u8>>> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::GetRecord { key, reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        Ok(rx.await.map_err(|_| anyhow::anyhow!("node gone"))??)
    }

    pub async fn publish_announce(&mut self, msg: String) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Publish { msg, reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        rx.await.map_err(|_| anyhow::anyhow!("node gone"))??;
        Ok(())
    }

    pub async fn request_chunk(
        &mut self,
        peer: PeerId,
        req: ChunkRequest,
    ) -> anyhow::Result<ChunkResponse> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::RequestChunk { peer, req, reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        let inner = rx
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))??;
        inner.await.map_err(|_| anyhow::anyhow!("request cancelled"))?
    }

    pub async fn request_manifest(
        &mut self,
        peer: PeerId,
        req: ManifestRequest,
    ) -> anyhow::Result<ManifestResponse> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::RequestManifest { peer, req, reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        let inner = rx
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))??;
        inner.await.map_err(|_| anyhow::anyhow!("request cancelled"))?
    }

    pub async fn connected_peers(&mut self) -> anyhow::Result<Vec<PeerId>> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Peers { reply: tx })
            .await
            .map_err(|_| anyhow::anyhow!("node gone"))?;
        Ok(rx.await.map_err(|_| anyhow::anyhow!("node gone"))?)
    }
}

// ---- commands ----

#[derive(Debug)]
enum Command {
    Listen {
        addr: Multiaddr,
        reply: oneshot::Sender<anyhow::Result<()>>,
    },
    Dial {
        addr: Multiaddr,
        reply: oneshot::Sender<anyhow::Result<()>>,
    },
    AddBootstrap {
        addr: Multiaddr,
        peer: PeerId,
    },
    BootstrapDht {
        reply: oneshot::Sender<anyhow::Result<()>>,
    },
    StartProviding {
        key: String,
        reply: oneshot::Sender<anyhow::Result<()>>,
    },
    GetProviders {
        key: String,
        reply: oneshot::Sender<anyhow::Result<HashSet<PeerId>>>,
    },
    PutRecord {
        key: String,
        value: Vec<u8>,
        reply: oneshot::Sender<anyhow::Result<()>>,
    },
    GetRecord {
        key: String,
        reply: oneshot::Sender<anyhow::Result<Vec<Vec<u8>>>>,
    },
    Publish {
        msg: String,
        reply: oneshot::Sender<anyhow::Result<()>>,
    },
    RequestChunk {
        peer: PeerId,
        req: ChunkRequest,
        reply: oneshot::Sender<anyhow::Result<oneshot::Receiver<anyhow::Result<ChunkResponse>>>>,
    },
    RequestManifest {
        peer: PeerId,
        req: ManifestRequest,
        reply: oneshot::Sender<anyhow::Result<oneshot::Receiver<anyhow::Result<ManifestResponse>>>>,
    },
    RespondChunk {
        channel: ResponseChannel<ChunkResponse>,
        resp: ChunkResponse,
    },
    RespondManifest {
        channel: ResponseChannel<ManifestResponse>,
        resp: ManifestResponse,
    },
    Peers {
        reply: oneshot::Sender<Vec<PeerId>>,
    },
}

impl Client {
    pub async fn respond_chunk(
        &mut self,
        channel: ResponseChannel<ChunkResponse>,
        resp: ChunkResponse,
    ) {
        let _ = self.tx.send(Command::RespondChunk { channel, resp }).await;
    }
    pub async fn respond_manifest(
        &mut self,
        channel: ResponseChannel<ManifestResponse>,
        resp: ManifestResponse,
    ) {
        let _ = self
            .tx
            .send(Command::RespondManifest { channel, resp })
            .await;
    }
}

// ---- node ----

pub struct Node {
    swarm: Swarm<SwarmBehaviour>,
    cmd_rx: mpsc::Receiver<Command>,
    evt_tx: mpsc::Sender<NodeEvent>,
    store: Arc<Mutex<BlockStore>>,
    topic: IdentTopic,
    pending_provide: HashMap<kad::QueryId, oneshot::Sender<anyhow::Result<()>>>,
    pending_providers: HashMap<kad::QueryId, PendingProviders>,
    pending_put: HashMap<kad::QueryId, oneshot::Sender<anyhow::Result<()>>>,
    pending_get: HashMap<kad::QueryId, PendingGet>,
    pending_chunk: HashMap<OutboundRequestId, oneshot::Sender<anyhow::Result<ChunkResponse>>>,
    pending_manifest:
        HashMap<OutboundRequestId, oneshot::Sender<anyhow::Result<ManifestResponse>>>,
    pending_dial: HashMap<PeerId, Vec<oneshot::Sender<anyhow::Result<()>>>>,
}

struct PendingProviders {
    tx: oneshot::Sender<anyhow::Result<HashSet<PeerId>>>,
    acc: HashSet<PeerId>,
}

struct PendingGet {
    tx: Option<oneshot::Sender<anyhow::Result<Vec<Vec<u8>>>>>,
    acc: Vec<Vec<u8>>,
}

pub async fn new_node(
    keypair: libp2p::identity::Keypair,
    store: BlockStore,
    cmd_buf: usize,
    evt_buf: usize,
) -> anyhow::Result<(Client, mpsc::Receiver<NodeEvent>, EventLoop)> {
    let peer_id = keypair.public().to_peer_id();

    let mut swarm = SwarmBuilder::with_existing_identity(keypair.clone())
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_quic()
        .with_dns()?
        .with_behaviour(|key| SwarmBehaviour::new(key))?
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(120)))
        .build();

    // Subscribe to announcements topic.
    let topic = IdentTopic::new(GOSSIP_TOPIC);
    swarm.behaviour_mut().gossipsub.subscribe(&topic)?;

    let (cmd_tx, cmd_rx) = mpsc::channel(cmd_buf);
    let (evt_tx, evt_rx) = mpsc::channel(evt_buf);

    let client = Client {
        tx: cmd_tx,
        local_peer_id: peer_id,
    };
    let node = Node {
        swarm,
        cmd_rx,
        evt_tx,
        store: Arc::new(Mutex::new(store)),
        topic,
        pending_provide: Default::default(),
        pending_providers: Default::default(),
        pending_put: Default::default(),
        pending_get: Default::default(),
        pending_chunk: Default::default(),
        pending_manifest: Default::default(),
        pending_dial: Default::default(),
    };
    Ok((client, evt_rx, EventLoop { node }))
}

pub struct EventLoop {
    node: Node,
}

impl EventLoop {
    pub async fn run(mut self) {
        let Node {
            ref mut swarm,
            ref mut cmd_rx,
            ref mut evt_tx,
            ref store,
            ref topic,
            ref mut pending_provide,
            ref mut pending_providers,
            ref mut pending_put,
            ref mut pending_get,
            ref mut pending_chunk,
            ref mut pending_manifest,
            ref mut pending_dial,
        } = &mut self.node;

        loop {
            tokio::select! {
                ev = swarm.select_next_some() => {
                    handle_swarm_event(
                        swarm, evt_tx, store, topic,
                        pending_provide, pending_providers, pending_put,
                        pending_get, pending_chunk, pending_manifest, pending_dial,
                        ev,
                    ).await;
                }
                cmd = cmd_rx.next() => {
                    let Some(cmd) = cmd else { break; };
                    handle_command(
                        swarm, store, topic,
                        pending_provide, pending_providers, pending_put,
                        pending_get, pending_chunk, pending_manifest, pending_dial,
                        cmd,
                    ).await;
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_command(
    swarm: &mut Swarm<SwarmBehaviour>,
    _store: &Arc<Mutex<BlockStore>>,
    topic: &IdentTopic,
    pending_provide: &mut HashMap<kad::QueryId, oneshot::Sender<anyhow::Result<()>>>,
    pending_providers: &mut HashMap<kad::QueryId, PendingProviders>,
    pending_put: &mut HashMap<kad::QueryId, oneshot::Sender<anyhow::Result<()>>>,
    pending_get: &mut HashMap<kad::QueryId, PendingGet>,
    pending_chunk: &mut HashMap<OutboundRequestId, oneshot::Sender<anyhow::Result<ChunkResponse>>>,
    pending_manifest: &mut HashMap<OutboundRequestId, oneshot::Sender<anyhow::Result<ManifestResponse>>>,
    pending_dial: &mut HashMap<PeerId, Vec<oneshot::Sender<anyhow::Result<()>>>>,
    cmd: Command,
) {
    match cmd {
        Command::Listen { addr, reply } => {
            let r = swarm.listen_on(addr).map(|_| ()).map_err(|e| anyhow::anyhow!(e));
            let _ = reply.send(r);
        }
        Command::Dial { addr, reply } => {
            // Extract peer id if present for tracking.
            let peer = addr.iter().find_map(|p| match p {
                Protocol::P2p(id) => Some(id),
                _ => None,
            });
            match swarm.dial(addr) {
                Ok(()) => {
                    if let Some(p) = peer {
                        pending_dial.entry(p).or_default().push(reply);
                    } else {
                        let _ = reply.send(Ok(()));
                    }
                }
                Err(e) => {
                    let _ = reply.send(Err(anyhow::anyhow!(e)));
                }
            }
        }
        Command::AddBootstrap { addr, peer } => {
            swarm.behaviour_mut().kademlia.add_address(&peer, addr);
        }
        Command::BootstrapDht { reply } => {
            match swarm.behaviour_mut().kademlia.bootstrap() {
                Ok(_) => {
                    let _ = reply.send(Ok(()));
                }
                Err(e) => {
                    let _ = reply.send(Err(anyhow::anyhow!(e)));
                }
            }
        }
        Command::StartProviding { key, reply } => {
            let k: kad::RecordKey = key.into_bytes().into();
            match swarm.behaviour_mut().kademlia.start_providing(k) {
                Ok(id) => {
                    pending_provide.insert(id, reply);
                }
                Err(e) => {
                    let _ = reply.send(Err(anyhow::anyhow!(e)));
                }
            }
        }
        Command::GetProviders { key, reply } => {
            let k: kad::RecordKey = key.into_bytes().into();
            let id = swarm.behaviour_mut().kademlia.get_providers(k);
            pending_providers.insert(id, PendingProviders { tx: reply, acc: HashSet::new() });
        }
        Command::PutRecord { key, value, reply } => {
            let record = kad::Record {
                key: key.into_bytes().into(),
                value,
                publisher: None,
                expires: None,
            };
            match swarm
                .behaviour_mut()
                .kademlia
                .put_record(record, kad::Quorum::One)
            {
                Ok(id) => {
                    pending_put.insert(id, reply);
                }
                Err(e) => {
                    let _ = reply.send(Err(anyhow::anyhow!(e)));
                }
            }
        }
        Command::GetRecord { key, reply } => {
            let k: kad::RecordKey = key.into_bytes().into();
            let id = swarm.behaviour_mut().kademlia.get_record(k);
            pending_get.insert(id, PendingGet { tx: Some(reply), acc: Vec::new() });
        }
        Command::Publish { msg, reply } => {
            let r = swarm
                .behaviour_mut()
                .gossipsub
                .publish(topic.clone(), msg.as_bytes())
                .map(|_| ())
                .map_err(|e| anyhow::anyhow!(e));
            let _ = reply.send(r);
        }
        Command::RequestChunk { peer, req, reply } => {
            let id = swarm.behaviour_mut().chunk_rpc.send_request(&peer, req);
            let (tx, rx) = oneshot::channel();
            pending_chunk.insert(id, tx);
            let _ = reply.send(Ok(rx));
        }
        Command::RequestManifest { peer, req, reply } => {
            let id = swarm.behaviour_mut().manifest_rpc.send_request(&peer, req);
            let (tx, rx) = oneshot::channel();
            pending_manifest.insert(id, tx);
            let _ = reply.send(Ok(rx));
        }
        Command::RespondChunk { channel, resp } => {
            let _ = swarm.behaviour_mut().chunk_rpc.send_response(channel, resp);
        }
        Command::RespondManifest { channel, resp } => {
            let _ = swarm.behaviour_mut().manifest_rpc.send_response(channel, resp);
        }
        Command::Peers { reply } => {
            let peers: Vec<PeerId> = swarm.connected_peers().copied().collect();
            let _ = reply.send(peers);
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_swarm_event(
    swarm: &mut Swarm<SwarmBehaviour>,
    evt_tx: &mut mpsc::Sender<NodeEvent>,
    store: &Arc<Mutex<BlockStore>>,
    _topic: &IdentTopic,
    pending_provide: &mut HashMap<kad::QueryId, oneshot::Sender<anyhow::Result<()>>>,
    pending_providers: &mut HashMap<kad::QueryId, PendingProviders>,
    pending_put: &mut HashMap<kad::QueryId, oneshot::Sender<anyhow::Result<()>>>,
    pending_get: &mut HashMap<kad::QueryId, PendingGet>,
    pending_chunk: &mut HashMap<OutboundRequestId, oneshot::Sender<anyhow::Result<ChunkResponse>>>,
    pending_manifest: &mut HashMap<OutboundRequestId, oneshot::Sender<anyhow::Result<ManifestResponse>>>,
    pending_dial: &mut HashMap<PeerId, Vec<oneshot::Sender<anyhow::Result<()>>>>,
    event: SwarmEvent<crate::behaviour::SwarmBehaviourEvent>,
) {
    match event {
        SwarmEvent::NewListenAddr { address, .. } => {
            info!("listening on {}", address);
            let _ = evt_tx.send(NodeEvent::NewListenAddr(address)).await;
        }
        SwarmEvent::ConnectionEstablished { peer_id, .. } => {
            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
            if let Some(list) = pending_dial.remove(&peer_id) {
                for tx in list {
                    let _ = tx.send(Ok(()));
                }
            }
        }
        SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
            if let Some(p) = peer_id {
                if let Some(list) = pending_dial.remove(&p) {
                    for tx in list {
                        let _ = tx.send(Err(anyhow::anyhow!(error.to_string())));
                    }
                }
            }
        }
        SwarmEvent::Behaviour(ev) => match ev {
            crate::behaviour::SwarmBehaviourEvent::Mdns(mdns::Event::Discovered(list)) => {
                for (peer, addr) in list {
                    debug!("mDNS discovered {} @ {}", peer, addr);
                    swarm.behaviour_mut().kademlia.add_address(&peer, addr);
                    swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer);
                    let _ = evt_tx.send(NodeEvent::PeerDiscovered(peer)).await;
                }
            }
            crate::behaviour::SwarmBehaviourEvent::Mdns(mdns::Event::Expired(list)) => {
                for (peer, addr) in list {
                    swarm.behaviour_mut().kademlia.remove_address(&peer, &addr);
                    swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer);
                }
            }
            crate::behaviour::SwarmBehaviourEvent::Identify(identify::Event::Received {
                peer_id,
                info,
                ..
            }) => {
                for addr in info.listen_addrs {
                    swarm.behaviour_mut().kademlia.add_address(&peer_id, addr);
                }
            }
            crate::behaviour::SwarmBehaviourEvent::Gossipsub(gossipsub::Event::Message {
                message,
                propagation_source,
                ..
            }) => {
                if let Ok(text) = String::from_utf8(message.data.clone()) {
                    // Announcement envelope: {"file_id":..,"file_name":..}
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let (Some(fid), Some(fname)) =
                            (v.get("file_id"), v.get("file_name"))
                        {
                            let _ = evt_tx
                                .send(NodeEvent::FileAnnounced {
                                    file_id: fid.as_str().unwrap_or("").to_string(),
                                    file_name: fname.as_str().unwrap_or("").to_string(),
                                    from: propagation_source,
                                })
                                .await;
                            return;
                        }
                    }
                    let _ = evt_tx.send(NodeEvent::GossipMessage(text)).await;
                }
            }
            crate::behaviour::SwarmBehaviourEvent::Kademlia(kad::Event::OutboundQueryProgressed {
                id,
                result,
                ..
            }) => match result {
                kad::QueryResult::StartProviding(Ok(_)) => {
                    if let Some(tx) = pending_provide.remove(&id) {
                        let _ = tx.send(Ok(()));
                    }
                }
                kad::QueryResult::StartProviding(Err(e)) => {
                    if let Some(tx) = pending_provide.remove(&id) {
                        let _ = tx.send(Err(anyhow::anyhow!(e)));
                    }
                }
                kad::QueryResult::GetProviders(Ok(kad::GetProvidersOk::FoundProviders {
                    providers,
                    ..
                })) => {
                    if let Some(p) = pending_providers.get_mut(&id) {
                        p.acc.extend(providers);
                    }
                }
                kad::QueryResult::GetProviders(Ok(
                    kad::GetProvidersOk::FinishedWithNoAdditionalRecord { .. },
                )) => {
                    if let Some(p) = pending_providers.remove(&id) {
                        let _ = p.tx.send(Ok(p.acc));
                    } else {
                        // Late finish: still try to finish query state quietly.
                    }
                }
                kad::QueryResult::GetProviders(Err(e)) => {
                    if let Some(p) = pending_providers.remove(&id) {
                        // Return what we have, or error if empty.
                        if p.acc.is_empty() {
                            let _ = p.tx.send(Err(anyhow::anyhow!(e)));
                        } else {
                            let _ = p.tx.send(Ok(p.acc));
                        }
                    }
                }
                kad::QueryResult::PutRecord(Ok(_)) => {
                    if let Some(tx) = pending_put.remove(&id) {
                        let _ = tx.send(Ok(()));
                    }
                }
                kad::QueryResult::PutRecord(Err(e)) => {
                    if let Some(tx) = pending_put.remove(&id) {
                        let _ = tx.send(Err(anyhow::anyhow!(e)));
                    }
                }
                kad::QueryResult::GetRecord(Ok(kad::GetRecordOk::FoundRecord(record))) => {
                    if let Some(p) = pending_get.get_mut(&id) {
                        p.acc.push(record.record.value.clone());
                    }
                }
                kad::QueryResult::GetRecord(Ok(
                    kad::GetRecordOk::FinishedWithNoAdditionalRecord { .. },
                )) => {
                    if let Some(mut p) = pending_get.remove(&id) {
                        if let Some(tx) = p.tx.take() {
                            let _ = tx.send(Ok(std::mem::take(&mut p.acc)));
                        }
                    }
                }
                kad::QueryResult::GetRecord(Err(e)) => {
                    if let Some(mut p) = pending_get.remove(&id) {
                        if let Some(tx) = p.tx.take() {
                            if p.acc.is_empty() {
                                let _ = tx.send(Err(anyhow::anyhow!(e)));
                            } else {
                                let _ = tx.send(Ok(std::mem::take(&mut p.acc)));
                            }
                        }
                    }
                }
                _ => {}
            },
            // Kademlia record results need version-tolerant handling: some
            // libp2p versions emit GetRecordOk::FoundRecord(PeerRecord) while
            // others include QueryStats. Fall through to generic logging for
            // anything not explicitly completed above.
            crate::behaviour::SwarmBehaviourEvent::Kademlia(_) => {}
            crate::behaviour::SwarmBehaviourEvent::ChunkRpc(
                request_response::Event::Message { message, peer, .. },
            ) => match message {
                request_response::Message::Request { request, channel, .. } => {
                    // Serve from local block store if present.
                    let found_data = {
                        let s = store.lock().await;
                        if s.has_block(&request.hash) {
                            s.get_block(&request.hash).ok()
                        } else {
                            None
                        }
                    };
                    if let Some(data) = found_data {
                        let _ = swarm.behaviour_mut().chunk_rpc.send_response(
                            channel,
                            ChunkResponse { data, found: true },
                        );
                    } else {
                        // Still forward to app layer (for choke decisions), but
                        // auto-reply not-found so requesters don't hang.
                        let _ = evt_tx
                            .send(NodeEvent::IncomingChunkRequest {
                                from: peer,
                                request,
                                channel,
                            })
                            .await;
                        // NOTE: app layer should respond; if it doesn't, the
                        // requester times out via request-response defaults.
                    }
                }
                request_response::Message::Response { request_id, response } => {
                    if let Some(tx) = pending_chunk.remove(&request_id) {
                        let _ = tx.send(Ok(response));
                    }
                }
            },
            crate::behaviour::SwarmBehaviourEvent::ChunkRpc(
                request_response::Event::OutboundFailure { request_id, error, .. },
            ) => {
                if let Some(tx) = pending_chunk.remove(&request_id) {
                    let _ = tx.send(Err(anyhow::anyhow!(error)));
                }
            }
            crate::behaviour::SwarmBehaviourEvent::ChunkRpc(_) => {}
            crate::behaviour::SwarmBehaviourEvent::ManifestRpc(
                request_response::Event::Message { message, peer, .. },
            ) => match message {
                request_response::Message::Request { request, channel, .. } => {
                    let maybe_json = {
                        let s = store.lock().await;
                        s.get_manifest(&request.file_id).ok().and_then(|m| m.to_json().ok())
                    };
                    if let Some(json) = maybe_json {
                        let _ = swarm.behaviour_mut().manifest_rpc.send_response(
                            channel,
                            ManifestResponse { manifest_json: json, found: true },
                        );
                    } else {
                        let _ = evt_tx
                            .send(NodeEvent::IncomingManifestRequest {
                                from: peer,
                                request,
                                channel,
                            })
                            .await;
                    }
                }
                request_response::Message::Response { request_id, response } => {
                    if let Some(tx) = pending_manifest.remove(&request_id) {
                        let _ = tx.send(Ok(response));
                    }
                }
            },
            crate::behaviour::SwarmBehaviourEvent::ManifestRpc(
                request_response::Event::OutboundFailure { request_id, error, .. },
            ) => {
                if let Some(tx) = pending_manifest.remove(&request_id) {
                    let _ = tx.send(Err(anyhow::anyhow!(error)));
                }
            }
            crate::behaviour::SwarmBehaviourEvent::ManifestRpc(_) => {}
            crate::behaviour::SwarmBehaviourEvent::Identify(_) => {}
            crate::behaviour::SwarmBehaviourEvent::Gossipsub(_) => {}
        },
        _ => {}
    }
}

/// Helper: parse a multiaddr with peer id.
pub fn parse_peer_addr(s: &str) -> anyhow::Result<(PeerId, Multiaddr)> {
    let addr: Multiaddr = s.parse()?;
    let peer = addr.iter().find_map(|p| match p {
        Protocol::P2p(id) => Some(id),
        _ => None,
    }).ok_or_else(|| anyhow::anyhow!("multiaddr missing /p2p/<peer-id>"))?;
    Ok((peer, addr))
}
