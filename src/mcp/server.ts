import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";
import { HUNK_MCP_PATH, HUNK_SESSION_SOCKET_PATH, resolveHunkMcpConfig } from "./config";
import { HunkDaemonState } from "./daemonState";
import type { SessionClientMessage } from "./types";

interface McpTransportEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

function formatToolJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function textContent(text: string) {
  return [
    {
      type: "text" as const,
      text,
    },
  ];
}

function createHunkMcpServer(state: HunkDaemonState) {
  const server = new McpServer({
    name: "hunk",
    version: "0.1.0",
  });

  server.registerTool(
    "list_sessions",
    {
      title: "List live Hunk sessions",
      description: "List the live Hunk diff-review sessions currently registered with the local daemon.",
    } as any,
    (async () => {
      const sessions = state.listSessions();

      return {
        content: textContent(formatToolJson({ sessions })),
        structuredContent: {
          sessions,
        },
      };
    }) as any,
  );

  server.registerTool(
    "get_session",
    {
      title: "Get one live Hunk session",
      description: "Fetch details for one live Hunk session by session id or repo root.",
      inputSchema: z.object({
        sessionId: z.string().optional().describe("Explicit Hunk session id."),
        repoRoot: z.string().optional().describe("Repo root fallback when exactly one session matches."),
      }) as any,
    } as any,
    (async (input: { sessionId?: string; repoRoot?: string }) => {
      const session = state.getSession({ sessionId: input.sessionId, repoRoot: input.repoRoot });

      return {
        content: textContent(formatToolJson(session)),
        structuredContent: {
          session,
        },
      };
    }) as any,
  );

  server.registerTool(
    "comment",
    {
      title: "Comment on a live Hunk diff",
      description: "Attach an inline review note to a specific diff line in a live Hunk session.",
      inputSchema: z.object({
        sessionId: z.string().optional().describe("Explicit Hunk session id."),
        repoRoot: z.string().optional().describe("Repo root fallback when exactly one session matches."),
        filePath: z.string().describe("Diff file path as shown by Hunk."),
        side: z.enum(["old", "new"]).describe("Which side of the diff the line belongs to."),
        line: z.number().int().positive().describe("1-based diff line number on the chosen side."),
        summary: z.string().min(1).describe("Short inline review note."),
        rationale: z.string().optional().describe("Optional longer explanation shown in the note card."),
        reveal: z.boolean().optional().describe("Whether Hunk should jump to and reveal the note. Defaults to true."),
        author: z.string().optional().describe("Optional author label for the live comment."),
      }) as any,
    } as any,
    (async (input: {
      sessionId?: string;
      repoRoot?: string;
      filePath: string;
      side: "old" | "new";
      line: number;
      summary: string;
      rationale?: string;
      reveal?: boolean;
      author?: string;
    }) => {
      const result = await state.sendComment({
        ...input,
        reveal: input.reveal ?? true,
      });

      return {
        content: textContent(formatToolJson(result)),
        structuredContent: {
          result,
        },
      };
    }) as any,
  );

  return server;
}

/** Serve the local Hunk MCP daemon and websocket session broker. */
export function serveHunkMcpServer() {
  const config = resolveHunkMcpConfig();
  const state = new HunkDaemonState();
  const transports = new Map<string, McpTransportEntry>();

  const server = Bun.serve<{ sessionId?: string }>({
    hostname: config.host,
    port: config.port,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          transport: `${config.httpOrigin}${HUNK_MCP_PATH}`,
          sessionSocket: `${config.wsOrigin}${HUNK_SESSION_SOCKET_PATH}`,
          sessions: state.listSessions().length,
        });
      }

      if (url.pathname === HUNK_SESSION_SOCKET_PATH) {
        if (bunServer.upgrade(request, { data: {} })) {
          return undefined;
        }

        return new Response("Expected websocket upgrade.", { status: 426 });
      }

      if (url.pathname !== HUNK_MCP_PATH) {
        return new Response("Not found.", { status: 404 });
      }

      const headerSessionId = request.headers.get("mcp-session-id") ?? undefined;
      const parsedBody = request.method === "POST" ? await request.json() : undefined;

      if (headerSessionId && transports.has(headerSessionId)) {
        const entry = transports.get(headerSessionId)!;
        return entry.transport.handleRequest(request, { parsedBody });
      }

      if (!headerSessionId && request.method === "POST" && isInitializeRequest(parsedBody)) {
        let transport: WebStandardStreamableHTTPServerTransport;
        let transportEntry: McpTransportEntry;

        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => {
            transports.set(sessionId, transportEntry);
          },
          onsessionclosed: (sessionId) => {
            const entry = transports.get(sessionId);
            if (entry) {
              void entry.server.close();
              transports.delete(sessionId);
            }
          },
        });

        const mcpServer = createHunkMcpServer(state);
        transportEntry = {
          server: mcpServer,
          transport,
        };

        await mcpServer.connect(transport);
        return transport.handleRequest(request, { parsedBody });
      }

      return Response.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid MCP session id provided.",
          },
          id: null,
        },
        {
          status: 400,
        },
      );
    },
    websocket: {
      message: (socket, message) => {
        if (typeof message !== "string") {
          return;
        }

        let parsed: SessionClientMessage;
        try {
          parsed = JSON.parse(message) as SessionClientMessage;
        } catch {
          return;
        }

        switch (parsed.type) {
          case "register":
            state.registerSession(socket, parsed.registration, parsed.snapshot);
            break;
          case "snapshot":
            state.updateSnapshot(parsed.sessionId, parsed.snapshot);
            break;
          case "command-result":
            state.handleCommandResult(parsed);
            break;
        }
      },
      close: (socket) => {
        state.unregisterSocket(socket);
      },
    },
  });

  console.log(`Hunk MCP daemon listening on ${config.httpOrigin}${HUNK_MCP_PATH}`);
  console.log(`Hunk session websocket listening on ${config.wsOrigin}${HUNK_SESSION_SOCKET_PATH}`);

  return server;
}
