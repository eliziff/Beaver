import { getRuntimeConfig } from "@/app/lib/runtimeConfig";

const config = getRuntimeConfig();
export const isLocalMode = config.mode === "local";
export const connectorsEnabled = config.capabilities.connectors;
