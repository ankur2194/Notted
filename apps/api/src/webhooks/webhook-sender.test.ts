import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { sendWebhook, type WebhookSendRequest } from "./webhook-sender";
import { WEBHOOK_SNIPPET_MAX_LENGTH } from "./webhooks.constants";

// Real in-process servers on an ephemeral loopback port. A mocked `http` module
// would prove nothing here: redirects, the byte cap and the timeout are all
// behaviours of the actual socket, not of our call sites.
const RELAXED = { allowInsecureUrls: true, selfHostnames: [] } as const;

interface TestServer {
  readonly origin: string;
  readonly requestCount: () => number;
}

const servers: Server[] = [];

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.on("error", () => {
      // The client destroys the socket on the byte cap; the resulting EPIPE on
      // the server side is expected and must not fail the run.
    });
    handler(request, response);
  });
  server.on("clientError", () => undefined);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, requestCount: () => requests };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function sendRequest(url: string, timeoutMs = 2_000): WebhookSendRequest {
  return {
    url,
    body: '{"event":"note.created"}',
    headers: { "content-type": "application/json", "user-agent": "Notted-Webhook/1" },
    timeoutMs,
    guard: RELAXED,
  };
}

describe("sendWebhook — delivery", () => {
  it("returns the status and a snippet for a 2xx JSON response", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"received":true}');
    });

    const result = await sendWebhook(sendRequest(`${server.origin}/hook`));

    expect(result.outcome).toBe("response");
    expect(result.outcome === "response" && result.status).toBe(200);
    expect(result.outcome === "response" && result.snippet).toBe('{"received":true}');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sends the exact signed bytes, once, as a POST", async () => {
    let method: string | undefined;
    let received = "";
    const server = await startServer((request, response) => {
      method = request.method;
      request.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(204).end();
      });
    });

    const request = sendRequest(`${server.origin}/hook`);
    await sendWebhook(request);

    expect(method).toBe("POST");
    expect(received).toBe(request.body);
    expect(server.requestCount()).toBe(1);
  });
});

describe("sendWebhook — L7 redirects are never followed", () => {
  it("returns the 3xx itself and never touches the redirect target", async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("should never be reached");
    });
    const redirector = await startServer((_request, response) => {
      response.writeHead(302, { location: `${target.origin}/hook` }).end();
    });

    const result = await sendWebhook(sendRequest(`${redirector.origin}/hook`));

    expect(result.outcome === "response" && result.status).toBe(302);
    // The whole point: a redirect is a fresh URL that never passed the guard.
    expect(target.requestCount()).toBe(0);
  });
});

describe("sendWebhook — L8 response byte cap", () => {
  it("caps the snippet and still completes when the body dwarfs the read limit", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      // No content-length: this exercises the streaming cap, not the declared
      // -length short circuit.
      for (let index = 0; index < 64; index += 1) response.write("a".repeat(4_096));
      response.end();
    });

    const result = await sendWebhook(sendRequest(`${server.origin}/hook`));

    expect(result.outcome).toBe("response");
    expect(result.outcome === "response" && result.status).toBe(200);
    const snippet = result.outcome === "response" ? (result.snippet ?? "") : "";
    expect(snippet.length).toBeLessThanOrEqual(WEBHOOK_SNIPPET_MAX_LENGTH);
    expect(snippet.length).toBeGreaterThan(0);
  });

  it("keeps the status but no snippet when content-length declares an oversized body", async () => {
    const body = "b".repeat(32 * 1_024);
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": Buffer.byteLength(body).toString(),
      });
      response.end(body);
    });

    const result = await sendWebhook(sendRequest(`${server.origin}/hook`));

    expect(result.outcome === "response" && result.status).toBe(200);
    expect(result.outcome === "response" && result.snippet).toBeNull();
  });
});

describe("sendWebhook — L8 timeout", () => {
  it("gives up on a receiver that accepts the connection and never answers", async () => {
    const server = await startServer(() => {
      // Deliberately no response: the socket stays open forever.
    });

    const result = await sendWebhook(sendRequest(`${server.origin}/hook`, 300));

    expect(result.outcome).toBe("error");
    expect(result.outcome === "error" && result.errorCode).toBe("timeout");
  });

  it("treats an aborted signal as a timeout", async () => {
    const server = await startServer(() => undefined);
    const controller = new AbortController();
    const pending = sendWebhook({
      ...sendRequest(`${server.origin}/hook`, 5_000),
      signal: controller.signal,
    });
    controller.abort();

    const result = await pending;
    expect(result.outcome === "error" && result.errorCode).toBe("timeout");
  });
});

describe("sendWebhook — snippet hygiene", () => {
  it("returns no snippet for a non-textual content type", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    });

    const result = await sendWebhook(sendRequest(`${server.origin}/hook`));

    expect(result.outcome === "response" && result.snippet).toBeNull();
  });

  it("strips newlines, control bytes and ANSI escapes from a textual snippet", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("first\nsecond\r\n\u0007\u001B[31mred\u001B[0m");
    });

    const result = await sendWebhook(sendRequest(`${server.origin}/hook`));
    const snippet = result.outcome === "response" ? result.snippet : null;

    expect(snippet).toBe("firstsecondred");
    expect(snippet).not.toContain("\n");
    expect(snippet).not.toContain("\r");
    expect(snippet).not.toContain("[31m");
  });
});

describe("sendWebhook — the guard still holds with insecure URLs allowed", () => {
  it("refuses a private address without opening a socket", async () => {
    const result = await sendWebhook(sendRequest("http://10.0.0.1/hook", 300));

    expect(result.outcome).toBe("error");
    // Either layer may claim it first; what matters is that no socket is opened,
    // which the 300 ms budget proves — a real connect attempt to 10.0.0.1 hangs.
    expect(result.outcome === "error" && result.errorCode).toMatch(/^(url_rejected|dns_blocked)$/u);
    expect(result.durationMs).toBeLessThan(300);
  });

  it("refuses an internal hostname and a non-https scheme it was not given", async () => {
    const internal = await sendWebhook(sendRequest("https://svc.internal/hook", 300));
    expect(internal.outcome === "error" && internal.errorCode).toBe("url_rejected");

    const strict = await sendWebhook({
      ...sendRequest("http://ok.example/hook", 300),
      guard: { allowInsecureUrls: false, selfHostnames: [] },
    });
    expect(strict.outcome === "error" && strict.errorCode).toBe("url_rejected");
  });
});
