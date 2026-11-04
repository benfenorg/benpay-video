import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("../web/configuration.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "");

function loadPlugin({ configured = false, unavailable = false } = {}) {
  let extension;
  let shown = 0;
  const dialogs = [];
  const listeners = new Map();
  const requests = [];
  const queued = [];
  function element(tag) {
    return {
      tag, dataset: {}, style: {}, value: "", children: [], events: {},
      setAttribute() {},
      append(...children) { this.children.push(...children); },
      addEventListener(event, callback) { this.events[event] = callback; },
      showModal() { shown++; },
      close() { this.events.close?.(); },
      remove() {}, reset() {}, focus() {},
    };
  }
  const document = {
    createElement: element,
    body: { append(dialog) { dialogs.push(dialog); } },
  };
  const api = {
    async queuePrompt(...args) { queued.push(args); return { prompt_id: "queued-1" }; },
    addEventListener(event, callback) { listeners.set(event, callback); },
    async fetchApi(path, options) {
      requests.push({ path, options });
      if (unavailable) throw new Error("offline");
      if (options?.method === "POST") configured = true;
      return { ok: true, json: async () => ({ configured, suffix: "abcd" }) };
    },
  };
  let output;
  const app = {
    registerExtension(value) { extension = value; },
    graph: { _nodes: [] },
    async graphToPrompt() { throw new Error("Key preflight must not serialize widgets"); },
    async queuePrompt(number, batchCount = 1, options = {}) {
      for (let index = 0; index < batchCount; index++) {
        await api.queuePrompt(number, { output }, options);
      }
      return true;
    },
  };
  new Function(
    "app", "api", "document", "loadTranslations", "onLanguageChange", "t", "currentLocale",
    source,
  )(
    app, api, document,
    async () => {}, () => {}, (key) => key, () => "en",
  );
  return {
    extension, dialogs, requests, queued,
    run: (nodes = { 1: { class_type: "BenpayVideo" } }, options = {}, batchCount = 1) => {
      output = nodes;
      const graphNodes = new Map(Object.entries(nodes).map(([id, node]) => [id, {
        id, comfyClass: node.class_type, mode: node.mode,
        inputs: Object.values(node.inputs || {}).map((value) => ({ value, type: "IMAGE" })),
        getInputLink(index) {
          const value = this.inputs[index].value;
          return Array.isArray(value) ? { origin_id: String(value[0]), origin_slot: value[1] } : null;
        },
      }]));
      app.graph._nodes = [...graphNodes.values()];
      const targets = options.partialExecutionTargets;
      return app.queuePrompt(0, batchCount, { queueNodeIds: targets });
    },
    get shown() { return shown; },
    error: () => listeners.get("execution_error")({ detail: {
      node_type: "BenpayVideo", exception_type: "plugin.ConfigurationError", prompt_id: "run-1",
    } }),
  };
}

function controls(plugin) {
  const form = plugin.dialogs.at(-1).children[2];
  return { form, input: form.children[0].children[1], cancel: form.children[2] };
}

test("startup cancellation still allows one configuration error prompt per execution", async () => {
  const plugin = loadPlugin();
  await plugin.extension.setup();
  assert.equal(plugin.shown, 1);
  assert.equal(plugin.requests[0].path, "/benpay-video/config-status");
  controls(plugin).cancel.events.click();
  await plugin.error();
  assert.equal(plugin.shown, 2);
  controls(plugin).cancel.events.click();
  await plugin.error();
  assert.equal(plugin.shown, 2);
});

test("Run prompts before submission after startup cancellation, saving continues the run", async () => {
  const plugin = loadPlugin();
  await plugin.extension.setup();
  controls(plugin).cancel.events.click();
  const running = plugin.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.shown, 2);
  assert.equal(plugin.queued.length, 0);
  const { form, input } = controls(plugin);
  input.value = "test-key";
  await form.events.submit({ preventDefault() {} });
  assert.equal(await running, true);
  assert.equal(plugin.queued.length, 1);
  await plugin.run();
  assert.equal(plugin.shown, 2);
});

test("cancelling Run configuration prevents submission and another Run can prompt again", async () => {
  const plugin = loadPlugin();
  await plugin.extension.setup();
  controls(plugin).cancel.events.click();
  for (let attempt = 0; attempt < 2; attempt++) {
    const running = plugin.run();
    await new Promise((resolve) => setImmediate(resolve));
    controls(plugin).cancel.events.click();
    assert.equal(await running, false);
  }
  assert.equal(plugin.shown, 3);
  assert.equal(plugin.queued.length, 0);
});

