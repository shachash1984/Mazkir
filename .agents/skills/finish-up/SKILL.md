---
name: finish-up
description: Prepare Mazkir changes for user review when the user invokes /finish-up or $finish-up. Create a branch, commit, bump the version and tag, push, and open a GitHub PR.
---

# Finish up

Invocation authorizes the branch, commit, version/tag, push, and PR operations below. Execute through opening the PR without another routine confirmation. Only the user approves PRs. Never approve or merge a PR, enable auto-merge, bypass protections, publish a release, or deploy to production as part of this command.

## Scope and preflight

- Inspect git status, staged/unstaged diffs, current branch, origin, and recent commits. Include changes made for the current task; preserve unrelated user work, including staged edits. Stage explicit files or hunks, never all files indiscriminately. Do not commit secrets, local databases, or generated artifacts.
- Verify GitHub authentication (`gh auth status`) and discover the repository/default branch from origin (`gh repo view --json nameWithOwner,defaultBranchRef`). Fetch the base branch and tags before choosing a version. Inspect any GitHub Actions workflows: if pushing a tag would deploy before user approval, stop and explain that conflict.
- Check for an existing PR or partially completed finish-up for this same work. Resume it instead of creating duplicate branches, version bumps, tags, or PRs. If there is no new work, report the existing result or that there is nothing to submit.

## Branch and version

- Create a new descriptive `codex/<change>` branch for a fresh invocation. Preserve the current task changes and inspect the resulting diff against the remote default branch; do not silently include unrelated commits. Use an isolated worktree if necessary to separate the intended changes without discarding other work.
- Default to a SemVer patch bump; honor an explicitly requested version or minor/major bump. Read package.json and existing local/remote tags. Choose an unused version newer than the package and existing stable release tags; never move or overwrite a tag. If an explicit version conflicts, report the conflict.
- Update package.json and package-lock.json together with `npm version <version> --no-git-tag-version --ignore-scripts`. Keep dependency versions unchanged. The matching annotated Git tag is `v<version>`.

## Verify, commit, push, and PR

1. Run `npm run check`, `npm test`, `npm run build`, and `git diff --check`; stop on failure and fix task-related problems before publishing. Use additional relevant checks when needed. Do not run evaluations that send real messages or mutate calendars as a routine finish-up check.
2. Inspect the complete staged diff and verify that only task changes and version metadata are included. Commit with a concise description of the resulting behavior. Create the annotated version tag on that commit, not an earlier commit.
3. Push only the new branch and its exact tag to origin, preferably in one atomic push: `git push --atomic --set-upstream origin <branch> refs/tags/<tag>`. Never force push or push all tags. On uncertain failure, inspect remote refs before retrying; preserve partial progress.
4. Open a normal PR against the discovered default branch using `gh pr create --base <base> --head <branch> --title <title> --body-file <file>`. Write the body to a temporary UTF-8 file. Explain the concrete problem, resulting behavior, version/tag, checks run, and relevant limitations. State that user approval is required. If a PR already exists for the branch, update it rather than opening another.
5. Verify the PR URL, base/head, and remote branch/tag commit. Report the PR link, branch, version/tag, and checks. Leave the PR open for the user; do not approve, merge, or deploy it.

If authentication, permissions, network, or CI prevents completion, report exactly what succeeded and what remains, retaining the branch/commit/tag so the next invocation can resume. Never claim a push or PR succeeded without verifying it.
