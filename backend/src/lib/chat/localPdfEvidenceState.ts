import { getLocalVersionFile } from "../localDocumentStore";
import {
  createLocalPdfArtifactSession,
  createLocalPdfLinkEvidenceSession,
  readLocalPdfEvidenceReceipt,
  type LocalPdfArtifactSession,
} from "../localPdfLookup";
import {
  appendLegalSourcePinpointLinks,
  hasLegalSourceQuoteCandidates,
  type AutomaticLegalSourceLink,
} from "../legalSourceLinks";

const MAX_HANDLES_PER_ANSWER = 20;
const artifactSessionsByTurn = new WeakMap<
  ReadonlySet<string>,
  Map<string, LocalPdfArtifactSession>
>();

export function localPdfArtifactSessionForTurn(
  handles: ReadonlySet<string>,
  sourcePath: string,
) {
  let sessions = artifactSessionsByTurn.get(handles);
  if (!sessions) {
    sessions = new Map();
    artifactSessionsByTurn.set(handles, sessions);
  }
  let session = sessions.get(sourcePath);
  if (!session) {
    session = createLocalPdfArtifactSession(sourcePath);
    sessions.set(sourcePath, session);
  }
  return session;
}

function sourceLabel(filename: string, locator: string) {
  const page = locator.match(/^\[page (\d+)\]$/u)?.[1];
  const pages = locator.match(/^\[pages ([\d, ]+)\]$/u)?.[1];
  return `${filename}, ${
    page ? `p. ${page}` : pages ? `pp. ${pages}` : locator
  }`;
}

export async function appendLocalPdfPinpointLinks(
  answer: string,
  userId: string,
  handles: ReadonlySet<string>,
  allowedDocumentIds?: ReadonlySet<string>,
  existingUrls: string[] = [],
) {
  if (!handles.size || !hasLegalSourceQuoteCandidates(answer)) return answer;

  const resolved = new Map<string, AutomaticLegalSourceLink>();
  const files = new Map<
    string,
    Awaited<ReturnType<typeof getLocalVersionFile>>
  >();
  const sessions = new Map<
    string,
    ReturnType<typeof createLocalPdfLinkEvidenceSession>
  >();
  for (const handle of [...handles].slice(0, MAX_HANDLES_PER_ANSWER)) {
    try {
      const receipt = await readLocalPdfEvidenceReceipt(handle);
      if (
        allowedDocumentIds &&
        !allowedDocumentIds.has(receipt.source.document_id)
      ) {
        continue;
      }
      const sourceKey =
        `${receipt.source.document_id}|${receipt.source.version_id}`;
      let file = files.get(sourceKey);
      if (file === undefined) {
        file = await getLocalVersionFile(
          userId,
          receipt.source.document_id,
          receipt.source.version_id,
        );
        files.set(sourceKey, file);
      }
      if (!file || file.fileType.toLowerCase() !== "pdf") continue;

      let session = sessions.get(file.path);
      if (!session) {
        session = createLocalPdfLinkEvidenceSession(
          file.path,
          localPdfArtifactSessionForTurn(handles, file.path),
        );
        sessions.set(file.path, session);
      }
      const linked = await session.rehydrate(handle);
      for (const source of linked.sources) {
        const key =
          `${linked.documentId}|${linked.versionId}|${source.key}`;
        if (!resolved.has(key)) {
          resolved.set(key, {
            key,
            label: sourceLabel(file.version.filename, source.label),
            evidence: {
              url: source.href,
              blockText: source.blockText,
              documentText: source.documentText,
              pageScoped: source.pageScoped,
            },
          });
        }
      }
    } catch {
      // Evidence links are additive; stale or unavailable evidence is omitted.
    }
  }
  return appendLegalSourcePinpointLinks(
    answer,
    [...resolved.values()],
    existingUrls,
  );
}
