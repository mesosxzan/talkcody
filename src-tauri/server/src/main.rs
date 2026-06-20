use std::path::PathBuf;
use talkcody_core::core::types::RuntimeEvent;
use talkcody_server::http;
use talkcody_server::state::ServerStateFactory;
use talkcody_server::ServerConfig;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::init();

    let workspace_root = std::env::var("WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().expect("current dir should be available"));
    let data_root = std::env::var("DATA_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .unwrap_or_else(|| workspace_root.clone())
                .join("talkcody-server")
        });

    let config = ServerConfig::new(workspace_root, data_root);
    let bind_addr: std::net::SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel::<RuntimeEvent>();
    let state = ServerStateFactory::create(config, event_tx).await?;
    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    let addr = listener.local_addr()?;

    log::info!("TalkCody server listening on {}", addr);
    http::serve(listener, state).await?;

    Ok(())
}
