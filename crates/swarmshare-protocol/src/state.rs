//! Transfer state model shared by CLI, web and native UIs.
//!
//! States mirror the TypeScript `TransferStatus`/page phases so every
//! client reports the same lifecycle. [`TransferState::can_transition_to`]
//! encodes the legal DAG; UIs use it to enable/disable actions.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferState {
    Idle,
    FileSelected,
    CreatingSession,
    WaitingForPeer,
    PeerConnected,
    Connecting,
    Transferring,
    Paused,
    Verifying,
    Complete,
    Cancelled,
    Failed,
}

impl TransferState {
    pub fn as_str(self) -> &'static str {
        match self {
            TransferState::Idle => "idle",
            TransferState::FileSelected => "file-selected",
            TransferState::CreatingSession => "creating-session",
            TransferState::WaitingForPeer => "waiting-for-peer",
            TransferState::PeerConnected => "peer-connected",
            TransferState::Connecting => "connecting",
            TransferState::Transferring => "transferring",
            TransferState::Paused => "paused",
            TransferState::Verifying => "verifying",
            TransferState::Complete => "complete",
            TransferState::Cancelled => "cancelled",
            TransferState::Failed => "failed",
        }
    }

    /// Terminal states (no outgoing transitions except back to Idle).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TransferState::Complete | TransferState::Cancelled | TransferState::Failed
        )
    }

    /// Whether file bytes may be moving in this state.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            TransferState::Transferring | TransferState::Paused | TransferState::Verifying
        )
    }

    /// Legal transitions of the transfer lifecycle DAG.
    pub fn can_transition_to(self, next: TransferState) -> bool {
        use TransferState::*;
        // Any state can reset to Idle (clear selection / start over).
        if next == Idle {
            return true;
        }
        match (self, next) {
            (Idle, FileSelected) => true,
            (FileSelected, CreatingSession | Connecting) => true,
            (CreatingSession, WaitingForPeer | Failed | Cancelled) => true,
            (WaitingForPeer, PeerConnected | Connecting | Failed | Cancelled) => true,
            (PeerConnected, Transferring | Failed | Cancelled) => true,
            (Connecting, Transferring | WaitingForPeer | Failed | Cancelled) => true,
            (Transferring, Paused | Verifying | Complete | Failed | Cancelled) => true,
            (Paused, Transferring | Failed | Cancelled) => true,
            (Verifying, Complete | Failed | Cancelled) => true,
            // Terminal states only go back to Idle (handled above).
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_sender() {
        use TransferState::*;
        let path = [
            Idle, FileSelected, CreatingSession, WaitingForPeer, PeerConnected,
            Transferring, Verifying, Complete,
        ];
        for w in path.windows(2) {
            assert!(w[0].can_transition_to(w[1]), "{:?} -> {:?}", w[0], w[1]);
        }
    }

    #[test]
    fn pause_resume_cancel() {
        use TransferState::*;
        assert!(Transferring.can_transition_to(Paused));
        assert!(Paused.can_transition_to(Transferring));
        assert!(Transferring.can_transition_to(Cancelled));
        assert!(!Paused.can_transition_to(Complete));
    }

    #[test]
    fn terminal_and_active_flags() {
        assert!(TransferState::Complete.is_terminal());
        assert!(!TransferState::Transferring.is_terminal());
        assert!(TransferState::Transferring.is_active());
        assert!(!TransferState::WaitingForPeer.is_active());
    }
}
