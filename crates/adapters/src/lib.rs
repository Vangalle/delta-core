pub mod agent;
pub mod journal;
pub mod pi;
pub mod terminal;

pub type AdapterResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
