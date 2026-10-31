import { initProjects } from "./projects.js";
import { initWorkspaceSync } from "./workspace-sync.js";
import { initDocuments } from "./documents.js";
import { bindChatDraft } from "./chat-draft.js";
/**
 * Panneau « Que fait mon agent ? » et fils privés. Chaque lecture et chaque action passe
 * par une commande Rust qui exécute la CLI correspondante (`mind-wake … --json`,
 * `owner-main.ts … --json`). Aucun appel modèle ni secret. Les images HTTP(S) référencées
 * sont chargées par le webview ; les images locales passent par une lecture native confinée.
 * Le texte des messages est inséré comme texte, jamais comme HTML.
 */

import { agentIsWorking, automaticBumpKind, BUMP_PROMPT_PATH, resolveBumpText, type BumpKind } from "./chat-presence.js";
import { activityModel, type ActivityModel } from "./activity.js";
import { mountAuthorizations } from "./authorizations.js";
import { conversation, conversationText, conversationReceipt, plainText, renderConversationMeta } from "./conversation.js";
import {recipientSender} from "./recipient.js";
import { repoThreads, type RepoThread } from "./repo-threads.js";
import { renderMarkdown } from "./markdown.js";
import { initMessageFileLinks } from "./message-file-links.js";
import { appendMessageImages } from "./message-images.js";
import { decorateMessageLinks } from "./message-links.js";
import { LIGHT_LABELS, panelView, type Line, type PanelView, type StatusRead } from "./view.js";

interface TauriGlobal {
  readonly core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
}

interface Envelope {
  readonly ok?: unknown;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

interface ThreadSummary {
  readonly thread_id: string;
  readonly subject: string | null;
  readonly received: number;
  readonly last_sequence: number;
  readonly last_at: string;
  readonly preview: string;
}

interface Message {
  readonly message_id: string;
  readonly from_self: boolean;
  readonly text: string;
  readonly provenance: { readonly kind: string; readonly received_at: string };
}

const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
const messageFileLinks = tauri ? initMessageFileLinks((command,args)=>tauri.core.invoke(command,args)) : null;
const authorizations = mountAuthorizations(async (command, args) => {
  if (!tauri) throw new Error("Les autorisations sont disponibles dans l’application MIND Wake.");
  return tauri.core.invoke(command, args);
});
const POLL_MS = 2000;
const CHART_EVERY = 5;
const DAY_MS = 86_400_000;
const SEEN_KEY = "mind-wake.seen-sequence";
const CHAT_SEEN_KEY = "mind-wake.chat-seen-at";

let fullscreen = false;
let fullscreenBusy = false;
async function setFullscreen(enabled: boolean): Promise<void> {
  if (!tauri || fullscreenBusy) return;
  fullscreenBusy = true;
  try {
    await tauri.core.invoke("app_fullscreen", {enabled});
    fullscreen = enabled;
    byId("app-fullscreen").textContent = enabled ? "Quitter le plein écran" : "Plein écran";
    byId("app-control-status").textContent = "";
  } catch (error) { byId("app-control-status").textContent = String(error); }
  finally { fullscreenBusy = false; }
}
byId("app-fullscreen").addEventListener("click", () => { void setFullscreen(!fullscreen); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.querySelector("dialog.message-image-dialog[open]")) return;
  if (event.key === "F11" || (event.key === "Escape" && fullscreen)) {
    event.preventDefault();
    void setFullscreen(event.key === "F11" ? !fullscreen : false);
  }
});
byId("app-restart").addEventListener("click", async () => {
  if (!tauri) return;
  const button = byId<HTMLButtonElement>("app-restart");
  button.disabled = true;
  byId("app-control-status").textContent = "Redémarrage…";
  try { await tauri.core.invoke("app_restart"); }
  catch (error) {
    byId("app-control-status").textContent = String(error);
    button.disabled = false;
  }
});

byId("engine-restart").addEventListener("click", async () => {
  if (!tauri) return;
  const button = byId<HTMLButtonElement>("engine-restart");
  if (button.disabled) return;
  button.disabled = true;
  const status = byId("engine-restart-status");
  status.hidden = false;
  status.textContent = "Redémarrage du moteur… La session en cours sera interrompue.";
  try {
    const result = await tauri.core.invoke("wake_restart") as CliRun;
    const envelope = JSON.parse(result.stdout) as Envelope;
    if (result.exitCode !== 0 || envelope.ok !== true) throw new Error(String(envelope.error?.message ?? "Redémarrage non confirmé"));
    status.textContent = "Moteur redémarré. Réglages conservés.";
    await refresh();
  } catch (error) { status.textContent = String(error); }
  finally { button.disabled = false; }
});

let lastRead: StatusRead | null = null;
let stopArmedUntil = 0;
let tick = 0;
let openThread: string | null = null;
let lastMessageId: string | null = null;
let draftKey: string | null = null;
const outgoingChat = new Map<string, HTMLLIElement>();

function messageLinks(body: HTMLElement): void {
  decorateMessageLinks(body, (command, args) => {
    if (!tauri) return Promise.reject(Error("Ouverture disponible dans l’application MIND Wake"));
    return tauri.core.invoke(command, args);
  });
}

