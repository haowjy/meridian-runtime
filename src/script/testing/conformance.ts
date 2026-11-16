import { afterEach, describe, expect, it } from "vitest";
import {
  type HostFunction,
  HostFunctionError,
  type Json,
  type ScriptRequest,
  type ScriptResult,
  type ScriptRunner,
} from "../index.js";

export interface ScriptConformanceOptions {
  /**
   * A runner that cannot start a run (its engine will not load, say). Without it the
   * `unavailable` case is skipped; a backend that has no way to fail that way omits it.
   */
  unavailable?: () => ScriptRunner;
  /**
   * A runner that runs one script at a time and queues the rest. Without it the queueing cases
   * are skipped; a backend that never queues omits it.
   */
  oneAtATime?: () => ScriptRunner;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function request(code: string, overrides: Partial<ScriptRequest> = {}): ScriptRequest {
  return {
    code,
    globals: {},
    wallMs: 5_000,
    cpuMs: 2_500,
    maxCalls: 100,
    maxCallBytes: 10_000,
    maxValueBytes: 10_000,
    maxLogBytes: 10_000,
    ...overrides,
  };
}

function ok(result: ScriptResult): Extract<ScriptResult, { kind: "returned" }> {
  expect(result).toMatchObject({ kind: "returned" });
  return result as Extract<ScriptResult, { kind: "returned" }>;
}

/**
 * One case per promise under "What `run` promises the host" in the design, and one per thing a
 * script is and can do. Every `ScriptRunner` passes it.
 */
export function describeScriptRunner(
  name: string,
  create: () => ScriptRunner,
  options: ScriptConformanceOptions = {},
): void {
  describe(`ScriptRunner conformance: ${name}`, () => {
    const runners: ScriptRunner[] = [];
    const runner = () => {
      const made = create();
      runners.push(made);
      return made;
    };
    afterEach(async () => {
      await Promise.all(runners.splice(0).map((made) => made.close()));
    });

    describe("what a script is and can do", () => {
      it("returns the value of an async function body, with host functions as globals", async () => {
        const seen: Json[][] = [];
        const result = await runner().run(
          request(
            "const a = await call('add', 1, 2); const b = await pubmed.search({ q: 'x' }); return [a, b]",
            {
              globals: {
                call: async (args) => {
                  seen.push(args);
                  return (args[1] as number) + (args[2] as number);
                },
                pubmed: { search: async (args) => ({ hits: args }) },
              },
            },
          ),
        );
        expect(ok(result).value).toEqual([3, { hits: [{ q: "x" }] }]);
        expect(seen).toEqual([["add", 1, 2]]);
      });

      it("reaches nothing but its globals", async () => {
        const result = await runner().run(
          request(
            "return [typeof fetch, typeof process, typeof require, typeof setTimeout, typeof XMLHttpRequest, typeof WebAssembly]",
          ),
        );
        expect(ok(result).value).toEqual(Array(6).fill("undefined"));
      });

      it("keeps nothing between two runs", async () => {
        const made = runner();
        await made.run(request("globalThis.leftover = 1; return null"));
        const second = await made.run(request("return typeof leftover"));
        expect(ok(second).value).toBe("undefined");
      });

      it("has calls in flight together", async () => {
        const started = Date.now();
        const result = await runner().run(
          request("return await Promise.all([1, 2, 3].map((n) => slow(n)))", {
            globals: {
              slow: async (args) => {
                await sleep(400);
                return args[0] as Json;
              },
            },
          }),
        );
        expect(ok(result).value).toEqual([1, 2, 3]);
        expect(Date.now() - started).toBeLessThan(1_150);
      });

      it("surfaces a host error as an Error with its message, and data when it is a HostFunctionError", async () => {
        const secret = Object.assign(new Error("plain failure"), { internal: "do not leak" });
        const globals: Record<string, HostFunction> = {
          plain: async () => {
            throw secret;
          },
          chosen: async () => {
            throw new HostFunctionError("chosen failure", { code: 7 });
          },
        };
        const result = await runner().run(
          request(
            `const out = {};
             for (const name of ['plain', 'chosen']) {
               try { await globalThis[name](); } catch (e) {
                 out[name] = { isError: e instanceof Error, message: e.message, data: e.data ?? null, internal: e.internal ?? null };
               }
             }
             return out`,
            { globals },
          ),
        );
        expect(ok(result).value).toEqual({
          plain: { isError: true, message: "plain failure", data: null, internal: null },
          chosen: { isError: true, message: "chosen failure", data: { code: 7 }, internal: null },
        });
      });
    });

    describe("what run promises the host", () => {
      it("never throws for what the script did, and never runs code twice", async () => {
        let effects = 0;
        const globals = {
          effect: async () => {
            effects++;
            return null;
          },
        };
        const made = runner();
        const results = await Promise.all([
          made.run(request("await effect(); throw new Error('boom')", { globals })),
          made.run(request("await effect(); return 1", { globals })),
          made.run(
            request("await effect(); while (true) {}", { globals, wallMs: 1_000, cpuMs: 200 }),
          ),
        ]);
        expect(results.map((r) => r.kind)).toEqual(["threw", "returned", "timed_out"]);
        expect(effects).toBe(3);
      });

      it("returns the value as JSON.stringify inside the script makes it", async () => {
        const result = await runner().run(
          request(
            "return { a: undefined, b: NaN, c: new Date(0), d: [undefined, () => 1], e: 'é', f: { g: null } }",
          ),
        );
        expect(ok(result).value).toEqual({
          b: null,
          c: "1970-01-01T00:00:00.000Z",
          d: [null, null],
          e: "é",
          f: { g: null },
        });
        expect(ok(await runner().run(request("return"))).value).toBeNull();
        expect(ok(await runner().run(request("return undefined"))).value).toBeNull();
      });

      it("reports a value JSON.stringify throws on as threw", async () => {
        const made = runner();
        for (const code of ["const a = []; a.push(a); return a", "return 10n"]) {
          expect(await made.run(request(code))).toMatchObject({ kind: "threw", name: "TypeError" });
        }
      });

      it("reports a syntax error, with line and column counted from the first line of code", async () => {
        const result = await runner().run(request("return ((;"));
        expect(result).toMatchObject({ kind: "threw", name: "SyntaxError", line: 1, column: 10 });
      });

      it("reports an uncaught error, with its position", async () => {
        const made = runner();
        const result = await made.run(request("\nconst x = null;\n  return x.foo;"));
        expect(result).toMatchObject({ kind: "threw", name: "TypeError", line: 3 });
        expect(await made.run(request("throw 42"))).toMatchObject({ kind: "threw", message: "42" });
        expect(
          await made.run(
            request("await call(); return 1", {
              globals: {
                call: async () => {
                  throw new Error("x");
                },
              },
            }),
          ),
        ).toMatchObject({
          kind: "threw",
          message: "x",
        });
      });

      it("times out on the wall limit, for a loop and for an await that never settles", async () => {
        const made = runner();
        for (const code of ["while (true) {}", "await new Promise(() => {})"]) {
          const started = Date.now();
          const result = await made.run(request(code, { wallMs: 1_000, cpuMs: 60_000 }));
          expect(result).toMatchObject({ kind: "timed_out", limit: "wall" });
          expect(Date.now() - started).toBeLessThan(3_000);
        }
      });

      it("times out on the cpu limit, which counts the script's own running time and not its waiting", async () => {
        const made = runner();
        const spun = await made.run(request("while (true) {}", { wallMs: 20_000, cpuMs: 300 }));
        expect(spun).toMatchObject({ kind: "timed_out", limit: "cpu" });

        const waited = await made.run(
          request("await slow(); return 1", {
            cpuMs: 150,
            globals: {
              slow: async () => {
                await sleep(700);
                return null;
              },
            },
          }),
        );
        expect(ok(waited).value).toBe(1);
      });

      it("reports a value over maxValueBytes as too_large, whole", async () => {
        const result = await runner().run(
          request("return 'x'.repeat(500)", { maxValueBytes: 100 }),
        );
        expect(result).toMatchObject({ kind: "too_large", bytes: 502 });
        expect(result).not.toHaveProperty("value");
      });

      it("aborts at once when the host's signal fires, and when it fired before the run", async () => {
        const made = runner();
        const controller = new AbortController();
        let reached = () => {};
        const inFlight = new Promise<void>((resolve) => {
          reached = resolve;
        });
        let seenAbort = false;
        const pending = made.run(
          request("await slow()", {
            globals: {
              slow: (_args, signal) =>
                new Promise<Json>((resolve) => {
                  reached();
                  signal.addEventListener("abort", () => {
                    seenAbort = true;
                    resolve(null);
                  });
                }),
            },
          }),
          controller.signal,
        );
        await inFlight;
        const started = Date.now();
        controller.abort();
        expect(await pending).toMatchObject({ kind: "aborted" });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(seenAbort).toBe(true);

        const early = AbortSignal.abort();
        expect(await made.run(request("return 1"), early)).toMatchObject({ kind: "aborted" });
      });

      it("reports unavailable when the backend cannot run", async (context) => {
        if (!options.unavailable) return context.skip();
        const broken = options.unavailable();
        try {
          const result = await broken.run(request("return 1"));
          expect(result).toMatchObject({ kind: "unavailable" });
          expect((result as { message: string }).message).not.toBe("");
        } finally {
          await broken.close();
        }
      });

      it("captures console.log, info, warn and error in order", async () => {
        const result = await runner().run(
          request(
            "console.log('a', 1, { b: 2 }); console.info('i'); console.warn('w'); console.error(new Error('e')); return 1",
          ),
        );
        expect(result.logs).toEqual({ text: 'a 1 {"b":2}\ni\nw\nError: e\n', cutBytes: 0 });
      });

      it("keeps the head and the tail of logs past maxLogBytes, and says how much went", async () => {
        const result = await runner().run(
          request("for (let i = 0; i < 2000; i++) console.log('line ' + i); return 1", {
            maxLogBytes: 200,
          }),
        );
        expect(Buffer.byteLength(result.logs.text)).toBeLessThanOrEqual(200);
        expect(result.logs.text.startsWith("line 0\nline 1\n")).toBe(true);
        expect(result.logs.text.endsWith("line 1999\n")).toBe(true);
        const printed = Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join("");
        expect(result.logs.cutBytes).toBe(
          Buffer.byteLength(printed) - Buffer.byteLength(result.logs.text),
        );
        expect(ok(result).value).toBe(1);
      });

      it("never fails a run for its logs, and carries them on every kind", async () => {
        const made = runner();
        const results = await Promise.all([
          made.run(request("console.log('before'); throw new Error('x')")),
          made.run(
            request("console.log('before'); while (true) {}", { wallMs: 1_000, cpuMs: 60_000 }),
          ),
          made.run(request("console.log('before'); return 'x'.repeat(50)", { maxValueBytes: 10 })),
        ]);
        expect(results.map((r) => r.kind)).toEqual(["threw", "timed_out", "too_large"]);
        for (const result of results) expect(result.logs.text).toBe("before\n");
      });

      it("throws in the script, without reaching the host, past maxCalls and maxCallBytes", async () => {
        let reached = 0;
        const result = await runner().run(
          request(
            `const out = [];
             for (let i = 0; i < 4; i++) { try { await note(i); out.push('ok'); } catch (e) { out.push(e.message); } }
             try { await note('x'.repeat(200)); } catch (e) { out.push('bytes'); }
             return out`,
            {
              maxCalls: 2,
              maxCallBytes: 100,
              globals: {
                note: async () => {
                  reached++;
                  return null;
                },
              },
            },
          ),
        );
        const out = ok(result).value as string[];
        expect(out.slice(0, 2)).toEqual(["ok", "ok"]);
        expect(out.slice(2).every((message) => message !== "ok")).toBe(true);
        expect(reached).toBe(2);
      });

      it("fires the signal of a call still in flight when the run ends, and drops what it returns", async () => {
        let seenAbort = false;
        const result = await runner().run(
          request("await hang()", {
            wallMs: 1_000,
            globals: {
              hang: (_args, signal) =>
                new Promise<Json>((resolve) => {
                  signal.addEventListener("abort", () => {
                    seenAbort = true;
                    resolve("late");
                  });
                }),
            },
          }),
        );
        expect(result).toMatchObject({ kind: "timed_out", limit: "wall" });
        expect(seenAbort).toBe(true);
      });

      it("ends a call that arrives after the run ended without starting it, and fires every signal", async () => {
        const signals: AbortSignal[] = [];
        const result = await runner().run(
          request("for (;;) { f(1) }", {
            wallMs: 400,
            cpuMs: 60_000,
            maxCalls: 1_000_000,
            globals: {
              f: (_args, signal) => {
                signals.push(signal);
                return new Promise<Json>(() => {});
              },
            },
          }),
        );
        expect(result).toMatchObject({ kind: "timed_out", limit: "wall" });
        const atEnd = signals.length;
        await sleep(300);
        expect(signals.length).toBe(atEnd);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
      });

      it("survives a script that replaces the built-ins its result passes through", async () => {
        const seen: Json[][] = [];
        const globals = {
          f: async (args: Json[]) => {
            seen.push(args);
            return null;
          },
        };
        const made = runner();
        const replacedThen = await made.run(
          request(
            `const t = Promise.prototype.then;
             Promise.prototype.then = function (a, b) { Promise.prototype.then = t; return t.call(this, () => "r{", b); };
             return 1`,
          ),
        );
        expect(ok(replacedThen).value).toBe(1);

        const replacedToJson = await made.run(
          request(
            "Array.prototype.toJSON = () => 5; Object.prototype.toJSON = () => 6; await f(1); return 2",
            {
              globals,
            },
          ),
        );
        expect(replacedToJson.kind).not.toBe("unavailable");
        expect(seen.every((args) => Array.isArray(args))).toBe(true);

        const replacedStringify = await made.run(
          request("JSON.stringify = () => 'x'; String = () => 5; return { a: 1 }"),
        );
        expect(ok(replacedStringify).value).toEqual({ a: 1 });
      });

      it("bounds the name and message of a thrown error", async () => {
        const result = await runner().run(
          request(
            "const e = new Error('x'.repeat(5_000_000)); e.name = 'N'.repeat(5_000_000); throw e",
            { maxValueBytes: 100 },
          ),
        );
        expect(result).toMatchObject({ kind: "threw" });
        const { name, message } = result as { name: string; message: string };
        expect(name.length).toBeLessThan(10_000);
        expect(message.length).toBeLessThan(10_000);
      });

      it("reports an error thrown by code that ends the wrapper, without reading it in the script", async () => {
        const made = runner();
        const started = await made.run(
          request("}); (function () { throw { toJSON() { return 'x'; } } "),
        );
        expect(started).toMatchObject({ kind: "threw" });
        const compiled = await made.run(
          request("}); throw { get name() { for (;;) {} } }; (function () { "),
        );
        expect(compiled.kind).toBe("timed_out");
      });

      it("ends every run still going as aborted when the runner closes", async () => {
        const made = runner();
        const pending = made.run(request("await new Promise(() => {})", { wallMs: 20_000 }));
        await sleep(200);
        await made.close();
        expect(await pending).toMatchObject({ kind: "aborted" });
      });
    });

    describe("a runner that queues", () => {
      const queued = (context: { skip: () => never }) => {
        if (!options.oneAtATime) return context.skip();
        const made = options.oneAtATime();
        runners.push(made);
        return made;
      };
      const holder = (release: Promise<void>) =>
        request("await hold(); return 'held'", {
          wallMs: 20_000,
          globals: { hold: () => release.then(() => null) },
        });

      it("runs a run past the limit when a slot frees, and does not count the wait toward wallMs", async (context) => {
        const made = queued(context);
        let free = () => {};
        const release = new Promise<void>((resolve) => {
          free = resolve;
        });
        const first = made.run(holder(release));
        const second = made.run(request("return 'second'", { wallMs: 1_500 }));
        await sleep(1_800);
        free();
        expect(ok(await first).value).toBe("held");
        expect(ok(await second).value).toBe("second");
      });

      it("takes a queued run out of the line when its signal fires, at once", async (context) => {
        const made = queued(context);
        let free = () => {};
        const release = new Promise<void>((resolve) => {
          free = resolve;
        });
        const first = made.run(holder(release));
        const controller = new AbortController();
        const second = made.run(request("return 1"), controller.signal);
        await sleep(100);
        const started = Date.now();
        controller.abort();
        expect(await second).toMatchObject({ kind: "aborted" });
        expect(Date.now() - started).toBeLessThan(500);
        expect(await made.run(request("return 1"), AbortSignal.abort())).toMatchObject({
          kind: "aborted",
        });
        free();
        await first;
      });

      it("ends queued runs as aborted without starting them when the runner closes, after its workers have ended", async (context) => {
        const made = queued(context);
        let ran = 0;
        const globals = {
          effect: async () => {
            ran++;
            return null;
          },
          hold: () => new Promise<Json>(() => {}),
        };
        const first = made.run(request("await hold()", { wallMs: 20_000, globals }));
        const queuedRuns = [1, 2].map(() =>
          made.run(request("await effect(); return 1", { globals })),
        );
        await sleep(200);
        await made.close();
        expect(await first).toMatchObject({ kind: "aborted" });
        for (const run of queuedRuns) expect(await run).toMatchObject({ kind: "aborted" });
        await sleep(200);
        expect(ran).toBe(0);
      });
    });
  });
}
