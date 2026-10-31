import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const LIMITS = Object.freeze({
  file: 131072,
  body: 150000,
  response: 400000,
  entries: 200,
  deadline: 5000,
});
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => {
  throw new Error(code);
};
const inside = (root, target) =>
  target === root ||
  (!path.relative(root, target).startsWith("..") && !path.isAbsolute(path.relative(root, target)));
// Layouts from daemon/paths.ts, runner/paths.ts and adapter registration.ts.
// Names deny access; they NEVER grant permission or identify a trusted installation.
const sensitiveComponent =
  /^(?:\.git|\.ssh|\.aws|\.codex|\.claude|profiles?|credentials?|secrets?|auth|runtime|runtimes|installation|codex-home|claude-home)$/i;
const allowed = (name) =>
  name.length > 0 &&
  !name.startsWith(".") &&
  !sensitiveComponent.test(name) &&
  !/^(?:node_modules|vendor|credentials|secrets|profiles|AppData)$/i.test(name) &&
  !/^(?:secrets?|credentials?|private[-_]?key|passwords?|tokens?|id_rsa|id_ed25519)(?:\.[^.]+)?$/i.test(
    name,
  ) &&
  !/[<>:"\\|?*\x00-\x1f]/.test(name) &&
  !/[. ]$/.test(name) &&
  !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name);
const textExtension = (name) =>
  /\.(?:txt|md|json|js|mjs|cjs|ts|tsx|jsx|css|html|svg|csv|yaml|yml|toml|rs|py|cs|gd|glsl|sh)$/i.test(
    name,
  );

// Reject links/junctions in ALL existing ancestors, including those above the selected root.
function noLinks(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const segment of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail("unsafe_path");
  }
  if (fs.realpathSync.native(target).toLowerCase() !== target.toLowerCase()) fail("unsafe_path");
}

function locate(root, relative, directory = false) {
  if (typeof relative !== "string" || relative.length > 1024 || relative.includes("\\"))
    fail("unsafe_path");
  const parts = relative === "" && directory ? [] : relative.split("/");
  if (parts.some((part) => part === ".." || part === "." || !allowed(part))) fail("unsafe_path");
  const target = path.resolve(root, ...parts);
  if (!inside(root, target)) fail("unsafe_path");
  noLinks(target);
  const stat = fs.lstatSync(target);
  if (
    directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || !textExtension(target)
  )
    fail("unsupported_file");
  return target;
}

