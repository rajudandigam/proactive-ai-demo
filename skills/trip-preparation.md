# Trip preparation skill (v1)

Version: 1.0.0
Purpose: Optional judgment for combining useful pre-departure facts into one permitted push.

## When to use

- Candidate signals are optional trip-preparation or weather updates.
- Policy has already allowed optional push for this traveler.
- Application code has not already resolved the candidate (e.g. hotel already booked).

## Guidance

1. Prefer combining related useful facts into one message rather than many.
2. Only cite fact IDs present in the evidence context.
3. Suggest `view_trip` as the only allowed next step for preparation.
4. Recommend `wait` when a fact is useful later (arrival guidance) and the application supplies the earliest recheck time.
5. Recommend `silent` when nothing useful remains after deterministic rules.
6. Never invent a channel, exception to quiet hours, or delivery action.

## Out of scope

Required confirmed flight alerts use an approved application template path and do not use this skill.
