const activeTurns = new Map<string, AbortController>();
const deletedTurns = new Set<string>();

export function anonymousTurnInProgress(chatId: string) {
  return activeTurns.has(chatId);
}

export function beginAnonymousTurn(
  chatId: string,
  controller: AbortController,
) {
  if (activeTurns.has(chatId)) return false;
  activeTurns.set(chatId, controller);
  return true;
}

export function abortAnonymousTurnForDeletion(chatId: string) {
  const controller = activeTurns.get(chatId);
  if (!controller) return false;
  deletedTurns.add(chatId);
  controller.abort();
  return true;
}

export function anonymousTurnWasDeleted(chatId: string) {
  return deletedTurns.has(chatId);
}

export function finishAnonymousTurn(chatId: string) {
  activeTurns.delete(chatId);
  deletedTurns.delete(chatId);
}
