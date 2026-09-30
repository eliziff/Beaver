use std::io::{self, BufRead, Write};
use serde_json::{json, Value};

// Both owners execute their real public functions. This bridge only serializes them.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let text = request["text"].as_str().ok_or("text missing")?;
        let started = std::time::Instant::now();
        let result = std::panic::catch_unwind(|| json!({
            "occurrences": owner::citation_occurrences_in_text(text),
            "references": owner::authority_references_in_text(text),
            "classification": owner::classify_citator_excerpt(text),
            "providers": owner::provider_citations_in_text(text)
        }));
        let record = match result {
            Ok(result) => json!({"id": request["id"], "status": "ok", "output": result,
                "elapsed_us": started.elapsed().as_micros()}),
            Err(_) => json!({"id": request["id"], "status": "error", "error": "native panic; see stderr"}),
        };
        serde_json::to_writer(&mut output, &record)?;
        writeln!(output)?;
        output.flush()?;
    }
    Ok(())
}
