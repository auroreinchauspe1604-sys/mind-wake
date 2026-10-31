/** Recipient configuration and read-only diagnostic. No grant, discovery scan or URL input. */
import fs from "node:fs";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { privateFile } from "./private-files.mjs";
import { callScopedWorkspace, hash } from "./workspace.mjs";

export function privateHost(host) {
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(host) === 6 && (host === "::1" || /^(fc|fd)/i.test(host));
}

export function loadScopedCredential(file) {
  const config = JSON.parse(fs.readFileSync(privateFile(file), "utf8"));
  if (
    !/^[a-f0-9]{64}$/.test(config.token) ||
    typeof config.capability !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(config.capability) ||
    typeof config.participant !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(config.participant)
  )
    throw new Error("invalid_credential");
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.pathname !== "/v1/scoped-workspace" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("invalid_endpoint");
  // One explicit existing private IP, no DNS lookup, public URL or redirect.
  if (!privateHost(endpoint.hostname.replace(/^\[|\]$/g, "")))
    throw new Error("private_transport_required");
  const ca = fs.readFileSync(privateFile(config.caFile));
  new X509Certificate(ca); // Parse trust material before spawning a client or making requests.
  return {
    endpoint: endpoint.href,
    capability: config.capability,
    participant: config.participant,
    token: config.token,
    ca,
  };
}

export async function diagnoseScopedWorkspace({ credential, scope, probe, fixture = false }) {
  let stage = "configuration";
  const base = { fixture, remoteAccessVerified: false };
  if (!credential)
    return { ...base, status: "not_configured", reason: "credential_required", stage };
  let config;
  try {
    config = loadScopedCredential(credential);
  } catch (error) {
    const reason = [
      "private_transport_required",
      "invalid_endpoint",
      "invalid_credential",
      "private_file_inside_git",
      "private_file_required",
    ].includes(error.message)
      ? error.message
      : error.code === "ENOENT"
        ? "private_file_missing"
        : "invalid_local_configuration";
    return { ...base, status: "not_configured", reason, stage };
  }
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(scope ?? "") ||
    typeof probe !== "string" ||
    !probe ||
    probe.length > 1024 ||
    probe.split("/").some((p) => !p || p === "." || p === "..") ||
    /[\\:\x00-\x1f]/.test(probe)
  )
    return {
      ...base,
      status: "not_configured",
      reason: "explicit_scope_and_relative_probe_required",
      stage,
    };
  let server;
  try {
    const options = {
      ...config,
      observe: (evidence) => {
        server = evidence;
      },
    };
    stage = "list";
    const list = await callScopedWorkspace(options, { op: "list", path: "", scope });
    if (list.scope !== scope || !Array.isArray(list.entries)) throw new Error("invalid_response");
    stage = "read";
    const read = await callScopedWorkspace(options, { op: "read", path: probe, scope });
    if (
      read.scope !== scope ||
      typeof read.text !== "string" ||
      hash(read.text) !== read.hash ||
      !server?.tlsAuthorized ||
      !server.certificateSha256
    )
      throw new Error("invalid_response");
    const local =
      new URL(config.endpoint).hostname.startsWith("127.") ||
      new URL(config.endpoint).hostname === "[::1]";
    return {
      ...base,
      status: fixture ? "fixture_read_succeeded" : "read_succeeded",
      stage,
      // A TLS response proves this endpoint, not two distinct machines or Aurore's identity.
      endpointReadVerified: true,
      locality: local ? "loopback" : "private_ip",
      server: { endpoint: config.endpoint, ...server },
      scope,
      capability: config.capability,
      participant: config.participant,
      listing: { entries: list.entries.length, truncated: list.truncated },
      probe: { sha256: read.hash, bytes: Buffer.byteLength(read.text) },
    };
  } catch (error) {
    const code = error.code ?? error.message;
    const status =
      code === "unauthorized"
        ? "auth_refused"
        : code === "forbidden"
          ? "scope_refused"
          : /CERT|TLS|SSL|SELF_SIGNED|VERIFY_LEAF/.test(code)
            ? "tls_refused"
            : [
                  "ECONNREFUSED",
                  "ECONNRESET",
                  "EHOSTUNREACH",
                  "ENETUNREACH",
                  "ETIMEDOUT",
                  "deadline",
                ].includes(code)
              ? "inaccessible"
              : "operation_refused";
    const reason = [
      "unauthorized",
      "forbidden",
      "unsafe_path",
      "unsupported_file",
      "file_limit",
      "sensitive_content",
      "busy",
      "deadline",
      "invalid_response",
      "operation_failed",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
    ].includes(code)
      ? code
      : status === "tls_refused"
        ? "certificate_validation_failed"
        : "request_failed";
    return {
      ...base,
      status,
      stage,
      reason,
      ...(status === "auth_refused"
        ? {
            note: "Invalid identity, token or inactive/revoked capability; transport cannot distinguish these.",
          }
        : {}),
    };
  }
}
