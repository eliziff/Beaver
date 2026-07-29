import { api, type Chat, type LibraryCollection, type Project, type StreamEvent } from "./api";
import "./styles.css";

type Route = "assistant" | "library" | "projects";
type Message = { role: "user" | "assistant"; text: string };
type State = { route: Route; chats: Chat[]; library: LibraryCollection | null; projects: Project[] | null; messages: Message[]; chatId: string | null; version: number; busy: boolean; status: string; error: string };

const root = document.querySelector<HTMLDivElement>("#root")!;
const state: State = { route: routeFromPath(), chats: [], library: null, projects: null, messages: [], chatId: null, version: 0, busy: false, status: "Ready", error: "" };

function routeFromPath(): Route { const route = location.pathname.replace(/^\//u, "").split("/")[0]; return route === "library" || route === "projects" ? route : "assistant"; }
function escape(value: unknown) { return String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function navigate(route: Route) { history.pushState({}, "", `/${route}`); state.route = route; state.error = ""; render(); void loadRoute(); }
function text(event: StreamEvent) { return event.type === "error" ? event.message || "Request failed" : event.text || ""; }
function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((event) => {
    if (!event || typeof event !== "object") return [];
    const row = event as { type?: unknown; text?: unknown };
    return (row.type === "content" || row.type === "content_final") && typeof row.text === "string" ? [row.text] : [];
  }).join("");
}

function shell(content: string) {
  return `<header class="topbar"><a class="brand" href="/assistant">Beaver</a><nav aria-label="Primary"><button data-route="assistant" class="nav ${state.route === "assistant" ? "active" : ""}">Assistant</button><button data-route="library" class="nav ${state.route === "library" ? "active" : ""}">Library</button><a class="nav" href="/table-of-authorities">Authorities</a><button data-route="projects" class="nav ${state.route === "projects" ? "active" : ""}">Projects</button></nav><span class="mode">Local</span></header><main class="content">${content}</main>`;
}

function assistant() {
  const messages = state.messages.map((message) => `<p class="message ${message.role}">${escape(message.text)}</p>`).join("");
  const chats = state.chats.slice(0, 8).map((chat) => `<li><button class="chat-link" data-chat-id="${escape(chat.id)}">${escape(chat.title || "Untitled chat")}</button></li>`).join("");
  return shell(`<section class="workspace"><div class="assistant-panel"><h1>What are you working on?</h1><div id="messages" class="messages">${messages || `<p class="empty">Start a client-work conversation.</p>`}</div><form id="prompt" class="prompt"><textarea name="content" rows="3" placeholder="Ask Beaver…" aria-label="Message Beaver" ${state.busy ? "disabled" : ""}></textarea><div class="prompt-foot"><span id="status" class="status" role="status">${escape(state.status)}</span><button class="primary" ${state.busy ? "disabled" : ""}>${state.busy ? "Working…" : "Send"}</button></div></form>${state.error ? `<p class="error">${escape(state.error)}</p>` : ""}</div><section class="panel"><div class="panel-heading"><h2>Recent chats</h2></div><ul class="chat-list">${chats || `<li class="empty">No chats yet.</li>`}</ul></section></section>`);
}

function library() {
  const rows = state.library?.documents.map((doc) => `<li><strong>${escape(doc.filename || "Untitled document")}</strong><span>${escape(doc.file_type || "File")}</span></li>`).join("") || "";
  return shell(`<section class="workspace"><div class="section-heading"><h1>Library</h1><label class="primary">Upload<input id="upload" type="file" /></label></div><section class="panel list" aria-live="polite">${state.library ? rows || `<p class="empty">No files yet.</p>` : `<p class="empty">Loading files…</p>`}</section>${state.error ? `<p class="error">${escape(state.error)}</p>` : ""}</section>`);
}

function projects() {
  const rows = state.projects?.map((project) => `<li><strong>${escape(project.name)}</strong><span>${escape(project.practice || "General")}</span></li>`).join("") || "";
  return shell(`<section class="workspace"><div class="section-heading"><h1>Projects</h1></div><form id="project" class="project-form"><input class="project-name" name="name" placeholder="New project name" aria-label="New project name" ${state.busy ? "disabled" : ""} /><button class="primary" ${state.busy ? "disabled" : ""}>${state.busy ? "Creating…" : "Create"}</button></form><section class="panel list" aria-live="polite">${state.projects ? rows || `<p class="empty">No projects yet.</p>` : `<p class="empty">Loading projects…</p>`}</section>${state.error ? `<p class="error">${escape(state.error)}</p>` : ""}</section>`);
}

function render() { root.innerHTML = state.route === "library" ? library() : state.route === "projects" ? projects() : assistant(); bind(); }

function bind() {
  root.querySelectorAll<HTMLElement>("[data-route]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.route as Route)));
  root.querySelectorAll<HTMLButtonElement>("[data-chat-id]").forEach((button) => button.addEventListener("click", () => void openChat(button.dataset.chatId!)));
  root.querySelector<HTMLFormElement>("#prompt")?.addEventListener("submit", send);
  root.querySelector<HTMLFormElement>("#project")?.addEventListener("submit", createProject);
  root.querySelector<HTMLInputElement>("#upload")?.addEventListener("change", upload);
}

async function openChat(id: string) {
  state.busy = true; state.status = "Loading chat…"; state.error = ""; state.chatId = id; render();
  try {
    const result = await api.chat(id);
    state.version = result.chat.transcript_version ?? 0;
    state.messages = result.messages.map((message) => ({ role: message.role, text: messageText(message.content) }));
    state.status = "Ready";
  } catch (error) { state.error = error instanceof Error ? error.message : "Chat unavailable"; state.status = "Ready"; }
  state.busy = false; render();
}

async function send(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = form.elements.namedItem("content") as HTMLTextAreaElement;
  const content = input.value.trim();
  if (!content || state.busy) return;
  state.busy = true; state.status = "Working…"; state.error = ""; state.messages.push({ role: "user", text: content }, { role: "assistant", text: "" }); render();
  try {
    await api.stream({ chatId: state.chatId, version: state.version, content, onEvent: (event) => {
      if (event.type === "chat_id") { state.chatId = event.chatId || state.chatId; state.version = event.transcriptVersion ?? state.version; }
      if (event.type === "transcript_version") state.version = event.transcriptVersion ?? state.version;
      if (event.type === "content_delta" || event.type === "content_final") { state.messages.at(-1)!.text = event.text || ""; updateMessages(); }
      if (event.type === "reasoning_delta" || event.type === "thinking") updateStatus("Working…");
      if (event.type === "error") { state.error = text(event); updateStatus(state.error); }
    }});
    state.status = "Ready"; state.chats = await api.chats();
  } catch (error) { state.error = error instanceof Error ? error.message : "Request failed"; state.status = "Ready"; }
  state.busy = false; render();
}

function updateMessages() { const target = document.querySelector<HTMLDivElement>("#messages"); if (target) target.innerHTML = state.messages.map((message) => `<p class="message ${message.role}">${escape(message.text)}</p>`).join(""); }
function updateStatus(value: string) { state.status = value; const target = document.querySelector<HTMLElement>("#status"); if (target) target.textContent = value; }
async function upload(event: Event) { const input = event.currentTarget as HTMLInputElement; const file = input.files?.[0]; input.value = ""; if (!file) return; state.status = "Uploading…"; state.error = ""; render(); try { await api.upload("files", file); state.library = await api.library("files"); state.status = "Ready"; } catch (error) { state.error = error instanceof Error ? error.message : "Upload failed"; state.status = "Ready"; } render(); }
async function createProject(event: SubmitEvent) { event.preventDefault(); const input = (event.currentTarget as HTMLFormElement).elements.namedItem("name") as HTMLInputElement; const name = input.value.trim(); if (!name || state.busy) return; state.busy = true; state.status = "Creating…"; state.error = ""; render(); try { await api.createProject(name); state.projects = await api.projects(); state.status = "Ready"; } catch (error) { state.error = error instanceof Error ? error.message : "Project creation failed"; state.status = "Ready"; } state.busy = false; render(); }
async function loadRoute() {
  const route = state.route;
  if (route === "projects") {
    try { state.projects = await api.projects(); }
    catch (error) { if (state.route === route) state.error = error instanceof Error ? error.message : "Projects unavailable"; }
    if (state.route === route) render();
    return;
  }
  if (route === "library") {
    try { state.library = await api.library("files"); }
    catch (error) { if (state.route === route) state.error = error instanceof Error ? error.message : "Library unavailable"; }
    if (state.route === route) render();
    return;
  }
  try { state.chats = await api.chats(); }
  catch { if (state.route === route) state.status = "Start a new local chat"; }
  if (state.route === route) render();
}

window.addEventListener("popstate", () => { state.route = routeFromPath(); render(); void loadRoute(); });
render(); void loadRoute();
