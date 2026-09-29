#!/usr/bin/env python3
"""Package a clean, fully built fork revision without registry Paperclip overlays."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def command(root, *args):
    return subprocess.check_output(args, cwd=root, text=True).strip()


def verify(root):
    revision = command(root, "git", "rev-parse", "HEAD")
    if command(root, "git", "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Tracked source is dirty; commit and rebuild before packaging")
    stamp = json.loads((root / "server/dist/build-info.json").read_text())
    if stamp.get("commit") != revision:
        raise ValueError("Server build stamp differs from HEAD; rebuild the entire workspace")
    for relative in ("cli/dist/index.js", "server/dist/index.js", "ui/dist/index.html", "node_modules/.modules.yaml", "packages/paperclip-runner/dist/bin/paperclip-runnerd"):
        if not (root / relative).is_file():
            raise ValueError(f"Missing build/install artifact: {relative}")
    return revision


def package(root, output):
    revision = verify(root)
    if output.is_relative_to(root):
        raise ValueError("Release output must be outside the checkout")
    if output.exists():
        raise ValueError("Refusing to overwrite an existing release")
    output.parent.mkdir(parents=True, exist_ok=True)
    packages = sorted({p.parent for p in root.rglob("package.json")
                       if not any(part in {"node_modules", ".git", "target", "dist"}
                                  for part in p.relative_to(root).parts)})
    generated = []
    for directory in [root, *packages]:
        for name in ("node_modules", "dist", "dist-issue-thread"):
            p = directory / name
            if p.is_dir() and p not in generated:
                generated.append(p)
    manifest = {
        "repository": "https://github.com/Zutfen-LLC/paperclip",
        "commit": revision,
        "tree": command(root, "git", "rev-parse", "HEAD^{tree}"),
        "lockfileSha256": hashlib.sha256((root / "pnpm-lock.yaml").read_bytes()).hexdigest(),
        "node": command(root, "node", "--version"),
        "pnpm": command(root, "pnpm", "--version"),
        "artifactDirectories": [str(p.relative_to(root)) for p in generated],
        "buildCommand": "pnpm install --frozen-lockfile && pnpm build",
        "entrypoint": "node cli/dist/index.js run --instance default",
    }
    with tempfile.TemporaryDirectory(prefix="paperclip-release-", dir=output.parent) as temp:
        staging = Path(temp) / "release"
        staging.mkdir()
        archive = Path(temp) / "source.tar"
        subprocess.run(["git", "archive", "--format=tar", f"--output={archive}", revision], cwd=root, check=True)
        with tarfile.open(archive) as source:
            source.extractall(staging, filter="data")
        for p in generated:
            shutil.copytree(p, staging / p.relative_to(root), symlinks=True,
                            dirs_exist_ok=True, copy_function=os.link)
        # Reject host-absolute links or workspace links that would escape this release.
        for directory, dirs, files in os.walk(staging, followlinks=False):
            for name in dirs + files:
                p = Path(directory) / name
                if p.is_symlink():
                    target = os.readlink(p)
                    if os.path.isabs(target) or not p.resolve().is_relative_to(staging.resolve()):
                        raise ValueError(f"Nonportable symlink: {p.relative_to(staging)}")
        (staging / "fork-release.json").write_text(json.dumps(manifest, indent=2) + "\n")
        with tarfile.open(output, "w:gz", compresslevel=1) as release:
            release.add(staging, arcname="release")
    with output.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    output.with_suffix(output.suffix + ".sha256").write_text(f"{digest}  {output.name}\n")
    print(json.dumps({"commit": revision, "archive": str(output), "sha256": digest}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    if args.verify_only:
        print(verify(root))
    elif args.output:
        package(root, args.output.resolve())
    else:
        parser.error("--output or --verify-only is required")