function readText(root, relative) {
  const target = locate(root, relative);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMITS.file) fail("file_limit");
    const buffer = Buffer.alloc(LIMITS.file + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > LIMITS.file) fail("file_limit");
    const bytes = buffer.subarray(0, count);
    const after = fs.fstatSync(fd);
    noLinks(target);
    const current = fs.statSync(target);
    if (
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail("changed_during_read");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail("unsupported_file");
    }
    if (text.includes("\0")) fail("unsupported_file");
    return {
      path: relative,
      bytes: count,
      modifiedAt: after.mtime.toISOString(),
      hash: hash(bytes),
      text,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function loadState(file) {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (state.version !== 1 || !Array.isArray(state.grants)) fail("invalid_state");
  return state;
}
export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    durableFile(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function durableFile(file, content) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function boundedBytes(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMITS.file) fail("file_limit");
    const bytes = Buffer.alloc(LIMITS.file + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > LIMITS.file) fail("file_limit");
    return bytes.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}
const privateDir = (stateFile) => `${path.resolve(stateFile)}.private`;
function mutateState(file, update) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Serialize cooperating operator processes; never silently break a stale lock.
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    const state = fs.existsSync(file) ? loadState(file) : { version: 1, grants: [] };
    const result = update(state);
    saveState(file, state);
    return result;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
export function grant(stateFile, root, participant, propose = false, selection = {}) {
  root = path.resolve(root);
  const components = root.split(path.sep);
  if (components.some((part) => sensitiveComponent.test(part))) fail("invalid_selection");
  noLinks(root);
  root = fs.realpathSync.native(root);
  // Explicit local installation metadata, never supplied by the remote API.
  // Custom --data-dir installations must be declared via --data-root or the existing env.
  const dataRoots = [...(selection.dataRoots ?? [])];
  if (process.env.MIND_WAKE_DATA_DIR) dataRoots.push(process.env.MIND_WAKE_DATA_DIR);
  if (process.env.LOCALAPPDATA) dataRoots.push(path.join(process.env.LOCALAPPDATA, "mind-wake"));
  const resolvedRoots = dataRoots.map((entry) => path.resolve(entry));
  for (const dataRoot of resolvedRoots) {
    if (inside(root, dataRoot)) fail("invalid_selection");
    if (inside(dataRoot, root)) {
      const workspace = path.join(dataRoot, "workspace");
      if (!inside(workspace, root)) fail("invalid_selection");
      const relative = path.relative(workspace, root);
      if (relative && relative.split(path.sep).some((part) => !allowed(part)))
        fail("invalid_selection");
    }
  }
  // AppData itself/Local/Roaming and arbitrary application control trees stay closed.
  // Only a locally declared installation's workspace subtree can be selected there.
  if (
    components.some((part) => /^AppData$/i.test(part)) &&
    !resolvedRoots.some((dataRoot) => inside(path.join(dataRoot, "workspace"), root))
  )
    fail("invalid_selection");
  if (
    !fs.statSync(root).isDirectory() ||
    root === path.parse(root).root ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(participant)
  )
    fail("invalid_selection");
  // Never share the profile root, state, or a parent containing either.
  if (
    inside(root, path.resolve(stateFile)) ||
    inside(root, privateDir(stateFile)) ||
    inside(privateDir(stateFile), root) ||
    (process.env.USERPROFILE && inside(root, path.resolve(process.env.USERPROFILE)))
  )
    fail("invalid_selection");
  const token = randomBytes(32).toString("hex");
  const id = randomUUID();
  mutateState(stateFile, (state) => {
    if (selection.scope !== undefined) {
      if (
        !/^[A-Za-z0-9_-]{1,80}$/.test(selection.scope) ||
        !Array.isArray(selection.rights) ||
        !selection.rights.length ||
        selection.rights.some((r) => !SCOPE_RIGHTS.includes(r))
      )
        fail("invalid_selection");
      for (const previous of state.grants.filter((g) => g.scope)) {
        if (previous.scope === selection.scope && previous.root !== root) fail("scope_conflict");
        if (
          previous.scope !== selection.scope &&
          (inside(previous.root, root) || inside(root, previous.root))
        )
          fail("scope_conflict");
        if (
          previous.active &&
          previous.scope === selection.scope &&
          previous.participant === participant
        )
          fail("scope_conflict");
      }
    }
    state.grants.push({
      id,
      root,
      participant,
      tokenHash: hash(token),
      rights: selection.scope
        ? [...new Set(selection.rights)]
        : propose
          ? ["read", "propose"]
          : ["read"],
      ...(selection.scope ? { scope: selection.scope } : {}),
      active: true,
    });
  });
  return { capability: id, participant, token };
}
export function revoke(stateFile, id) {
  mutateState(stateFile, (state) => {
    const entry = state.grants.find((g) => g.id === id);
    if (!entry) fail("unknown_capability");
    entry.active = false;
  });
}
function authorize(stateFile, req) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) fail("unauthorized");
  const cap = loadState(stateFile).grants.find(
    (g) => g.id === req.headers["x-workspace-capability"],
  );
  if (
    !cap?.active ||
    cap.participant !== req.headers["x-workspace-participant"] ||
    typeof cap.tokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(cap.tokenHash) ||
    !timingSafeEqual(Buffer.from(cap.tokenHash, "hex"), Buffer.from(hash(token), "hex"))
  )
    fail("unauthorized");
  return cap;
}
function listWorkspace(root, body) {
  const target = locate(root, body.path ?? "", true);
  const dir = fs.opendirSync(target);
  const entries = [];
  let scanned = 0;
  let truncated = false;
  try {
    let entry;
    while ((entry = dir.readSync())) {
      if (++scanned > LIMITS.entries) {
        truncated = true;
        break;
      }
      if (!allowed(entry.name)) continue;
      const relative = [body.path, entry.name].filter(Boolean).join("/");
      try {
        if (entry.isDirectory()) {
          locate(root, relative, true);
          entries.push({ name: entry.name, kind: "directory" });
        } else if (entry.isFile() && textExtension(entry.name)) {
          const { text, ...metadata } = readText(root, relative);
          entries.push({ name: entry.name, kind: "file", ...metadata });
        }
      } catch {
        /* Unsafe, binary, changing or oversized entries are omitted. */
      }
    }
  } finally {
    dir.closeSync();
  }
  return { entries, truncated, scanned };
}
function operate(stateFile, cap, body) {
  // Named capabilities belong exclusively to the supervised scoped adapter.
  // Never interpret independent rights through the legacy HTTPS contract.
  if (cap.scope || !body || typeof body !== "object" || !cap.rights.includes("read"))
    fail("forbidden");
  switch (body.op) {
    case "list": {
      return listWorkspace(cap.root, body);
    }
    case "read":
      return readText(cap.root, body.path);
    case "propose": {
      return submitProposal(stateFile, cap, body);
    }
    default:
      fail("forbidden");
  }
}

