if (!process.env.LEGAL_SOURCE_PROVIDER_MODULE) throw new Error("Set LEGAL_SOURCE_PROVIDER_MODULE to the provider module under test");
const { a2ajLegalSourceProvider } = await import(process.env.LEGAL_SOURCE_PROVIDER_MODULE);
const cov = await a2ajLegalSourceProvider.coverage("laws");
console.log(JSON.stringify(cov, null, 1).slice(0, 2500));
