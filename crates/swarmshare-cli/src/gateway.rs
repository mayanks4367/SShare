//! HTTP gateway: browser access + dashboard + metrics for SwarmShare.

use std::{net::SocketAddr, path::PathBuf};

use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::{Html, IntoResponse, Json},
    routing::get,
};

use swarmshare_core::{BlockStore, FileManifest};

#[derive(Clone)]
pub struct GatewayState {
    pub store_root: PathBuf,
    pub peer_id: String,
}

pub async fn serve(store_root: PathBuf, peer_id: String, listen: SocketAddr) -> anyhow::Result<()> {
    let state = GatewayState { store_root, peer_id };
    let app = Router::new()
        .route("/", get(index))
        .route("/api/files", get(api_files))
        .route("/api/stats", get(api_stats))
        .route("/file/:file_id", get(download_file))
        .route("/manifest/:file_id", get(get_manifest))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(listen).await?;
    tracing::info!("gateway on http://{}", listen);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn index(State(s): State<GatewayState>) -> Html<String> {
    let store = BlockStore::new(&s.store_root).unwrap();
    let files = store.list_manifests().unwrap_or_default();
    let mut rows = String::new();
    for m in &files {
        let have = store.have_set(m).len();
        rows.push_str(&format!(
            "<tr><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}/{}</td>\
             <td><a href=\"/file/{}\">download</a> · <a href=\"/manifest/{}\">manifest</a></td></tr>",
            &m.file_id[..12.min(m.file_id.len())],
            html_escape(&m.file_name),
            m.file_size,
            have,
            m.num_chunks(),
            m.file_id,
            m.file_id
        ));
    }
    Html(format!(
        "<!doctype html><html><head><meta charset=utf-8><title>SwarmShare</title>\
         <style>body{{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}}\
         table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ddd;padding:6px}}code{{font-size:12px}}</style></head>\
         <body><h1>🌀 SwarmShare Gateway</h1><p>Peer <code>{}</code> · store <code>{}</code></p>\
         <table><tr><th>id</th><th>name</th><th>bytes</th><th>have/total</th><th>links</th></tr>{}</table>\
         <p>API: <a href=\"/api/files\">/api/files</a> · <a href=\"/api/stats\">/api/stats</a></p></body></html>",
        s.peer_id,
        s.store_root.display(),
        rows
    ))
}

async fn api_files(State(s): State<GatewayState>) -> impl IntoResponse {
    let store = match BlockStore::new(&s.store_root) {
        Ok(x) => x,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        }
    };
    let files = store.list_manifests().unwrap_or_default();
    (StatusCode::OK, Json(serde_json::to_value(&files).unwrap()))
}

async fn api_stats(State(s): State<GatewayState>) -> impl IntoResponse {
    let store = BlockStore::new(&s.store_root).unwrap();
    let files = store.list_manifests().unwrap_or_default();
    let blocks = std::fs::read_dir(s.store_root.join("blocks"))
        .map(|d| d.count())
        .unwrap_or(0);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "peer_id": s.peer_id,
            "files": files.len(),
            "blocks": blocks,
            "total_bytes": files.iter().map(|f| f.file_size).sum::<u64>(),
        })),
    )
}

async fn get_manifest(
    State(s): State<GatewayState>,
    Path(file_id): Path<String>,
) -> impl IntoResponse {
    let store = BlockStore::new(&s.store_root).unwrap();
    match store.get_manifest(&file_id) {
        Ok(m) => (StatusCode::OK, Json(serde_json::to_value(&m).unwrap())),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "manifest not found"})),
        ),
    }
}

async fn download_file(
    State(s): State<GatewayState>,
    Path(file_id): Path<String>,
) -> impl IntoResponse {
    let store = BlockStore::new(&s.store_root).unwrap();
    let manifest: FileManifest = match store.get_manifest(&file_id) {
        Ok(m) => m,
        Err(_) => {
            return axum::response::Response::builder()
                .status(404)
                .body(axum::body::Body::from("manifest not found"))
                .unwrap()
        }
    };
    let have = store.have_set(&manifest);
    if have.len() != manifest.num_chunks() {
        return axum::response::Response::builder()
            .status(409)
            .body(axum::body::Body::from(format!(
                "incomplete: have {}/{} chunks — keep the daemon running to fetch more",
                have.len(),
                manifest.num_chunks()
            )))
            .unwrap();
    }
    // Assemble to memory and serve.
    let chunker = manifest._chunker();
    let mut out = Vec::with_capacity(manifest.file_size as usize);
    for (i, h) in manifest.chunk_hashes.iter().enumerate() {
        let stored = match store.get_block(h) {
            Ok(b) => b,
            Err(_) => {
                return axum::response::Response::builder()
                    .status(500)
                    .body(axum::body::Body::from(format!("missing block {}", i)))
                    .unwrap()
            }
        };
        let raw = match chunker.decode(&swarmshare_core::Chunk {
            index: i as u32,
            hash: h.clone(),
            raw_len: stored.len(),
            stored_len: stored.len(),
            data: stored,
        }) {
            Ok(b) => b,
            Err(e) => {
                return axum::response::Response::builder()
                    .status(500)
                    .body(axum::body::Body::from(format!("decode failed: {}", e)))
                    .unwrap()
            }
        };
        out.extend_from_slice(&raw);
    }
    axum::response::Response::builder()
        .status(200)
        .header("Content-Type", "application/octet-stream")
        .header(
            "Content-Disposition",
            format!("attachment; filename=\"{}\"", manifest.file_name),
        )
        .body(axum::body::Body::from(out))
        .unwrap()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