function conversationBody(text: string, kind: BumpKind | null, imageText = text): HTMLDivElement {
  const body = document.createElement("div"), paragraph = document.createElement("p");
  body.className = "conversation-body"; body.append(paragraph);
  if (kind === null) {
    paragraph.textContent = text;
    messageLinks(paragraph);
    appendMessageImages(body, imageText, (command, args) => {
      if (!tauri) return Promise.reject(Error("Images locales disponibles dans l’app"));
      return tauri.core.invoke(command, args);
    });
    return body;
  }
  const icon = document.createElement("span");
  icon.className = "bump-invitation-icon";
  icon.textContent = "↗";
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", kind === "bumpe" ? "Bumpe, relance au point cliqué" : "Bump");
  const point = kind === "bumpe" ? /Point choisi par ton humain : \((-?\d+), (-?\d+)\)/.exec(text) : null;
  icon.title = kind === "bumpe" ? `Bumpe · relance ciblée${point ? ` au point (${point[1]}, ${point[2]})` : " au point cliqué"}` : "Bump · invitation à relancer la conversation";
  paragraph.append(icon);
  return body;
}

function outgoingBubble(key: string, text: string, follow = true): HTMLLIElement {
  const li = document.createElement("li");
  li.dataset["self"] = "true";
  li.dataset["messageId"] = key;
  li.className = "message-outgoing";
  const meta = document.createElement("small");
  meta.textContent = "Toi · Envoi en cours…";
  meta.setAttribute("role", "status");
  const kind = automaticBumpKind({from:"human",id:key,text});
  if (kind !== null) li.dataset["invitation"] = kind;
  const body = conversationBody(text, kind);
  li.append(meta, body);
  outgoingChat.set(key, li);
  byId("chat").append(li);
  if (kind === null) messageFileLinks?.observe([{id:key,at:new Date().toISOString(),text}],false,true);
  byId("chat-note").textContent = "";
  if (follow) byId("chat").scrollTop = byId("chat").scrollHeight;
  return li;
}
let chatOpen = false;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- type d'élément choisi par l'appelant
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`élément #${id} absent`);
  return el as T;
}

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<Envelope> {
  if (tauri === undefined) throw new Error("hors de l'application desktop");
  const run = (await tauri.core.invoke(cmd, args)) as CliRun;
  return JSON.parse(run.stdout) as Envelope;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorText(envelope: Envelope): string {
  const m = envelope.error?.message;
  return typeof m === "string" ? m : "refusé";
}

// --- Agent : statut, voyant, sélecteur ---------------------------------------------------

async function refresh(): Promise<void> {
  try {
    const envelope = await invoke("wake_status");
    lastRead = { ok: true, fetchedAt: Date.now(), envelope };
    const input = (envelope.data as { keyboardContext?: { state?: string } } | undefined)
      ?.keyboardContext;
    const indicator = document.getElementById("input-sharing");
    if (indicator) {
      indicator.hidden = !input || input.state === "off";
      indicator.textContent =
        input?.state === "active"
          ? "Partage du texte ACTIF — icône T pour pause ou arrêt"
          : input?.state === "paused"
            ? "Partage du texte en pause"
            : input?.state === "starting"
              ? "Démarrage du partage du texte…"
              : "État du partage du texte indisponible";
    }
  } catch (error) {
    lastRead = { ok: false, fetchedAt: Date.now(), error: message(error) };
  }
  render(panelView(lastRead, Date.now()));
  renderChatPresence();
  window.dispatchEvent(new Event("wake-interface-ready"));
  if (tick % CHART_EVERY === 0) await refreshChart();
  if (tick % CHART_EVERY === 0) await refreshThreads();
  if (tick % CHART_EVERY === 0 || chatOpen) await refreshChat();
  tick += 1;
}

function fillLines(id: string, lines: readonly Line[]): void {
  const list = byId<HTMLDListElement>(id);
  list.replaceChildren(
    ...lines.flatMap((line) => {
      const dt = document.createElement("dt");
      dt.textContent = line.label;
      const dd = document.createElement("dd");
      dd.textContent = line.value;
      return [dt, dd];
    }),
  );
  const section = list.closest("section");
  if (section !== null) section.hidden = lines.length === 0;
}

function render(view: PanelView): void {
  byId("state").dataset["tone"] = view.tone;
  const light = byId("light");
  light.dataset["light"] = view.light;
  light.setAttribute("aria-label", `Voyant : ${LIGHT_LABELS[view.light]}`);
  light.title = LIGHT_LABELS[view.light];
  byId("headline").textContent = view.headline;
  byId("agent-active-project").textContent = view.activeProject ? `Projet : ${view.activeProject}` : "";
  byId("agent-active-project").hidden = view.activeProject === null;
  byId("app-status").textContent = view.headline;
  byId("app-status").dataset["tone"] = view.tone;
  byId("reason").textContent = view.reason;
  byId("simulated").hidden = !view.simulated;
  byId("last-contact").textContent = `Dernier contact avec Wake : ${view.lastContact}`;
  fillLines("activity", view.activity);
  fillLines("consumption", view.consumption);
  fillLines("protection", view.protection);

  const on = byId<HTMLButtonElement>("mode-on");
  const wake = byId<HTMLButtonElement>("mode-wake");
  const off = byId<HTMLButtonElement>("mode-off");
  const always = byId<HTMLButtonElement>("mode-always");
  always.setAttribute("aria-pressed", String(view.alwaysOn));
  always.disabled = !view.canAlwaysOn;
  always.title = view.light === "forced_off" ? "Réactiver Wake et enchaîner les réveils" : "Enchaîner les réveils après chaque réponse";
  on.setAttribute("aria-pressed", String(view.light === "on" && !view.alwaysOn));
  wake.setAttribute("aria-pressed", String(view.light === "awake" && !view.alwaysOn));
  off.setAttribute("aria-pressed", String(view.light === "forced_off"));
  on.disabled = !view.canResume && !view.alwaysOn;
  wake.disabled = !view.canWake;
  off.disabled = !view.canStop;
  byId<HTMLButtonElement>("pause").disabled = !view.canPause;
  const armed = Date.now() < stopArmedUntil;
  off.textContent = armed ? "Confirmer l'arrêt" : "Force-off";
  off.dataset["armed"] = String(armed);
}

function feedback(text: string): void {
  byId("feedback").textContent = text;
}

async function control(cmd: string, done: string): Promise<void> {
  feedback("Commande envoyée…");
  try {
    const envelope = await invoke(cmd);
    const detail =
      typeof envelope.data?.["detail"] === "string" ? ` ${envelope.data["detail"]}` : "";
    feedback(envelope.ok === true ? `${done}${detail}` : `Refusé.${detail}`);
  } catch (error) {
    feedback(`Échec : ${message(error)}`);
  }
  tick = 0;
  await refresh();
}

// --- Graphe réveils / consommation -------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

async function refreshChart(): Promise<void> {
  let model: ActivityModel | null;
  try {
    model = activityModel(await invoke("wake_journal"), Date.now(), DAY_MS);
  } catch {
    model = null;
  }
  drawChart(model);
}

function drawChart(model: ActivityModel | null): void {
  const box = byId("chart");
  const summary = byId("chart-summary");
  if (model === null) {
    box.replaceChildren();
    summary.textContent = "Journal indisponible : aucun graphe affiché.";
    return;
  }
  const W = 400;
  const H = 120;
  const PAD = 18;
  const chart = svg("svg", { viewBox: `0 0 ${String(W)} ${String(H)}`, role: "img" });
  chart.setAttribute(
    "aria-label",
    `${String(model.sessions.length)} réveils sur 24 h, ${model.totalKnownTokens.toLocaleString("fr-FR")} tokens mesurés`,
  );
  const x = (t: number): number =>
    PAD + ((t - model.from) / (model.to - model.from)) * (W - 2 * PAD);
  const base = H - PAD;
  chart.append(svg("line", { x1: PAD, x2: W - PAD, y1: base, y2: base, class: "axis" }));
  for (let h = 0; h <= 24; h += 6) {
    const t = model.from + (h / 24) * (model.to - model.from);
    chart.append(svg("line", { x1: x(t), x2: x(t), y1: base, y2: base + 4, class: "axis" }));
    const label = svg("text", { x: x(t), y: H - 2, class: "tick" });
    // Dernière graduation alignée à droite : « maintenant » ne déborde pas du cadre.
    if (h === 24) label.style.textAnchor = "end";
    label.textContent = h === 24 ? "maintenant" : `-${String(24 - h)} h`;
    chart.append(label);
  }
  for (const s of model.sessions) {
    const start = s.startedAt ?? s.endedAt ?? model.to;
    const cx = x(start);
    // Réveil : marque au sol. Consommation : barre proportionnelle, ou barre hachurée
    // pleine hauteur grisée si les tokens sont inconnus (jamais une barre nulle).
    if (s.tokens === null) {
      chart.append(
        svg("rect", { x: cx - 3, y: PAD, width: 6, height: base - PAD, class: "bar unknown" }),
      );
    } else if (model.maxTokens > 0) {
      const h = Math.max(2, (s.tokens / model.maxTokens) * (base - PAD));
      chart.append(
        svg("rect", {
          x: cx - 3,
          y: base - h,
          width: 6,
          height: h,
          class: s.simulated ? "bar simulated" : "bar",
        }),
      );
    }
    const dot = svg("circle", { cx, cy: base, r: 3.5, class: "wake" });
    const title = svg("title", {});
    title.textContent = `${new Date(start).toLocaleString("fr-FR")} — ${
      s.tokens === null ? "tokens inconnus" : `${s.tokens.toLocaleString("fr-FR")} tokens`
    }${s.outcome === null ? " (en cours)" : ` · ${s.outcome}`}${s.simulated ? " · SIMULÉ" : ""}`;
    dot.append(title);
    chart.append(dot);
  }
  box.replaceChildren(chart);
  summary.textContent =
    model.sessions.length === 0
      ? "Aucun réveil sur les dernières 24 h."
      : `${String(model.sessions.length)} réveil(s) · ${model.totalKnownTokens.toLocaleString("fr-FR")} tokens mesurés` +
        (model.unknownCount > 0
          ? ` · ${String(model.unknownCount)} session(s) à consommation inconnue (barres grisées)`
          : "") +
        (model.simulated ? " · contient des sessions SIMULÉES" : "");
}

// --- Fils privés -------------------------------------------------------------------------

function seenSequence(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? "0") || 0;
  } catch {
    return 0;
  }
}

