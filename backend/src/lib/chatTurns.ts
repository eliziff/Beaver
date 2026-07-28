const activeTurns = new Map<string, AbortController>();
const deletedTurns = new Set<string>();

export function chatTurnInProgress(chatId: string) {
  return activeTurns.has(chatId);
}

export function beginChatTurn(chatId: string, controller: AbortController) {
  if (activeTurns.has(chatId)) return false;
  activeTurns.set(chatId, controller);
  return true;
}

export function abortChatTurn(chatId: string) {
  const controller = activeTurns.get(chatId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function abortChatTurnForDeletion(chatId: string) {
  if (!activeTurns.has(chatId)) return false;
  deletedTurns.add(chatId);
  return abortChatTurn(chatId);
}

export function chatTurnWasDeleted(chatId: string) {
  return deletedTurns.has(chatId);
}

export function finishChatTurn(
  chatId: string,
  controller?: AbortController,
) {
  if (controller && activeTurns.get(chatId) !== controller) return;
  activeTurns.delete(chatId);
  deletedTurns.delete(chatId);
}
