"""Independent fixture checks for the read-only harvest; run with Python stdlib."""

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("harvest", Path(__file__).with_name("hook-harvest.py"))
harvest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harvest)


class HarvestTests(unittest.TestCase):
    def test_comparison_preserves_real_deltas_and_empty_files(self):
        left = {"same": b"x", "stamp": b"# hook_pack_version: 67\nexit 2\n",
                "body": b"# hook_pack_version: 67\nexit 0\n", "empty": b"",
                "added": b"new", "prose": b"version 67"}
        right = {"same": b"x", "stamp": b"# hook_pack_version: 1\nexit 2\n",
                 "body": b"# hook_pack_version: 1\nexit 2\n", "empty": b"",
                 "removed": b"old", "prose": b"version 1"}
        rows = {row["path"]: row for row in harvest.compare(left, right)}
        self.assertEqual({p: r["status"] for p, r in rows.items()}, {
            "same": "identical", "stamp": "version-stamp-only", "body": "different",
            "empty": "identical", "added": "consumer-only", "removed": "caws-only",
            "prose": "different",
        })
        self.assertEqual(rows["empty"]["consumer_bytes"], 0)
        self.assertEqual(rows["empty"]["consumer_sha256"],
                         "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        self.assertNotEqual(rows["stamp"]["consumer_sha256"], rows["stamp"]["caws_sha256"])

    def test_dispatch_comments_and_expressions_are_not_active_handlers(self):
        data = b'''HANDLERS=(
  first.sh second.sh
  "audit.sh tool-use"
  # "audit.sh stop"
  # test-run-guard.sh refuses raw pytest
  "$DYNAMIC_HANDLER"
)
'''
        result = harvest.declarations(data)
        self.assertEqual([r["entry"] for r in result["declared"]],
                         ["first.sh", "second.sh", "audit.sh tool-use"])
        self.assertEqual(result["commented"], [{"entry": "audit.sh stop", "line": 4}])
        self.assertEqual(result["unresolved_lines"], [6])

    def test_inventory_does_not_follow_links_or_include_vendor_and_cache_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "hooks"
            root.mkdir()
            (root / "custom.sh").write_bytes(b"exit 2\n")
            for name in ("node_modules", "__pycache__", ".pristine"):
                (root / name).mkdir()
                (root / name / "payload").write_bytes(b"excluded")
            outside = base / "outside"
            outside.mkdir()
            (outside / "payload").write_bytes(b"not hook source")
            (root / "linked-dir").symlink_to(outside, target_is_directory=True)
            (root / "linked-file").symlink_to(outside / "payload")
            files, excluded = harvest.inventory(root)
            self.assertEqual(files, {"custom.sh": b"exit 2\n"})
            self.assertEqual({r["path"] for r in excluded},
                             {"node_modules", "__pycache__", ".pristine", "linked-dir", "linked-file"})
            self.assertEqual((outside / "payload").read_bytes(), b"not hook source")

    def test_snapshot_refuses_mid_read_changes_even_without_a_commit(self):
        with patch.object(harvest, "git", return_value="head\n"), patch.object(
            harvest, "inventory", side_effect=[({"guard.sh": b"exit 2"}, []),
                                               ({"guard.sh": b"exit 0"}, [])]
        ):
            with self.assertRaisesRegex(RuntimeError, "source changed during inventory"):
                harvest.snapshot(Path("repo"), Path("repo/hooks"))


if __name__ == "__main__":
    unittest.main()
