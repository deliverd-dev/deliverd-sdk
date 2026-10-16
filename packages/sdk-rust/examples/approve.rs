//! Ask a person, and act on the answer.
//!
//! ```bash
//! DELIVERD_API_KEY=dlv_… cargo run --example approve
//! DELIVERD_MODE=development cargo run --example approve                         # no key
//! DELIVERD_MODE=development DELIVERD_DEV_OUTCOME=rejected cargo run --example approve
//! ```

use deliverd::{ApprovalRequest, Deliverd, Factor, Risk};

#[tokio::main]
async fn main() -> deliverd::Result<()> {
    let deliverd = Deliverd::from_env()?;

    let decision = deliverd
        .approve(
            ApprovalRequest::new("Deploy release 4.2 to production")
                .description("142 commits since 4.1. All checks green.")
                .risk(Risk::High)
                .factor(Factor::ok("All checks green"))
                .factor(Factor::warning("Touches the payments path").detail("3 files under /billing"))
                .expires_in("4h"),
        )
        .await?;

    if decision.approved {
        println!("Approved by {}. Deploying.", decision.decided_by.as_deref().unwrap_or("someone"));
    } else {
        println!("Not deploying: {} ({}).", decision.status, decision.note.as_deref().unwrap_or("no reason given"));
    }
    Ok(())
}
