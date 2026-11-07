//! a2aj-gold <step>: see the library's usage.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = a2aj_gold::run(&args) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
