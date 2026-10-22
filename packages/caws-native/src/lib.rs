//! Native transport support components. These modules do not confer project authority.

#[cfg(feature = "sqlite-store")]
pub mod invocation_project;
pub mod owned_group;
pub mod plan_snapshots;
pub mod process_comm_macos;
pub mod render_owner;
pub mod render_writer;
pub mod renderer_backend;
pub mod service_git_view;
pub mod service_image;
pub mod service_journal;
pub mod service_protocol;
pub mod session_cache;
pub mod session_cache_wire;
pub mod stop_budget;
#[cfg(feature = "sqlite-store")]
pub mod transcript_store;
#[cfg(feature = "sqlite-store")]
pub mod transcript_store_wire;
