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
  new Function(
    "app", "api", "document", "loadTranslations", "onLanguageChange", "t", "currentLocale",
    source,
  )(
    { registerExtension(value) { extension = value; } }, api, document,
    async () => {}, () => {}, (key) => key, () => "en",
  );
  return {
    extension, dialogs, requests, queued,
    run: (output = { 1: { class_type: "BenpayVideo" } }, options = {}) => api.queuePrompt(0, { output }, options),
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
  assert.deepEqual(await running, { prompt_id: "queued-1" });
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
    const rejected = assert.rejects(running, /keyMissing/);
    await new Promise((resolve) => setImmediate(resolve));
    controls(plugin).cancel.events.click();
    await rejected;
  }
  assert.equal(plugin.shown, 3);
  assert.equal(plugin.queued.length, 0);
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
  const rejected = assert.rejects(running, /keyMissing/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.shown, 2);
  controls(plugin).cancel.events.click();
  await rejected;
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
