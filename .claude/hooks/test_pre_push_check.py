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
        self.hook_cwd = MODULE.OUR_REPO

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
            MODULE.push_targets("cd server && git push origin HEAD", self.hook_cwd),
            [self.hook_cwd / "server"],
        )

    def test_keeps_cwd_when_cd_target_does_not_exist(self) -> None:
        self.assertEqual(
            MODULE.push_targets("cd /not/exist; git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_preserves_outer_cwd_after_subshell(self) -> None:
        self.assertEqual(
            MODULE.push_targets("(cd /tmp && git push) && git push", self.hook_cwd),
            [Path("/tmp"), self.hook_cwd],
        )

    def test_detects_git_c_push_from_outside_repo(self) -> None:
        self.assertEqual(
            MODULE.push_targets(f"git -C {self.hook_cwd} push origin HEAD", Path("/tmp")),
            [self.hook_cwd],
        )

    def test_rebases_relative_git_dir_against_git_cwd(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"git -C {self.hook_cwd} --git-dir .git push",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_rebases_relative_work_tree_against_git_cwd(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"git -C {self.hook_cwd} --work-tree . push",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_detects_push_through_env_prefix(self) -> None:
        self.assertEqual(
            MODULE.push_targets("env FOO=1 git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_detects_push_through_command_prefix(self) -> None:
        self.assertEqual(
            MODULE.push_targets("command git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_detects_push_in_if_then_block(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"if cd {self.hook_cwd}; then git push origin HEAD; fi",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_detects_push_in_brace_group(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"{{ cd {self.hook_cwd}; git push origin HEAD; }}",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_detects_push_through_time_prefix(self) -> None:
        self.assertEqual(
            MODULE.push_targets("time git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_detects_push_through_nohup_prefix(self) -> None:
        self.assertEqual(
            MODULE.push_targets("nohup git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_detects_push_through_exec_prefix(self) -> None:
        self.assertEqual(
            MODULE.push_targets("exec git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )


if __name__ == "__main__":
    unittest.main()
