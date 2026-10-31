//! Bounded raster reads confined to the same roots as the document reader.
use std::io::Read;
use std::path::{Component, Path, PathBuf};
const MAX_BYTES: u64 = 8_000_000;
const MAX_PIXELS: u64 = 32_000_000;

fn dimensions(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    let be = |b: &[u8]| u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    let le24 = |b: &[u8]| u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16;
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
        return Some(("png", be(&bytes[16..20]), be(&bytes[20..24])));
    }
    if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) && bytes.len() >= 10 {
        return Some(("gif", u16::from_le_bytes([bytes[6], bytes[7]]) as u32, u16::from_le_bytes([bytes[8], bytes[9]]) as u32));
    }
    if bytes.starts_with(b"\xff\xd8") {
        let mut i = 2;
        while i + 4 <= bytes.len() {
            if bytes[i] != 0xff { return None; }
            while i < bytes.len() && bytes[i] == 0xff { i += 1; }
            let marker = *bytes.get(i)?; i += 1;
            if marker == 0xd9 || marker == 0xda { break; }
            if marker == 0x01 || (0xd0..=0xd7).contains(&marker) { continue; }
            let length = u16::from_be_bytes([*bytes.get(i)?, *bytes.get(i + 1)?]) as usize;
            if length < 2 || i + length > bytes.len() { return None; }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) && length >= 7 {
                return Some(("jpeg", u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32, u16::from_be_bytes([bytes[i + 3], bytes[i + 4]]) as u32));
            }
            i += length;
        }
    }
    if bytes.len() >= 30 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        if &bytes[12..16] == b"VP8X" { return Some(("webp", 1 + le24(&bytes[24..27]), 1 + le24(&bytes[27..30]))); }
        if &bytes[12..16] == b"VP8 " && &bytes[23..26] == b"\x9d\x01\x2a" {
            return Some(("webp", (u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff) as u32, (u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff) as u32));
        }
        if &bytes[12..16] == b"VP8L" && bytes[20] == 0x2f {
            let bits = u32::from_le_bytes(bytes[21..25].try_into().ok()?);
            return Some(("webp", (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
        }
    }
    None
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (chunk[0] as u32) << 16 | (chunk.get(1).copied().unwrap_or(0) as u32) << 8 | chunk.get(2).copied().unwrap_or(0) as u32;
        result.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        result.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        result.push(if chunk.len() > 1 { ALPHABET[((value >> 6) & 63) as usize] as char } else { '=' });
        result.push(if chunk.len() > 2 { ALPHABET[(value & 63) as usize] as char } else { '=' });
    }
    result
}

pub fn read_confined(reference: &str, roots: &[PathBuf]) -> Result<String, String> {
    if reference.is_empty() || reference.len() > 4096 || reference.chars().any(char::is_control)
        || reference.starts_with("\\\\") || reference.starts_with("//") { return Err("Chemin d’image refusé".into()); }
    let path = Path::new(reference);
    if path.components().any(|c| matches!(c, Component::ParentDir)) { return Err("Chemin d’image refusé".into()); }
    // A drive prefix is permitted, alternate data streams and other URL schemes are not.
    let without_drive = if reference.as_bytes().get(1) == Some(&b':') && reference.as_bytes()[0].is_ascii_alphabetic() { &reference[2..] } else { reference };
    if without_drive.contains(':') { return Err("Chemin d’image refusé".into()); }
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") { return Err("Format d’image non pris en charge".into()); }
    let mut target = None;
    for root in roots {
        let Ok(base) = root.canonicalize() else { continue; };
        // Canonicalization prevents symlink/junction escapes from either allowed root.
        let candidate = if path.is_absolute() { path.to_path_buf() } else { base.join(path) };
        let Ok(real) = candidate.canonicalize() else { continue; };
        if real.starts_with(&base) { target = Some(real); break; }
    }
    let target = target.ok_or("Image absente ou hors des espaces autorisés")?;
    let mut file = std::fs::File::open(target).map_err(|_| "Image indisponible")?;
    let metadata = file.metadata().map_err(|_| "Image indisponible")?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES { return Err("Image trop volumineuse (8 Mo maximum)".into()); }
    let mut bytes = Vec::new();
    file.by_ref().take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "Image indisponible")?;
    if bytes.len() as u64 > MAX_BYTES { return Err("Image trop volumineuse".into()); }
    raster_data_url(&bytes, &extension)
}

pub fn raster_data_url(bytes: &[u8], extension: &str) -> Result<String, String> {
    if bytes.len() as u64 > MAX_BYTES { return Err("Image trop volumineuse".into()); }
    let (mime, width, height) = dimensions(&bytes).ok_or("Image raster non reconnue")?;
    if width == 0 || height == 0 || width > 16384 || height > 16384 || width as u64 * height as u64 > MAX_PIXELS { return Err("Dimensions d’image trop grandes".into()); }
    let matches = match extension { "jpg" | "jpeg" => mime == "jpeg", other => other == mime };
    if !matches { return Err("Le contenu ne correspond pas au format d’image".into()); }
    Ok(format!("data:image/{mime};base64,{}", base64(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec(); bytes.extend(width.to_be_bytes()); bytes.extend(height.to_be_bytes()); bytes
    }
    #[test]
    fn confines_raster_reads_and_checks_bytes_and_dimensions() {
        let dir = std::env::temp_dir().join(format!("wake-image-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(dir.join("allowed")).unwrap();
        let roots = [dir.join("allowed")];
        std::fs::write(roots[0].join("sample.png"), png(10, 20)).unwrap();
        assert!(read_confined("sample.png", &roots).unwrap().starts_with("data:image/png;base64,"));
        assert!(read_confined(&roots[0].join("sample.png").to_string_lossy(), &roots).is_ok());
        std::fs::write(dir.join("outside.png"), png(10, 20)).unwrap();
        assert!(read_confined(&dir.join("outside.png").to_string_lossy(), &roots).is_err());
        for reference in ["../outside.png", "sample.png:secret", "https://example.com/a.png", "\\\\server\\share\\a.png"] { assert!(read_confined(reference, &roots).is_err()); }
        std::fs::write(roots[0].join("fake.png"), b"<svg onload='attack()'/>").unwrap();
        assert!(read_confined("fake.png", &roots).is_err());
        std::fs::write(roots[0].join("huge.png"), png(10000, 10000)).unwrap();
        assert!(read_confined("huge.png", &roots).is_err());
        let oversized = std::fs::File::create(roots[0].join("oversized.png")).unwrap(); oversized.set_len(MAX_BYTES + 1).unwrap();
        assert!(read_confined("oversized.png", &roots).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn recognizes_supported_raster_headers_and_encodes_without_html() {
        assert_eq!(dimensions(b"GIF89a\x10\0\x20\0"), Some(("gif", 16, 32)));
        assert_eq!(dimensions(b"\xff\xd8\xff\xc0\0\x07\x08\0\x10\0\x20"), Some(("jpeg", 32, 16)));
        assert_eq!(dimensions(b"<svg/>"), None);
        assert_eq!(base64(b"f"), "Zg=="); assert_eq!(base64(b"fo"), "Zm8="); assert_eq!(base64(b"foo"), "Zm9v");
    }
}
