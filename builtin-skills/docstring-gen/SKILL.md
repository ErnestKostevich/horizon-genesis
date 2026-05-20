---
name: docstring-gen
description: |
  Generate accurate JSDoc, TSDoc, or PyDoc docstrings from a function
  body — including param types, return type, thrown exceptions, and
  one-line summary. Activate when the user says "add docstrings",
  "document this function", "jsdoc this", "pydoc", "fill in the docs",
  or selects an undocumented function.
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# Docstring generator

Good docstrings answer three questions: what does this do, what does
it accept, what does it return (or throw). They are not a paraphrase
of the function body. Use `read_file` to inspect the source.

## Procedure

1. **Detect the language and convention.** Look at file extension and
   the first existing docstring in the file:
   - `.py` → PEP-257 / Google-style / NumPy-style (match what already exists)
   - `.ts` / `.tsx` → TSDoc (no `@param {type}` — types come from TS)
   - `.js` / `.jsx` → JSDoc with `@param {type} name`
   - `.rs` → `///` doc comments with `# Examples` / `# Errors`
   - `.go` → leading `// FunctionName does ...` sentence style
2. **Read the function body.** Identify every parameter, every return
   path, every `throw` / `raise`, and every observable side effect
   (network call, mutation of an argument, filesystem write).
3. **Write the summary line.** Start with a verb in present tense:
   "Returns ...", "Computes ...", "Sends ...", "Reads ...". One sentence.
   ≤80 chars. End with a period.
4. **Document parameters.** One line each. Format depends on language.
   For optional params, note the default. For union types, list them.
   Don't restate the type if the language already encodes it (TS, Rust).
5. **Document the return value.** Describe what's returned, not the type
   alone. "Returns the user record, or `null` if no user matches the id."
6. **Document side effects and errors.** `@throws` / `Raises:` / `# Errors`.
   Include the condition: "Throws RangeError if `count` is negative."
7. **Add an example** for non-obvious APIs only. Keep it ≤5 lines.

## Anti-patterns to avoid

- Don't paraphrase the function body line-by-line.
- Don't write "this function does X" — drop the preamble.
- Don't invent parameters or return values that aren't in the code.
- Don't add types to TSDoc — TypeScript already has them.

## Example invocation

> User: "Add jsdoc to this function" (pointing at a JS auth function)

Response:
```js
/**
 * Verifies a JWT against the configured secret and returns its payload.
 *
 * @param {string} token - The JWT to verify (without the `Bearer ` prefix).
 * @param {object} [options] - Verification options.
 * @param {string} [options.audience] - Required aud claim.
 * @returns {object} The decoded payload.
 * @throws {JsonWebTokenError} If the signature is invalid or the token is expired.
 */
```
