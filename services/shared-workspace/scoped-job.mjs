/** Owner-only server imported in a Wake job process; no child or automatic restart. */
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { createSecureContext } from "node:tls";
import { privateFile } from "../../scripts/setup-shared-workspace.mjs";
import { createScopedWorkspaceServer, loadState } from "./workspace.mjs";
import { privateHost } from "./scoped-client.mjs";

const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export function readScopedJobConfig(file) {
  file = privateFile(file);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const stateFile = privateFile(config.stateFile);
  const keyFile = privateFile(config.keyFile);
  const certFile = privateFile(config.certFile);
  // Every retained grant matters, including revoked grants and legacy roots.
  for (const { root } of loadState(stateFile).grants) {
    for (const target of [file, stateFile, `${stateFile}.private`, keyFile, certFile])
      if (inside(root, target)) throw new Error("private_file_inside_scope");
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error("invalid_port");
  // Explicit operator-selected interface. No tunnel, DNS, firewall or route is created.
  if (
    typeof config.host !== "string" ||
    !config.host ||
    ["0.0.0.0", "::", "*"].includes(config.host)
  )
    throw new Error("explicit_host_required");
  return { stateFile, keyFile, certFile, host: config.host, port: config.port };
}

export function preflightScopedJob(file) {
  if (!file) return { status: "not_configured", reason: "target_config_required", started: false };
  try {
    const config = readScopedJobConfig(file);
    if (!privateHost(config.host)) throw new Error("private_transport_required");
    const key = fs.readFileSync(config.keyFile),
      cert = fs.readFileSync(config.certFile);
    const certificate = new X509Certificate(cert);
    if (!certificate.checkIP(config.host)) throw new Error("certificate_host_mismatch");
    if (
      Date.parse(certificate.validFrom) > Date.now() ||
      Date.parse(certificate.validTo) <= Date.now()
    )
      throw new Error("certificate_expired_or_not_yet_valid");
    if (!certificate.checkPrivateKey(createPrivateKey(key)))
      throw new Error("certificate_key_mismatch");
    createSecureContext({ key, cert, minVersion: "TLSv1.2" });
    const scopes = loadState(config.stateFile)
      .grants.filter((g) => g.active && g.scope)
      .map((g) => ({
        scope: g.scope,
        participant: g.participant,
        rights: g.rights,
        capability: g.id,
      }));
    if (!scopes.length) throw new Error("no_active_scopes");
    return {
      status: "ready_to_start",
      started: false,
      transport: "existing_private_ip_tls",
      host: config.host,
      port: config.port,
      certificateSha256: certificate.fingerprint256,
      scopes,
    };
  } catch (error) {
    const known = [
      "no_active_scopes",
      "private_transport_required",
      "private_file_inside_git",
      "private_file_inside_scope",
      "explicit_host_required",
      "invalid_port",
      "certificate_host_mismatch",
      "certificate_key_mismatch",
      "certificate_expired_or_not_yet_valid",
    ];
    return {
      status: "not_configured",
      started: false,
      reason: known.includes(error.message)
        ? error.message
        : error.code === "ENOENT"
          ? "private_file_missing"
          : "invalid_target_configuration",
    };
  }
}

export async function runScopedWorkspaceJob(file) {
  const job = process.env.MIND_WAKE_JOB_ID;
  const output = process.env.MIND_WAKE_JOB_OUTPUT;
  if (!/^job_[0-9a-f-]{36}$/.test(job ?? "") || !output || !path.isAbsolute(output))
    throw new Error("supervised_wake_job_required");
  const config = readScopedJobConfig(file);
  if (preflightScopedJob(file).status !== "ready_to_start")
    throw new Error("target_preflight_refused");
  const controller = new AbortController();
  const server = createScopedWorkspaceServer({
    stateFile: config.stateFile,
    key: fs.readFileSync(config.keyFile),
    cert: fs.readFileSync(config.certFile),
    signal: controller.signal,
  });
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  try {
    server.listen(config.port, config.host);
    await once(server, "listening");
    // Non-secret readiness evidence for the owner. Never publish config/state/tokens.
    fs.writeFileSync(
      path.join(output, "scoped-ready.json"),
      JSON.stringify({
        job,
        pid: process.pid,
        host: config.host,
        port: server.address().port,
        route: "/v1/scoped-workspace",
      }),
      { flag: "wx", mode: 0o600 },
    );
    await once(server, "close");
  } finally {
    stop();
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, stop);
  }
}
