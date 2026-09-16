# Feature ideas for Mazkir

Date: 16 September 2026  
Status: brainstorming backlog, not an approved implementation plan.

Mazkir can grow into the family's everyday coordination assistant: a place to capture commitments, see what needs attention, and share responsibility through the WhatsApp chats both people already use.

These ideas build on the current project documentation. Scheduling and agenda queries already exist. Shared tasks and bilingual voice replies are documented as locally implemented, with production rollout and live acceptance checks pending. Those capabilities are the starting point, not new feature proposals.

## Best next features

Start with a combined daily view, recurring household tasks, and reusable checklists. Together, they answer three frequent questions: “What do we have today?”, “What keeps coming around?”, and “What must we remember this time?”

Priority and effort below are qualitative product judgments, not delivery estimates. Validate them against actual family use after the existing features are deployed and checked.

| Priority | Idea | Main benefit | Relative effort |
| --- | --- | --- | --- |
| 1 | Combined calendar and task view | One answer for the day's commitments | Small–medium |
| 2 | Recurring household tasks | Stop recreating routine chores | Medium |
| 3 | Reusable checklists | Remember all the steps for familiar situations | Medium |
| 4 | Capture several actions from one message | Turn a natural brain dump into organized work | Medium–large |
| 5 | Weekly family planning | Agree on responsibilities before the week starts | Medium |
| 6 | Tasks linked to events | Keep preparation connected to the appointment | Medium–large |
| 7 | Notification preferences | Make proactive help fit each person's routine | Medium |
| 8 | Search and recent activity | Find details and understand what changed | Small–medium |

## 1. Combined calendar and task view

**Example:** “What's our day tomorrow?” / “מה יש לנו מחר?”

Return one compact response with timed events, tasks due that day, and a separate overdue section. Keep each item clearly identified as an event or task, with ownership visible for tasks.

**First version:** On-demand daily and weekly views, using existing calendar and task data. Make follow-ups such as “Mark task 2 done” and “Move event 1 to 5” unambiguous.

**Later:** An optional morning briefing at a time chosen by each person. Skip empty briefings and allow pause or cancellation in chat.

**Boundary:** Show only Mazkir-managed events. Do not imply the view includes either person's full work calendar. Scheduled briefings would introduce a new opt-in notification behavior.

## 2. Recurring household tasks

**Example:** “Every Thursday, remind me to take out the recycling.”

Support routine responsibilities such as changing filters, paying recurring bills, or booking periodic appointments. Unlike a recurring calendar event, each occurrence needs its own completion state.

**First version:** Weekly and monthly tasks with a fixed owner. Completing this week's task leaves next week's occurrence intact. Support skipping one occurrence and pausing the series.

**Decision to make:** Should an unfinished occurrence remain overdue when the next one arrives, or should one open task carry forward? Make that policy explicit before implementation. Also define monthly dates that do not occur in every month.

**Boundary:** Recurring tasks are currently deferred. Keep recurrence separate from reminder frequency; this feature should not silently introduce daily nudges until completion.

## 3. Reusable checklists

**Example:** “Create our weekend-trip checklist.”

Save reusable lists for trips, school preparation, hosting, or routine household maintenance. Start a fresh copy each time so previous completion marks do not carry over.

**First version:** Named templates with checkable items. Let either person add an item, mark it done, and ask what remains. Save a template only when requested.

**Later:** Assign individual items and attach deadlines where useful.

**Decision to make:** Start with lightweight checklist items or full subtasks. Lightweight items keep the experience simpler; full subtasks need their own ownership, reminders, and lifecycle rules.

## 4. Capture several actions from one message

**Example:** “Add the school meeting Tuesday at 6, remind me to bring the form Monday, and add buying printer ink to our tasks.”

Convert a single text or voice message into several calendar and task actions, then send a concise result for each one.

**First version:** Handle a short batch of independent actions. Execute clear items under the existing behavior and clarify only ambiguous items. Report partial success accurately so a retry cannot duplicate completed work.

**Later:** Support dependencies such as “Book the appointment, then remind me the day before.”

**Boundary:** This needs durable progress for every action, not just a longer language-model prompt. Confirmed dates and owners must remain visible in the response.

## 5. Weekly family planning

**Example:** “Help us plan next week.”

Summarize upcoming events, due and overdue tasks, and unassigned work. Let the conversation end in concrete changes: assigning a task, moving a deadline, or adding preparation time.

**First version:** An on-demand review with three sections: commitments, tasks needing attention, and decisions to make. Suggest a small number of decisions grounded in actual items.

**Later:** An opt-in weekly prompt at the family's chosen time.

**Boundary:** Do not automatically assign work or interpret task counts as a fair measure of workload. One task may take five minutes and another several hours.

## 6. Tasks linked to events

**Example:** “For the school meeting, add a task to fill out the form the day before.”

Connect preparation to the relevant appointment so the family can ask, “What do we still need to do before the meeting?”

