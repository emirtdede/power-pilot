use powerpilot_setup_lib::payload;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 {
        eprintln!("Usage: pp-pack <stub.exe> <win-unpacked-dir> <out-setup.exe> <version>");
        std::process::exit(2);
    }
    let stub = PathBuf::from(&args[0]);
    let unpacked = PathBuf::from(&args[1]);
    let out = PathBuf::from(&args[2]);
    let version = &args[3];

    match payload::pack_directory(&stub, &unpacked, &out, version, true) {
        Ok(trailer) => {
            println!(
                "[pp-pack] OK - stub={} B, payload={} B, unpacked={} B, version={}",
                trailer.stub_size, trailer.payload_size, trailer.unpacked_bytes, trailer.version
            );
        }
        Err(err) => {
            eprintln!("[pp-pack] FAILED: {err}");
            std::process::exit(1);
        }
    }
}
