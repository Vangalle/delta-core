use delta_host::{Service,router};
use std::{path::PathBuf,io::Write};

#[tokio::main]
async fn main() -> Result<(),Box<dyn std::error::Error>> {
    let cwd=std::env::var_os("DELTA_CWD").map(PathBuf::from).unwrap_or(std::env::current_dir()?);
    let data=std::env::var_os("DELTA_DATA").map(PathBuf::from).unwrap_or_else(||cwd.join(".delta-core"));
    std::fs::create_dir_all(&data)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&data,std::fs::Permissions::from_mode(0o700))?;
    }
    let token_path=data.join("owner-token");
    let token=if token_path.exists() { std::fs::read_to_string(&token_path)?.trim().to_owned() } else {
        let token=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
        let mut options=std::fs::OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        options.open(&token_path)?.write_all(token.as_bytes())?;
        println!("First-start owner token: {token}");
        token
    };
    let service=Service::open(&data,&cwd,&token).map_err(|e|format!("host initialization: {e:?}"))?;
    if let Some(executable)=std::env::var_os("DELTA_PI") {
        service.register_backend("pi".into(),std::sync::Arc::new(delta_adapters::pi::PiBackend { executable:executable.into(),..Default::default() })).await;
    }
    let assets=std::env::var_os("DELTA_ASSETS").map(PathBuf::from).unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/layer/dist"));
    let address=std::env::var("DELTA_LISTEN").unwrap_or_else(|_|"127.0.0.1:47831".into());
    let listener=tokio::net::TcpListener::bind(&address).await?;
    println!("Delta Core: http://{}",listener.local_addr()?);
    println!("Execution directory: {}",cwd.canonicalize()?.display());
    println!("Owner token file: {}",token_path.display());
    println!("Execution grants allow host-code execution. For remote access, use TLS and invite only trusted members.");
    let shutdown=service.clone();
    axum::serve(listener,router(service,Some(assets))).with_graceful_shutdown(async move {
        let _=tokio::signal::ctrl_c().await;
        shutdown.shutdown().await;
    }).await?;
    Ok(())
}
