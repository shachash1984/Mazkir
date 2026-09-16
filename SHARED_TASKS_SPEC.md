# Shared tasks in Mazkir

Status: approved for implementation by the user's instruction to implement this plan. Local implementation completed 16 September 2026; production deployment and real WhatsApp acceptance testing are pending.

## Purpose and scope

Let the two configured family members manage a shared task list through their existing private WhatsApp chats. Support the existing Hebrew, English, mixed-language, text, and voice interaction model described in [DESIGN.md](DESIGN.md). Tasks remain in Mazkir; creating a task or deadline does not create an Outlook event.

All tasks are visible to both people. Either person can create, edit, assign, complete, cancel, reopen, or restore any task. Ownership identifies responsibility and does not restrict access. Group chats and additional users are outside this scope.

## Task content and lifecycle

Each task has a title, an optional plain-text note, an optional owner, an optional deadline, and a status: active, completed, or canceled. Notes can contain links, phone numbers, or instructions. Attachments, subtasks, priorities, and custom categories are deferred.

- Ownership defaults to unassigned. Explicitly naming a person assigns the task to them; "me" refers to the sender. "Remind me to book the dentist" creates a sender-owned task when creating a new task.
- An existing-task reminder request does not by itself reassign that task.
- Creation confirmation includes ownership and any deadline or reminder schedule.
- Completing a task removes it from active views and stops pending reminders.
- "Delete" cancels a task rather than immediately erasing it. Cancellation removes it from active views and stops pending reminders.
- Either person can reopen a completed task, retaining its owner and deadline. Old reminders remain stopped; new reminders require an explicit request.
- Either person can restore a canceled task, retaining its title, note, owner, and deadline. Return it to the active list, notify the other person once, and leave old reminders stopped, just as when reopening a completed task.
- Keep active tasks until completed or canceled. Keep completed and canceled tasks for 90 days so users can review or restore them, then delete their content. This storage is separate from the existing 30-day chat history.

## Deadlines

A deadline and a reminder are distinct, optional properties. A task can have neither, either, or both. Setting a deadline alone never schedules notifications.

Date-only deadlines cover the entire named date in Asia/Jerusalem. A task due Friday becomes overdue when Saturday begins. A deadline with an explicit time becomes overdue after that time. Use the existing explicit-time-zone interpretation behavior where applicable.

## Reminder behavior

### Recipients

Without an explicit recipient, remind the owner; for an unassigned task, remind both people. "Remind me" and "remind both of us" override that default.

Owner-following reminders switch recipients on reassignment. The new owner inherits only the remaining notifications at their existing scheduled times; reassignment does not reset the notification count. The immediate reassignment update is separate from these reminders. Explicitly selected recipients stay unchanged.

### Two notifications

Each reminder request schedules two notifications, at least 24 hours apart. Completion or cancellation stops any remaining notifications.

The second notification is at the same local time the next day, provided at least 24 hours have elapsed. If daylight saving makes that interval shorter, use the same local time on the following day. If the task is overdue at delivery, state that in the reminder. Do not send further notifications without a new request.

For a reminder date without a time, use 09:00 Israel time and confirm the exact date and time. Repeating reminders such as "every day until done" are deferred; explain the limit when requested.

### Changing reminders

A new reminder request replaces pending reminders for its intended recipients with a fresh two-notification schedule. "Remind me tomorrow at 10" replaces the sender's pending schedule; "remind both of us" replaces both schedules. Confirm the resulting change.

Changing a deadline moves reminders explicitly expressed relative to that deadline, such as "the day before it is due." Reminders for an explicit date and time remain fixed. Confirm any schedule changes along with the deadline change. A deadline change does not reset delivered notifications. If the first notification was already delivered, move only the remaining relative notification, preserving at least 24 hours from the first delivery. If its revised time has already passed, send it once as a catch-up when that spacing permits.

Snoozing affects only the requester's notifications. It does not change the deadline or the other person's notifications, and delays an existing notification rather than adding another. After the first delivery, snoozing moves the remaining notification while preserving at least 24 hours from the first delivery. After both notifications have been delivered, explain that no notifications remain and ask whether to create a new two-notification reminder; do not create it without an affirmative answer.

### Recovery after downtime

If reminders became due while Mazkir was offline, send one catch-up notification when the task is still active. If both notifications were missed, combine them into that single notification and finish the schedule. If only the first was missed, schedule the second using the agreed spacing from actual delivery. Evaluate catch-up per recipient so one person's receipt does not consume the other person's reminder.

## Notifications about task changes

The sender receives a confirmation of a successful action. The other person receives the following updates:

| Change | Notification to the other person |
| --- | --- |
| Task created and assigned to the other person | Immediate notification with task, assigner, and any due date |
| Self-assigned or unassigned task created | None |
| Owner changed, including becoming unassigned | One update |
| Deadline changed | One update |
| Task completed | One update identifying who completed it |
| Task canceled | One update |
| Completed task reopened | One update |
| Canceled task restored | One update |
| Title or note edited | None; confirm the edit to the sender, and show current content to either person in task details |
| Reminder adjusted | No change notification; reminder delivery follows its schedule |

Changes involving reassignment should produce one update to the other person rather than duplicate assignment and edit messages.

## Viewing and selecting tasks

Support these natural-language views:

