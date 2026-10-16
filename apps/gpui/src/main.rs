fn main() {
    let vault = std::env::args().nth(1).map(std::path::PathBuf::from);
    mimenote_gpui::run(vault);
}
