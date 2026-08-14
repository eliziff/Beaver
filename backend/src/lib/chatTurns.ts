import type { ProviderTurnControl } from "./llm";

type ActiveTurn = {
  controller: AbortController;
  provider: ProviderTurnControl | null;
};

const activeTurns = new Map<string, ActiveTurn>();
const deletedTurns = new Set<string>();

export function chatTurnInProgress(chatId: string) {
  return activeTurns.has(chatId);
}

export function beginChatTurn(chatId: string, controller: AbortController) {
  if (activeTurns.has(chatId)) return false;
  activeTurns.set(chatId, { controller, provider: null });
  return true;
}

export function setChatTurnControl(
  chatId: string,
  controller: AbortController,
  provider: ProviderTurnControl | null,
) {
  const turn = activeTurns.get(chatId);
  if (turn?.controller === controller) turn.provider = provider;
}

export async function steerChatTurn(
  chatId: string,
  message: { id: string; text: string },
) {
  const provider = activeTurns.get(chatId)?.provider;
  if (!provider) return false;
  await provider.steer(message);
  return true;
}

export function abortChatTurn(chatId: string) {
  const turn = activeTurns.get(chatId);
  if (!turn) return false;
  turn.controller.abort();
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
  if (controller && activeTurns.get(chatId)?.controller !== controller) return;
  activeTurns.delete(chatId);
  deletedTurns.delete(chatId);
}