function markSeen(sequence: number): void {
  try {
    if (sequence > seenSequence()) localStorage.setItem(SEEN_KEY, String(sequence));
  } catch {
    // Préférence d'affichage seulement : sans stockage, tout reste « non lu ».
  }
}

async function refreshThreads(): Promise<void> {
  const status = byId("threads-status");
  let threads: readonly ThreadSummary[];
  try {
    const envelope = await invoke("owner_threads");
    // Sans hub configuré, l'onglet n'a rien à montrer : il reste masqué, sans erreur.
    const configured = envelope.error?.code !== "not_configured";
    byId("tab-threads").hidden = !configured;
    if (!configured) {
      if (!byId("view-threads").hidden) selectTab("panel");
      return;
    }
    if (envelope.ok !== true) {
      status.textContent = `Fils indisponibles : ${errorText(envelope)}`;
      byId("threads").replaceChildren();
      byId("unread").hidden = true;
      return;
    }
    threads = (envelope.data?.["threads"] ?? []) as ThreadSummary[];
  } catch (error) {
    status.textContent = `Fils indisponibles : ${message(error)}`;
    return;
  }
  const seen = seenSequence();
  const unread = threads.filter((t) => t.last_sequence > seen).length;
  byId("unread").textContent = String(unread);
  byId("unread").hidden = unread === 0;
  status.textContent = threads.length === 0 ? "Aucun message de ton agent pour l'instant." : "";
  byId("threads").replaceChildren(
    ...threads.map((t) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["unread"] = String(t.last_sequence > seen);
      const subject = document.createElement("strong");
      subject.textContent = t.subject ?? "(sans sujet)";
      const preview = document.createElement("span");
      preview.className = "thread-preview";
      preview.textContent = plainText(t.preview);
      const when = document.createElement("small");
      when.textContent = new Date(t.last_at).toLocaleString("fr-FR");
      button.append(subject, preview, when);
      button.addEventListener(
        "click",
        () => void showThread(t.thread_id, t.subject, t.last_sequence),
      );
      li.append(button);
      return li;
    }),
  );
}

