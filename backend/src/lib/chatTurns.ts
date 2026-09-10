import type { ProviderTurnControl } from "./llm";

type ActiveTurn = {
  controller: AbortController;
  provider: ProviderTurnControl | null;
  steering: AbortController;
};

const activeTurns = new Map<string, ActiveTurn>();

export function beginChatTurn(chatId: string, controller: AbortController) {
  if (controller.signal.aborted || activeTurns.has(chatId)) return false;
  activeTurns.set(chatId, { controller, provider: null, steering: new AbortController() });
  return true;
}

export function setChatTurnControl(
  chatId: string,
  controller: AbortController,
  provider: ProviderTurnControl | null,
) {
  const turn = activeTurns.get(chatId);
  if (!turn || turn.controller !== controller || turn.provider === provider) return;
  const previous = turn.steering;
  turn.provider = provider;
  turn.steering = new AbortController();
  previous.abort();
}

export async function steerChatTurn(
  chatId: string,
  message: { id: string; text: string },
) {
  const turn = activeTurns.get(chatId), provider = turn?.provider;
  if (!turn || !provider || turn.controller.signal.aborted) return false;
  const signal = AbortSignal.any([turn.controller.signal, turn.steering.signal]);
  // Stop waiting when this turn/control ends, even if the provider never settles.
  // Keep both promise handlers attached so a late rejection is still observed.
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve().then(() => {
      if (!signal.aborted) return provider.steer(message);
    }).then(() => {
      cleanup();
      resolve(!signal.aborted && activeTurns.get(chatId) === turn && turn.provider === provider);
    }, (error: unknown) => {
      cleanup();
      if (signal.aborted) resolve(false);
      else reject(error);
    });
  });
}

export function abortChatTurnForDeletion(chatId: string) {
  activeTurns.get(chatId)?.controller.abort();
}

export function finishChatTurn(
  chatId: string,
  controller?: AbortController,
) {
  const turn = activeTurns.get(chatId);
  if (controller && turn?.controller !== controller) return;
  activeTurns.delete(chatId);
  turn?.steering.abort();
}
