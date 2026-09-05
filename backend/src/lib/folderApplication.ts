export async function validateFolderMove(id: string, parentId: string | null,
  load: (id: string) => Promise<{ parent_folder_id: string | null }>,
  error: (cycle: boolean) => Error) {
  const seen = new Set<string>();
  while (parentId) {
    if (parentId === id) throw error(false);
    if (seen.has(parentId)) throw error(true);
    seen.add(parentId);
    parentId = (await load(parentId)).parent_folder_id;
  }
}
