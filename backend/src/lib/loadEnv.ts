// Node's built-in .env loader (same no-override semantics as dotenv, minus
// the dependency). Imported for its side effect as the entry point's first
// import so it runs before any module reads process.env, under both CJS and
// ESM evaluation order. Production has no .env file - the shell provides env.
try { process.loadEnvFile(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
