import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import askUser, { type AskUserRequest, type AskUserResolved } from "./index.ts";

type UiFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const events = createEventBus();
  const tools: ToolDefinition[] = [];
  askUser({
    events,
    registerTool: (tool: ToolDefinition) => tools.push(tool),
  } as unknown as ExtensionAPI);
  const request = deferred<AskUserRequest>();
  const ready = deferred<void>();
  const resolved: AskUserResolved[] = [];
  let input: ((key: string) => void) | undefined;
  let closed = 0;
  events.on("ask-user:request", (value) =>
    request.resolve(value as AskUserRequest),
  );
  events.on("ask-user:resolved", (value) =>
    resolved.push(value as AskUserResolved),
  );
  const ctx = {
    mode: "tui",
    ui: {
      custom(factory: UiFactory) {
        return new Promise((done) => {
          const component = factory(
            { requestRender() {} } as Parameters<UiFactory>[0],
            {} as Parameters<UiFactory>[1],
            {} as Parameters<UiFactory>[2],
            (value) => {
              closed++;
              done(value);
            },
          );
          assert.ok(!(component instanceof Promise));
          input = component.handleInput?.bind(component);
          ready.resolve();
        });
      },
    },
  } as unknown as ExtensionContext;
  return {
    events,
    request: request.promise,
    ready: ready.promise,
    resolved,
    closed: () => closed,
    input: (key: string) => {
      assert.ok(input);
      input(key);
    },
    execute: (signal?: AbortSignal) =>
      tools[0].execute(
        "q",
        {
          question: "Choose",
          options: [{ label: "Left" }, { label: "Right" }],
        },
        signal,
        undefined,
        ctx,
      ),
  };
}

test("external replies settle once and close the terminal popup", async () => {
  for (const [response, expected, message] of [
    [{ index: 2 }, { index: 2 }, /option 2: Right/],
    [{ text: " custom " }, { text: "custom" }, /own answer: custom/],
    [null, null, /dismissed/],
  ] as const) {
    const f = setup();
    const pending = f.execute();
    const remote = await f.request;
    await f.ready;
    assert.equal(remote.id, "q");
    remote.respond({ index: 0 });
    remote.respond(response);
    remote.respond({ index: 1 });
    const result = await pending;
    assert.ok(result.content[0].type === "text");
    assert.match(result.content[0].text, message);
    assert.deepEqual(f.resolved, [{ id: "q", response: expected }]);
    assert.equal(f.closed(), 1);
    assert.ok(remote.signal.aborted);
  }
});

test("the terminal still answers without a remote responder; late replies are ignored", async () => {
  const f = setup();
  const pending = f.execute();
  const remote = await f.request;
  await f.ready;
  f.events.on("ask-user:resolved", () => remote.respond({ index: 1 }));
  f.input("2");
  const result = await pending;
  assert.deepEqual(result.content, [
    { type: "text", text: "User selected option 2: Right" },
  ]);
  remote.respond({ index: 1 });
  assert.deepEqual(f.resolved, [{ id: "q", response: { index: 2 } }]);
  assert.ok(remote.signal.aborted);
});

test("cancellation closes both participants without accepting an answer", async () => {
  const f = setup();
  const controller = new AbortController();
  const pending = f.execute(controller.signal);
  const remote = await f.request;
  await f.ready;
  controller.abort();
  assert.deepEqual((await pending).content, [
    { type: "text", text: "Cancelled" },
  ]);
  remote.respond({ index: 1 });
  assert.deepEqual(f.resolved, [{ id: "q", response: null }]);
  assert.equal(f.closed(), 1);
  assert.ok(remote.signal.aborted);
});
