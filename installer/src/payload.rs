use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub const TRAILER_MAGIC: &[u8; 8] = b"PPSETUP1";
pub const TRAILER_SIZE: u64 = 96;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadTrailer {
    pub stub_size: u64,
    pub payload_size: u64,
    pub unpacked_bytes: u64,
    pub sha256: [u8; 32],
    pub version: String,
}

impl PayloadTrailer {
    pub fn to_bytes(&self) -> [u8; 96] {
        let mut buf = [0u8; 96];
        buf[0..8].copy_from_slice(&self.stub_size.to_le_bytes());
        buf[8..16].copy_from_slice(&self.payload_size.to_le_bytes());
        buf[16..24].copy_from_slice(&self.unpacked_bytes.to_le_bytes());
        buf[24..56].copy_from_slice(&self.sha256);
        let vb = self.version.as_bytes();
        let n = vb.len().min(32);
        buf[56..56 + n].copy_from_slice(&vb[..n]);
        buf[88..96].copy_from_slice(TRAILER_MAGIC);
        buf
    }

    pub fn from_bytes(buf: &[u8; 96]) -> Option<Self> {
        if &buf[88..96] != TRAILER_MAGIC {
            return None;
        }
        let stub_size = u64::from_le_bytes(buf[0..8].try_into().ok()?);
        let payload_size = u64::from_le_bytes(buf[8..16].try_into().ok()?);
        let unpacked_bytes = u64::from_le_bytes(buf[16..24].try_into().ok()?);
        let mut sha256 = [0u8; 32];
        sha256.copy_from_slice(&buf[24..56]);
        let ver_raw = &buf[56..88];
        let ver_len = ver_raw.iter().position(|&b| b == 0).unwrap_or(32);
        let version = String::from_utf8_lossy(&ver_raw[..ver_len]).trim().to_string();
        Some(Self {
            stub_size,
            payload_size,
            unpacked_bytes,
            sha256,
            version,
        })
    }
}

/// Reads Windows PE IMAGE_DIRECTORY_ENTRY_SECURITY offset so trailer lookup works identically
/// both before and after Authenticode `signtool.exe` appends a PKCS#7 certificate table at EOF.
fn pe_security_table_offset(file: &mut File, file_len: u64) -> Option<u64> {
    if file_len < 0x100 {
        return None;
    }
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos).ok()?;
    if &dos[0..2] != b"MZ" {
        return None;
    }
    let e_lfanew = u32::from_le_bytes(dos[60..64].try_into().ok()?) as u64;
    if e_lfanew + 24 + 144 > file_len {
        return None;
    }
    file.seek(SeekFrom::Start(e_lfanew)).ok()?;
    let mut pe_hdr = [0u8; 24];
    file.read_exact(&mut pe_hdr).ok()?;
    if &pe_hdr[0..4] != b"PE\0\0" {
        return None;
    }
    let mut magic_buf = [0u8; 2];
    file.read_exact(&mut magic_buf).ok()?;
    let opt_magic = u16::from_le_bytes(magic_buf);
    // Security directory (DataDirectory[4]):
    // PE32 (0x10B): offset 96 + 4*8 = 128 from Optional Header start
    // PE32+ (0x20B): offset 112 + 4*8 = 144 from Optional Header start
    let sec_dir_rel: u64 = match opt_magic {
        0x10B => 128,
        0x20B => 144,
        _ => return None,
    };
    let sec_dir_pos = e_lfanew + 24 + sec_dir_rel;
    file.seek(SeekFrom::Start(sec_dir_pos)).ok()?;
    let mut entry = [0u8; 8];
    file.read_exact(&mut entry).ok()?;
    let cert_offset = u32::from_le_bytes(entry[0..4].try_into().ok()?) as u64;
    let cert_size = u32::from_le_bytes(entry[4..8].try_into().ok()?) as u64;
    if cert_offset > 0 && cert_size > 0 && cert_offset < file_len {
        Some(cert_offset)
    } else {
        None
    }
}

