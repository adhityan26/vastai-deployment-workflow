import { describe, expect, it } from "vitest";
import { cancelPrompt, queuedIds } from "../src/cancel.js";
import { ComfyError } from "../src/comfy.js";

/** A fake ComfyUI queue: each queue() read returns the next snapshot (the last one repeats). */
function fakeComfy(snapshots: { running: string[]; pending: string[] }[]) {
  const calls: string[] = [];
  let i = 0;
  const item = (id: string, n: number) => [n, id, {}, {}, []];
  return {
    calls,
    comfy: {
      queue: async () => {
        calls.push("queue");
        const s = snapshots[Math.min(i++, snapshots.length - 1)]!;
        return { running: s.running.map(item), pending: s.pending.map(item) };
      },
      deleteQueued: async (id: string) => void calls.push(`delete ${id}`),
      interrupt: async (id: string) => void calls.push(`interrupt ${id}`),
    },
  };
}

describe("queuedIds", () => {
  it("reads the prompt id of each ComfyUI queue item and skips malformed ones", () => {
    expect(queuedIds([[1, "a", {}], [2, "b"], "x", [3], [4, 5], null, [5, ""]])).toEqual(["a", "b"]);
  });
});

describe("cancelPrompt", () => {
  it("a queued prompt is deleted from the queue and nothing is interrupted", async () => {
    const f = fakeComfy([{ running: ["other"], pending: ["mine", "z"] }, { running: ["other"], pending: ["z"] }]);
    expect(await cancelPrompt(f.comfy, "mine")).toBe("dequeued");
    expect(f.calls).toEqual(["queue", "delete mine", "queue"]);
  });

  it("the running prompt is interrupted only after the queue shows it is this one, and by its id", async () => {
    const f = fakeComfy([{ running: ["mine"], pending: ["z"] }]);
    expect(await cancelPrompt(f.comfy, "mine")).toBe("interrupted");
    expect(f.calls).toEqual(["queue", "interrupt mine"]);
  });

  it("never interrupts while another prompt runs (this one is not in the queue)", async () => {
    const f = fakeComfy([{ running: ["other"], pending: [] }]);
    expect(await cancelPrompt(f.comfy, "mine")).toBe("not_queued");
    expect(f.calls).toEqual(["queue"]);
  });

  it("a prompt that started between the queue read and the delete is then interrupted", async () => {
    const f = fakeComfy([{ running: ["other"], pending: ["mine"] }, { running: ["mine"], pending: [] }]);
    expect(await cancelPrompt(f.comfy, "mine")).toBe("interrupted");
    expect(f.calls).toEqual(["queue", "delete mine", "queue", "interrupt mine"]);
  });

  it("a prompt the delete did not remove is an error after a few tries (no interrupt)", async () => {
    const f = fakeComfy([{ running: ["other"], pending: ["mine"] }]);
    await expect(cancelPrompt(f.comfy, "mine")).rejects.toBeInstanceOf(ComfyError);
    expect(f.calls.filter((c) => c.startsWith("interrupt"))).toEqual([]);
    expect(f.calls.filter((c) => c === "delete mine")).toHaveLength(3);
  });

  it("ComfyUI errors propagate", async () => {
    const f = fakeComfy([{ running: [], pending: [] }]);
    f.comfy.queue = async () => {
      throw new ComfyError(500, "boom");
    };
    await expect(cancelPrompt(f.comfy, "mine")).rejects.toBeInstanceOf(ComfyError);
  });
});
