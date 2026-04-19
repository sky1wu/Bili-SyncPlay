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

    def test_parses_cd_double_dash_before_path(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"cd -- {self.hook_cwd} && git push origin HEAD",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_parses_cd_option_before_path(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"cd -P {self.hook_cwd} && git push origin HEAD",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_cd_dash_leaves_cwd_unchanged(self) -> None:
        # `cd -` swaps to $OLDPWD; we cannot know it, so keep the current cwd
        # and evaluate the follow-up push against the hook cwd (our repo).
        self.assertEqual(
            MODULE.push_targets("cd - && git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_expands_tilde_in_resolve_path(self) -> None:
        home = Path.home()
        self.assertEqual(MODULE._resolve_path("~", Path("/tmp")), home)
        self.assertEqual(MODULE._resolve_path("~/sub", Path("/tmp")), home / "sub")

    def test_expands_tilde_in_git_c_from_outside_repo(self) -> None:
        home = Path.home()
        try:
            rel = self.hook_cwd.relative_to(home)
        except ValueError:
            self.skipTest("repo is not under $HOME")
        self.assertEqual(
            MODULE.push_targets(
                f"git -C ~/{rel} push origin HEAD",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_env_short_chdir_applies_to_git_push(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"env -C {self.hook_cwd} git push origin HEAD",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_env_long_chdir_applies_to_git_push(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"env --chdir={self.hook_cwd} git push origin HEAD",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_env_chdir_separate_arg_applies_to_git_push(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"env --chdir {self.hook_cwd} git push origin HEAD",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_pipe_does_not_leak_cd_to_following_push(self) -> None:
        self.assertEqual(
            MODULE.push_targets("cd /tmp | cat; git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_background_does_not_leak_cd_to_following_push(self) -> None:
        self.assertEqual(
            MODULE.push_targets("cd /tmp & git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_skips_leading_redirection_before_git(self) -> None:
        self.assertEqual(
            MODULE.push_targets(">/tmp/log git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_skips_split_redirection_before_git(self) -> None:
        self.assertEqual(
            MODULE.push_targets("< /dev/null git push origin HEAD", self.hook_cwd),
            [self.hook_cwd],
        )

    def test_applies_git_dir_and_work_tree_assignments(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"GIT_DIR={self.hook_cwd}/.git GIT_WORK_TREE={self.hook_cwd} git push origin HEAD",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_git_dir_beats_work_tree_for_repo_identity(self) -> None:
        self.assertEqual(
            MODULE.push_targets(
                f"git --git-dir {self.hook_cwd}/.git --work-tree /tmp push origin HEAD",
                Path("/tmp"),
            ),
            [self.hook_cwd],
        )

    def test_short_circuit_and_preserves_alternate_cwd(self) -> None:
        # `false && cd /tmp` may skip the cd at runtime; push must still be
        # evaluated against the cwd before the short-circuit (our repo).
        targets = MODULE.push_targets(
            "false && cd /tmp; git push origin HEAD",
            self.hook_cwd,
        )
        self.assertIn(self.hook_cwd, targets)

    def test_short_circuit_or_preserves_alternate_cwd(self) -> None:
        # `cd /tmp || cd <repo>` — whichever branch runs, if either lands in
        # the repo, checks must fire.
        targets = MODULE.push_targets(
            f"cd /tmp || cd {self.hook_cwd}; git push origin HEAD",
            self.hook_cwd,
        )
        self.assertIn(self.hook_cwd, targets)

    def test_short_circuit_alt_applies_to_post_compound_push(self) -> None:
        # `cd /tmp && git push; git push` — the SECOND push runs regardless
        # of whether `cd /tmp` succeeded, so its cwd could still be the
        # original hook cwd (our repo). The alt must only kick in after the
        # compound merges, not inside the chain.
        targets = MODULE.push_targets(
            "cd /tmp && git push origin HEAD; git push origin HEAD",
            self.hook_cwd,
        )
        self.assertIn(self.hook_cwd, targets)

    def test_short_circuit_chain_push_does_not_overreport(self) -> None:
        # `cd server && git push` — the push runs only if cd succeeded, so
        # the only real target is <repo>/server. We must not leak an alt
        # into the in-chain push (that was the source of the regression).
        self.assertEqual(
            MODULE.push_targets(
                "cd server && git push origin HEAD",
                self.hook_cwd,
            ),
            [self.hook_cwd / "server"],
        )


if __name__ == "__main__":
    unittest.main()
