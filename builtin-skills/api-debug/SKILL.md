---
name: api-debug
description: |
  Shape, send, and replay REST/GraphQL requests with full request/response
  inspection. Activate when the user says "test this endpoint",
  "hit the API", "curl this", "why is this 500", "debug this request",
  "replay the failing call", or shares a HAR file or curl command.
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# API request shaper and replayer

API debugging is mostly about making the request reproducible. Save
the request, run it, inspect the response, change one thing, run again.
Use `run_shell` for `curl`, `read_file` for HAR/spec files.

## Procedure

1. **Capture the request.** Get the user's starting point: a curl
   command, a HAR export, a route handler, or "the request the
   frontend is sending". If they don't have one, ask for the endpoint,
   method, headers, and body.
2. **Build the canonical curl.** Always emit one curl block the user
   can paste into a terminal:
   ```bash
   curl -i -X POST https://api.example.com/v1/users \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"email":"a@b.com"}'
   ```
   Use `$TOKEN` env-var references, never hardcoded secrets.
3. **Send it.** Run via `run_shell`. Capture status code, response
   headers, body. For GraphQL, parse the `errors[]` array — a 200
   response can still contain errors.
4. **Diagnose.** Map status code to likely cause:
   - 400 → bad request shape (missing field, wrong type) — diff body against schema
   - 401 → missing/expired token — check `exp` claim if JWT
   - 403 → token valid but lacks scope/role
   - 404 → URL typo, or resource ID doesn't exist for this user
   - 422 → validation error — read `errors[]` in body
   - 429 → rate limited — check `Retry-After` header
   - 5xx → server problem — look at server logs, retry once with backoff
5. **Bisect.** If the same request works in one environment and fails
   in another: diff the headers, diff the body, diff the auth token's
   claims. One difference is the culprit.
6. **Replay loop.** Change one thing, re-run, observe. Don't change
   three headers at once.

## GraphQL specifics

- Pretty-print the query with indentation before sending.
- For partial errors (200 with `errors[]`), check `path` to find the
  failing field.
- Use `__typename` in the query when debugging type confusion.

## Anti-patterns to avoid

- Don't paste real bearer tokens into the conversation — use placeholders.
- Don't trust the status code alone; read the body.
- Don't retry blindly on 4xx — those are client errors, retries won't help.

## Example invocation

> User: "This POST to /api/orders is returning 500, help me debug"

Response: ask for the request body, build a curl with the user's token
as `$TOKEN`, send it, see "TypeError: cannot read property 'sku' of
undefined" in response, hypothesize body is missing `items[]`,
re-send with corrected body, confirm 200.
