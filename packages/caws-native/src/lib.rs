//! Native transport support components. These modules do not confer project authority.

pub mod agent_pid_cache;
pub mod context_git;
mod installed_generation;
pub mod invocation_project;
pub mod monotonic_deadline;
pub mod owned_group;
pub mod plan_snapshots;
pub mod process_comm_macos;
pub mod render_context;
pub mod render_observation;
pub mod render_owner;
pub mod render_writer;
pub mod renderer_backend;
pub mod renderer_calendar;
pub mod service_git_view;
pub mod service_image;
pub mod service_journal;
pub mod service_protocol;
pub mod session_cache;
pub mod session_cache_wire;
pub mod session_publication;
pub mod session_publication_wire;
pub mod stop_budget;
#[cfg(feature = "sqlite-store")]
pub mod transcript_store;
#[cfg(feature = "sqlite-store")]
pub mod transcript_store_wire;