pub fn read_trailer(exe_path: &Path) -> io::Result<Option<PayloadTrailer>> {
    let mut file = File::open(exe_path)?;
    let file_len = file.metadata()?.len();
    if file_len < TRAILER_SIZE {
        return Ok(None);
    }

    // Check candidate end offsets: EOF, and (if Authenticode-signed) cert_offset minus 0..16 alignment bytes.
    let mut candidates = vec![file_len];
    if let Some(cert_off) = pe_security_table_offset(&mut file, file_len) {
        for pad in 0..=16u64 {
            if cert_off >= TRAILER_SIZE + pad {
                candidates.push(cert_off - pad);
            }
        }
    }

    for end in candidates {
        if end < TRAILER_SIZE {
            continue;
        }
        file.seek(SeekFrom::Start(end - TRAILER_SIZE))?;
        let mut buf = [0u8; 96];
        file.read_exact(&mut buf)?;
        if let Some(trailer) = PayloadTrailer::from_bytes(&buf) {
            if trailer.stub_size + trailer.payload_size + TRAILER_SIZE == end {
                return Ok(Some(trailer));
            }
        }
    }
    Ok(None)
}

pub fn verify_payload_sha256(exe_path: &Path, trailer: &PayloadTrailer) -> io::Result<bool> {
    let mut file = File::open(exe_path)?;
    file.seek(SeekFrom::Start(trailer.stub_size))?;
    let mut hasher = Sha256::new();
    let mut remaining = trailer.payload_size;
    let mut buf = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let n = file.read(&mut buf[..to_read])?;
        if n == 0 {
            return Ok(false);
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    let digest = hasher.finalize();
    Ok(digest.as_slice() == trailer.sha256)
}

struct SubReader {
    file: File,
    start: u64,
    len: u64,
    pos: u64,
}

impl SubReader {
    fn new(mut file: File, start: u64, len: u64) -> io::Result<Self> {
        file.seek(SeekFrom::Start(start))?;
        Ok(Self { file, start, len, pos: 0 })
    }
}

impl Read for SubReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.len.saturating_sub(self.pos);
        if left == 0 {
            return Ok(0);
        }
        let max_n = (left as usize).min(buf.len());
        let n = self.file.read(&mut buf[..max_n])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for SubReader {
    fn seek(&mut self, style: SeekFrom) -> io::Result<u64> {
        let next = match style {
            SeekFrom::Start(o) => o as i128,
            SeekFrom::End(o) => self.len as i128 + o as i128,
            SeekFrom::Current(o) => self.pos as i128 + o as i128,
        };
        if next < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        let clamped = (next as u64).min(self.len);
        self.file.seek(SeekFrom::Start(self.start + clamped))?;
        self.pos = clamped;
        Ok(self.pos)
    }
}

pub fn extract_payload<F>(exe_path: &Path, target_dir: &Path, mut on_progress: F) -> io::Result<PayloadTrailer>
where
    F: FnMut(u8),
{
    let trailer = read_trailer(exe_path)?.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "Installer payload trailer not found in executable.")
    })?;
    if !verify_payload_sha256(exe_path, &trailer)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Installer payload SHA-256 verification failed. The setup file may be corrupted.",
        ));
    }

    fs::create_dir_all(target_dir)?;
    let file = File::open(exe_path)?;
    let reader = SubReader::new(file, trailer.stub_size, trailer.payload_size)?;
    let mut archive = ZipArchive::new(reader)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("Corrupt archive: {e}")))?;

    let total_entries = archive.len().max(1);
    for idx in 0..archive.len() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("Archive read error: {e}")))?;
        let rel = entry.enclosed_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::PermissionDenied, "Unsafe path traversal entry rejected.")
        })?;
        let out_path = target_dir.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out_file = File::create(&out_path)?;
            io::copy(&mut entry, &mut out_file)?;
        }
        let pct = (((idx + 1) * 100) / total_entries).min(100) as u8;
        on_progress(pct);
    }

    Ok(trailer)
}

/// Ensures `<target_dir>\uninstall.exe` exists as the clean standalone uninstaller stub
/// (never duplicating the 100+ MB app payload). If the payload already provided a signed
/// `uninstall.exe` copy of the stub, keeps it; otherwise extracts bytes `0..stub_size` of self.
pub fn write_uninstaller_stub(exe_path: &Path, trailer: &PayloadTrailer, target_dir: &Path) -> io::Result<PathBuf> {
    let dest = target_dir.join("uninstall.exe");
    if dest.exists() {
        if let Ok(meta) = fs::metadata(&dest) {
            if meta.len() >= 100_000 {
                return Ok(dest);
            }
        }
    }
    let mut src = File::open(exe_path)?;
    let mut out = File::create(&dest)?;
    let mut remaining = trailer.stub_size;
    let mut buf = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let n = src.read(&mut buf[..to_read])?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        remaining -= n as u64;
    }
    out.flush()?;
    Ok(dest)
}

