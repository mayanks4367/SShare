//! HTTP gateway: browser access + dashboard + metrics for SwarmShare.
//!
//! Two audiences:
//! - Humans: `/` dashboard, `/file/:id` whole-file download.
//! - Web app (`WEB_INTEGRATION.md`): `/api/*` metadata + per-chunk relay.
//!
//! Bulk transfer stays peer-to-peer (libp2p / WebRTC) whenever possible.
//! The per-chunk `GET /api/chunks/:id/:index` endpoint is a *deliberate
//! fallback/relay* for browsers that cannot establish a P2P channel.

use std::{net::SocketAddr, path::PathBuf};

use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::from_fn,
    response::{Html, IntoResponse, Json},
    routing::{get, post},
};
use serde::Deserialize;

use swarmshare_core::{BlockStore, FileManifest};
use swarmshare_protocol::WebManifest;

/// Gateway software version (surfaced on `/api/health`).
pub const GATEWAY_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Max raw upload accepted by `POST /api/files` (512 MiB guard).
pub const MAX_UPLOAD_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone)]
pub struct GatewayState {
    pub store_root: PathBuf,
    pub peer_id: String,
}

/// Build the router (split out so tests can serve it on an ephemeral port).
pub fn build_router(state: GatewayState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/api/files", get(api_files))
        .route(
            "/api/files/upload",
            post(upload_file).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/stats", get(api_stats))
        .route("/api/health", get(api_health))
        .route("/api/web-manifest/:file_id", get(api_web_manifest))
        .route("/api/chunks/:file_id/:index", get(api_chunk))
        .route("/file/:file_id", get(download_file))
        .route("/manifest/:file_id", get(get_manifest))
        .layer(from_fn(cors_middleware))
        .with_state(state)
}

pub async fn serve(store_root: PathBuf, peer_id: String, listen: SocketAddr) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(listen).await?;
    serve_on(listener, GatewayState { store_root, peer_id }).await
}

/// Serve on an already-bound listener (used by tests for port discovery).
pub async fn serve_on(
    listener: tokio::net::TcpListener,
    state: GatewayState,
) -> anyhow::Result<()> {
    tracing::info!("gateway on http://{}", listener.local_addr()?);
    axum::serve(listener, build_router(state)).await?;
    Ok(())
}

/// Minimal CORS so a web app on another origin can use the metadata API.
/// The gateway is LAN-trusted by design; see WEB_INTEGRATION.md.
async fn cors_middleware(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> impl IntoResponse {
    if req.method() == Method::OPTIONS {
        return (
            StatusCode::NO_CONTENT,
            cors_headers(HeaderMap::new()),
        )
            .into_response();
    }
    let mut resp = next.run(req).await;
    let headers = cors_headers(std::mem::take(resp.headers_mut()));
    *resp.headers_mut() = headers;
    resp
}

fn cors_headers(mut h: HeaderMap) -> HeaderMap {
    h.insert("access-control-allow-origin", "*".parse().unwrap());
    h.insert(
        "access-control-allow-methods",
        "GET, POST, OPTIONS".parse().unwrap(),
    );
    h.insert(
        "access-control-allow-headers",
        "content-type, range".parse().unwrap(),
    );
    h.insert("access-control-max-age", "86400".parse().unwrap());
    h
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

/// Liveness + inventory for web clients and load balancers.
async fn api_health(State(s): State<GatewayState>) -> impl IntoResponse {
    let store = match BlockStore::new(&s.store_root) {
        Ok(x) => x,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"ok": false, "error": e.to_string()})),
            )
        }
    };
    let files = store.list_manifests().unwrap_or_default();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "peer_id": s.peer_id,
            "version": GATEWAY_VERSION,
            "files": files.len(),
            "total_bytes": files.iter().map(|f| f.file_size).sum::<u64>(),
        })),
    )
}

