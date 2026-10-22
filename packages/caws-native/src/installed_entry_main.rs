//! Installed transport. The ordinary invoke frontend remains a separate selected image.
#[path = "installed_entry.rs"]
mod installed_entry;

fn main() {
    std::process::exit(i32::from(installed_entry::run()));
}
