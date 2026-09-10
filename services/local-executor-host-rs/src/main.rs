use tenvyr_local_executor_host::{parse_host_config, start_host};

#[tokio::main]
async fn main() {
    let config = match parse_host_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Local executor host failed to start {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = start_host(config).await {
        eprintln!("Local executor host failed to start {error}");
        std::process::exit(1);
    }
}
