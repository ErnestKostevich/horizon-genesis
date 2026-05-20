---
name: daily-brief
description: |
  Morning briefing that combines weather, today's calendar, top news, and
  any user-defined priorities into a 60-second read. Activate when the
  user says "good morning", "brief me", "daily briefing", "what's on
  today", "morning update", or runs a morning routine that calls this
  skill on a schedule.
license: BUSL-1.1
metadata:
  category: productivity
  version: 1.0.0
  author: Horizon AI
---

# Daily brief

Mornings work best when you don't have to assemble information from
five apps. This skill produces one short briefing — weather, calendar,
news, priorities — that you read once and start the day. Length is
fixed at roughly 200-300 words so it stays readable in under a minute.

## Procedure

1. **Gather user context.** First time only: ask for location (for
   weather), top 3 news topics they actually care about (skip the
   generic firehose), and any persistent priorities (project they're
   shipping, person they're avoiding letting down). Cache these.
2. **Pull weather.** Use `web_search` or a configured weather tool for
   the user's location. Report: high, low, precipitation chance,
   notable conditions (storm, heat warning). Skip humidity unless
   notable.
3. **Pull calendar.** Use the user's calendar integration. List today's
   events with: time, title, attendees if a meeting, 1-line context
   if known. Flag the first event's start time prominently — that's
   the only one that matters before coffee.
4. **Pull news on user's topics.** For each of their 3 topics, run
   `web_search` for "news today <topic>" and pull 1-2 top headlines.
   Skip pure clickbait. If nothing material happened, say so —
   don't pad with filler.
5. **Surface user priorities.** Pull from memory: what's the user
   shipping this week, who's waiting on a reply, what's the one
   thing that has to happen today. If they have a journal or todo
   integration, use those.
6. **Generate the brief.** Use this exact layout — consistency
   matters for a morning routine:
   ```
   # Good morning, <name>
   <date, day of week>

   ## Weather (<location>)
   <one sentence>

   ## Today (<n events>)
   - <time> <event>
   - ...
   First thing: <event at first time slot>

   ## News
   <topic 1>: <headline>
   <topic 2>: <headline>
   <topic 3>: <headline>

   ## Priority today
   <one sentence — the one thing>

   ## Quote
   <optional, a short quote — only if user opted in>
   ```
7. **Keep it short.** If a section has nothing real, write "Quiet."
   instead of inventing content. The user will trust the brief more
   if it admits empty days.

## Customization

- The user can disable any section in their config.
- "Priority today" can pull from a journal entry written the night before.
- News topics should be specific ("AI safety regulation") not broad ("tech").

## Anti-patterns to avoid

- Don't make this 800 words. It's a brief.
- Don't pull generic "trending news" the user didn't ask for.
- Don't include weather data they don't read (UV index, dew point).
- Don't motivational-quote unless the user opted in. Most people hate it.

## Example invocations

> User: "Brief me" (on a Monday at 7am)

Response: weather "65°F, mostly sunny, 10% rain"; calendar 4 events,
first 9:30 1:1 with Alice; news 3 headlines on AI safety, climate,
markets; priority "ship the v0.3 release before EOD"; total 220 words.

> User: "Good morning" (Saturday, calendar empty, news topics quiet)

Response: weather "72°F, sunny, no rain"; calendar "Quiet — no
scheduled events"; news section honestly notes "AI safety: quiet
weekend, no material news. Climate: quiet. Markets: closed."; priority
from memory: "tidy the office and write the weekly review you skipped";
no quote (user opted out). 140 words — short because the day is
short, and the brief reflects it.
