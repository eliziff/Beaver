import "./lib/loadEnv";
import path from "node:path";
import { createMcpServerApp } from "./lib/mcpServer/server";

// Beaver as a ChatGPT/Claude connector: the MCP endpoint, its app page and that page's Beaver API.
const port = Number(process.env.BEAVER_MCP_PORT ?? 3005);
const { app, secret } = createMcpServerApp({ port,
  beaverOrigin: process.env.BEAVER_API_ORIGIN ?? "http://127.0.0.1:3000",
  app: path.resolve(__dirname, "../../frontend/.tmp/mcp-app-dist") });
app.listen(port, "127.0.0.1", () => {
  console.log(`Beaver MCP on http://127.0.0.1:${port}/mcp/${secret}`);
});
