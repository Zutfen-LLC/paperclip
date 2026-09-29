"""Release safeguards; fixture artifacts are explicitly synthetic test inputs."""
import errno
from unittest import mock
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("pack", Path(__file__).with_name("package-exact-head.py"))
assert spec is not None and spec.loader is not None
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)


class ReleaseSafeguards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "repo"
        self.root.mkdir()
        self.git("init", "--quiet")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Release test")
        (self.root / "package.json").write_text('{"name":"fixture"}\n')
        (self.root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
        self.git("add", "package.json", "pnpm-lock.yaml")
        self.git("commit", "--quiet", "-m", "fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()
        for name in ("cli/dist/index.js", "server/dist/index.js", "ui/dist/index.html", "node_modules/.modules.yaml", "packages/paperclip-runner/dist/bin/paperclip-runnerd"):
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("test fixture artifact\n")
        (self.root / "server/dist/build-info.json").write_text(json.dumps({"commit": self.sha}))
        for directory in ("cli", "server", "ui"):
            (self.root / directory / "package.json").write_text('{"name":"fixture"}\n')
        self.output = self.base / "release.tar.gz"

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True)

    def test_clean_built_head_verifies(self):
        self.assertEqual(pack.verify(self.root), self.sha)

    def test_tracked_drift_is_rejected(self):
        (self.root / "package.json").write_text('{"name":"changed"}\n')
        with self.assertRaisesRegex(ValueError, "dirty"):
            pack.verify(self.root)

    def test_stale_build_is_rejected(self):
        (self.root / "server/dist/build-info.json").write_text('{"commit":"wrong"}')
        with self.assertRaisesRegex(ValueError, "differs"):
            pack.verify(self.root)

    def test_missing_artifact_is_rejected(self):
        (self.root / "ui/dist/index.html").unlink()
        with self.assertRaisesRegex(ValueError, "Missing"):
            pack.verify(self.root)

    def test_missing_native_runner_is_rejected(self):
        (self.root / "packages/paperclip-runner/dist/bin/paperclip-runnerd").unlink()
        with self.assertRaisesRegex(ValueError, "Missing"):
            pack.verify(self.root)

    def test_package_keeps_source_and_artifacts_not_untracked_secrets(self):
        (self.root / ".env").write_text("SYNTHETIC_TEST_SECRET=not-a-real-secret\n")
        pack.package(self.root, self.output)
        with tarfile.open(self.output) as archive:
            names = archive.getnames()
            self.assertIn("release/package.json", names)
            self.assertIn("release/server/dist/index.js", names)
            self.assertNotIn("release/.env", names)
            manifest_stream = archive.extractfile("release/fork-release.json")
            assert manifest_stream is not None
            manifest = json.load(manifest_stream)
            self.assertEqual(manifest["commit"], self.sha)
        self.assertTrue(self.output.with_suffix(".gz.sha256").is_file())

    def test_bundled_cli_can_resolve_hoisted_locked_dependencies(self):
        virtual = self.root / "node_modules/.pnpm/node_modules"
        target = self.root / "node_modules/.pnpm/fixture-dep@1/node_modules/fixture-dep"
        target.mkdir(parents=True)
        (target / "package.json").write_text('{"name":"fixture-dep","main":"index.js"}\n')
        (target / "index.js").write_text('module.exports = 42;\n')
        virtual.mkdir(parents=True)
        (virtual / "fixture-dep").symlink_to("../fixture-dep@1/node_modules/fixture-dep")
        pack.package(self.root, self.output)
        with tarfile.open(self.output) as archive:
            self.assertEqual(archive.getmember("release/node_modules/fixture-dep").linkname,
                             ".pnpm/node_modules/fixture-dep")

    def test_cross_filesystem_staging_falls_back_to_copy(self):
        with mock.patch.object(pack.os, "link", side_effect=OSError(errno.EXDEV, "cross-device link")):
            pack.package(self.root, self.output)
        with tarfile.open(self.output) as archive:
            stream = archive.extractfile("release/server/dist/index.js")
            assert stream is not None
            self.assertEqual(stream.read(), b"test fixture artifact\n")

    def test_checkout_absolute_link_becomes_release_relative(self):
        (self.root / "node_modules/owned").symlink_to(self.root / "server", target_is_directory=True)
        pack.package(self.root, self.output)
        with tarfile.open(self.output) as archive:
            self.assertEqual(archive.getmember("release/node_modules/owned").linkname, "../server")

    def test_nonportable_link_is_rejected(self):
        (self.root / "node_modules/escape").symlink_to("/etc/passwd")
        with self.assertRaisesRegex(ValueError, "Nonportable"):
            pack.package(self.root, self.output)

    def test_existing_output_is_not_overwritten(self):
        self.output.write_text("sentinel")
        with self.assertRaisesRegex(ValueError, "overwrite"):
            pack.package(self.root, self.output)
        self.assertEqual(self.output.read_text(), "sentinel")


if __name__ == "__main__":
    unittest.main()
