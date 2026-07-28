import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Chat, type LibraryCollection } from "./api";
import "./styles.css";

type Route = "assistant" | "library" | "authorities";

function currentRoute(): Route {
  const value = window.location.pathname.split("/").filter(Boolean)[0];
  return value === "library" || value === "authorities" ? value : "assistant";
}

function Shell({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate("assistant")} aria-label="Open Assistant">
          <span className="brand-mark">◆</span> Beaver
        </button>
        <nav aria-label="Primary navigation">
          {(["assistant", "library", "authorities"] as Route[]).map((item) => (
            <button
              className={`nav-link ${route === item ? "active" : ""}`}
              key={item}
              onClick={() => navigate(item)}
            >
              {item === "authorities" ? "Authorities" : item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <span className="mode">Local</span>
      </header>
      <main className="content">
        {route === "assistant" && <Assistant />}
        {route === "library" && <Library />}
        {route === "authorities" && <Placeholder title="Authorities" />}
      </main>
    </div>
  );
}

function Assistant() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("Ready");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api.chats().then(setChats).catch(() => setStatus("Start a new local chat"));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    const content = prompt.trim();
    const nextMessages = [...messages, { role: "user", content }, { role: "assistant", content: "" }];
    setMessages(nextMessages);
    setPrompt("");
    setRunning(true);
    setStatus("Working…");
    try {
      for await (const event of api.streamChat(nextMessages.slice(0, -1))) {
        if (event.type === "content_delta" && event.text) {
          setMessages((current) => {
            const last = current.length - 1;
            return current.map((message, index) => index === last ? { ...message, content: message.content + event.text } : message);
          });
        }
        if (event.type === "error") throw new Error(event.error || "Chat failed");
      }
      setStatus("Ready");
      setChats((current) => [{ id: crypto.randomUUID(), title: content }, ...current]);
    } catch {
      setStatus("Could not complete the local chat");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="workspace">
      <div className="hero">
        <p className="eyebrow">Assistant</p>
        <h1>What are you working on?</h1>
        <p className="muted">Draft, review, or research client work.</p>
        <form className="prompt" onSubmit={submit}>
          <textarea disabled={running} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask Beaver…" rows={3} />
          <button className="primary" disabled={running} type="submit">{running ? "Working…" : "Send"}</button>
        </form>
        <span className="status" role="status">{status}</span>
      </div>
      {messages.length > 0 && <section className="panel transcript">{messages.map((message, index) => <div className={`message ${message.role}`} key={`${message.role}-${index}`}><strong>{message.role === "user" ? "You" : "Beaver"}</strong><p>{message.content || (running ? "…" : "No response")}</p></div>)}</section>}
      <section className="panel">
        <div className="panel-heading"><h2>Recent chats</h2><span>{chats.length}</span></div>
        {chats.length ? chats.slice(0, 8).map((chat) => <div className="row" key={chat.id}>{chat.title || "Untitled chat"}</div>) : <p className="empty">No chats yet.</p>}
      </section>
    </section>
  );
}

function Library() {
  const [library, setLibrary] = useState<LibraryCollection | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.library("files").then(setLibrary).catch(() => setError("The local Library is unavailable."));
  }, []);
  return (
    <section className="workspace">
      <div className="section-heading"><div><p className="eyebrow">Library</p><h1>Files</h1></div><label className="upload">Upload<input type="file" /></label></div>
      {error && <p className="error">{error}</p>}
      <section className="panel list" aria-live="polite">
        {!library && !error && <p className="empty">Loading files…</p>}
        {library?.documents.length ? library.documents.map((doc) => <div className="row" key={doc.id}><strong>{doc.filename || "Untitled document"}</strong><span>{doc.file_type || "File"}</span></div>) : library && <p className="empty">No files yet.</p>}
      </section>
    </section>
  );
}

function Placeholder({ title }: { title: string }) {
  return <section className="workspace"><p className="eyebrow">Static shell</p><h1>{title}</h1><p className="muted">This vertical slice is next in the migration.</p></section>;
}

function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const navigate = (next: Route) => { history.pushState({}, "", `/${next}`); setRoute(next); };
  return <Shell route={route} navigate={navigate} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
