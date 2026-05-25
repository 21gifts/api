use axum::{http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use serde::Serialize;
use std::net::SocketAddr;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct Info {
    service: &'static str,
    version: &'static str,
    description: &'static str,
}

async fn healthz() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(Health {
            status: "ok",
            service: "21gifts-api",
            version: env!("CARGO_PKG_VERSION"),
        }),
    )
}

async fn info() -> impl IntoResponse {
    Json(Info {
        service: "21gifts-api",
        version: env!("CARGO_PKG_VERSION"),
        description: "Backend for 21.gifts — see https://github.com/21gifts/api",
    })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/info", get(info));

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:3000".into())
        .parse()?;

    tracing::info!("21gifts-api listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
