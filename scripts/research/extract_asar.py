"""Extract an Electron ASAR as data, without loading any application code.

Usage: python extract_asar.py INPUT.asar OUTPUT_DIRECTORY
The output directory must not already exist. A SHA-256 manifest is included.
"""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import struct


def extract(source: Path, destination: Path) -> dict:
    source = source.resolve(strict=True)
    destination = destination.resolve()
    if destination.exists():
        raise ValueError(f"Output already exists: {destination}")

    entries = []
    archive_size = source.stat().st_size
    with source.open("rb") as archive:
        prefix = archive.read(16)
        if len(prefix) != 16:
            raise ValueError("Truncated ASAR header")
        size_payload, header_size, header_payload, json_size = struct.unpack("<4I", prefix)
        if (
            size_payload != 4
            or header_size < 8
            or header_payload + 4 != header_size
            or json_size > header_payload - 4
            or header_size > 64 * 1024 * 1024
            or 8 + header_size > archive_size
        ):
            raise ValueError("Invalid ASAR header lengths")
        header = json.loads(archive.read(json_size).decode("utf-8"))
        data_start = 8 + header_size

        def walk(directory: dict, parent: PurePosixPath) -> None:
            for name, entry in directory.get("files", {}).items():
                if name in ("", ".", "..") or any(c in name for c in ("/", "\\", ":")):
                    raise ValueError(f"Unsafe archive name: {name!r}")
                relative = parent / name
                target = destination.joinpath(*relative.parts)
                if not target.resolve().is_relative_to(destination):
                    raise ValueError(f"Path outside destination: {relative}")
                if "files" in entry:
                    walk(entry, relative)
                    continue
                if entry.get("link") or entry.get("unpacked"):
                    raise ValueError(f"Links/unpacked files need separate review: {relative}")
                size = int(entry["size"])
                offset = int(entry["offset"])
                if size < 0 or offset < 0 or data_start + offset + size > archive_size:
                    raise ValueError(f"File outside archive bounds: {relative}")
                entries.append((relative, target, size, data_start + offset))

        walk(header, PurePosixPath())
        destination.mkdir(parents=True)
        manifest_files = []
        for relative, target, size, start in entries:
            archive.seek(start)
            content = archive.read(size)
            if len(content) != size:
                raise ValueError(f"Truncated file: {relative}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as output:
                output.write(content)
            digest = hashlib.sha256(content).hexdigest()
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise ValueError(f"Output verification failed: {relative}")
            manifest_files.append({"path": relative.as_posix(), "size": size, "sha256": digest})

    with source.open("rb") as archive:
        archive_digest = hashlib.file_digest(archive, "sha256").hexdigest()
    manifest = {
        "archive": str(source),
        "archive_sha256": archive_digest,
        "file_count": len(manifest_files),
        "files": manifest_files,
    }
    (destination / "extraction-manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    result = extract(args.source, args.destination)
    print(json.dumps({"file_count": result["file_count"], "archive_sha256": result["archive_sha256"]}))
