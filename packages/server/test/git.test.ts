import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Project } from "@of/core";
import { GitError, GitMirror } from "../src/git.js";
import { makeExec, nodeSpawn } from "../src/runners/process.js";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

async function setup(): Promise<{ project: Project; mirror: GitMirror; work: string; clones: string }> {
  const root = await mkdtemp(join(tmpdir(), "of-git-"));
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  const clones = join(root, "clones");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", bare, work]);
  await writeFile(join(work, "README.md"), "hi\n");
  sh(work, "add", ".");
  sh(work, "commit", "-m", "init");
  sh(work, "push", "origin", "HEAD:main");
  const project: Project = { id: "of", title: "OF", status: "active", repo: bare, defaultBranch: "main", autoQueueMode: false, parallelEnabled: false, nextTaskNumber: 1, created: "x", updated: "x" };
  return { project, mirror: new GitMirror({ clonesDir: clones, gitBin: "git", exec: makeExec(nodeSpawn) }), work, clones };
}

describe("GitMirror (real git)", () => {
  it("verifies pushed commits on the right branch only", async () => {
    const { project, mirror, work } = await setup();
    sh(work, "checkout", "-b", "of/task-001-x");
    await writeFile(join(work, "a.txt"), "a\n");
    sh(work, "add", ".");
    sh(work, "commit", "-m", "task");
    const sha = sh(work, "rev-parse", "HEAD");
    expect(await mirror.verify(project, sha, "of/task-001-x")).toBe(false); // not pushed
    sh(work, "push", "origin", "HEAD:of/task-001-x");
    expect(await mirror.verify(project, sha, "of/task-001-x")).toBe(true);
    expect(await mirror.verify(project, sha, "main")).toBe(false);
    expect(await mirror.verify(project, "zz", "main")).toBe(false);
    expect(await mirror.verify(project, sha, "bad branch")).toBe(false);
    expect(await mirror.remoteBranchExists(project, "of/task-001-x")).toBe(true);
    expect(await mirror.remoteBranchExists(project, "nope")).toBe(false);
    expect(await mirror.remoteBranchExists(project, "bad branch")).toBe(false);

    const wt = await mirror.prepareWorktree(project, "of/task-001-x");
    expect(wt.ref).toBe("origin/of/task-001-x");
    expect(await mirror.readFile(project, "a.txt")).toBe("a\n");
    await mirror.writeFile(project, ".ai-factory/PLAN.md", "# p");
    expect(await mirror.readFile(project, ".ai-factory/PLAN.md")).toBe("# p");
    const def = await mirror.prepareWorktree(project, "missing");
    expect(def.ref).toBe("origin/main");
    expect(await mirror.readFile(project, ".ai-factory/PLAN.md")).toBeNull();
    expect(await mirror.readFile(project, "../x")).toBeNull();
    await expect(mirror.writeFile(project, "../x", "")).rejects.toThrow(GitError);
    expect((await mirror.prepareWorktree(project, null)).ref).toBe("origin/main");
  });

  it("errors: no repo, bad remote", async () => {
    const { project, mirror } = await setup();
    await expect(mirror.sync({ ...project, repo: "" })).rejects.toThrow(/no repo/);
    await expect(mirror.sync({ ...project, id: "zz", repo: "/nonexistent/repo.git" })).rejects.toThrow(GitError);
  });
});
