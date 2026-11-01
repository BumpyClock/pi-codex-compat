#!/usr/bin/env python3
"""Run executable hook/installer fixtures. No outbound push or real project tools."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class HookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="push hooks ")
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name)
        self.repo = self.parent / "checkout with spaces"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        for path in [".githooks/pre-push", "scripts/install-git-hooks.sh"]:
            dest = self.repo / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / path, dest)
        if (ROOT / '.gitattributes').exists():
            shutil.copy2(ROOT / '.gitattributes', self.repo / '.gitattributes')
        (self.repo / ".gitignore").write_text("node_modules/\n")
        self.commit("file with spaces.ts", "first")
        self.base = self.git("rev-parse", "HEAD")
        self.commit("file with spaces.ts", "second")
        self.head = self.git("rev-parse", "HEAD")
        self.zero = "0" * len(self.head)
        self.calls = self.parent / "calls"
        self.bin = self.parent / "bin"
        self.bin.mkdir()
        self.stub(self.bin / "node", '#!/bin/sh\necho 24\n')
        self.stub(self.bin / "npm", '#!/bin/sh\necho "npm $*" >> "$CALLS"\nexit "${FAIL_NPM:-0}"\n')
        self.stub(self.repo / "node_modules/.bin/biome", '#!/bin/sh\necho "biome $*" >> "$CALLS"\nexit "${FAIL_BIOME:-0}"\n')
        self.stub(self.repo / "node_modules/.bin/tsc", '#!/bin/sh\nexit 0\n')

    def stub(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        path.chmod(0o755)

    def git(self, *args, cwd=None):
        return subprocess.check_output(["git", *args], cwd=cwd or self.repo, text=True).strip()

    def commit(self, path, text):
        (self.repo / path).write_text(text)
        self.git("add", "-A")
        self.git("commit", "-qm", "fixture")

    def record(self, local=None, remote=None):
        return f"refs/heads/topic {local or self.head} refs/heads/topic {remote or self.base}\n"

    def run_hook(self, records=None, **extra):
        self.calls.write_text("")
        result = subprocess.run([str(self.repo / ".githooks/pre-push")], cwd=self.repo,
                                input=self.record() if records is None else records, text=True,
                                env={**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                                     "CALLS": str(self.calls), **extra}, capture_output=True)
        return result, self.calls.read_text().splitlines()

    def test_full_scope_for_new_unknown_empty_and_multiple_refs(self):
        for records in [self.record(), self.record(remote=self.zero), self.record(remote="f" * 40),
                        "", self.record() + self.record(remote=self.zero), self.record(remote=self.head)]:
            with self.subTest(records=records):
                result, calls = self.run_hook(records)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls, ["biome check .", "npm run typecheck"])

    def test_renamed_and_deleted_source_still_checks_full_project(self):
        self.git("mv", "file with spaces.ts", "renamed source.ts")
        self.git("commit", "-qm", "rename")
        self.head = self.git("rev-parse", "HEAD")
        self.assertEqual(len(self.run_hook()[1]), 2)
        self.git("rm", "renamed source.ts")
        self.git("commit", "-qm", "delete")
        self.head = self.git("rev-parse", "HEAD")
        self.assertEqual(len(self.run_hook()[1]), 2)

    def test_deletion_only_skips_but_mixed_update_checks(self):
        deleted = self.record(local=self.zero)
        self.assertEqual(self.run_hook(deleted)[1], [])
        self.assertEqual(len(self.run_hook(deleted + self.record())[1]), 2)

    def test_non_head_and_malformed_refs_fail(self):
        for records in [self.record(local=self.base), "bad record\n", self.record() + "bad record\n"]:
            result, calls = self.run_hook(records)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

    def test_dirty_checkout_and_missing_tool_fail(self):
        (self.repo / "unrelated.txt").write_text("user work")
        self.assertNotEqual(self.run_hook()[0].returncode, 0)
        (self.repo / "unrelated.txt").unlink()
        (self.repo / "node_modules/.bin/biome").unlink()
        self.assertNotEqual(self.run_hook()[0].returncode, 0)

    def test_failed_checks_propagate(self):
        self.assertEqual(self.run_hook(FAIL_BIOME="17")[0].returncode, 17)
        self.assertEqual(self.run_hook(FAIL_NPM="23")[0].returncode, 23)

    def installer(self, cwd=None):
        cwd = cwd or self.repo
        return subprocess.run([str(cwd / "scripts/install-git-hooks.sh")], cwd=cwd,
                              capture_output=True, text=True)

    def test_installer_idempotent_and_refuses_existing_config_or_hook(self):
        hook = self.repo / ".git/hooks/pre-commit"
        self.stub(hook, "#!/bin/sh\nexit 0\n")
        self.assertNotEqual(self.installer().returncode, 0)
        self.assertEqual(hook.read_text(), "#!/bin/sh\nexit 0\n")
        hook.unlink()
        self.git("config", "core.hooksPath", "unrelated hooks")
        self.assertNotEqual(self.installer().returncode, 0)
        self.assertEqual(self.git("config", "core.hooksPath"), "unrelated hooks")
        self.git("config", "--unset", "core.hooksPath")
        self.assertEqual(self.installer().returncode, 0)
        self.assertEqual(self.installer().returncode, 0)
        self.assertEqual(self.git("config", "core.hooksPath"), ".githooks")

    def test_installer_in_disposable_linked_worktree(self):
        linked = self.parent / "linked checkout"
        self.git("worktree", "add", "-qb", "linked-fixture", str(linked))
        self.assertEqual(self.installer(linked).returncode, 0)
        self.assertEqual(self.git("config", "core.hooksPath", cwd=linked), ".githooks")

    def test_git_status_error_stops_before_project_checks(self):
        (self.repo / '.git/index').write_bytes(b'bad')
        result, calls = self.run_hook()
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [])

    def test_autocrlf_checkout_preserves_shell_entrypoints(self):
        self.git('config', 'core.autocrlf', 'true')
        self.git('checkout-index', '--force', '--all')
        for path in ['.githooks/pre-push', 'scripts/install-git-hooks.sh']:
            self.assertNotIn(b'\r\n', (self.repo / path).read_bytes(), path)


if __name__ == "__main__":
    unittest.main()
