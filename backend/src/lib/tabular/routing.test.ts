import { expect, it, vi } from "vitest";
import { classifyJevColumns, jevRoutesForColumns } from "./jev";

it("reuses serialized column decisions across rows and reordering, and classifies only edits", async () => {
  const columns = [{ index: 0, name: "Consent", prompt: "Is consent required?", format: "yes_no" },
    { index: 1, name: "Conditions", prompt: "Explain every condition.", format: "text" }],
    ask = vi.fn(async (_system: string, _user: string, _signal: AbortSignal) => JSON.stringify({ routes: [{ index: 0, kind: "choice" }] }));
  const initial = await classifyJevColumns({ columns, ask }), saved = JSON.parse(JSON.stringify(initial));
  const reordered = [{ ...columns[1], index: 8 }, { ...columns[0], index: 3 }];
  const reused = await classifyJevColumns({ columns: reordered, previous: saved, ask });
  expect(ask).toHaveBeenCalledTimes(1);
  expect(jevRoutesForColumns(reordered, reused)).toEqual([{ index: 3, kind: "choice" }]);
  const changed = [{ ...columns[0], prompt: "Is consent required for affiliates?" }, columns[1]];
  expect(jevRoutesForColumns(changed, saved)).toEqual([]);
  await classifyJevColumns({ columns: changed, previous: saved, ask });
  expect(ask).toHaveBeenCalledTimes(2);
  expect(JSON.parse(ask.mock.calls[1][1])).toEqual([changed[0]]);
});

it("does not persist a failed classification as a normal-model decision", async () => {
  const columns = [{ index: 0, name: "Consent", prompt: "Is consent required?", format: "yes_no" }],
    ask = vi.fn().mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValue(JSON.stringify({ routes: [{ index: 0, kind: "choice" }] }));
  const failed = await classifyJevColumns({ columns, ask });
  expect(failed).toEqual({});
  expect(jevRoutesForColumns(columns, failed)).toEqual([]);
  const retry = await classifyJevColumns({ columns, previous: failed, ask });
  expect(jevRoutesForColumns(columns, retry)).toEqual([{ index: 0, kind: "choice" }]);
});
