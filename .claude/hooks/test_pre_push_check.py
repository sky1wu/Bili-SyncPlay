from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("pre-push-check.py")
SPEC = importlib.util.spec_from_file_location("pre_push_check", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PushTargetsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.hook_cwd = Path("/workspace/Bili-SyncPlay")

    def test_ignores_git_push_used_as_argument(self) -> None:
        self.assertEqual(MODULE.push_targets("echo git push", self.hook_cwd), [])

    def test_detects_push_with_git_global_flags(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                "git -c color.ui=always push origin HEAD", self.hook_cwd
            ),
            [self.hook_cwd],
        )

    def test_tracks_cd_for_following_segments(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                "cd packages/server && git push origin HEAD", self.hook_cwd
            ),
            [self.hook_cwd / "packages/server"],
        )

    def test_preserves_outer_cwd_after_subshell(self) -> None:
        self.assertEqual(
            MODULE.push_targets("(cd /tmp && git push) && git push", self.hook_cwd),
            [Path("/tmp"), self.hook_cwd],
        )

    def test_detects_git_c_push_from_outside_repo(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                "git -C /workspace/Bili-SyncPlay push origin HEAD", Path("/tmp")
            ),
            [self.hook_cwd],
        )

    def test_rebases_relative_git_dir_against_git_cwd(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                "git -C /workspace/Bili-SyncPlay --git-dir .git push",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_rebases_relative_work_tree_against_git_cwd(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                "git -C /workspace/Bili-SyncPlay --work-tree . push",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )


if __name__ == "__main__":
    unittest.main()
