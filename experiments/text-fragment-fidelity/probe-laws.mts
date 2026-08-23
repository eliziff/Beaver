import { a2ajLegalSourceProvider } from "file:///C:/Users/elias/Desktop/MikeOSS%20Fork/backend/src/lib/legalSources/a2aj.ts";
const cov = await a2ajLegalSourceProvider.coverage("laws");
console.log(JSON.stringify(cov, null, 1).slice(0, 2500));
