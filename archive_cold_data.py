#!/usr/bin/env python3
"""
V6.0 STORAGE_OPTIMIZATION — Standalone Cold Storage archival script.

Usage:
    python archive_cold_data.py            # archive records older than 30d
    python archive_cold_data.py --dry-run  # preview archival impact
    python archive_cold_data.py --age 60   # custom threshold (days)

Moves records with timestamp < T-{age}d from ghostrail.enc (hot) to
ghostrail_archive.enc (cold, ZIP + AES-256-GCM). The main /points
endpoint stays ultra-light because only hot records remain in
ghostrail.enc; /api/archive streams cold data on demand.

This script is also invoked automatically by tracker_map.py:
  - Once on startup (main())
  - Every 6h via a background thread
Running it manually is useful for operators who want to trigger an
out-of-band archival pass (e.g. after a SECRET_KEY rotation that
re-encrypted the hot DB).
"""
import argparse
import os
import sys
from pathlib import Path

# Make tracker_map importable
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Lazy import so --help works even if dependencies are missing
def _run():
    import tracker_map as tm  # noqa: E402

    parser = argparse.ArgumentParser(
        description="Cold Storage archival: move records older than T-Nd from ghostrail.enc to ghostrail_archive.enc",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview archival impact without mutating any files",
    )
    parser.add_argument(
        "--age",
        type=int,
        default=tm.ARCHIVE_AGE_DAYS,
        help=f"Archival age threshold in days (default: {tm.ARCHIVE_AGE_DAYS})",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List a summary of the cold archive and exit",
    )
    parser.add_argument(
        "--offset",
        type=int,
        default=0,
        help="Offset for --list pagination (default: 0)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=50,
        help="Limit for --list pagination (default: 50)",
    )
    args = parser.parse_args()

    # Override the threshold if --age was passed
    if args.age != tm.ARCHIVE_AGE_DAYS:
        tm.ARCHIVE_AGE_DAYS = args.age

    if args.list:
        payload = tm.read_archive(offset=args.offset, limit=args.limit)
        print("=" * 60)
        print(f"Cold Storage Archive — ghostrail_archive.enc")
        print("=" * 60)
        print(f"  version:       {payload.get('version', 'v6.0_cold_storage')}")
        print(f"  algorithm:     {payload.get('algorithm', 'AES-256-GCM')}")
        print(f"  compression:   {payload.get('compression', 'zip')}")
        print(f"  record_count:  {payload.get('record_count', 0)}")
        print(f"  archived_at:   {payload.get('archived_at', '(never)')}")
        print(f"  offset:        {payload.get('offset', 0)}")
        print(f"  returned:      {payload.get('returned', 0)}")
        print("-" * 60)
        for i, rec in enumerate(payload.get("records", [])[:args.limit]):
            ts = rec.get("timestamp") or rec.get("ts") or "?"
            lat = rec.get("lat", "?")
            lng = rec.get("lng", "?")
            print(f"  [{i+1}] {ts}  lat={lat}  lng={lng}")
        if not payload.get("records"):
            print("  (no records returned — archive may be empty)")
        return 0

    print("=" * 60)
    print(f"Cold Storage Archival — age threshold: T-{tm.ARCHIVE_AGE_DAYS}d")
    print(f"  hot_db:  {tm.GHOSTRAIL_ENC_PATH}")
    print(f"  cold_db: {tm.GHOSTRAIL_ARCHIVE_PATH}")
    print(f"  mode:    {'DRY-RUN' if args.dry_run else 'ARCHIVE'}")
    print("=" * 60)

    summary = tm.archive_cold_data(dry_run=args.dry_run)
    print(f"  threshold:           {summary.get('threshold')}")
    print(f"  archived:            {summary.get('archived', 0)}")
    print(f"  kept_hot:            {summary.get('kept_hot', 0)}")
    print(f"  archive_total:       {summary.get('archive_total', 0)}")
    if summary.get("error"):
        print(f"  ERROR: {summary['error']}")
        return 1
    print("=" * 60)
    print("OK" if not args.dry_run else "DRY-RUN (no files modified)")
    return 0


if __name__ == "__main__":
    sys.exit(_run())
