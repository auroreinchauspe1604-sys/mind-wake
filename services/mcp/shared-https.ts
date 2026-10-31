/** Message-only HTTPS facade. Never exposes the local pipe or local helper tools. */
import { createServer, type ServerOptions } from "node:https";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Hub } from "./hub.js";
import type { HubCall } from "./hub-link.js";
import { HubError, hubRequestSchema, type HubResponse } from "./protocol.js";
import type { MaintenanceCall } from "../../src/communication/maintenance-protocol.js";

export const SHARED_OPS = new Set(["whoami", "directory", "send_message", "read_inbox", "reply"]);
export const SHARED_MAX_BYTES = 32_768;
export function sharedPresentation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sharedPresentation);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "channel" && entry === "mind-local-hub"
          ? "mind-shared-hub"
          : sharedPresentation(entry),
      ]),
    );
  return value;
}

export function serveSharedHub(
  hub: Hub,
  tls: ServerOptions,
  keyIsActive: (key: string) => boolean,
  maintenance?: {
    parse(raw: unknown): { id: number } | null;
    handle(actor: string, raw: unknown): unknown;
  },
) {
  let inFlight = 0;
  // Global pre-auth admission window: bounded state, including invalid credentials.
  let windowAt = Date.now(),
    admissions = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (Date.now() - windowAt >= 60_000) {
      windowAt = Date.now();
      admissions = 0;
    }
    if (++admissions > 600 || inFlight >= 16) {
      send(429, { error: "rate_limited" });
      return;
    }
    inFlight++;
    req.setTimeout(5000, () => req.destroy());
    let id = 0;
    try {
      if (req.method !== "POST" || req.url !== "/v1/messages")
        throw new HubError("bad_request", "Endpoint inconnu.");
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ") || auth.length > 263)
        throw new HubError("not_authenticated", "Authentification refusée.");
      const key = auth.slice(7);
      if (!keyIsActive(key)) throw new HubError("not_authenticated", "Authentification refusée.");
      const party = hub.authenticate(key);
      if (req.headers["content-type"] !== "application/json")
        throw new HubError("bad_request", "JSON requis.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > SHARED_MAX_BYTES) throw new HubError("bad_request", "Corps trop grand.");
        chunks.push(bytes);
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const control = maintenance?.parse(raw);
      if (maintenance && control) {
        id = control.id;
        send(200, { id, ok: true, result: maintenance.handle(party.ref, raw) });
        return;
      }
      const parsed = hubRequestSchema.safeParse(raw);
      if (!parsed.success || !SHARED_OPS.has(parsed.data.op))
        throw new HubError("permission_denied", "Opération non exposée.");
      id = parsed.data.id;
      const result = sharedPresentation(await hub.handle(party, parsed.data));
      send(200, { id, ok: true, result });
    } catch (error) {
      const detail =
        error instanceof HubError ? error : new HubError("internal", "Opération impossible.");
      send(detail.code === "not_authenticated" ? 401 : 400, {
        id,
        ok: false,
        error: detail.toWire(),
      });
    } finally {
      inFlight--;
    }
  };
  const server = createServer({ ...tls, minVersion: "TLSv1.2" }, (req, res) => {
    void handle(req, res).catch(() => {
      res.destroy();
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  return {
    server,
    async listen(port: number, host = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return (server.address() as AddressInfo).port;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    },
  };
}

export class RemoteHubLink {
  readonly #url: URL;
  readonly #key: string;
  #next = 0;
  get endpoint(): string {
    return this.#url.href;
  }
  constructor(endpoint: string, key: string) {
    try {
      this.#url = new URL(endpoint);
    } catch {
      throw new Error("Endpoint HTTPS invalide.");
    }
    if (
      this.#url.protocol !== "https:" ||
      this.#url.username ||
      this.#url.password ||
      this.#url.search ||
      this.#url.hash ||
      this.#url.pathname !== "/v1/messages"
    )
      throw new Error("HTTPS endpoint /v1/messages requis, sans credentials ni paramètres.");
    if (key.length < 16 || key.length > 256 || /[\r\n]/.test(key)) throw new Error("Clé invalide.");
    this.#key = key;
  }
  async call<T>(call: HubCall): Promise<T> {
    if (!SHARED_OPS.has(call.op)) throw new HubError("permission_denied", "Opération non exposée.");
    return this.exchange<T>(call);
  }
  async maintenance<T>(call: MaintenanceCall): Promise<T> {
    return this.exchange<T>(call);
  }
  private async exchange<T>(call: HubCall | MaintenanceCall): Promise<T> {
    const id = ++this.#next;
    const body = JSON.stringify({ ...call, id });
    if (Buffer.byteLength(body) > SHARED_MAX_BYTES)
      throw new HubError("bad_request", "Corps trop grand.");
    return new Promise<T>((resolve, reject) => {
      const req = request(
        this.#url,
        {
          method: "POST",
          rejectUnauthorized: true,
          headers: {
            authorization: `Bearer ${this.#key}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1_048_576) res.destroy(new Error("oversize"));
            else chunks.push(chunk);
          });
          res.on("error", () => {
            reject(new HubError("internal", "Réponse distante interrompue.", true));
          });
          res.on("end", () => {
            clearTimeout(timer);
            try {
              // https.request does not follow redirects.
              if (res.statusCode !== 200 && res.statusCode !== 400 && res.statusCode !== 401)
                throw new Error("status");
              const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HubResponse;
              if (!response.ok)
                throw new HubError(
                  response.error.code,
                  response.error.message,
                  response.error.retryable,
                );
              if (response.id !== id || res.statusCode !== 200) throw new Error("response");
              resolve(response.result as T);
            } catch (error) {
              reject(
                error instanceof HubError
                  ? error
                  : new HubError("internal", "Réponse distante invalide.", true),
              );
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(new Error("timeout")), 8000);
      req.on("error", () => {
        clearTimeout(timer);
        reject(new HubError("internal", "Hub distant injoignable.", true));
      });
      req.end(body);
    });
  }
}
