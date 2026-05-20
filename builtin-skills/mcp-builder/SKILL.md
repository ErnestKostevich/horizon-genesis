---
name: mcp-builder
description: |
  Scaffold a new Model Context Protocol (MCP) server in Node/TypeScript
  or Python from a high-level description of the tools it should expose.
  Activate when the user says "build an MCP server", "expose this API
  as MCP", "make a tool for Claude", "scaffold an MCP", or shares an
  API they want to wrap.
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# MCP server scaffolder

MCP servers expose tools, resources, and prompts to LLM hosts.
The job is mostly: design the tool surface, then map it to handlers.
Use `run_shell` for project init and `Write` for files.

## Procedure

1. **Clarify the surface.** Before any code, agree on:
   - **Tool list**: each with a name, one-line description, input schema,
     and expected output shape. Aim for 5-15 tools — too few is anemic,
     too many overwhelms the LLM.
   - **Resources** (read-only data the host can fetch): paths, MIME types.
   - **Prompts** (templated user-facing intents): optional.
   - **Auth model**: env vars, OAuth, none.
2. **Pick the runtime.** Default: Node/TypeScript with `@modelcontextprotocol/sdk`.
   Use Python (`mcp` package, `FastMCP` for ergonomics) if the underlying
   library is Python-only (e.g. scientific Python, ML models).
3. **Scaffold the project.**
   - Node: `npm init -y`, install `@modelcontextprotocol/sdk` and `zod`,
     add `tsconfig.json` with `"module": "node16"`, `"target": "es2022"`.
   - Python: `uv init` or `python -m venv`, install `mcp[cli]`,
     create `pyproject.toml` with `[project.scripts]` entry.
4. **Implement the server skeleton.**
   ```ts
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   import { z } from "zod";

   const server = new McpServer({ name: "my-mcp", version: "0.1.0" });

   server.tool("search_docs",
     "Search documentation for a phrase.",
     { query: z.string().describe("Search phrase") },
     async ({ query }) => {
       const results = await doSearch(query);
       return { content: [{ type: "text", text: JSON.stringify(results) }] };
     }
   );

   await server.connect(new StdioServerTransport());
   ```
5. **Tool design rules.** Each tool MUST:
   - Have a name in `snake_case`, ≤30 chars, verb-first.
   - Have a one-line description that names the action and the object.
   - Use Zod (Node) or Pydantic (Python) for input schemas with `.describe()`
     on every field — the LLM reads those descriptions.
   - Return structured content, not just strings. Errors return
     `{ isError: true, content: [...] }`.
6. **Add a config block** for the host (Claude Desktop, etc):
   ```json
   { "mcpServers": { "my-mcp": { "command": "node", "args": ["./dist/index.js"] } } }
   ```
7. **Test with the inspector.** Run `npx @modelcontextprotocol/inspector node dist/index.js`
   and call each tool. Don't ship without exercising every tool at least once.

## Anti-patterns to avoid

- Don't expose dozens of fine-grained CRUD tools when a few coarse tools
  would do — the LLM picks worse with more options.
- Don't leak internal errors to the model — wrap them with friendly text.
- Don't omit `.describe()` on schema fields — the LLM cannot guess intent.
- Don't require interactive auth flows in stdio servers; use env vars.

## Example invocation

> User: "Build an MCP server for the GitHub API with tools for issues and PRs"

Response: clarify which GitHub operations (list, get, create, comment),
scaffold Node project, implement `list_issues`, `get_issue`,
`create_issue_comment`, `list_pull_requests`, `get_pull_request_diff`,
add `GITHUB_TOKEN` env-var auth, write README with Claude Desktop config.
