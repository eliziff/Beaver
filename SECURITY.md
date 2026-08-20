# Beaver security

Beaver handles privileged legal work product. Security changes should protect confidentiality, integrity, availability, and evidentiary provenance without turning a small self-hosted installation into an enterprise security platform. This is an engineering and deployment baseline, not a compliance certification or jurisdiction-specific legal opinion. Last reviewed: 2026-08-20.

## Report a vulnerability

Use the repository's private security-reporting channel or contact its maintainers privately. Include the affected mode (local or cloud), version/commit, impact, and a minimal reproduction. Do not put client material, credentials, or an unpatched exploit in a public issue. Only the current `main` line is supported until releases define a different policy.

## Deployment baseline

Local mode is a single-OS-user trust boundary. It binds to loopback and has no application login; never expose it through port forwarding, a reverse proxy, a shared workstation account, or a LAN address. Use cloud mode when access from another device is required.

For every installation:

1. Run Beaver and its converters under a dedicated, non-administrator OS account. Enable full-disk encryption, endpoint protection, automatic OS/browser updates, and a screen lock.
2. Keep the host, Node.js, LibreOffice/Pandoc/Python helpers, container images, and Beaver dependencies patched. Remove unused services and firewall database, object-storage, and management ports.
3. Back up the database and document objects together. Keep at least one encrypted offline or immutable copy and perform a restore test; a backup that has never restored is not a recovery control.
4. Decide which client matters may leave the host before configuring an AI provider. Local Beaver storage does not make a remote model local: selected prompts and document context are sent to the configured provider. Verify its contract, retention, training, residency, and breach terms.
5. Treat documents, emails, legal-source pages, model output, and MCP metadata/results as adversarial input. Do not enable macros or open exported files outside a patched, protected desktop environment.
6. Give MCP connectors separate, least-privilege credentials. New tools stay disabled until reviewed; only explicitly read-only tools can be enabled for autonomous chat. Re-review tools after a server or credential change.
7. Maintain a short incident plan covering isolation, evidence preservation, credential rotation, restore, insurer/provider contacts, and the firm's jurisdiction-specific duties to clients, privacy regulators, and its law society.

Use separate cryptographically random values of at least 32 characters for
`USER_API_KEYS_ENCRYPTION_SECRET` and `MCP_CONNECTORS_ENCRYPTION_SECRET`. Store
them with the deployment secrets, not in the repository; losing them makes the
corresponding stored credentials unrecoverable.

Cloud mode additionally requires an exact HTTPS `PUBLIC_ORIGIN`, TLS to PostgreSQL and object storage, the correct numeric trusted-proxy hop count, MFA for application and Supabase administrators, RLS on every exposed table/storage object, short-lived signed downloads, and tested tenant-isolation policies. At the Supabase Auth boundary, require at least 12-character passwords, enable leaked-password rejection where available, confirm email addresses and email changes, review Auth rate limits, and disable public signup when the firm provisions accounts centrally. Never ship service-role, database, storage, model, or connector secrets to the browser.

## Security invariants and harness

The security harness should fail if local mode accepts non-loopback hosts or cross-site browser requests; cloud access escapes actor/RLS scope; remote fetches reach private, loopback, link-local, or metadata addresses; uploads/archives exceed resource limits, preserve traversal paths, parse DTD entities, or send embedded/external OOXML content to a converter; secrets enter errors or document-processing subprocesses; OAuth state or tokens cross connector/resource boundaries; or an external tool loop can run without a budget and explicit MCP authorization.

Run the focused checks for security-boundary changes:

```powershell
npm audit --prefix backend
npm audit --prefix frontend
npm test --prefix backend -- server.test.ts schemaSecurity.test.ts documentRoutes.test.ts storage.test.ts remoteUrlSafety.test.ts safeError.test.ts mcpOAuthSecurity.test.ts mcpConnectorBoundary.test.ts mcpResponseLimits.test.ts
npm run build --prefix backend
npm run build --prefix frontend
npm run measure:source
```

The harness baseline is 78,608 nonblank production lines and its current contraction target is 70,000. Security work should consolidate existing primitives instead of adding parallel frameworks. The full release checks remain in `AGENTS.md`.

`npm audit` does not cover the directly pinned SheetJS tarball. Keep `xlsx` at 0.20.3 or a reviewed successor, preserve the lockfile integrity hash, and check the vendor advisories before releases that parse uploaded spreadsheets.

## Primary guidance and reusable resources

- Small Canadian firms: [Canadian Centre for Cyber Security baseline controls](https://www.cyber.gc.ca/en/guidance/baseline-cyber-security-controls-small-and-medium-organizations), its [ransomware playbook](https://www.cyber.gc.ca/en/guidance/ransomware-playbook-itsm00099), and the [Canadian Bar Association continuity and recovery guide](https://cba.org/Resources/Practice-Tools/Business-Continuity-Disaster-Recovery-Planning-Guide).
- Legal confidentiality and AI use: the [CBA privacy and ethics toolkit](https://cba.org/Resources/Practice-Tools/Privacy-And-Ethics-A-Toolkit-for-Lawyers). Confirm controlling duties with the firm's own law society.
- Minimum organizational controls: [CISA Cross-Sector Cybersecurity Performance Goals](https://www.cisa.gov/cybersecurity-performance-goals) and [NIST Cybersecurity Framework 2.0](https://www.nist.gov/cyberframework).
- Software assurance: [NIST SSDF SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final), [OWASP ASVS](https://github.com/OWASP/ASVS), the [OWASP Cheat Sheet Series](https://github.com/OWASP/CheatSheetSeries), and [OpenSSF Scorecard](https://github.com/ossf/scorecard). Use their requirements and tests selectively; do not vendor the projects.
- Web and document boundaries: OWASP's [REST security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html), [file upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), and [CSRF/Fetch Metadata](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) guides, plus [Express production security](https://expressjs.com/en/advanced/best-practice-security.html), Supabase's [production checklist](https://supabase.com/docs/guides/deployment/going-into-prod), [password security](https://supabase.com/docs/guides/auth/password-security), and [Data API security model](https://supabase.com/docs/guides/api/securing-your-api).
- PDF rendering: Mozilla's [PDF.js malicious-document advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq) recommends disabling dynamic evaluation for untrusted PDFs. Beaver also caps decoded image pixels to bound memory use.
- Spreadsheet parsing: SheetJS vendor advisories for [prototype pollution](https://cdn.sheetjs.com/advisories/CVE-2023-30533) and [ReDoS](https://cdn.sheetjs.com/advisories/CVE-2024-22363); both are fixed by Beaver's pinned 0.20.3 tarball.
- Office conversion: Microsoft's Open XML documentation distinguishes [external relationships](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.packaging.openxmlpartcontainer.externalrelationships?view=openxml-3.0.1) from ordinary [hyperlinks](https://learn.microsoft.com/en-us/office/open-xml/presentation/how-to-get-all-the-external-hyperlinks-in-a-presentation). Beaver rejects embedded objects, DDE/include fields, attached templates, and non-hyperlink external relationships before conversion, then runs LibreOffice with an isolated profile and resource limits.
- MCP: the official [authorization security considerations](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/security-considerations.mdx) and [tool security requirements](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/draft/server/tools.mdx). Tool annotations are untrusted hints, not authorization facts.
- AI-specific threats: OWASP's [prompt injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) and [excessive agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) guidance; Greshake et al., [indirect prompt injection](https://arxiv.org/abs/2302.12173); and Radosevich and Halloran, [MCP Safety Audit](https://arxiv.org/abs/2504.03767). Treat the papers as threat research, not proof that a scanner makes an agent safe.