test("Escape and dialog close cancel Run without rejecting or submitting", async () => {
  for (const eventName of ["cancel", "close"]) {
    const plugin = loadPlugin();
    await plugin.extension.setup();
    controls(plugin).cancel.events.click();
    const running = plugin.run();
    await new Promise((resolve) => setImmediate(resolve));
    plugin.dialogs.at(-1).events[eventName]({ preventDefault() {} });
    assert.equal(await running, false);
    assert.equal(plugin.queued.length, 0);
  }
});

test("workflows without BenPay nodes submit without a configuration check", async () => {
  const plugin = loadPlugin({ unavailable: true });
  await plugin.extension.setup();
  const checks = plugin.requests.length;
  await plugin.run({ 1: { class_type: "SaveImage" } });
  assert.equal(plugin.requests.length, checks);
  assert.equal(plugin.queued.length, 1);
});

test("partial execution ignores unrelated BenPay nodes and follows upstream dependencies", async () => {
  const plugin = loadPlugin();
  await plugin.extension.setup();
  controls(plugin).cancel.events.click();
  const output = {
    1: { class_type: "BenpayVideo" },
    2: { class_type: "SaveImage", inputs: { images: ["3", 0] } },
    3: { class_type: "LoadImage", inputs: { image: "test.png" } },
    4: { class_type: "SaveVideo", inputs: { video: ["1", 0] } },
  };
  const checks = plugin.requests.length;
  await plugin.run(output, { partialExecutionTargets: ["2"] });
  assert.equal(plugin.requests.length, checks);
  assert.equal(plugin.queued.length, 1);
  const running = plugin.run(output, { partialExecutionTargets: ["4"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.shown, 2);
  controls(plugin).cancel.events.click();
  assert.equal(await running, false);
  assert.equal(plugin.queued.length, 1);
});

test("configured or unavailable startup does not open a dialog", async () => {
  for (const options of [{ configured: true }, { unavailable: true }]) {
    const plugin = loadPlugin(options);
    await plugin.extension.setup();
    assert.equal(plugin.shown, 0);
  }
});

test("startup dialog saves through existing configuration API and clears the input", async () => {
  const plugin = loadPlugin();
  await plugin.extension.setup();
  const { form, input } = controls(plugin);
  input.value = "test-key";
  await form.events.submit({ preventDefault() {} });
  const save = plugin.requests.find(({ path }) => path === "/benpay-video/config");
  assert.equal(save.options.method, "POST");
  assert.deepEqual(JSON.parse(save.options.body), { apiKey: "test-key" });
  assert.equal(input.value, "");
  await plugin.error();
  assert.equal(plugin.shown, 1);
});

test("a fresh page can prompt again after the previous page was dismissed", async () => {
  const first = loadPlugin();
  await first.extension.setup();
  controls(first).cancel.events.click();
  const next = loadPlugin();
  await next.extension.setup();
  assert.equal(next.shown, 1);
});


test("cancelling a batch stops every submission, saving allows the whole batch", async () => {
  const plugin = loadPlugin();
  await plugin.extension.setup();
  controls(plugin).cancel.events.click();
  const canceled = plugin.run(undefined, {}, 3);
  await new Promise((resolve) => setImmediate(resolve));
  controls(plugin).cancel.events.click();
  assert.equal(await canceled, false);
  assert.equal(plugin.shown, 2);
  assert.equal(plugin.queued.length, 0);
  const saved = plugin.run(undefined, {}, 3);
  await new Promise((resolve) => setImmediate(resolve));
  const { form, input } = controls(plugin);
  input.value = "test-key";
  await form.events.submit({ preventDefault() {} });
  assert.equal(await saved, true);
  assert.equal(plugin.shown, 3);
  assert.equal(plugin.queued.length, 3);
});

test("preflight follows containers, nested outputs and subgraph inputs without serialization", () => {
  const usesBenPayNodes = new Function("app", source + "\nreturn usesBenPayNodes;")({ registerExtension() {} });
  const video = { id: 1, comfyClass: "BenpayVideo", inputs: [] };
  const group = {
    id: 10, subgraph: { _nodes: [video] },
    resolveSubgraphOutputLink() { return { outputNode: video, link: { origin_slot: 0 } }; },
  };
  const save = {
    id: 20, comfyClass: "SaveVideo", inputs: [{ type: "VIDEO" }],
    getInputLink() { return { origin_id: 10, origin_slot: 0 }; },
  };
  const graph = { _nodes: [group, save], serialize() { assert.fail("serialized graph"); } };
  assert.equal(usesBenPayNodes(graph, ["20"]), true);
  assert.equal(usesBenPayNodes(graph, ["10"]), true);
  assert.equal(usesBenPayNodes(graph, ["10:1"]), true);
  const nested = { id: 30, subgraph: { _nodes: [group] }, resolveSubgraphOutputLink() { return { outputNode: group, link: { origin_slot: 0 } }; } };
  assert.equal(usesBenPayNodes({ _nodes: [nested] }, ["30"]), true);
  group.mode = 2;
  assert.equal(usesBenPayNodes(graph), false);
  group.mode = 4;
  assert.equal(usesBenPayNodes(graph), false);
  group.mode = 0;
  const innerSave = { id: 2, comfyClass: "SaveVideo", inputs: [{ type: "VIDEO" }], getInputLink() { return { originIsIoNode: true, origin_slot: 0 }; } };
  const receiver = {
    id: 40, inputs: [{ type: "VIDEO", link: 7 }], subgraph: { _nodes: [innerSave] },
    getInputLink() { assert.fail("subgraph getInputLink resolves the wrong side of the boundary"); },
  };
  const outerGraph = { _nodes: [video, receiver], getLink(id) { return id === 7 ? { origin_id: 1, origin_slot: 0 } : null; } };
  receiver.graph = outerGraph;
  assert.equal(usesBenPayNodes(outerGraph, ["40:2"]), true);
});

test("partial execution follows only the connected subgraph output", () => {
  const usesBenPayNodes = new Function("app", source + "\nreturn usesBenPayNodes;")({ registerExtension() {} });
  const video = { id: 1, comfyClass: "BenpayVideo", inputs: [] };
  const image = { id: 2, comfyClass: "LoadImage", inputs: [] };
  const group = {
    id: 10, subgraph: { _nodes: [video, image] },
    resolveSubgraphOutputLink(slot) {
      return { outputNode: slot === 0 ? video : image, link: { origin_slot: 0 } };
    },
  };
  const preview = { id: 20, inputs: [{ type: "IMAGE" }], getInputLink() { return { origin_id: 10, origin_slot: 1 }; } };
  const graph = { _nodes: [group, preview] };
  assert.equal(usesBenPayNodes(graph, ["20"]), false);
  assert.equal(usesBenPayNodes(graph, ["10"]), true);
});

test("muted and bypassed BenPay nodes do not trigger configuration", async () => {
  const plugin = loadPlugin();
  await plugin.extension.setup();
  controls(plugin).cancel.events.click();
  for (const mode of [2, 4]) {
    await plugin.run({ 1: { class_type: "BenpayVideo", mode } });
  }
  assert.equal(plugin.shown, 1);
  assert.equal(plugin.queued.length, 2);
});

test("partial execution follows virtual output sources across subgraph boundaries", () => {
  const usesBenPayNodes = new Function("app", source + "\nreturn usesBenPayNodes;")({ registerExtension() {} });
  const video = { id: 1, comfyClass: "BenpayVideo", inputs: [] };
  const group = { id: 10, subgraph: { _nodes: [video] } };
  const virtual = {
    id: 2, isVirtualNode: true, inputs: [],
    resolveVirtualOutput(slot) {
      assert.equal(slot, 0);
      return { node: video, slot: 0 };
    },
  };
  const save = { id: 3, inputs: [{ type: "VIDEO" }], getInputLink() { return { origin_id: 2, origin_slot: 0 }; } };
  const graph = { _nodes: [group, virtual, save] };
  assert.equal(usesBenPayNodes(graph, ["3"]), true);
  video.mode = 2;
  assert.equal(usesBenPayNodes(graph, ["3"]), false);
  video.mode = 0;
  virtual.mode = 2;
  assert.equal(usesBenPayNodes(graph, ["3"]), false);
});

test("cyclic virtual connections terminate without submitting or serializing", () => {
  const usesBenPayNodes = new Function("app", source + "\nreturn usesBenPayNodes;")({ registerExtension() {} });
  const first = { id: 1, isVirtualNode: true, inputs: [] };
  const second = { id: 2, isVirtualNode: true, inputs: [] };
  first.resolveVirtualOutput = () => ({ node: second, slot: 0 });
  second.resolveVirtualOutput = () => ({ node: first, slot: 0 });
  const save = { id: 3, inputs: [{ type: "VIDEO" }], getInputLink() { return { origin_id: 1, origin_slot: 0 }; } };
  assert.equal(usesBenPayNodes({ _nodes: [first, second, save] }, ["3"]), false);
});