function activeCap(state, id, participant) {
  const cap = state.grants.find((g) => g.id === id && g.participant === participant);
  if (!cap?.active || !cap.rights.includes("read") || !cap.rights.includes("propose"))
    fail("forbidden");
  return cap;
}
function proposalView(p) {
  return { ...p, kind: "durable-proposal", applied: p.status === "applied" };
}
function submitProposal(stateFile, authorized, body) {
  if (
    typeof body.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(body.idempotencyKey)
  )
    fail("invalid_request");
  if (
    typeof body.text !== "string" ||
    Buffer.byteLength(body.text) > LIMITS.file ||
    body.text.includes("\0")
  )
    fail("file_limit");
  return mutateState(stateFile, (state) => {
    const cap = activeCap(state, authorized.id, authorized.participant);
    const proposals = (state.proposals ??= []);
    const fingerprint = hash(JSON.stringify([body.path, body.expectedHash, body.text]));
    const existing = proposals.find(
      (p) => p.capability === cap.id && p.idempotencyKey === body.idempotencyKey,
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail("idempotency_conflict");
      return proposalView(existing);
    }
    if (
      proposals.length >= 64 ||
      proposals.reduce((n, p) => n + Buffer.byteLength(p.text), 0) + Buffer.byteLength(body.text) >
        4 * 1024 * 1024
    )
      fail("queue_limit");
    const current = readText(cap.root, body.path);
    if (current.hash !== body.expectedHash) fail("hash_conflict");
    const proposal = {
      id: randomUUID(),
      capability: cap.id,
      participant: cap.participant,
      path: body.path,
      expectedHash: current.hash,
      proposedHash: hash(body.text),
      text: body.text,
      idempotencyKey: body.idempotencyKey,
      fingerprint,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    proposals.push(proposal);
    return proposalView(proposal);
  });
}
function findProposal(state, id) {
  const proposal = state.proposals?.find((p) => p.id === id);
  if (!proposal) fail("unknown_proposal");
  return proposal;
}
function reconcile(state, proposal) {
  const cap = state.grants.find(
    (g) => g.id === proposal.capability && g.participant === proposal.participant,
  );
  if (["applying", "restoring"].includes(proposal.status)) {
    const current = readText(cap.root, proposal.path);
    const completed =
      proposal.status === "applying" ? proposal.proposedHash : proposal.expectedHash;
    const previous = proposal.status === "applying" ? proposal.expectedHash : proposal.proposedHash;
    if (current.hash === completed)
      proposal.status = proposal.status === "applying" ? "applied" : "restored";
    else if (current.hash === previous)
      proposal.status = proposal.status === "applying" ? "pending" : "applied";
    else {
      proposal.status = "conflict";
      proposal.reason = "recovery_hash_conflict";
    }
    proposal.reconciledAt = new Date().toISOString();
    proposal.observedHash = current.hash;
  }
  if (
    proposal.status === "pending" &&
    (!cap?.active || !cap.rights.includes("read") || !cap.rights.includes("propose"))
  )
    proposal.status = "revoked";
  return proposal;
}

// Local authority ONLY. These functions are never routed by the HTTPS facade.
export function localProposals(stateFile, id) {
  return mutateState(stateFile, (state) => {
    if (id) return proposalView(reconcile(state, findProposal(state, id)));
    return {
      proposals: (state.proposals ?? []).map((p) => {
        reconcile(state, p);
        const { text, fingerprint, ...metadata } = proposalView(p);
        return metadata;
      }),
    };
  });
}
export function localReject(stateFile, id) {
  return mutateState(stateFile, (state) => {
    const p = reconcile(state, findProposal(state, id));
    if (p.status === "pending") {
      p.status = "rejected";
      p.decidedAt = new Date().toISOString();
    }
    return proposalView(p);
  });
}
export function localApply(stateFile, id, restoreHash) {
  return mutateState(stateFile, (state) => {
    const p = reconcile(state, findProposal(state, id));
    const restoring = restoreHash !== undefined;
    if (restoring && p.status === "restored") {
      if (restoreHash !== p.proposedHash) fail("hash_conflict");
      return proposalView(p);
    }
    if (!restoring && p.status !== "pending") return proposalView(p);
    const cap = activeCap(state, p.capability, p.participant);
    if (restoring && (p.status !== "applied" || restoreHash !== p.proposedHash))
      fail("hash_conflict");
    const target = locate(cap.root, p.path);
    const current = readText(cap.root, p.path);
    const expected = restoring ? p.proposedHash : p.expectedHash;
    if (current.hash !== expected) {
      if (restoring) fail("hash_conflict");
      p.status = "conflict";
      p.reason = "hash_conflict";
      return proposalView(p);
    }
    const directory = privateDir(stateFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    noLinks(directory);
    const backup = path.join(directory, `${p.id}.before`);
    if (!restoring) {
      const bytes = boundedBytes(target);
      if (hash(bytes) !== expected) {
        p.status = "conflict";
        p.reason = "hash_conflict";
        return proposalView(p);
      }
      if (fs.existsSync(backup)) {
        noLinks(backup);
        if (hash(boundedBytes(backup)) !== expected) fail("backup_mismatch");
      } else durableFile(backup, bytes);
    }
    if (restoring) noLinks(backup);
    const replacement = restoring ? boundedBytes(backup) : Buffer.from(p.text, "utf8");
    const wanted = restoring ? p.expectedHash : p.proposedHash;
    if (hash(replacement) !== wanted) fail("backup_mismatch");
    const temp = path.join(path.dirname(target), `.mind-workspace-${randomUUID()}.tmp`);
    try {
      durableFile(temp, replacement);
      fs.chmodSync(temp, fs.statSync(target).mode);
      // Persist intent AFTER durable backup and BEFORE replacing the selected file.
      p.status = restoring ? "restoring" : "applying";
      saveState(stateFile, state);
      // Best-effort editor conflict check immediately before rename; NOT an OS CAS.
      locate(cap.root, p.path);
      if (readText(cap.root, p.path).hash !== expected) {
        p.status = "conflict";
        p.reason = "hash_conflict";
        return proposalView(p);
      }
      fs.renameSync(temp, target);
      const observed = readText(cap.root, p.path);
      if (observed.hash !== wanted) {
        p.status = "conflict";
        p.reason = "post_write_hash_conflict";
        return proposalView(p);
      }
      p.status = restoring ? "restored" : "applied";
      p.observedHash = observed.hash;
      p.decidedAt = new Date().toISOString();
      return proposalView(p);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  });
}

export function createWorkspaceServer({ stateFile, key, cert }) {
  return workspaceServer({ stateFile, key, cert });
}

// Separate route and explicit authority: legacy grants never enter this surface.
export function createScopedWorkspaceServer({ stateFile, key, cert, signal }) {
  if (!signal || signal.aborted) fail("supervision_required");
  return workspaceServer({ stateFile, key, cert, signal, scoped: true });
}

function workspaceServer({ stateFile, key, cert, signal, scoped = false }) {
  const lifetime = new AbortController();
  const sockets = new Set();
  const stop = () => {
    lifetime.abort();
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  let active = 0,
    windowAt = Date.now(),
    admissions = 0;
  const server = https.createServer(
    { key, cert, minVersion: "TLSv1.2", maxHeaderSize: 8192 },
    async (req, res) => {
      const send = (status, value) => {
        if (res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
      };
      if (Date.now() - windowAt >= 60000) {
        windowAt = Date.now();
        admissions = 0;
      }
      if (++admissions > 120 || active >= 4) return send(429, { error: "busy" });
      active++;
      const timer = setTimeout(() => req.destroy(), LIMITS.deadline);
      try {
        if (
          req.method !== "POST" ||
          req.url !== (scoped ? "/v1/scoped-workspace" : "/v1/workspace") ||
          req.headers["content-type"] !== "application/json"
        )
          fail("bad_request");
        if (lifetime.signal.aborted) fail("stopped");
        const initial = authorize(stateFile, req);
        if (scoped && !initial.scope) fail("forbidden");
        let length = 0;
        const chunks = [];
        for await (const chunk of req) {
          length += chunk.length;
          if (length > LIMITS.body) {
            send(413, { error: "body_limit" });
            req.resume();
            return;
          }
          chunks.push(chunk);
        }
        // Re-authorize AFTER receiving body: revocation during upload takes effect.
        const cap = authorize(stateFile, req);
        if (lifetime.signal.aborted) fail("stopped");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        let result;
        if (scoped) {
          if (!cap.scope) fail("forbidden");
          const session = createScopedWorkspaceSession({
            stateFile,
            credential: {
              capability: cap.id,
              participant: cap.participant,
              token: req.headers.authorization.slice(7),
            },
            signal: lifetime.signal,
          });
          try {
            result = session.call(body);
          } finally {
            session.stop();
          }
        } else result = operate(stateFile, cap, body);
        send(200, { result });
      } catch (error) {
        const known = [
          "unauthorized",
          "forbidden",
          "unsafe_path",
          "unsupported_file",
          "file_limit",
          "hash_conflict",
          "changed_during_read",
          "bad_request",
          "invalid_request",
          "idempotency_conflict",
          "queue_limit",
          "stopped",
          "sensitive_content",
        ];
        const code =
          error.code === "EEXIST"
            ? "busy"
            : known.includes(error.message)
              ? error.message
              : "operation_failed";
        send(
          code === "busy"
            ? 429
            : code === "unauthorized"
              ? 401
              : ["hash_conflict", "idempotency_conflict"].includes(code)
                ? 409
                : 400,
          { error: code },
        );
      } finally {
        clearTimeout(timer);
        active--;
      }
    },
  );
  server.headersTimeout = LIMITS.deadline;
  server.requestTimeout = LIMITS.deadline;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  signal?.addEventListener("abort", stop, { once: true });
  server.once("close", () => {
    lifetime.abort();
    signal?.removeEventListener("abort", stop);
  });
  // No request, path, body, token or credential logging.
  return server;
}

export async function callWorkspace({ endpoint, ca, capability, participant, token }, body) {
  return workspaceRequest({ endpoint, ca, capability, participant, token }, body, "/v1/workspace");
}

export async function callScopedWorkspace(credential, body) {
  return workspaceRequest(credential, body, "/v1/scoped-workspace");
}

async function workspaceRequest(
  { endpoint, ca, capability, participant, token, observe },
  body,
  route,
) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== route
  )
    fail("invalid_endpoint");
  const data = JSON.stringify(body);
  if (Buffer.byteLength(data) > LIMITS.body) fail("body_limit");
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        ca,
        rejectUnauthorized: true,
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          "x-workspace-capability": capability,
          "x-workspace-participant": participant,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        // Optional local diagnostic evidence from the verified TLS connection, never a log.
        const peer = res.socket.getPeerCertificate();
        const evidence = {
          tlsAuthorized: res.socket.authorized,
          certificateSha256: peer.fingerprint256,
        };
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > LIMITS.response) req.destroy(new Error("response_limit"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (res.statusCode !== 200 && !result.error) throw new Error("invalid_response");
            observe?.(evidence);
            result.error ? reject(new Error(result.error)) : resolve(result.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("deadline")), LIMITS.deadline);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(data);
  });
}

// Scoped engine. Deliberately NOT routed by the legacy createWorkspaceServer/operate.
export const SCOPE_RIGHTS = Object.freeze([
  "list",
  "search",
  "read",
  "create",
  "write",
  "delete",
  "propose",
]);
export const SEARCH_LIMITS = Object.freeze({
  entries: 1000,
  results: 100,
  bytes: 2 * 1024 * 1024,
  depth: 16,
});
// Local authority APIs only. The caller must already hold the owner's delegation.
export function localGrantScope(stateFile, { name, root, participant, rights, dataRoots = [] }) {
  if (typeof name !== "string" || typeof root !== "string" || !path.isAbsolute(root))
    fail("invalid_selection");
  return grant(stateFile, root, participant, false, { scope: name, rights, dataRoots });
}

function scopeCap(stateFile, credential) {
  const cap = authorize(stateFile, {
    headers: {
      authorization: `Bearer ${credential.token}`,
      "x-workspace-capability": credential.capability,
      "x-workspace-participant": credential.participant,
    },
  });
  // Legacy grants keep their historical list/read/propose behavior, never direct rights.
  return cap;
}
function hasRight(cap, right) {
  return cap.scope
    ? cap.rights.includes(right)
    : ["list", "read"].includes(right)
      ? cap.rights.includes("read")
      : right === "propose" && cap.rights.includes("propose");
}
// Defense in depth, not a universal secret classifier. Select curated roots without secrets.
function publicText(text) {
  if (
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*["']?\s*[:=]\s*["']?[^\s"',;]{8,}/i.test(
      text,
    )
  )
    fail("sensitive_content");
  return text;
}
function scopeRead(root, relative) {
  const file = readText(root, relative);
  publicText(file.text);
  return file;
}
function scopeSearch(cap, body, check) {
  if (
    typeof body.query !== "string" ||
    !body.query.length ||
    body.query.length > 200 ||
    !["name", "content"].includes(body.mode ?? "name")
  )
    fail("invalid_request");
  const mode = body.mode ?? "name";
  const start = body.path ?? "";
  locate(cap.root, start, true);
  const results = [],
    reasons = new Set();
  let scanned = 0,
    bytes = 0;
  const begin = Date.now();
  const query = body.query.toLowerCase();
  function visit(relative, depth) {
    check();
    const directory = locate(cap.root, relative, true);
    const dir = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = dir.readSync())) {
        check();
        if (scanned >= SEARCH_LIMITS.entries) {
          reasons.add("entries");
          return;
        }
        if (Date.now() - begin >= LIMITS.deadline) {
          reasons.add("deadline");
          return;
        }
        if (results.length >= SEARCH_LIMITS.results) {
          reasons.add("results");
          return;
        }
        scanned++;
        if (!allowed(entry.name)) continue;
        const child = [relative, entry.name].filter(Boolean).join("/");
        try {
          if (entry.isDirectory()) {
            locate(cap.root, child, true);
            if (mode === "name" && entry.name.toLowerCase().includes(query))
              results.push({ path: child, kind: "directory" });
            if (depth < SEARCH_LIMITS.depth) visit(child, depth + 1);
            else reasons.add("depth");
          } else if (entry.isFile() && textExtension(entry.name)) {
            // Bound actual bytes read as well as output; no global index or regex execution.
            const target = locate(cap.root, child);
            const size = fs.statSync(target).size;
            if (size > LIMITS.file) {
              reasons.add("file_size");
              continue;
            }
            if (bytes + LIMITS.file > SEARCH_LIMITS.bytes) {
              reasons.add("bytes");
              return;
            }
            bytes += LIMITS.file; // conservative read budget including changing files
            const file = scopeRead(cap.root, child);
            if (mode === "name") {
              if (entry.name.toLowerCase().includes(query))
                results.push({ path: child, kind: "file" });
            } else {
              const offset = file.text.toLowerCase().indexOf(query);
              if (offset >= 0)
                results.push({
                  path: child,
                  kind: "file",
                  hash: file.hash,
                  line: file.text.slice(0, offset).split("\n").length,
                  snippet: file.text.slice(Math.max(0, offset - 40), offset + 120),
                  snippetTruncated: file.text.length > offset + 120 || offset > 40,
                });
            }
          }
        } catch (error) {
          if (error.message === "stopped") throw error;
          reasons.add("omitted"); // unsafe, sensitive, binary or changing, no path/error leak
        }
      }
    } finally {
      dir.closeSync();
    }
  }
  visit(start, 0);
  check();
  return {
    results,
    scanned,
    budgetedBytes: bytes,
    truncated: reasons.size > 0,
    reasons: [...reasons],
    untrusted: true,
  };
}
function directTarget(root, relative) {
  if (
    typeof relative !== "string" ||
    relative.length > 1024 ||
    relative.includes("\\") ||
    relative.split("/").some((p) => p === "." || p === ".." || !allowed(p)) ||
    !textExtension(relative)
  )
    fail("unsafe_path");
  const target = path.resolve(root, relative);
  if (!inside(root, target)) fail("unsafe_path");
  const parent = path.posix.dirname(relative);
  locate(root, parent === "." ? "" : parent, true);
  try {
    fs.lstatSync(target);
    locate(root, relative);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return target;
}
function observe(root, relative) {
  const target = directTarget(root, relative);
  try {
    fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return scopeRead(root, relative).hash;
}
function snapshot(stateFile, id, side, bytes) {
  const directory = privateDir(stateFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  noLinks(directory);
  const file = path.join(directory, `${id}.${side}`);
  durableFile(file, bytes);
}
function snapshotBytes(stateFile, record, side) {
  const file = path.join(privateDir(stateFile), `${record.id}.${side}`);
  noLinks(file);
  const bytes = boundedBytes(file);
  if (hash(bytes) !== record[side]) fail("backup_mismatch");
  return bytes;
}
function operationView(record) {
  const { id, op, path: relative, before, after, status, scope, participant } = record;
  return { id, op, path: relative, before, after, status, scope, participant, historical: true };
}
function recordCap(state, record) {
  const cap = state.grants.find((c) => c.id === record.capability);
  if (!cap || cap.scope !== record.scope || cap.participant !== record.participant)
    fail("invalid_state");
  return cap;
}
function reconcileOperation(state, record) {
  if (!["prepared", "restoring"].includes(record.status)) return;
  const cap = recordCap(state, record);
  const actual = observe(cap.root, record.path);
  const restoring = record.status === "restoring";
  if (actual === (restoring ? record.before : record.after))
    record.status = restoring ? "restored" : "applied";
  else if (actual === (restoring ? record.after : record.before))
    record.status = restoring ? "applied" : "prepared";
  else record.status = "conflict";
}
function replaceScoped(stateFile, cap, record, restoring, check) {
  const expected = restoring ? record.after : record.before;
  const wanted = restoring ? record.before : record.after;
  const target = directTarget(cap.root, record.path);
  if (observe(cap.root, record.path) !== expected) fail("hash_conflict");
  const bytes =
    wanted === null ? null : snapshotBytes(stateFile, record, restoring ? "before" : "after");
  check();
  if (expected === null) {
    // Exclusive creation does not overwrite a racing creator.
    durableFile(target, bytes);
  } else if (wanted === null) {
    locate(cap.root, record.path);
    if (observe(cap.root, record.path) !== expected) fail("hash_conflict");
    fs.unlinkSync(target); // private durable snapshot retained; local restore recreates exclusively
  } else {
    const temporary = path.join(path.dirname(target), `.mind-workspace-${randomUUID()}.tmp`);
    try {
      durableFile(temporary, bytes);
      fs.chmodSync(temporary, fs.statSync(target).mode);
      check();
      locate(cap.root, record.path);
      if (observe(cap.root, record.path) !== expected) fail("hash_conflict");
      fs.renameSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  if (observe(cap.root, record.path) !== wanted) fail("hash_conflict");
  record.status = restoring ? "restored" : "applied";
}
function directOperation(stateFile, authorized, body, check) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(body.idempotencyKey ?? "")) fail("invalid_request");
  if (body.op !== "create" && !/^[a-f0-9]{64}$/.test(body.expectedHash ?? ""))
    fail("invalid_request");
  if (body.op === "create" && body.expectedHash !== undefined) fail("invalid_request");
  if (body.op !== "delete") {
    if (
      typeof body.text !== "string" ||
      Buffer.byteLength(body.text) > LIMITS.file ||
      body.text.includes("\0")
    )
      fail("file_limit");
    publicText(body.text);
  }
  return mutateState(stateFile, (state) => {
    const cap = state.grants.find((c) => c.id === authorized.id);
    if (!cap?.active || !hasRight(cap, body.op)) fail("forbidden");
    const operations = (state.operations ??= []);
    const fingerprint = hash(
      JSON.stringify([body.op, body.path, body.expectedHash ?? null, body.text ?? null]),
    );
    let record = operations.find((r) => r.capability === cap.id && r.key === body.idempotencyKey);
    if (record) {
      if (record.fingerprint !== fingerprint) fail("idempotency_conflict");
      reconcileOperation(state, record);
      if (record.status !== "prepared") return operationView(record);
    } else {
      if (operations.length >= 64) fail("queue_limit");
      const current = observe(cap.root, body.path);
      if (current !== (body.op === "create" ? null : body.expectedHash)) fail("hash_conflict");
      record = {
        id: randomUUID(),
        capability: cap.id,
        scope: cap.scope,
        participant: cap.participant,
        op: body.op,
        path: body.path,
        key: body.idempotencyKey,
        fingerprint,
        before: current,
        after: body.op === "delete" ? null : hash(body.text),
        status: "prepared",
      };
      // Both sides durable before intent; no file bodies/absolute roots in remote result.
      if (current !== null) {
        const original = scopeRead(cap.root, body.path);
        if (original.hash !== current) fail("hash_conflict");
        snapshot(stateFile, record.id, "before", Buffer.from(original.text));
      }
      if (record.after !== null) snapshot(stateFile, record.id, "after", Buffer.from(body.text));
      operations.push(record);
      saveState(stateFile, state);
    }
    check();
    replaceScoped(stateFile, cap, record, false, check);
    return operationView(record);
  });
}
// Local recovery is possible after revocation. It never grants new remote authority.
export function localRestoreOperation(stateFile, id, expectedHash) {
  return mutateState(stateFile, (state) => {
    const record = state.operations?.find((r) => r.id === id);
    if (!record) fail("unknown_operation");
    reconcileOperation(state, record);
    if (expectedHash !== record.after) fail("hash_conflict");
    if (record.status === "restored") return operationView(record);
    if (record.status !== "applied") fail("hash_conflict");
    const cap = recordCap(state, record);
    if (observe(cap.root, record.path) !== expectedHash) fail("hash_conflict");
    record.status = "restoring";
    saveState(stateFile, state);
    replaceScoped(stateFile, cap, record, true, () => {});
    return operationView(record);
  });
}
// Supervisor-owned lifetime. No listener, background process or credential creation.
// Abort is permanent for this session: resuming needs a fresh supervised instance.
export function createScopedWorkspaceSession({ stateFile, credential, signal }) {
  if (!signal) fail("supervision_required");
  const identity = Object.freeze({ ...credential });
  let stopped = signal.aborted;
  const stop = () => {
    stopped = true;
  };
  signal.addEventListener("abort", stop, { once: true });
  const check = () => {
    if (stopped || signal.aborted) fail("stopped");
  };
  return {
    stop() {
      stop();
      signal.removeEventListener("abort", stop);
    },
    call(body) {
      check();
      if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid_request");
      if (Buffer.byteLength(JSON.stringify(body)) > LIMITS.body) fail("file_limit");
      const cap = scopeCap(stateFile, identity); // reload revocation and rights every call
      if (!hasRight(cap, body.op)) fail("forbidden");
      if (body.scope !== undefined && body.scope !== cap.scope) fail("forbidden");
      if (
        ["root", "rights", "participant", "capability", "token"].some((k) => Object.hasOwn(body, k))
      )
        fail("invalid_request");
      switch (body.op) {
        case "search":
          return scopeSearch(cap, body, check);
        case "read":
          return { ...scopeRead(cap.root, body.path), scope: cap.scope, untrusted: true };
        case "list": {
          // Reuse bounded traversal/metadata and do not expose content.
          const output = listWorkspace(cap.root, body);
          output.entries = output.entries.filter((entry) => {
            if (entry.kind !== "file") return true;
            try {
              scopeRead(cap.root, entry.path);
              return true;
            } catch {
              return false;
            }
          });
          return { ...output, scope: cap.scope, untrusted: true };
        }
        case "propose":
          // No new direct authority; legacy review remains in the existing local MCP.
          publicText(body.text ?? "");
          scopeRead(cap.root, body.path);
          return submitProposal(stateFile, cap, body);
        case "create":
        case "write":
        case "delete":
          return directOperation(stateFile, cap, body, check);
        default:
          fail("forbidden");
      }
    },
  };
}
