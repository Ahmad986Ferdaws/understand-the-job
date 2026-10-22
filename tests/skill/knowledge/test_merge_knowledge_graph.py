#!/usr/bin/env python3
"""
test_merge_knowledge_graph.py — safety checks in merge-knowledge-graph.py:
the data directory must not be (or contain) a symlink, and the script must not
silently clobber a code graph produced by /understand unless --force is given.

Run from the repo root:
    python -m unittest tests.skill.knowledge.test_merge_knowledge_graph -v
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent.parent
_SCRIPT = (
    _REPO_ROOT / "understand-anything-plugin" / "skills" / "understand-knowledge"
    / "merge-knowledge-graph.py"
)


def _load() -> Any:
    spec = importlib.util.spec_from_file_location("merge_knowledge_graph_safety", _SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load merge-knowledge-graph.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["merge_knowledge_graph_safety"] = module
    spec.loader.exec_module(module)
    return module


mkg = _load()

MANIFEST = {
    "nodes": [
        {"id": "article:a", "type": "article", "name": "A", "summary": "s",
         "tags": [], "complexity": "simple"},
    ],
    "edges": [],
    "categories": [],
}

CODE_NODES = [
    {"id": "file:src/a.ts", "type": "file", "name": "a.ts", "filePath": "src/a.ts",
     "summary": "s", "tags": [], "complexity": "simple"},
    {"id": "function:src/a.ts:f", "type": "function", "name": "f", "filePath": "src/a.ts",
     "summary": "s", "tags": [], "complexity": "simple"},
]
CODE_META = {"lastAnalyzedAt": "t", "gitCommitHash": "abc1234def", "version": "1.0.0",
             "analyzedFiles": 2}


def _graph(**extra: Any) -> dict:
    base = {
        "version": "1.0.0",
        "project": {"name": "p", "languages": [], "frameworks": [], "description": "d",
                    "analyzedAt": "t", "gitCommitHash": "abc1234def"},
        "nodes": CODE_NODES, "edges": [], "layers": [], "tour": [],
    }
    base.update(extra)
    return base


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.base = Path(tempfile.mkdtemp(prefix="ua-mkg-sec-")).resolve()
        self.root = self.base / "wiki-project"
        self.outside = self.base / "outside"
        self.root.mkdir()
        self.outside.mkdir()
        self.ua = self.root / ".ua"
        (self.ua / "intermediate").mkdir(parents=True)
        self.write("intermediate/scan-manifest.json", MANIFEST)

    def tearDown(self) -> None:
        shutil.rmtree(self.base, ignore_errors=True)

    def write(self, rel: str, value: Any) -> None:
        (self.ua / rel).write_text(json.dumps(value), encoding="utf-8")

    def cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(_SCRIPT), *args],
            capture_output=True, text=True, timeout=60,
        )

    @property
    def assembled(self) -> Path:
        return self.ua / "intermediate" / "assembled-graph.json"


class TestExistingGraphVerdict(_Base):
    def verdict(self) -> Any:
        return mkg.existing_graph_verdict(self.ua)

    def test_empty_data_dir_is_replaceable(self) -> None:
        self.assertIsNone(self.verdict())

    def test_codebase_kind_is_protected(self) -> None:
        self.write("knowledge-graph.json", _graph(kind="codebase"))
        self.assertIn("kind: codebase", self.verdict())

    def test_kindless_graph_with_code_nodes_is_protected(self) -> None:
        self.write("knowledge-graph.json", _graph())
        self.assertIn("file/function/class", self.verdict())

    def test_kindless_graph_is_protected_by_git_commit_meta(self) -> None:
        self.write("knowledge-graph.json", _graph(nodes=[]))
        self.write("meta.json", CODE_META)
        self.assertIn("git commit", self.verdict())

    def test_kindless_empty_graph_without_meta_is_replaceable(self) -> None:
        self.write("knowledge-graph.json", _graph(nodes=[]))
        self.assertIsNone(self.verdict())

    def test_meta_alone_is_protected(self) -> None:
        self.write("meta.json", CODE_META)
        self.assertIn("git commit", self.verdict())

    def test_meta_with_empty_hash_or_figma_version_is_not_code(self) -> None:
        self.write("meta.json", {**CODE_META, "gitCommitHash": ""})
        self.assertIsNone(self.verdict())
        self.write("meta.json", {**CODE_META, "figmaVersion": "v1"})
        self.assertIsNone(self.verdict())

    def test_knowledge_and_design_graphs_are_replaceable_even_with_commit_meta(self) -> None:
        self.write("meta.json", CODE_META)
        for kind in ("knowledge", "design"):
            self.write("knowledge-graph.json", _graph(kind=kind))
            self.assertIsNone(self.verdict(), kind)

    def test_unreadable_graph_is_protected(self) -> None:
        (self.ua / "knowledge-graph.json").write_text("{ nope", encoding="utf-8")
        self.assertIn("unreadable", self.verdict())

    def test_non_object_graph_is_protected(self) -> None:
        self.write("knowledge-graph.json", [1, 2, 3])
        self.assertIn("unreadable", self.verdict())

    def test_unreadable_meta_is_ignored(self) -> None:
        self.write("knowledge-graph.json", _graph(nodes=[]))
        (self.ua / "meta.json").write_text("garbage", encoding="utf-8")
        self.assertIsNone(self.verdict())


class TestMergeRefusesToClobberCodeGraph(_Base):
    def test_fresh_dir_merges(self) -> None:
        graph = mkg.merge(self.root)
        self.assertEqual(len(graph["nodes"]), 1)
        self.assertTrue(self.assembled.is_file())
        self.assertEqual(json.loads(self.assembled.read_text())["kind"], "knowledge")

    def test_refuses_and_leaves_everything_untouched(self) -> None:
        self.write("knowledge-graph.json", _graph(kind="codebase"))
        self.write("meta.json", CODE_META)
        before = {p.name: p.read_bytes() for p in self.ua.glob("*.json")}

        with self.assertRaises(mkg.WouldOverwriteCodeGraph) as ctx:
            mkg.merge(self.root)

        self.assertIn("--force", str(ctx.exception))
        self.assertFalse(self.assembled.exists())
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.ua.glob("*.json")})

    def test_force_proceeds(self) -> None:
        self.write("knowledge-graph.json", _graph())
        mkg.merge(self.root, force=True)
        self.assertTrue(self.assembled.is_file())

    def test_rerun_over_a_previous_knowledge_graph_is_fine(self) -> None:
        self.write("knowledge-graph.json", _graph(kind="knowledge", nodes=[]))
        self.write("meta.json", CODE_META)  # knowledge meta records the wiki repo's commit
        mkg.merge(self.root)
        self.assertTrue(self.assembled.is_file())

    def test_cli_exit_codes(self) -> None:
        ok = self.cli(str(self.root))
        self.assertEqual(ok.returncode, 0, ok.stderr)

        self.write("knowledge-graph.json", _graph())
        refused = self.cli(str(self.root))
        self.assertEqual(refused.returncode, 3)
        self.assertIn("Refusing to continue", refused.stderr)

        forced = self.cli(str(self.root), "--force")
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertIn("--force", forced.stderr)

        flag_first = self.cli("--force", str(self.root))
        self.assertEqual(flag_first.returncode, 0, flag_first.stderr)

    def test_cli_usage_error(self) -> None:
        r = self.cli()
        self.assertEqual(r.returncode, 1)
        self.assertIn("Usage:", r.stderr)


@unittest.skipIf(os.name == "nt", "symlinks need elevated rights on Windows")
class TestSymlinkHardening(_Base):
    def test_symlinked_data_dir_is_rejected(self) -> None:
        elsewhere = self.outside / "ua"
        shutil.move(str(self.ua), str(elsewhere))
        os.symlink(elsewhere, self.ua)

        with self.assertRaises(mkg.UnsafeDataDir) as ctx:
            mkg.assert_safe_data_dir(self.root)
        self.assertIn("symbolic link", str(ctx.exception))

        r = self.cli(str(self.root))
        self.assertEqual(r.returncode, 2)
        self.assertIn("Unsafe data directory", r.stderr)
        self.assertFalse((elsewhere / "intermediate" / "assembled-graph.json").exists())

    def test_symlink_pointing_inside_the_project_is_rejected(self) -> None:
        real = self.root / "real-data"
        shutil.move(str(self.ua), str(real))
        os.symlink(real, self.ua)
        with self.assertRaises(mkg.UnsafeDataDir):
            mkg.assert_safe_data_dir(self.root)

    def test_nested_symlinked_output_is_rejected_and_victim_untouched(self) -> None:
        victim = self.outside / ".zshrc"
        victim.write_text("# precious\n")
        os.symlink(victim, self.assembled)

        r = self.cli(str(self.root))

        self.assertEqual(r.returncode, 2)
        self.assertIn("assembled-graph.json is a symbolic link", r.stderr)
        self.assertEqual(victim.read_text(), "# precious\n")

    def test_deeply_nested_symlink_is_rejected(self) -> None:
        deep = self.ua / "intermediate" / "a" / "b"
        deep.mkdir(parents=True)
        os.symlink(self.outside, deep / "link")
        with self.assertRaises(mkg.UnsafeDataDir):
            mkg.assert_safe_data_dir(self.root)

    def test_dangling_symlinked_legacy_dir_is_picked_up_and_rejected(self) -> None:
        os.symlink(self.outside / "nowhere", self.root / ".understand-anything")
        self.assertEqual(mkg.resolve_ua_dir(self.root).name, ".understand-anything")
        with self.assertRaises(mkg.UnsafeDataDir):
            mkg.assert_safe_data_dir(self.root)
        self.assertFalse((self.outside / "nowhere").exists())

    def test_reason_is_one_line_without_control_characters(self) -> None:
        os.symlink(self.outside, self.ua / "bad\n\x1b[31mname")
        with self.assertRaises(mkg.UnsafeDataDir) as ctx:
            mkg.assert_safe_data_dir(self.root)
        self.assertNotIn("\n", str(ctx.exception))
        self.assertNotIn("\x1b", str(ctx.exception))

    def test_safe_write_replaces_instead_of_following(self) -> None:
        # Reach the writer past the guard to show the rename semantics on their own.
        victim = self.outside / "victim.txt"
        victim.write_text("keep")
        target = self.ua / "intermediate" / "out.json"
        os.symlink(victim, target)
        real_assert = mkg.assert_safe_data_dir
        mkg.assert_safe_data_dir = lambda root: root / ".ua"
        try:
            mkg._safe_write_text(self.root, self.ua / "intermediate", "out.json", "new")
        finally:
            mkg.assert_safe_data_dir = real_assert
        self.assertEqual(victim.read_text(), "keep")
        self.assertFalse(target.is_symlink())
        self.assertEqual(target.read_text(), "new")


class TestSafeDirLayouts(_Base):
    def test_missing_data_dir_is_safe(self) -> None:
        shutil.rmtree(self.ua)
        self.assertEqual(mkg.assert_safe_data_dir(self.root), self.ua)

    def test_normal_nested_dir_is_safe(self) -> None:
        (self.ua / "intermediate" / "deep").mkdir()
        (self.ua / "intermediate" / "deep" / "f.json").write_text("{}")
        self.assertEqual(mkg.assert_safe_data_dir(self.root), self.ua)

    def test_legacy_dir_wins_when_present(self) -> None:
        legacy = self.root / ".understand-anything"
        (legacy / "intermediate").mkdir(parents=True)
        (legacy / "intermediate" / "scan-manifest.json").write_text(json.dumps(MANIFEST))
        self.assertEqual(mkg.resolve_ua_dir(self.root), legacy)
        mkg.merge(self.root)
        self.assertTrue((legacy / "intermediate" / "assembled-graph.json").is_file())
        self.assertFalse(self.assembled.exists())

    def test_data_dir_that_is_a_file_is_rejected(self) -> None:
        shutil.rmtree(self.ua)
        self.ua.write_text("x")
        with self.assertRaises(mkg.UnsafeDataDir):
            mkg.assert_safe_data_dir(self.root)

    def test_write_leaves_no_temp_files(self) -> None:
        mkg.merge(self.root)
        names = sorted(p.name for p in (self.ua / "intermediate").iterdir())
        self.assertEqual(names, ["assembled-graph.json", "scan-manifest.json"])


if __name__ == "__main__":
    unittest.main()
