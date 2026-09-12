import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { ApplicationScope } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { proposalRoute } from "../lib/proposalRoute";
import { textField } from "../lib/textField";
import { folderDesignSchema, type createFolderOrganize } from "../lib/folderOrganize";

const previewInput = z.object({ instruction: textField(2_000), model: textField(200).optional(),
  reasoningEffort: textField(20).optional() }).strict();
const applyInput = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  design: folderDesignSchema }).strict();

/** The same two steps on a library and on a project: propose the folders, then create them and file the documents. */
export function mountOrganize(router: Router, path: string,
  resolve: (req: Request, res: Response) => { scope: ApplicationScope;
    organize: ReturnType<typeof createFolderOrganize> }) {
  router.post(`${path}/organize/preview`, proposalRoute((body) => previewInput.parse(body),
    (req, res, input, signal, progress) => {
      const { scope, organize } = resolve(req, res);
      return organize.preview(scope, input, signal, progress);
    }));
  router.post(`${path}/organize/apply`, asyncRoute(async (req, res) => {
    const input = applyInput.parse(req.body ?? {}), { scope, organize } = resolve(req, res);
    res.json(await organize.apply(scope, input));
  }));
}
