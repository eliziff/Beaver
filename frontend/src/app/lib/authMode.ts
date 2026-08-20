import { getRuntimeConfig } from "@/app/lib/runtimeConfig";

export const isLocalMode = getRuntimeConfig().mode === "local";