**First version:** Link a task to one Mazkir event and allow a deadline relative to that event. Moving the event updates a relative deadline and any affected deadline-relative reminders, with a clear confirmation. Absolute deadlines stay fixed.

**Decision to make:** When an event is canceled, should linked tasks remain active or should Mazkir ask what to do with them? Preserve them until that policy is chosen. Recurring events also require a distinction between one occurrence and the whole series.

## 7. Notification preferences

**Example:** “Hold routine updates until 8 AM.” / “Pause my daily briefing until Sunday.”

Give each person control over quiet hours, optional digests, and routine task-change updates.

**First version:** Preferences scoped to the requesting person, with a chat command to inspect and reset them. Show the effective delivery time when a requested reminder would fall in quiet hours.

**Decision to make:** Define how quiet hours interact with explicitly timed reminders, catch-up delivery, and the existing minimum 24-hour spacing. Do not silently delay a reminder the user explicitly requested at a particular time.

**Boundary:** Existing task-change notifications are part of the approved specification. Making them configurable is a deliberate product change. Operational failure alerts should retain their separate purpose.

## 8. Search and recent activity

**Example:** “What's the link for the school form?” / “Who moved the dentist task?”

Find retained task notes and show recent changes with the actor and time, reducing the need to scroll through two separate conversations.

**First version:** Search active task titles and notes, plus a compact task activity view for ownership, deadline, and status changes. Return matching tasks when the reference is ambiguous.

**Later:** Search completed tasks within the existing retention window and use task search results to open details directly.

**Boundary:** This is not a search of all WhatsApp history. Avoid promising access to expired content. Any new activity history needs an explicit retention rule and should not preserve deleted task content indefinitely.

## Bigger ideas to revisit

| Idea | Example | Smallest useful version | What changes |
| --- | --- | --- | --- |
| Shared grocery list | “Add milk and tomatoes; we already bought bread.” | One shared list with quantities and purchased state | Groceries are currently deferred; decide whether a dedicated list adds enough beyond tasks |
| Screenshot and document capture | “Add the meeting from this school notice.” | Extract one proposed event or task from an image and clarify missing details | Adds attachment processing, extraction checks, cost, and retention decisions |
| Family group chat | “Who can handle pickup?” | Support one explicitly authorized group | Changes authorization, conversation references, and visibility; group support is currently deferred |
| Availability assistance | “When are we both free for an hour?” | Flag overlaps among Mazkir-managed events first | Full availability requires additional calendar access and workplace permission; an empty Mazkir slot does not establish free time |
| Pickup and handoff coordination | “I'll drop off; can you handle pickup?” | Explicitly assign separate drop-off and pickup tasks | Needs a distinction between requesting help and the other person accepting responsibility |
| Appointment context | “What's the address for tomorrow's appointment?” | Store and retrieve an explicitly supplied location and preparation note | Live routes or travel estimates would require a separate integration and cost review |
| Household reference notes | “Save the washing machine model.” | Explicitly saved, searchable shared notes with edit/delete commands | Introduces longer-lived shared information beyond task and chat retention |
| Travel mode | “For this trip, show times in London and Israel.” | A temporary display preference with both zones shown | Must distinguish display time from changing actual event times or default scheduling rules |

## Suggested sequence

1. **Validate the foundation:** Complete rollout and live acceptance checks for shared tasks and voice, including delivery, recovery, and calendar invitation behavior.
2. **Make existing data more useful:** Add the combined daily view, then search and recent activity if finding details is a frequent problem.
3. **Reduce repeat work:** Add recurring tasks and reusable checklists, starting with the routines the family actually repeats.
4. **Connect planning:** Add weekly review and event-linked preparation tasks.
5. **Expand input and reach selectively:** Consider batches, attachments, groceries, or group chat based on repeated requests. Add notification preferences before expanding proactive messages substantially.

## How to decide what earns a place

Try each feature on real household situations and ask:

- Does it eliminate a repeated message, forgotten commitment, or manual step?
- Can both people understand the result and correct it through chat?
- Does it help without creating unwanted notifications or duplicate work?
- Can it fit the project's configured AI and hosting budgets without continuous model polling?

Useful pilot signals include repeated use by both people, how often interpretations need correction, duplicate-action incidents, and whether optional notifications remain enabled. Choose numeric targets after establishing a baseline; collect aggregate signals where possible rather than retaining extra family message content.

## Project references

- [README.md](README.md): implemented capabilities, deployment status, and current limits.
- [DESIGN.md](DESIGN.md): agreed behavior, budget constraints, and deferred scope.
- [SHARED_TASKS_SPEC.md](SHARED_TASKS_SPEC.md): task ownership, reminder semantics, notifications, and retention.
- [VALIDATION.md](VALIDATION.md): validation evidence and outstanding acceptance checks.

This document proposes future choices. It does not change the approved behavior in those documents or authorize implementation or deployment.
