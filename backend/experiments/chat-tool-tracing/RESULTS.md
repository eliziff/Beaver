# Chat tool tracing experiment

The former production benchmark adapter depended on the retired batch-tool
facade and was not part of normal Beaver behavior. This experiment preserves
the useful capability against the compact one-call `BeaverTool` contract:
when `MIKE_BENCHMARK_TRACE_TOOLS=1`, it wraps a supplied tool list and emits a
bounded, hash-bearing result event after each call.

Production and production tests do not import this directory. Promotion would
require a concrete benchmark runner that composes the wrapper explicitly; it
does not require restoring the old batch executor or route hook.