async function showThread(
  threadId: string,
  subject: string | null,
  lastSequence: number,
): Promise<void> {
  if (openThread !== threadId) draftKey = null;
  openThread = threadId;
  byId("threads").hidden = true;
  byId("thread").hidden = false;
  byId("thread-subject").textContent = subject ?? "(sans sujet)";
  try {
    const envelope = await invoke("owner_thread", { threadId });
    if (envelope.ok !== true) {
      byId("reply-status").textContent = `Fil indisponible : ${errorText(envelope)}`;
      return;
    }
    const messages = (envelope.data?.["messages"] ?? []) as Message[];
    lastMessageId = messages.findLast((m) => !m.from_self)?.message_id ?? null;
    byId("messages").replaceChildren(
      ...messages.map((m) => {
        const li = document.createElement("li");
        li.dataset["self"] = String(m.from_self);
        const meta = document.createElement("small");
        meta.textContent = `${m.from_self ? "Toi" : m.provenance.kind === "agent" ? "Ton agent" : m.provenance.kind} · ${new Date(m.provenance.received_at).toLocaleString("fr-FR")}`;
        const body = document.createElement("p");
        body.textContent = m.text;
        messageLinks(body);
        appendMessageImages(body, m.text, (command, args) => tauri!.core.invoke(command, args));
        li.append(meta, body);
        return li;
      }),
    );
    markSeen(lastSequence);
    await refreshThreads();
  } catch (error) {
    byId("reply-status").textContent = `Fil indisponible : ${message(error)}`;
  }
}

async function sendReply(): Promise<void> {
  const text = byId<HTMLTextAreaElement>("reply-text").value.trim();
  if (openThread === null || text === "") return;
  // Une clé par brouillon : un renvoi après échec réseau ne crée pas de doublon.
  draftKey ??= `ui-${crypto.randomUUID()}`;
  const status = byId("reply-status");
  status.textContent = "Envoi…";
  try {
    const envelope = await invoke("owner_reply", {
      threadId: openThread,
      inReplyTo: lastMessageId,
      idempotencyKey: draftKey,
      text,
    });
    if (envelope.ok !== true) {
      status.textContent = `Non envoyé : ${errorText(envelope)}`;
      return;
    }
    status.textContent = "Envoyé dans le fil. Ton agent le lira à sa prochaine session autorisée.";
    byId<HTMLTextAreaElement>("reply-text").value = "";
    draftKey = null;
    const subject = byId("thread-subject").textContent;
    await showThread(openThread, subject, 0);
  } catch (error) {
    status.textContent = `Non envoyé : ${message(error)}`;
  }
}

// --- Messages avec l'agent ---------------------------------------------------------------

