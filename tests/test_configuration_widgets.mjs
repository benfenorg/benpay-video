import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const controlSource = (await readFile(new URL("../web/video_controls.js", import.meta.url), "utf8"))
  .replace('import { t } from "./i18n.js";', "const t = (key) => key;");
const { bindVideoControls } = await import(
  `data:text/javascript;base64,${Buffer.from(controlSource).toString("base64")}`
);
const source = (await readFile(new URL("../web/configuration.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "");
let extension;
const listeners = new Map();
new Function(
  "app", "api", "bindVideoControls", "bindModelSelection", "loadTranslations", "t", "onLanguageChange",
  source,
)(
  { registerExtension(value) { extension = value; } },
  {
    fetchApi: async () => ({ ok: true, json: async () => ({ configured: true, suffix: "abcd" }) }),
    addEventListener(name, callback) { listeners.set(name, callback); },
  },
  bindVideoControls,
  async () => {},
  async () => {},
  (key) => key,
  () => {},
);

function createNode() {
  return {
    comfyClass: "BenpayVideo",
    properties: {},
    widgets: [
      { name: "protocol", value: "doubao", options: {} },
      { name: "ratio", value: "16:9", options: {} },
      { name: "seed", value: 42, options: {} },
      { name: "generation", value: 0, options: {} },
    ],
    setDirtyCanvas() {},
    addWidget(type, name, value, callback, options) {
      const widget = { type, name, value, callback, options };
      this.widgets.push(widget);
      return widget;
    },
  };
}

test("configuration status and both buttons opt out of old and new serialization contracts", async () => {
  const node = createNode();
  await extension.nodeCreated(node);
  const controls = node.widgets.slice(4);
  assert.equal(controls.length, 3);
  for (const widget of controls) {
    assert.equal(widget.serialize, false, widget.name);
    assert.equal(widget.options.serialize, false, widget.name);
  }
  const restored = createNode();
  await extension.nodeCreated(restored);
  for (const isSerializable of [
    (widget) => widget.serialize !== false,
    (widget) => widget.options.serialize !== false,
  ]) {
    const saved = node.widgets.filter(isSerializable).map((widget) => widget.value);
    assert.deepEqual(saved, ["doubao", "16:9", 42, 0]);
    const targets = restored.widgets.filter(isSerializable);
    saved.forEach((value, index) => { targets[index].value = value; });
    restored.onConfigure?.();
    assert.deepEqual(targets.map((widget) => widget.value), saved);
  }
  node.onRemoved();
  restored.onRemoved();
});

test("new generation readiness clears when that node starts, including runs that fail", async () => {
  await extension.setup();
  const node = createNode();
  node.id = 7;
  await extension.nodeCreated(node);
  const generation = node.widgets.find((widget) => widget.name === "generation");
  const button = node.widgets.find((widget) => widget.name === "regenerate");
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { confirm: () => true };
    button.callback();
    assert.equal(button.readyForGeneration, true);
    listeners.get("executing")({ detail: { node: "8" } });
    assert.equal(button.readyForGeneration, true);
    listeners.get("executing")({ detail: { node: "7", display_node: "7" } });
    assert.equal(button.readyForGeneration, false);
    assert.equal(button.name, "regenerate");
    assert.equal(generation.value, 1);
    assert.equal(generation.hidden, true);
    assert.equal(generation.options.hidden, true);
    assert.equal(node.widgets[0].options.getOptionLabel, undefined);
  } finally {
    globalThis.window = previousWindow;
    node.onRemoved();
  }
});