| Request | Result |
| --- | --- |
| "Show our tasks" | All active tasks |
| "What's on my list?" | Active tasks owned by the sender |
| "What's unassigned?" | Active tasks without an owner |
| "What's overdue?" | Active tasks past their deadline |
| "What's due this week?" | Active tasks due in the requested week |
| "Show details for task 2" | Task details including its optional note |

Order active lists by overdue tasks first, then upcoming deadlines, then tasks without deadlines. Return a compact numbered list containing the title, owner, and deadline or an indication that there is no deadline.

Example:

```text
Open tasks — 3
1. Submit school form — You · overdue Sep 14
2. Book dentist — [spouse's name] · due Sep 18
3. Buy batteries — Unassigned · no deadline
```

Support follow-ups such as "Mark 2 done," "Assign 3 to me," and "Remind me about 1 tomorrow." Numbers refer to the most recent task list in the sender's own chat. Resolve them to stable task identities and check current state before applying a change. One person's list must not change the meaning of the other person's numbers.

## Ambiguity and duplicate tasks

Execute clear requests without an extra approval step, consistent with existing Mazkir behavior. Clarify essential ambiguity rather than choosing between plausible tasks or people.

If a new task appears to duplicate an active task, ask whether to update that task or add another. Do not silently merge tasks. Completed and canceled tasks do not trigger this check.

Example: "There's already 'Book dentist,' assigned to you. Update that task or add another?"

## Implementation constraints for later design

The local implementation follows these engineering requirements:

- Persist task content separately from expiring conversation context, with existing encryption and authorized-user restrictions.
- Keep stable task identities, per-chat list references, lifecycle timestamps, and enough recipient-specific reminder state to apply the rules above after a restart.
- Validate interpreted actions before changing durable state. Serialize conflicting edits and recheck current task state before notification delivery.
- Separate committed task changes from outbound confirmations and notifications. Retrying a message must not repeat a task mutation or create another reminder schedule.
- Account for uncertain WhatsApp delivery: reuse durable delivery identities where possible, and never claim a stronger delivery guarantee than the existing integration supports.
- Keep the existing configured spending limits and operational health monitoring. Scheduling due notifications should not require a continuously running model.
- Document backup retention separately: deleting task content from the live database does not by itself erase older backups.

## Acceptance scenarios

1. Both people can manage the same task from separate chats; unconfigured users cannot access task data.
2. An unspecified owner remains unassigned; a sender-relative owner resolves correctly; assignment to the other person produces one notification.
3. A due date alone creates no reminders. Date-only overdue classification changes at the local date boundary.
4. A reminder with no specified time uses 09:00 Israel time and confirms that timestamp.
5. A reminder produces two notifications at least 24 hours apart, including across daylight saving changes, and no third notification.
6. Completing or canceling before the second notification prevents its delivery and notifies the other person once.
7. Explicit reminder recipients survive owner changes; owner-following recipients follow the agreed reassignment policy.
8. A new reminder request replaces only its intended recipients' pending schedules.
9. Snoozing one person's notification leaves the other person's schedule and the task deadline unchanged.
10. Deadline-relative reminders move when the deadline changes; fixed-time reminders do not.
11. Downtime spanning one or both reminder times produces the agreed catch-up behavior without a burst of stale notifications.
12. Each person's numbered list retains its own task references; later task changes are checked before executing follow-up commands.
13. A likely active duplicate prompts a choice; a completed or canceled match does not.
14. Reopening retains task content, owner, and deadline, notifies the other person, and does not restart old reminders.
15. Active tasks remain accessible after chat-history expiration; terminal task content expires after 90 days.
16. Repeated inbound messages and process restarts do not duplicate tasks, mutations, or reminder schedules.

## Implementation notes

- `src/task-domain.ts` defines validated commands, task/reminder state, deadline parsing, and reminder spacing. `src/tasks.ts` owns task operations, filtering, retention, durable notifications, and reminder delivery.
- Task state uses the existing encrypted SQLite vault; no new provider account or database schema migration is needed. A task change, notification intent, and replay receipt commit in one SQLite transaction. The existing job queue delivers text/voice receipts afterward.
- The worker serializes task changes and outbound task delivery. Task requests take an initial interpretation pass without fetching Outlook events. Calendar edits still load calendar candidates before interpreting the final calendar action.
- Proactive task updates and reminders are text messages. Voice requests retain the existing text-plus-speech reply behavior. Long task replies provide their full text with a brief spoken pointer to it.
- Notifications use stable delivery IDs and persist retry state. After the configured retry limit, `doctor` identifies the blocked task notification; the existing `resume ID` command resets it. The health monitor becomes unhealthy while task notifications need intervention. An uncertain WhatsApp response can still cause a duplicate receipt.
- Sender-relative snoozing preserves the other person's schedule. If an owner-following schedule expands to both people after becoming unassigned, it does not replace an existing explicitly addressed schedule. Delivered notifications remain consumed.
- Removing a deadline removes reminders relative to it; fixed-time reminders remain. The confirmation states this. The first version expresses deadline-relative reminders as calendar days before the deadline at a chosen local time (09:00 by default).
- Numbered task references and recent task mentions are scoped to each private chat. Proactive messages are added to that chat's history so replies can refer to the task just mentioned. Active task content persists independently of those expiring references.
- Model context contains a bounded task summary. Full task lists are generated from storage and sent in text chunks; title searches and numeric references are resolved against storage.
- Retention is checked hourly under the worker lock, including when a blocked calendar job prevents delivery. Backups can still contain older content until those backups expire.

See [VALIDATION.md](VALIDATION.md) for validation evidence and remaining live checks.
