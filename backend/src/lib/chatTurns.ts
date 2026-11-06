import type { ProviderTurnControl } from "./llm";

// One chat turn, start to end, and the one owner of each stage:
//   queued     the job row, until a worker claims it (jobQueue)
//   preparing  the worker holds the job, no chat yet (TurnSlot, chatTurnWorker)
//   claimed    this registry holds the chat and steering reaches the turn (TurnSlot)
//   streaming  the model answers or runs tools (turnEngine, the llm runners' run states),
//              its transcript commits one write at a time (SaveState, chatApplication)
//   paused     the turn asked for inputs: its job succeeds and a later turn answers (AskState)
//   ended      the job row; a lost lease or stopped worker requeues it and the next attempt resumes
type ActiveTurn = {
  controller: AbortController;
  // The provider steering reaches; `ended` releases whoever waits on it once it detaches.
  control: { provider: ProviderTurnControl; ended: AbortController } | null;
};

const activeTurns = new Map<string, ActiveTurn>();

export function beginChatTurn(chatId: string, controller: AbortController) {
  if (controller.signal.aborted || activeTurns.has(chatId)) return false;
  activeTurns.set(chatId, { controller, control: null });
  return true;
}

export function setChatTurnControl(
  chatId: string,
  controller: AbortController,
  provider: ProviderTurnControl | null,
) {
  const turn = activeTurns.get(chatId);
  if (!turn || turn.controller !== controller || (turn.control?.provider ?? null) === provider) return;
  const previous = turn.control;
  turn.control = provider && { provider, ended: new AbortController() };
  previous?.ended.abort();
}

export async function steerChatTurn(
  chatId: string,
  message: Parameters<ProviderTurnControl["steer"]>[0],
) {
  const turn = activeTurns.get(chatId), control = turn?.control;
  if (!turn || !control || turn.controller.signal.aborted) return false;
  const signal = AbortSignal.any([turn.controller.signal, control.ended.signal]);
  // Stop waiting when this turn/control ends, even if the provider never settles.
  // Keep both promise handlers attached so a late rejection is still observed.
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve().then(() => {
      if (!signal.aborted) return control.provider.steer(message);
    }).then(() => {
      cleanup();
      resolve(!signal.aborted);
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
  turn?.control?.ended.abort();
}