/// Browser-facing manifest: everything needed to fetch + verify one file
/// over WebRTC (primary) or the chunk relay below (fallback). No file bytes.
async fn api_web_manifest(
    State(s): State<GatewayState>,
    Path(file_id): Path<String>,
) -> impl IntoResponse {
    let store = match BlockStore::new(&s.store_root) {
        Ok(x) => x,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        }
    };
    match store.get_manifest(&file_id) {
        Ok(m) => {
            let web = web_manifest_for(&m);
            if let Err(e) = web.validate() {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e})),
                );
            }
            (StatusCode::OK, Json(serde_json::to_value(&web).unwrap()))
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "manifest not found"})),
        ),
    }
}

pub fn web_manifest_for(m: &FileManifest) -> WebManifest {
    WebManifest {
        file_id: m.file_id.clone(),
        file_name: m.file_name.clone(),
        mime: if m.mime.is_empty() {
            "application/octet-stream".to_string()
        } else {
            m.mime.clone()
        },
        file_size: m.file_size,
        chunk_size: m.chunk_size,
        total_chunks: m.num_chunks(),
        chunk_hashes_blake3: m.chunk_hashes.clone(),
        chunk_hashes_sha256: m.chunk_sha256.clone(),
        sha256: m.sha256.clone(),
        compressed: m.compressed,
        created_at: m.created_at,
    }
}

/// Deliberate fallback relay: one stored chunk as raw bytes.
///
/// Browsers should prefer WebRTC/DataChannel transfer; use this only when
/// no P2P channel can be established. Responses are immutable
/// (content-addressed) hence cacheable.
async fn api_chunk(
    State(s): State<GatewayState>,
    Path((file_id, index)): Path<(String, usize)>,
) -> impl IntoResponse {
    let store = match BlockStore::new(&s.store_root) {
        Ok(x) => x,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                HeaderMap::new(),
                Bytes::from(format!("store error: {}", e)),
            )
                .into_response()
        }
    };
    let manifest = match store.get_manifest(&file_id) {
        Ok(m) => m,
        Err(_) => {
            return (StatusCode::NOT_FOUND, HeaderMap::new(), Bytes::from("manifest not found"))
                .into_response()
        }
    };
    let Some(hash) = manifest.chunk_hashes.get(index) else {
        return (StatusCode::NOT_FOUND, HeaderMap::new(), Bytes::from("chunk index out of range"))
            .into_response();
    };
    let data = match store.get_block(hash) {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                HeaderMap::new(),
                Bytes::from("chunk not stored"),
            )
                .into_response()
        }
    };
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/octet-stream".parse().unwrap());
    headers.insert("cache-control", "public, max-age=31536000, immutable".parse().unwrap());
    headers.insert("x-chunk-index", index.to_string().parse().unwrap());
    headers.insert("x-total-chunks", manifest.num_chunks().to_string().parse().unwrap());
    headers.insert("x-chunk-hash-blake3", hash.parse().unwrap());
    if let Some(sha) = manifest.chunk_sha256.get(index) {
        headers.insert("x-chunk-hash-sha256", sha.parse().unwrap());
    }
    (StatusCode::OK, headers, Bytes::from(data)).into_response()
}

#[derive(Debug, Deserialize)]
struct UploadQuery {
    /// Required: original file name (also drives MIME guessing).
    name: String,
    /// Optional comma-separated search keywords.
    #[serde(default)]
    keywords: String,
    /// Optional zstd per-chunk compression.
    #[serde(default)]
    compress: bool,
    /// Optional XOR parity group size (0 = off).
    #[serde(default)]
    parity: usize,
    /// Optional explicit MIME type (else guessed from `name`).
    #[serde(default)]
    mime: String,
}

