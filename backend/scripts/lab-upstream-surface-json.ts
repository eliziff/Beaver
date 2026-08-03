/** Emit the frozen upstream Mike LAB prompt and schemas for the Python LAB runner. */
import {
  UPSTREAM_MIKE_COMMIT,
  UPSTREAM_MIKE_LAB_SYSTEM_PROMPT,
  UPSTREAM_MIKE_LAB_TOOLS,
  UPSTREAM_MIKE_SCHEMA_SHA256,
  UPSTREAM_MIKE_SOURCE_BLOBS,
} from "../src/lib/chat/upstreamMikeBenchmarkSurface";

process.stdout.write(
  JSON.stringify({
    commit: UPSTREAM_MIKE_COMMIT,
    source_blobs: UPSTREAM_MIKE_SOURCE_BLOBS,
    schema_sha256: UPSTREAM_MIKE_SCHEMA_SHA256,
    system_prompt: UPSTREAM_MIKE_LAB_SYSTEM_PROMPT,
    tools: UPSTREAM_MIKE_LAB_TOOLS,
  }),
);