fn collect_files(root: &Path, cur: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(cur)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            collect_files(root, &p, out)?;
        } else if p.is_file() {
            out.push(p);
        }
    }
    Ok(())
}

pub fn pack_directory(
    stub_exe: &Path,
    unpacked_dir: &Path,
    out_setup_exe: &Path,
    version: &str,
    include_self_as_uninstaller: bool,
) -> io::Result<PayloadTrailer> {
    let stub_bytes = fs::read(stub_exe)?;
    let stub_size = stub_bytes.len() as u64;

    if let Some(parent) = out_setup_exe.parent() {
        fs::create_dir_all(parent)?;
    }

    let tmp_zip = out_setup_exe.with_extension("payload.zip.tmp");
    let mut unpacked_bytes: u64 = 0;

    {
        let zf = File::create(&tmp_zip)?;
        let mut zw = ZipWriter::new(zf);
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Zstd)
            .compression_level(Some(9));

        let mut files = Vec::new();
        collect_files(unpacked_dir, unpacked_dir, &mut files)?;
        files.sort();

        for file_path in files {
            let rel = file_path
                .strip_prefix(unpacked_dir)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
            let rel_name = rel.to_string_lossy().replace('\\', "/");
            if rel_name.eq_ignore_ascii_case("uninstall.exe") && include_self_as_uninstaller {
                continue;
            }
            let meta = fs::metadata(&file_path)?;
            unpacked_bytes += meta.len();
            zw.start_file(rel_name, opts)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("zip start error: {e}")))?;
            let mut f = File::open(&file_path)?;
            io::copy(&mut f, &mut zw)?;
        }

        if include_self_as_uninstaller {
            unpacked_bytes += stub_size;
            zw.start_file("uninstall.exe", opts)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("zip stub error: {e}")))?;
            zw.write_all(&stub_bytes)?;
        }

        zw.finish()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("zip finish error: {e}")))?;
    }

    let payload_size = fs::metadata(&tmp_zip)?.len();
    let mut hasher = Sha256::new();
    {
        let mut pf = File::open(&tmp_zip)?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = pf.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }
    let mut sha256 = [0u8; 32];
    sha256.copy_from_slice(&hasher.finalize());

    let trailer = PayloadTrailer {
        stub_size,
        payload_size,
        unpacked_bytes,
        sha256,
        version: version.to_string(),
    };

    {
        let mut out = File::create(out_setup_exe)?;
        out.write_all(&stub_bytes)?;
        let mut pf = File::open(&tmp_zip)?;
        io::copy(&mut pf, &mut out)?;
        out.write_all(&trailer.to_bytes())?;
        out.flush()?;
    }

    let _ = fs::remove_file(&tmp_zip);
    Ok(trailer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_verify_and_extract_roundtrip() {
        let base = std::env::temp_dir().join(format!("pp-payload-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src_dir = base.join("src");
        let dst_dir = base.join("dst");
        fs::create_dir_all(src_dir.join("sub")).unwrap();
        fs::write(src_dir.join("hello.txt"), b"Power Pilot payload ok").unwrap();
        fs::write(src_dir.join("sub").join("nested.bin"), vec![42u8; 4096]).unwrap();

        let stub = base.join("stub.exe");
        fs::write(&stub, b"MZFAKE_STUB_HEADER_BYTES_1234567890").unwrap();

        let setup_exe = base.join("Setup.exe");
        let packed = pack_directory(&stub, &src_dir, &setup_exe, "1.0.0", false).unwrap();
        assert_eq!(packed.version, "1.0.0");

        let read_back = read_trailer(&setup_exe).unwrap().expect("trailer missing");
        assert_eq!(read_back, packed);
        assert!(verify_payload_sha256(&setup_exe, &read_back).unwrap());

        let mut last_pct = 0u8;
        extract_payload(&setup_exe, &dst_dir, |p| last_pct = p).unwrap();
        assert_eq!(last_pct, 100);
        assert_eq!(fs::read(dst_dir.join("hello.txt")).unwrap(), b"Power Pilot payload ok");
        assert_eq!(fs::read(dst_dir.join("sub").join("nested.bin")).unwrap().len(), 4096);

        let uninst = write_uninstaller_stub(&setup_exe, &read_back, &dst_dir).unwrap();
        assert_eq!(fs::read(uninst).unwrap(), b"MZFAKE_STUB_HEADER_BYTES_1234567890");

        let _ = fs::remove_dir_all(&base);
    }
}