/// Publish raw bytes into the store (browser "seed via gateway").
///
/// Body is the raw file; metadata comes from the query string, e.g.
/// `POST /api/files/upload?name=photo.png&keywords=photo`. Returns the
/// native manifest plus the web manifest. NOTE: this stores into the local
/// BlockStore served here; DHT announcement happens via `share`/`daemon`
/// re-provide, not in this handler.
async fn upload_file(
    State(s): State<GatewayState>,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> impl IntoResponse {
    if q.name.trim().is_empty() || q.name.contains('/') || q.name.contains('\\') {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "query param 'name' is required (plain file name)"})),
        );
    }
    if body.len() > MAX_UPLOAD_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"error": "upload exceeds 512 MiB"})),
        );
    }
    let store = match BlockStore::new(&s.store_root) {
        Ok(x) => x,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        }
    };
    let mime = if q.mime.trim().is_empty() {
        swarmshare_core::store::guess_mime(&q.name).to_string()
    } else {
        q.mime.clone()
    };
    let keywords: Vec<String> = q
        .keywords
        .split(',')
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .collect();
    match store.import_bytes(&q.name, &body, &mime, keywords, q.compress, q.parity) {
        Ok(m) => {
            let web = web_manifest_for(&m);
            (
                StatusCode::CREATED,
                Json(serde_json::json!({
                    "manifest": serde_json::to_value(&m).unwrap(),
                    "web_manifest": serde_json::to_value(&web).unwrap(),
                })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Response {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Response {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
        fn json(&self) -> serde_json::Value {
            serde_json::from_slice(&self.body).expect("json body")
        }
    }

    async fn http_raw(
        addr: SocketAddr,
        method: &str,
        path: &str,
        extra_headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Response {
        let mut stream = match tokio::net::TcpStream::connect(addr).await {
            Ok(s) => s,
            // Unreachable once serving; lets readiness probes retry instead of panicking.
            Err(_) => {
                return Response { status: 503, headers: Vec::new(), body: b"not serving (yet)".to_vec() }
            }
        };
        let mut req = format!("{} {} HTTP/1.1\r\nhost: {}\r\nconnection: close\r\n", method, path, addr);
        for (k, v) in extra_headers {
            req.push_str(&format!("{}: {}\r\n", k, v));
        }
        let len = body.map(|b| b.len()).unwrap_or(0);
        req.push_str(&format!("content-length: {}\r\n\r\n", len));
        stream.write_all(req.as_bytes()).await.expect("write head");
        if let Some(b) = body {
            stream.write_all(b).await.expect("write body");
        }
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.expect("read");
        let head_end = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| i + 4)
            .expect("head");
        let head = String::from_utf8_lossy(&raw[..head_end]);
        let mut lines = head.lines();
        let status_line = lines.next().expect("status");
        let status: u16 = status_line.split_whitespace().nth(1).expect("code").parse().expect("u16");
        let mut headers = Vec::new();
        for line in lines {
            if line.is_empty() {
                continue;
            }
            if let Some((k, v)) = line.split_once(':') {
                headers.push((k.trim().to_lowercase(), v.trim().to_string()));
            }
        }
        Response { status, headers, body: raw[head_end..].to_vec() }
    }

    async fn spawn_gateway() -> (SocketAddr, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("swarmshare-gw-{}-{}", std::process::id(), nanos));
        let _ = std::fs::remove_dir_all(&dir);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let state = GatewayState { store_root: dir.clone(), peer_id: "test-peer".into() };
        tokio::spawn(async move {
            let _ = serve_on(listener, state).await;
        });
        // Readiness: retry the health endpoint until the server answers.
        for _ in 0..100 {
            let probe = http_raw(addr, "GET", "/api/health", &[], None).await;
            if probe.status == 200 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        (addr, dir)
    }

    fn sample_bytes() -> Vec<u8> {
        // ~600 KiB pseudo-random => 3 chunks at 256 KiB, incompressible-ish.
        let mut x: u64 = 0x1234_5678_9ABC_DEF0;
        (0..600 * 1024)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x & 0xFF) as u8
            })
            .collect()
    }

    #[tokio::test]
    async fn health_reports_inventory_and_cors() {
        let (addr, _dir) = spawn_gateway().await;
        let r = http_raw(addr, "GET", "/api/health", &[("origin", "http://localhost:5173")], None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.json()["ok"], serde_json::json!(true));
        assert_eq!(r.json()["peer_id"], serde_json::json!("test-peer"));
        assert_eq!(r.header("access-control-allow-origin"), Some("*"));
    }

    #[tokio::test]
    async fn options_preflight_is_accepted() {
        let (addr, _dir) = spawn_gateway().await;
        let r = http_raw(addr, "OPTIONS", "/api/web-manifest/whatever", &[], None).await;
        assert_eq!(r.status, 204);
        assert_eq!(r.header("access-control-allow-origin"), Some("*"));
    }

    #[tokio::test]
    async fn upload_manifest_chunks_roundtrip() {
        let (addr, _dir) = spawn_gateway().await;
        let data = sample_bytes();

        // 1. Publish raw bytes (browser "seed via gateway").
        let up = http_raw(
            addr,
            "POST",
            "/api/files/upload?name=demo.bin&keywords=demo,test",
            &[("content-type", "application/octet-stream")],
            Some(&data),
        )
        .await;
        assert_eq!(up.status, 201, "body: {}", String::from_utf8_lossy(&up.body));
        let file_id = up.json()["manifest"]["file_id"].as_str().expect("file_id").to_string();
        let sha256 = up.json()["manifest"]["sha256"].as_str().expect("sha256").to_string();

        // 2. Web manifest carries the browser-verifiable bridge.
        let wm = http_raw(addr, "GET", &format!("/api/web-manifest/{}", file_id), &[], None).await;
        assert_eq!(wm.status, 200);
        let wmj = wm.json();
        assert_eq!(wmj["total_chunks"], serde_json::json!(3));
        assert_eq!(wmj["file_size"], serde_json::json!(data.len()));
        assert_eq!(wmj["sha256"], serde_json::json!(sha256));
        assert_eq!(wmj["chunk_hashes_sha256"].as_array().expect("arr").len(), 3);

        // 3. Per-chunk relay reassembles the exact bytes (deliberate fallback).
        let mut out = Vec::new();
        for i in 0..3 {
            let c = http_raw(addr, "GET", &format!("/api/chunks/{}/{}", file_id, i), &[], None).await;
            assert_eq!(c.status, 200);
            assert_eq!(c.header("x-chunk-index"), Some(i.to_string().as_str()));
            assert_eq!(c.header("cache-control"), Some("public, max-age=31536000, immutable"));
            let expect_sha = wmj["chunk_hashes_sha256"][i].as_str().expect("sha");
            assert_eq!(c.header("x-chunk-hash-sha256"), Some(expect_sha));
            out.extend_from_slice(&c.body);
        }
        assert_eq!(out, data);

        // Whole-file SHA-256 matches what a browser computes via WebCrypto.
        assert_eq!(swarmshare_core::sha256_hex(&out), sha256);

        // 4. Legacy endpoints still work (CLI compatibility).
        let mf = http_raw(addr, "GET", &format!("/manifest/{}", file_id), &[], None).await;
        assert_eq!(mf.status, 200);
        let full = http_raw(addr, "GET", &format!("/file/{}", file_id), &[], None).await;
        assert_eq!(full.status, 200);
        assert_eq!(full.body, data);
    }

    #[tokio::test]
    async fn upload_rejects_bad_name_and_unknown_chunks_404() {
        let (addr, _dir) = spawn_gateway().await;
        let bad = http_raw(addr, "POST", "/api/files/upload?name=", &[("content-type", "application/octet-stream")], Some(b"x")).await;
        assert!(bad.status == 400 || bad.status == 422, "got {}", bad.status);

        let missing = http_raw(addr, "GET", "/api/chunks/doesnotexist/0", &[], None).await;
        assert_eq!(missing.status, 404);

        // Valid upload, then out-of-range index.
        let up = http_raw(
            addr,
            "POST",
            "/api/files/upload?name=tiny.bin",
            &[("content-type", "application/octet-stream")],
            Some(b"hi"),
        )
        .await;
        assert_eq!(up.status, 201);
        let file_id = up.json()["manifest"]["file_id"].as_str().expect("id").to_string();
        let oob = http_raw(addr, "GET", &format!("/api/chunks/{}/9", file_id), &[], None).await;
        assert_eq!(oob.status, 404);
    }
}