function chatSeenAt(): string {
  try {
    return localStorage.getItem(CHAT_SEEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function markChatSeen(at: string): void {
  try {
    localStorage.setItem(CHAT_SEEN_KEY, at);
  } catch {
    // Préférence d'affichage seulement.
  }
}

/** Markdown de l'agent affiché sans ses marques (titres, gras, code) ; jamais interprété. */

let chatVisibleCount = 30;
let chatSignature = "";
let chatLoadingOlder = false;
let chatHasOpened = false;
byId("chat-older").addEventListener("click", () => { chatVisibleCount += 30; chatLoadingOlder = true; void refreshChat(); });
async function refreshChat(): Promise<void> {
  void refreshRecipient();
  let model;
  try {
    // Réponses des sessions réveillées pour aider l'agent : facultatives, jamais bloquantes.
    const [messages, helpers] = await Promise.all([
      invoke("wake_messages"),
      invoke("helpers_answers").catch(() => null),
    ]);
    model = conversation(messages, helpers);
  } catch (error) {
    byId("chat-note").textContent = `Messages indisponibles : ${message(error)}`;
    return;
  }
  if (model === null) {
    byId("chat-note").textContent = "Messages indisponibles : format inattendu.";
    return;
  }
  const fresh = model.agentUpdatedAt !== null && model.agentUpdatedAt > chatSeenAt();
  byId("chat-new").hidden = chatOpen || !fresh;
  if (chatOpen && model.agentUpdatedAt !== null) markChatSeen(model.agentUpdatedAt);
  byId("chat-note").textContent = model.note ?? "";
  byId("chat-older").hidden = model.items.length <= chatVisibleCount;
  // Keep local bubbles through polling until the persisted ID appears.
  let reconciled = false;
  for (const item of model.items) {
    if (item.id && item.from === "human") {
      if (outgoingChat.delete(item.id)) reconciled = true;
      // Persistence is authoritative even if the send acknowledgement was lost.
      if (pendingBump?.key === item.id) pendingBump = null;
    }
  }
  if (outgoingChat.size) byId("chat-note").textContent = "";
  messageFileLinks?.observe(model.items.filter(item=>(item.from === "human" || item.from === "agent" || item.from === "received") && automaticBumpKind(item) === null).map(item=>({id:item.id,at:item.at,text:item.text})),chatSignature === "" || chatLoadingOlder);
  const signature=JSON.stringify(model.items.slice(-chatVisibleCount));
  if(signature===chatSignature && !reconciled)return;
  const chatPane=byId("chat");
  const firstRender=chatSignature==="";
  const follow=!chatLoadingOlder && (firstRender || chatPane.scrollHeight-chatPane.scrollTop-chatPane.clientHeight < 100);
  const oldTop=chatPane.scrollTop,oldHeight=chatPane.scrollHeight;
  chatSignature=signature;
  byId("chat").replaceChildren(
    ...model.items.slice(-chatVisibleCount).map((item) => {
      const li = document.createElement("li");
      li.dataset["self"] = String(item.from === "human");
      if (item.id) li.dataset["messageId"] = item.id;
      const meta = document.createElement("small");
      li.dataset["from"] = item.from;
      if (item.humanRecipient === "Auroracle") li.dataset["recipient"] = "auroracle";
      renderConversationMeta(meta, item);
      const delivery = conversationReceipt(item);
      if (delivery) {
        const receipt = document.createElement("span");
        receipt.className = "delivery-receipt";
        receipt.dataset["delivered"] = String(delivery.delivered);
        receipt.textContent = delivery.text;
        receipt.title = delivery.title;
        receipt.setAttribute("aria-label", delivery.label);
        meta.append(receipt);
      }
      const kind = automaticBumpKind(item);
      if (kind !== null) li.dataset["invitation"] = kind;
      const body = conversationBody(conversationText(item, plainText), kind, item.text);
      li.append(meta, body);
      if (item.pendingReason) {
        const wait = document.createElement("small");
        wait.className = "message-wait";
        wait.textContent = item.pendingReason;
        li.append(wait);
      }
      return li;
    }),
  );
  chatPane.append(...outgoingChat.values());
  chatPane.scrollTop=follow?chatPane.scrollHeight:oldTop+(chatPane.scrollHeight-oldHeight);
  chatLoadingOlder=false;
}

// Presence is UI state, never a persisted conversation item.
function renderChatPresence(): void {
  const visible = agentIsWorking(lastRead, Date.now());
  const presence = byId("chat-presence");
  if (presence.hidden !== !visible) presence.hidden = !visible;
}
// Expire the indication even if a status request is stuck.
setInterval(renderChatPresence, 1000);

let bumpBusy = false;
let pendingBump: { key: string; text: string; bubble: HTMLLIElement } | null = null;
byId("chat-bump").addEventListener("mousedown", event => event.preventDefault());
byId("chat-bump").addEventListener("click", async () => {
  if (bumpBusy || pendingBump?.bubble.dataset["sending"] === "true") return;
  bumpBusy = true;
  const button = byId<HTMLButtonElement>("chat-bump");
  button.disabled = true;
  if (pendingBump === null) {
    const text = await resolveBumpText(() => {
      if (!tauri) throw new Error("Application indisponible");
      return tauri.core.invoke("document_browse", {scope:"agent",relative:BUMP_PROMPT_PATH,read:true});
    });
    const key = `ui-bump-${crypto.randomUUID()}`;
    pendingBump = {key, text, bubble:outgoingBubble(key, text, false)};
  }
  const {key, text, bubble} = pendingBump;
  // Bump invites a contribution; it cannot lift Pause or start a stopped daemon.
  try { await transmitChat(key, text, bubble, false); }
  finally { bumpBusy = false; button.disabled = false; }
});

// A recipient label is not a route. Keep the draft until a backend-paired human
// identity and reply thread exist; never silently send it to the owner agent.
byId("chat-recipient").addEventListener("change", () => {
  void refreshRecipient();
});
let recipientConfigured=false,recipientChecking=false,recipientPolledAt=0;
async function refreshRecipient():Promise<void> {
  if(recipientChecking)return;
  recipientChecking=true;
  try {
    const status=await invoke("recipient_status");
    recipientConfigured=status.ok===true && status.data?.["configured"]===true;
    const option=byId<HTMLSelectElement>("chat-recipient").querySelector('option[value="auroracle"]');
    const ownerOption=byId<HTMLSelectElement>("chat-recipient").querySelector('option[value="owner"]');
    if(ownerOption)ownerOption.textContent=status.data?.["localOwnerName"]==="Marco" ? "Marco · mon agent" : "Mon agent";
    if(option instanceof HTMLOptionElement) {
      // Never change a chosen recipient after route removal: that could send a
      // retained peer draft to the local owner on the next click.
      option.hidden=status.data?.["pilot"]!==true && byId<HTMLSelectElement>("chat-recipient").value!=="auroracle";
      option.disabled=option.hidden;
      option.textContent=recipientConfigured ? "Auroracle" : "Auroracle · non raccordé";
    }
    if(byId<HTMLSelectElement>("chat-recipient").value==="auroracle")byId("chat-recipient-status").textContent=String(status.data?.["detail"] ?? "Route indisponible.");
    else byId("chat-recipient-status").textContent="";
    if(recipientConfigured && Date.now()-recipientPolledAt>10_000) {
      recipientPolledAt=Date.now();
      const result=await invoke("recipient_poll");
      if(result.ok!==true && byId<HTMLSelectElement>("chat-recipient").value==="auroracle")byId("chat-recipient-status").textContent="Réception distante indisponible ; messages locaux conservés.";
    }
  } catch {
    recipientConfigured=false;
    if(byId<HTMLSelectElement>("chat-recipient").value==="auroracle")byId("chat-recipient-status").textContent="Route indisponible. Brouillon conservé.";
  }
  finally {recipientChecking=false;}
}
const recipientStorage=(()=>{try{return localStorage;}catch{return undefined;}})();
const saveChatDraft=bindChatDraft(byId<HTMLTextAreaElement>('chat-text'),byId<HTMLSelectElement>('chat-recipient'),recipientStorage);
window.addEventListener('beforeunload',saveChatDraft);
const sendRemoteRecipient=recipientSender(invoke,()=>`ui-${crypto.randomUUID()}`,recipientStorage);
async function sendToAgent(): Promise<void> {
  if (byId<HTMLSelectElement>("chat-recipient").value === "auroracle") {
    try {byId("chat-status").textContent=await sendRemoteRecipient(byId<HTMLTextAreaElement>("chat-text"));void refreshChat();}
    catch(error){byId("chat-status").textContent=message(error);}
    saveChatDraft();
    return;
  }
  const field = byId<HTMLTextAreaElement>("chat-text");
  const text = field.value.trim();
  if (text === "") return;
  const key = `ui-${crypto.randomUUID()}`;
  const bubble = outgoingBubble(key, text);
  field.value = "";
  saveChatDraft();
  field.focus();
  await transmitChat(key, text, bubble);
}

async function transmitChat(key: string, text: string, bubble: HTMLLIElement, requestWake = true): Promise<void> {
  const meta = bubble.querySelector("small")!;
  bubble.querySelector("button")?.remove();
  bubble.dataset["sending"] = "true";
  meta.textContent = "Toi · Envoi en cours…";
  try {
    const envelope = await invoke("wake_reply", { idempotencyKey: key, text });
    const detail = typeof envelope.data?.["detail"] === "string" ? envelope.data["detail"] : "";
    if (envelope.ok !== true) throw new Error(detail || errorText(envelope));
  } catch (error) {
    bubble.dataset["sending"] = "false";
    meta.textContent = `Toi · Envoi non confirmé : ${message(error)}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Réessayer";
    retry.addEventListener("click", () => { void transmitChat(key, text, bubble, requestWake); });
    bubble.append(retry);
    return;
  }
  bubble.dataset["sending"] = "false";
  meta.textContent = "Toi · Envoyé · en attente de réception";
  if (pendingBump?.key === key) pendingBump = null;
  // Refresh independently: waking the agent must never delay the sent receipt.
  void refreshChat();
  if (!requestWake) { tick = 0; return; }
  try {
    const wake = await invoke("wake_now");
    if (wake.ok !== true) {
      const detail = typeof wake.data?.["detail"] === "string" ? wake.data["detail"] : errorText(wake);
      byId("chat-status").textContent = `Message envoyé. Pas de réveil : ${detail}.`;
    }
  } catch (error) {
    byId("chat-status").textContent = `Message envoyé. Pas de réveil : ${message(error)}.`;
  }
  tick = 0;
}

byId("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendToAgent();
});

// --- Navigation et événements -------------------------------------------------------------

type Tab = "panel" | "chat" | "threads" | "agents" | "history" | "settings" | "authorizations" | "projects" | "documents";

function selectTab(tab: Tab): void {
  document.querySelector("main")?.setAttribute("data-active-tab", tab);
  byId("tab-documents").setAttribute("aria-selected", String(tab === "documents"));
  for (const name of ["panel", "chat", "threads", "agents", "history", "settings", "authorizations", "projects"] as const) {
    byId(`tab-${name}`).setAttribute("aria-selected", String(name === tab));
    byId(`view-${name}`).hidden = name !== "chat" && name !== tab;
  }
  byId("view-documents").hidden = tab !== "documents" && tab !== "chat";
  chatOpen = true;
  if (tab === "authorizations") void authorizations.open();
  if (tab === "threads") void refreshThreads();
  if (!chatHasOpened || tab === "chat") {
    const firstOpen=!chatHasOpened;
    chatHasOpened=true;
    void refreshChat().then(()=>{ if(firstOpen)byId("chat").scrollTop=byId("chat").scrollHeight; });
  }
  if (tab === "agents") void refreshAgentThreads();
  if (tab === "history") {
    void refreshWakeHistory();
    try { localStorage.setItem("mind-wake-history-visited", "true"); } catch { /* Display preference. */ }
  }
  try { localStorage.setItem("mind-wake-active-tab", tab); } catch { /* Display preference only. */ }
}

byId("tab-panel").addEventListener("click", () => {
  selectTab("panel");
});
byId("tab-chat").addEventListener("click", () => {
  selectTab("chat");
});
byId("tab-threads").addEventListener("click", () => {
  selectTab("threads");
});
byId("thread-back").addEventListener("click", () => {
  openThread = null;
  byId("thread").hidden = true;
  byId("threads").hidden = false;
  byId("reply-status").textContent = "";
});
byId("reply-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendReply();
});

byId("mode-on").addEventListener(
  "click",
  () => void control("wake_on", "Allumé : réveils autorisés."),
);
byId("mode-always").addEventListener(
  "click",
  () => void control("wake_always_on", "Always-on activé."),
);
byId("mode-wake").addEventListener("click", () => void control("wake_now", "Réveil demandé."));
byId("pause").addEventListener("click", () => void control("wake_pause", "Pause appliquée."));
byId("mode-off").addEventListener("click", () => {
  // Deux clics rapprochés : l'arrêt d'urgence ne se lève que par une action explicite
  // ultérieure de l'humain, une confirmation évite qu'un clic égaré l'impose.
  if (Date.now() < stopArmedUntil) {
    stopArmedUntil = 0;
    void control("wake_stop", "Arrêt d'urgence appliqué.");
  } else {
    stopArmedUntil = Date.now() + 5000;
    render(panelView(lastRead, Date.now()));
  }
});

void refresh();
setInterval(() => void refresh(), POLL_MS);

// Repo-agent conversations: read-only observation of the actual exchanged messages.
let agentThreads: RepoThread[] = [];
let selectedAgentThread: string | null = null;
function renderAgentThreads(): void {
  byId("agents-count").textContent = String(agentThreads.length);
  byId("agents-count").hidden = agentThreads.length === 0;
  byId("agents-status").textContent = agentThreads.length ? "" : "Aucune conversation entre agents enregistrée.";
  const selected = agentThreads.find(t => t.id === selectedAgentThread);
  byId("agents-list").hidden = selected !== undefined;
  byId("agent-thread").hidden = selected === undefined;
  byId("agents-list").replaceChildren(...agentThreads.map(t => {
    const li = document.createElement("li"), button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("strong"), detail = document.createElement("small"), preview = document.createElement("span");
    title.textContent = `Wake ↔ ${t.project}`;
    detail.textContent = `${t.runtime} · ${t.messages.length} messages · ${new Date(t.messages.at(-1)?.at ?? "").toLocaleString("fr-FR")}`;
    preview.className = "thread-preview"; preview.textContent = t.messages.at(-1)?.text.slice(0, 180) ?? "";
    button.append(title, detail, preview);
    button.addEventListener("click", () => { selectedAgentThread = t.id; renderAgentThreads(); });
    li.append(button); return li;
  }));
  if (!selected) return;
  byId("agent-thread-title").textContent = `Wake ↔ ${selected.project}`;
  byId("agent-thread-pointers").textContent = `Repo : ${selected.repo}\nSession ${selected.runtime} : ${selected.sessionId}\nHistorique : ${selected.transcript}\nFil : ${selected.id}`;
  byId("agent-thread-messages").replaceChildren(...selected.messages.map(m => {
    const li = document.createElement("li"), meta = document.createElement("small"), body = renderMarkdown(m.text);
    li.dataset["self"] = String(m.from === "wake");
    li.dataset["from"] = m.from === "repo" ? "session" : "agent"; li.dataset["messageId"] = m.id;
    meta.textContent = `${m.from === "system" ? "État de la consultation" : m.from === "wake" ? "Agent Wake" : `Session ${selected.runtime} · ${selected.project}`} · ${new Date(m.at).toLocaleString("fr-FR")}`;
    messageLinks(body);
    appendMessageImages(body, m.text, (command, args) => tauri!.core.invoke(command, args));
    li.append(meta, body);
    if (m.from === "repo" && m.text.length === 4000 && Date.parse(m.at) < Date.parse("2026-10-30T16:00:00Z")) {
      const notice = document.createElement("p"); notice.className = "hint";
      notice.textContent = "Cette réponse historique atteint l’ancienne limite de 4 000 caractères : elle peut être incomplète.";
      li.append(notice);
    }
    return li;
  }));
}
async function refreshAgentThreads(): Promise<void> {
  try {
    const env = await invoke("wake_messages");
    if (env.ok !== true) throw new Error(errorText(env));
    agentThreads = repoThreads(env); renderAgentThreads();
  } catch (error) { byId("agents-status").textContent = `Conversations indisponibles : ${message(error)}`; }
}
byId("tab-agents").addEventListener("click", () => selectTab("agents"));
byId("agent-thread-back").addEventListener("click", () => { selectedAgentThread = null; renderAgentThreads(); });
void refreshAgentThreads();
setInterval(() => { if (!byId("view-agents").hidden) void refreshAgentThreads(); }, POLL_MS);

interface WakeTurnView {
  id: string; sessionId: string; at: string; prompt: string;
  promptMissing?: boolean;
  responses: {id:string;at:string;text:string}[];
}
let wakeTurns: WakeTurnView[] = [];
let wakeHistoryNote = "";
let wakeHistorySignature = "";
function renderWakeHistory(): void {
  const pane=byId("view-history");
  const firstRender=wakeHistorySignature==="";
  const follow=firstRender || pane.scrollHeight-pane.scrollTop-pane.clientHeight<100;
  const oldTop=pane.scrollTop;
  const expanded=new Set([...byId("wake-history-messages").querySelectorAll<HTMLDetailsElement>("details[open]")].map(d=>d.dataset["turnId"]));
  const signature=JSON.stringify({turns:wakeTurns,note:wakeHistoryNote});
  if(signature===wakeHistorySignature)return;
  wakeHistorySignature=signature;
  byId("wake-history-status").textContent = wakeHistoryNote || (!wakeTurns.length ? "Aucun échange disponible." : "");
  const items=wakeTurns.flatMap(turn=>[
    {id:turn.id,at:turn.at,text:turn.prompt,prompt:true,missing:turn.promptMissing===true},
    ...turn.responses.map(r=>({...r,prompt:false,missing:false})),
    ...(turn.responses.length ? [] : [{id:`pending:${turn.id}`,at:turn.at,text:"Aucune réponse visible enregistrée pour ce réveil pour le moment.",prompt:false,missing:false}]),
  ]);
  byId("wake-history-messages").replaceChildren(...items.map(m=>{
    const li=document.createElement("li"),meta=document.createElement("strong"),body=document.createElement("p");
    li.dataset["from"]=m.prompt?"prompt":"agent";
    li.dataset["messageId"]=m.id;
    const pending=m.id.startsWith("pending:");
    if(pending)li.className="wake-placeholder";
    meta.textContent=`${pending?"État du réveil":m.prompt?m.missing?"Échange partiel":"Réveil":"Réponse de l’agent"} · ${new Date(m.at).toLocaleString("fr-FR")}`;
    if(m.prompt) {
      const cue=document.createElement("p"),details=document.createElement("details"),summary=document.createElement("summary"),pre=document.createElement("pre");
      cue.className="wake-cue";cue.textContent=m.missing?"Début de ce réveil non chargé":m.text.split("\n")[0]??m.text;
      summary.textContent="Voir le prompt complet et son contexte";
      pre.textContent=m.text;details.dataset["turnId"]=m.id;details.open=expanded.has(m.id);details.append(summary,pre);li.append(meta,cue);if(!m.missing)li.append(details);
    } else { body.textContent=m.text;messageLinks(body);appendMessageImages(body,m.text,(command,args)=>tauri!.core.invoke(command,args));li.append(meta,body); }
    return li;
  }));
  pane.scrollTop=follow?pane.scrollHeight:oldTop;
}
async function refreshWakeHistory(): Promise<void> {
  try {
    const env=await invoke("wake_history");
    if(env.ok!==true)throw new Error(errorText(env));
    const data=env.data;
    if(!data || !Array.isArray(data["turns"]))throw new Error("Format inattendu");
    const locations=data["locations"] as {workspace?:string;systemPrompt?:string|null} | undefined;
    byId<HTMLButtonElement>("open-system-prompt").disabled=!locations?.systemPrompt;
    byId("open-system-prompt").title=locations?.systemPrompt ?? "Aucun prompt MIND chargé disponible.";
    byId("open-agent-folder").title=locations?.workspace ?? "Dossier de travail de l’agent";
    wakeTurns=data["turns"] as WakeTurnView[];
    wakeHistoryNote=typeof data["note"]==="string"?data["note"]:"";
    renderWakeHistory();
  } catch(error) {byId("wake-history-status").textContent=`Historique indisponible : ${message(error)}`;}
}
byId("tab-history").addEventListener("click",()=>selectTab("history"));
async function openWakeLocation(kind: "workspace" | "systemPrompt"): Promise<void> {
  const status=byId("runtime-link-status");
  try {
    if(!tauri)throw new Error("Ouvrir depuis l’app desktop.");
    await tauri.core.invoke("wake_open_location",{kind});
    status.textContent=kind==="workspace"?"Dossier ouvert dans l’Explorateur.":"Prompt système MIND ouvert dans le Bloc-notes.";
  } catch(error){status.textContent=message(error);}
}
byId("open-system-prompt").addEventListener("click",()=>void openWakeLocation("systemPrompt"));
byId("open-agent-folder").addEventListener("click",()=>void openWakeLocation("workspace"));
setInterval(()=>{if(!byId("view-history").hidden)void refreshWakeHistory();},5000);
selectTab("documents");

// Updates have their own status: no interference with agent activity or drafts.
let updateBusy = false;
async function refreshAppUpdate(check = false): Promise<void> {
  if (!tauri || updateBusy) return;
  const button = byId<HTMLButtonElement>("app-update-check");
  const label = byId("app-update-status");
  if (check) { updateBusy = true; button.disabled = true; label.textContent = "Vérification et installation en cours…"; }
  try {
    const result = await tauri.core.invoke("app_update", {check}) as {state: string; development?: boolean; message?: string; revision?: string};
    const labels: Record<string, string> = {
      disabled: "Désactivé en mode développement.", idle: "Vérification automatique au démarrage et toutes les 6 heures.",
      checking: "Recherche d’une mise à jour…", building: "Installation en arrière-plan…",
      busy: "Une mise à jour est déjà en cours.", current: "Application à jour.",
      installed: "Mise à jour installée. Quittez puis rouvrez le panneau pour l’utiliser. Les sessions déjà actives continuent avec leur version actuelle.",
      error: "Échec de la mise à jour. La version précédente est conservée.",
    };
    label.textContent = result.development ? "Désactivé en mode développement." : (labels[result.state] || result.state);
    if (result.message && !result.development) label.textContent += ` ${result.message}`;
    button.disabled = !!result.development || ["building", "checking", "busy"].includes(result.state);
  } catch (error) { label.textContent = String(error); button.disabled = false; }
  finally { updateBusy = false; }
}
byId("app-update-check").addEventListener("click", () => { void refreshAppUpdate(true); });
void refreshAppUpdate();
setInterval(() => { void refreshAppUpdate(); }, 5000);

// Build metadata stays accurate while an update is staged for the next launch.
async function showAppVersion(): Promise<void> {
  const version = byId("app-version");
  const sourceDate = byId("app-revision-date");
  const buildDate = byId("app-build-date");
  const formatDate = (value: string): string => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Indisponible" : date.toLocaleString("fr-FR", {dateStyle: "long", timeStyle: "short"});
  };
  try {
    if (!tauri) throw new Error("hors de l’application");
    const info = await tauri.core.invoke("app_version") as {
      version: string; revision: string; revisionDate: string; builtAt: string; dirty: string; debug: boolean;
    };
    version.textContent = `v${info.version} · ${info.revision ? info.revision.slice(0, 12) : "révision inconnue"}${info.debug ? " · dev" : ""}${info.dirty === "true" ? " · modifications locales" : ""}`;
    sourceDate.textContent = formatDate(info.revisionDate) + (info.dirty === "true" ? " (dernier commit ; modifications locales incluses dans ce build)" : "");
    buildDate.textContent = formatDate(new Date(Number(info.builtAt) * 1000).toISOString());
  } catch {
    version.textContent = "Version indisponible";
    sourceDate.textContent = "Indisponible";
    buildDate.textContent = "Indisponible";
  }
}
void showAppVersion();

byId("tab-settings").addEventListener("click", () => { selectTab("settings"); });
if (tauri) initWorkspaceSync((command, args) => tauri.core.invoke(command, args));

byId("tab-documents").addEventListener("click", () => { selectTab("documents"); });
if (tauri) initDocuments((command, args) => tauri.core.invoke(command, args));
byId("tab-authorizations").addEventListener("click", () => { selectTab("authorizations"); });

byId("tab-projects").addEventListener("click",()=>selectTab("projects"));
if(tauri)initProjects((command,args)=>tauri.core.invoke(command,args));
