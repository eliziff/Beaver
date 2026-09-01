void import("./authoritiesStandaloneServer").then(({ startAuthoritiesStandalone }) =>
  startAuthoritiesStandalone()).catch((error) => {
  console.error(error instanceof Error ? error.message : "Authorities could not start");
  process.exitCode = 1;
});
