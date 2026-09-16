# Mazkir project instructions

## Finish-up command

When the user sends `/finish-up` (optionally followed by a version or notes), read and execute [.agents/skills/finish-up/SKILL.md](.agents/skills/finish-up/SKILL.md). Treat `$finish-up` as the same workflow.

This invocation authorizes creating a branch, committing the current task's changes, updating the version and Git tag, pushing to GitHub, and opening a PR. Merely discussing or configuring the command does not invoke it.

Only the user approves PRs. Never approve or merge PRs, enable auto-merge, or deploy through this workflow. Keep unrelated user changes out of the commit.
