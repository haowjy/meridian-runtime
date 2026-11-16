import type { ScriptLogs } from "../index.js";

// What a script printed, kept in a SharedArrayBuffer the worker writes (`worker.ts`, `appendLog`)
// and the host reads after the worker has ended. Layout: an 8-byte count of every byte printed,
// then the first `headBytes` bytes, then a ring that holds the latest bytes. The ring is one slice
// longer than the tail kept, which is what lets a write that was cut off leave the rest readable.
// Nothing is posted per line, so a script that prints in a loop costs the host nothing.

export interface LogLayout {
  buffer: SharedArrayBuffer;
  headBytes: number;
  ringBytes: number;
  /** The most the worker writes between two updates of the count. */
  sliceBytes: number;
}

export function createLogLayout(maxLogBytes: number): LogLayout {
  const headBytes = Math.floor(maxLogBytes / 2);
  const tailBytes = maxLogBytes - headBytes;
  const sliceBytes = 4096;
  const ringBytes = tailBytes + sliceBytes;
  return {
    buffer: new SharedArrayBuffer(8 + headBytes + ringBytes),
    headBytes,
    ringBytes,
    sliceBytes,
  };
}

const CONTINUATION = 0b1100_0000;

function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  return 2;
}

export function readLogs(layout: LogLayout): ScriptLogs {
  const printed = Number(new BigInt64Array(layout.buffer, 0, 1)[0]);
  const head = new Uint8Array(layout.buffer, 8, layout.headBytes);
  const ring = new Uint8Array(layout.buffer, 8 + layout.headBytes, layout.ringBytes);
  const tailBytes = layout.ringBytes - layout.sliceBytes;
  const maxLogBytes = layout.headBytes + tailBytes;
  const decoder = new TextDecoder();

  const ringBytes = (from: number, to: number): Uint8Array => {
    const out = new Uint8Array(to - from);
    for (let at = from, i = 0; at < to; ) {
      const offset = (at - layout.headBytes) % layout.ringBytes;
      const count = Math.min(to - at, layout.ringBytes - offset);
      out.set(ring.subarray(offset, offset + count), i);
      at += count;
      i += count;
    }
    return out;
  };

  if (printed <= maxLogBytes) {
    const first = head.subarray(0, Math.min(printed, layout.headBytes));
    const rest =
      printed > layout.headBytes ? ringBytes(layout.headBytes, printed) : new Uint8Array();
    return { text: decoder.decode(first) + decoder.decode(rest), cutBytes: 0 };
  }

  // Cut in the middle: drop the partial character at each cut so no replacement character appears.
  let headEnd = layout.headBytes;
  let lead = headEnd - 1;
  while (lead > 0 && ((head[lead] as number) & CONTINUATION) === 0b1000_0000) lead--;
  if (lead >= 0 && lead + utf8Length(head[lead] as number) > headEnd) headEnd = lead;
  const tail = ringBytes(printed - tailBytes, printed);
  let tailStart = 0;
  while (tailStart < tail.length && ((tail[tailStart] as number) & CONTINUATION) === 0b1000_0000) {
    tailStart++;
  }
  return {
    text: decoder.decode(head.subarray(0, headEnd)) + decoder.decode(tail.subarray(tailStart)),
    cutBytes: printed - headEnd - (tail.length - tailStart),
  };
}
