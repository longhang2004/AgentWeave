import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addGitWorktree,
  removeGitWorktree,
  worktreeIsRegistered,
  getGitRunner,
  setGitRunner,
} from "./workspace-execution.service";

/**
 * PP1 Slice A — pure git-worktree helpers over REAL local repositories
 * (no network, no paid provider). Deterministic temp repos exercise:
 * creation, registration verification, retry idempotency, preservation of
 * dirty work, idempotent removal of already-removed worktrees.
 */
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const describeWithGit = gitAvailable ? describe : describe.skip;

function initRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "tenvyr-worktree-spec-"));
  const run = (args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Tenvyr Spec",
        GIT_AUTHOR_EMAIL: "spec@tenvyr.local",
        GIT_COMMITTER_NAME: "Tenvyr Spec",
        GIT_COMMITTER_EMAIL: "spec@tenvyr.local",
      },
    });
  writeFileSync(join(root, "README.md"), "# source\n", "utf8");
  run(["init", "-b", "main"]);
  run(["config", "user.name", "Tenvyr Spec"]);
  run(["config", "user.email", "spec@tenvyr.local"]);
  run(["add", "README.md"]);
  run(["commit", "-m", "initial"]);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describeWithGit("PP1 git worktree helpers", () => {
  it("creates a distinct registered worktree with a tenvyr-owned branch", () => {
    const repo = initRepo();
    try {
      const executionPath = join(repo.root, "..", `run-${Date.now()}`);
      rmSync(executionPath, { recursive: true, force: true });
      const error = addGitWorktree(repo.root, executionPath, "tenvyr/run-test");
      expect(error).toBeNull();
      expect(existsSync(join(executionPath, "README.md"))).toBe(true);
      expect(worktreeIsRegistered(repo.root, executionPath)).toBe("REGISTERED");
      // Distinct from the source tree.
      expect(executionPath).not.toBe(repo.root);
      const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: executionPath,
        encoding: "utf8",
      });
      expect(head.stdout.trim()).toBe("tenvyr/run-test");
      // Source branch stays untouched.
      const sourceBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repo.root,
        encoding: "utf8",
      });
      expect(sourceBranch.stdout.trim()).toBe("main");
      rmSync(executionPath, { recursive: true, force: true });
    } finally {
      repo.cleanup();
    }
  });

  it("treats an already-registered worktree as success (retry idempotency)", () => {
    const repo = initRepo();
    try {
      const executionPath = join(repo.root, "..", `run-retry-${Date.now()}`);
      rmSync(executionPath, { recursive: true, force: true });
      expect(
        addGitWorktree(repo.root, executionPath, "tenvyr/run-retry"),
      ).toBeNull();
      // A retry of the same allocation must NOT fail: the worktree already
      // exists and is registered.
      expect(
        addGitWorktree(repo.root, executionPath, "tenvyr/run-retry"),
      ).toBeNull();
      expect(worktreeIsRegistered(repo.root, executionPath)).toBe("REGISTERED");
      rmSync(executionPath, { recursive: true, force: true });
    } finally {
      repo.cleanup();
    }
  });

  it("removes a CLEAN worktree without force (preservation policy allows it)", () => {
    const repo = initRepo();
    try {
      const executionPath = join(repo.root, "..", `run-clean-${Date.now()}`);
      rmSync(executionPath, { recursive: true, force: true });
      expect(
        addGitWorktree(repo.root, executionPath, "tenvyr/run-clean"),
      ).toBeNull();
      const outcome = removeGitWorktree(repo.root, executionPath);
      expect(outcome).toBe("removed");
      expect(existsSync(executionPath)).toBe(false);
      expect(worktreeIsRegistered(repo.root, executionPath)).toBe("ABSENT");
    } finally {
      repo.cleanup();
    }
  });

  it("REFUSES to remove a DIRTY worktree (operator/agent work is preserved)", () => {
    const repo = initRepo();
    try {
      const executionPath = join(repo.root, "..", `run-dirty-${Date.now()}`);
      rmSync(executionPath, { recursive: true, force: true });
      expect(
        addGitWorktree(repo.root, executionPath, "tenvyr/run-dirty"),
      ).toBeNull();
      // The fake coding runtime leaves uncommitted work in the worktree.
      writeFileSync(join(executionPath, "agent-work.txt"), "uncommitted\n", "utf8");
      const outcome = removeGitWorktree(repo.root, executionPath);
      expect(typeof outcome).toBe("object");
      expect((outcome as { refused: string }).refused).toMatch(/cannot remove|dirty|matches/i);
      // The dirty tree still exists with the work intact.
      expect(existsSync(join(executionPath, "agent-work.txt"))).toBe(true);
      expect(worktreeIsRegistered(repo.root, executionPath)).toBe("REGISTERED");
      rmSync(executionPath, { recursive: true, force: true });
    } finally {
      repo.cleanup();
    }
  });

  it("treats an already-removed worktree as an idempotent success", () => {
    const repo = initRepo();
    try {
      const executionPath = join(repo.root, "..", `run-gone-${Date.now()}`);
      rmSync(executionPath, { recursive: true, force: true });
      expect(
        addGitWorktree(repo.root, executionPath, "tenvyr/run-gone"),
      ).toBeNull();
      // Remove it behind the service's back (e.g. operator or crash).
      const removed = spawnSync("git", ["worktree", "remove", executionPath], {
        cwd: repo.root,
        encoding: "utf8",
      });
      expect(removed.status).toBe(0);
      expect(removeGitWorktree(repo.root, executionPath)).toBe("already-removed");
    } finally {
      repo.cleanup();
    }
  });

  it("reports an unregistered path as not registered (never assumes)", () => {
    const repo = initRepo();
    try {
      const ghost = join(repo.root, "..", `run-ghost-${Date.now()}`);
      expect(worktreeIsRegistered(repo.root, ghost)).toBe("ABSENT");
    } finally {
      repo.cleanup();
    }
  });

  it("returns UNKNOWN when worktree listing evidence fails or is malformed", () => {
    const previous = getGitRunner();
    try {
      setGitRunner(() => ({ status: null, stdout: "", stderr: "timeout" }));
      expect(worktreeIsRegistered("/repo", "/repo/worktree")).toBe("UNKNOWN");

      setGitRunner(() => ({ status: 0, stdout: "", stderr: "" }));
      expect(worktreeIsRegistered("/repo", "/repo/worktree")).toBe("UNKNOWN");

      setGitRunner(() => ({ status: 0, stdout: "not porcelain", stderr: "" }));
      expect(worktreeIsRegistered("/repo", "/repo/worktree")).toBe("UNKNOWN");
    } finally {
      setGitRunner(previous);
    }
  });

  it("returns WORKTREE_STATE_UNKNOWN when removal fails and registration cannot be observed", () => {
    const previous = getGitRunner();
    try {
      setGitRunner((_cwd, args) =>
        args[0] === "worktree" && args[1] === "remove"
          ? { status: 1, stdout: "", stderr: "git is unavailable" }
          : { status: null, stdout: "", stderr: "timeout" },
      );
      expect(removeGitWorktree("/repo", "/repo/worktree")).toMatchObject({
        code: "WORKTREE_STATE_UNKNOWN",
      });
    } finally {
      setGitRunner(previous);
    }
  });
});
