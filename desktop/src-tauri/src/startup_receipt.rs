//! Local startup evidence for the supervisor that owns this exact process.
pub fn write() -> Result<(), Box<dyn std::error::Error>> {
    let Some(file) = std::env::var_os("MIND_WAKE_STARTUP_RECEIPT") else { return Ok(()); };
    let instance = std::env::var("MIND_WAKE_STARTUP_INSTANCE")?;
    let file = std::path::PathBuf::from(file);
    if !file.is_absolute() || instance.len() != 36 { return Err("Invalid startup receipt".into()); }
    let receipt = serde_json::json!({
        "pid": std::process::id(), "instance": instance,
        "executable": std::env::current_exe()?,
        "revision": env!("WAKE_BUILD_REVISION"),
        "dirty": env!("WAKE_BUILD_DIRTY"),
    });
    // One fresh path per launch: never replace an older receipt or follow a symlink.
    use std::io::Write;
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(file)?;
    output.write_all(serde_json::to_string(&receipt)?.as_bytes())?;
    Ok(())
}
