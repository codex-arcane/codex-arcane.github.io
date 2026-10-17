#!/usr/bin/env python3
"""
Scan data/ and write data/manifest.json so the website knows which categories exist.

Each folder inside data/ is one category. Put the scraped .json file and its
images folder anywhere inside it, for example:

    data/additional-gear/additionalgear.json
    data/additional-gear/images/*.webp

Optional: add data/<folder>/category.json with {"name": "Display name"} to
control the tab label. Otherwise the folder name is used ("additional-gear"
becomes "Additional Gear").

Run:  py scripts/build_manifest.py
"""
import json
import re
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
SKIP_DIRS = {"cache"}  # raw scraped HTML, not needed by the site


def pretty(name):
    return re.sub(r"[-_]+", " ", name).strip().title()


def rel(p):
    return p.relative_to(DATA.parent).as_posix()


def main():
    categories = []
    for folder in sorted(p for p in DATA.iterdir() if p.is_dir()):
        files = [
            f for f in sorted(folder.rglob("*.json"))
            if f.name != "category.json" and not SKIP_DIRS & set(f.relative_to(folder).parts)
        ]
        if not files:
            continue

        name = pretty(folder.name)
        meta = folder / "category.json"
        if meta.exists():
            name = json.loads(meta.read_text(encoding="utf-8")).get("name", name)

        count = 0
        for f in files:
            content = json.loads(f.read_text(encoding="utf-8"))
            count += len(content) if isinstance(content, list) else 0

        images = next((d for d in [folder / "images", *folder.rglob("images")] if d.is_dir()), None)
        categories.append({
            "id": folder.name,
            "name": name,
            "count": count,
            "files": [rel(f) for f in files],
            "images": rel(images) if images else None,
        })
        print(f"{name}: {count} items from {len(files)} file(s)")

    (DATA / "manifest.json").write_text(json.dumps({"categories": categories}, indent=2), encoding="utf-8")
    print(f"Wrote {DATA / 'manifest.json'} with {len(categories)} categories")


if __name__ == "__main__":
    main()
