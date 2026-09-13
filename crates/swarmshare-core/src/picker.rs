//! Download intelligence: rarest-first picker, peer reputation,
//! and tit-for-tat choking (BitTorrent-style fairness).
//!
//! - `RarestFirstPicker`: given availability counts per chunk, pick the
//!   rarest missing chunk first (maximises swarm health).
//! - `PeerReputation`: EWMA success tracking; bad peers get deprioritised.
//! - `ChokeManager`: only N concurrent upload slots; every 10s optimistically
//!   unchoke a random peer (BitTorrent fairness).

use std::collections::{HashMap, HashSet};

// NOTE: core crate stays libp2p-free; peers are plain base58 strings.

/// Pick next chunk to download.
pub struct RarestFirstPicker {
    num_chunks: usize,
    /// chunk -> set of peers that have it (peer as string id)
    availability: Vec<HashSet<String>>,
}

impl RarestFirstPicker {
    pub fn new(num_chunks: usize) -> Self {
        Self {
            num_chunks,
            availability: vec![HashSet::new(); num_chunks],
        }
    }

    pub fn advertise(&mut self, peer: &str, have: &HashSet<usize>) {
        for &i in have {
            if i < self.num_chunks {
                self.availability[i].insert(peer.to_string());
            }
        }
    }

    pub fn set_have(&mut self, peer: &str, index: usize) {
        if index < self.num_chunks {
            self.availability[index].insert(peer.to_string());
        }
    }

    /// Rarest missing chunk first. Returns None when nothing downloadable.
    pub fn next(&self, missing: &HashSet<usize>) -> Option<usize> {
        let mut best: Option<(usize, usize)> = None; // (rarity, index)
        for &i in missing {
            let r = self.availability.get(i).map(|s| s.len()).unwrap_or(0);
            if r == 0 {
                continue; // nobody has it (yet)
            }
            match best {
                None => best = Some((r, i)),
                Some((br, _)) if r < br => best = Some((r, i)),
                _ => {}
            }
        }
        best.map(|(_, i)| i)
    }

    /// Peers holding a given chunk.
    pub fn holders(&self, index: usize) -> Vec<String> {
        self.availability
            .get(index)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// Tracks per-peer reliability in [0,1]. Starts at 0.5 (neutral).
pub struct PeerReputation {
    scores: HashMap<String, f64>,
}

impl Default for PeerReputation {
    fn default() -> Self {
        Self {
            scores: HashMap::new(),
        }
    }
}

impl PeerReputation {
    pub fn score(&self, peer: &str) -> f64 {
        *self.scores.get(peer).unwrap_or(&0.5)
    }

    pub fn report_success(&mut self, peer: &str) {
        let e = self.scores.entry(peer.to_string()).or_insert(0.5);
        *e = (*e * 0.8 + 1.0 * 0.2).min(1.0);
    }

    pub fn report_failure(&mut self, peer: &str) {
        let e = self.scores.entry(peer.to_string()).or_insert(0.5);
        *e = (*e * 0.8).max(0.0);
    }

    /// Order candidate peers best-first.
    pub fn rank(&self, peers: Vec<String>) -> Vec<String> {
        let mut p = peers;
        p.sort_by(|a, b| {
            self.score(b)
                .partial_cmp(&self.score(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        p
    }
}

/// BitTorrent-style choking: limit concurrent uploads, optimistic unchoke.
pub struct ChokeManager {
    pub upload_slots: usize,
    unchoked: HashSet<String>,
    round: u64,
}

impl ChokeManager {
    pub fn new(upload_slots: usize) -> Self {
        Self {
            upload_slots,
            unchoked: HashSet::new(),
            round: 0,
        }
    }

    /// Recompute unchoked set: top peers by uploaded contribution + 1 random
    /// optimistic unchoke. `contrib` maps peer -> bytes we downloaded from them.
    pub fn rechoke(&mut self, contrib: &HashMap<String, u64>, rng_pick: Option<String>) {
        self.round += 1;
        let mut ranked: Vec<(&String, &u64)> = contrib.iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(a.1));
        self.unchoked.clear();
        for (p, _) in ranked.into_iter().take(self.upload_slots.max(1) - 1) {
            self.unchoked.insert(p.clone());
        }
        // Optimistic unchoke: give one newcomer a chance.
        if let Some(p) = rng_pick {
            self.unchoked.insert(p);
        }
    }

    pub fn is_unchoked(&self, peer: &str) -> bool {
        // If we never rechoked, allow everyone (bootstrap).
        if self.round == 0 {
            return true;
        }
        self.unchoked.contains(peer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rarest_first() {
        let mut p = RarestFirstPicker::new(3);
        p.set_have("a", 0);
        p.set_have("a", 1);
        p.set_have("b", 1);
        p.set_have("a", 2);
        p.set_have("b", 2);
        p.set_have("c", 2);
        let missing: HashSet<usize> = [0, 1, 2].into_iter().collect();
        assert_eq!(p.next(&missing), Some(0)); // rarest
    }

    #[test]
    fn reputation_ranking() {
        let mut r = PeerReputation::default();
        r.report_success("good");
        r.report_success("good");
        r.report_failure("bad");
        r.report_failure("bad");
        let ranked = r.rank(vec!["bad".into(), "good".into(), "new".into()]);
        assert_eq!(ranked[0], "good");
    }
}
