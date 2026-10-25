import { ComfyError, type ComfyClient } from "./comfy.js";

/** How often a cancel reads the queue again after a delete that did not take (a prompt that keeps showing as pending). */
const MAX_ATTEMPTS = 3;

/** The prompt ids of ComfyUI queue items (`[number, prompt_id, prompt, extra_data, outputs]`); malformed items are skipped. */
export function queuedIds(items: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (Array.isArray(item) && typeof item[1] === "string" && item[1] !== "") ids.push(item[1]);
  }
  return ids;
}

/**
 * What a cancel did: `dequeued` (it was waiting and is gone from the queue), `interrupted` (it was the running
 * prompt), `not_queued` (ComfyUI has it neither running nor waiting: finished, or never there).
 */
export type CancelOutcome = "dequeued" | "interrupted" | "not_queued";

/**
 * Stop one prompt. A waiting prompt is deleted from the queue, then the queue is read again (it may have started
 * in between). The running prompt is interrupted only after a queue read showed that it IS this prompt, and the
 * interrupt names it, so a ComfyUI that reads `prompt_id` cannot stop another job if it finished in between. Never
 * interrupts while another prompt runs. Unreachable and ComfyError propagate; a prompt the delete never removes is
 * a ComfyError.
 */
export async function cancelPrompt(
  comfy: Pick<ComfyClient, "queue" | "deleteQueued" | "interrupt">,
  promptId: string,
): Promise<CancelOutcome> {
  let deleted = false;
  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    const queue = await comfy.queue();
    if (queuedIds(queue.running).includes(promptId)) {
      await comfy.interrupt(promptId);
      return "interrupted";
    }
    if (!queuedIds(queue.pending).includes(promptId)) return deleted ? "dequeued" : "not_queued";
    if (attempt === MAX_ATTEMPTS) break;
    await comfy.deleteQueued(promptId);
    deleted = true;
  }
  throw new ComfyError(0, "the prompt stayed in the queue after deleting it");
}
