import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("../web/image_inputs.js", import.meta.url), "utf8"))
  .replace('import { app } from "../../scripts/app.js";', "");

function fixture(type, properties = {}) {
  const input = {
    id: "1", comfyClass: type, properties, inputs: [],
    outputs: [{ links: [11] }],
    serialize() { return { id: 1, type, properties }; },
  };
  const node = {
    id: "2", comfyClass: "BenpayVideoFromImages", properties: { benpayRecoveryId: "owner" },
    inputs: [{ name: "images", link: 11 }, { name: "last_frame", link: null }],
    widgets: [{ name: "image_mode", value: "reference_images" }, { name: "protocol", value: "doubao" }],
    setDirtyCanvas() {},
    disconnectInput() { assert.fail("existing input was disconnected"); },
  };
  const graph = {
    _nodes: [input, node],
    links: { 11: { origin_id: "1", origin_slot: 0, target_id: "2", target_slot: 0 } },
    getNodeById(id) { return this._nodes.find((item) => String(item.id) === String(id)); },
    setDirtyCanvas() {},
    add() { assert.fail("unexpected helper node created"); },
    remove() { assert.fail("existing input node was removed"); },
  };
  input.graph = node.graph = graph;
  const app = { graph, registerExtension(value) { this.extension = value; } };
  const helpers = new Function("app", source + "\nreturn { captureLayout, restoreLayout }; ")(app);
  return { input, node, graph, app, ...helpers };
}

test("loading existing processing and batch chains preserves their exact inputs", () => {
  for (const type of ["ImageScale", "BatchImagesNode", "BenpayReferenceImages"]) {
    const { input, node, graph, app } = fixture(type);
    const link = graph.links[11];
    input.inputs = Array.from({ length: 5 }, (_, index) => ({ name: `image${index + 1}`, link: null }));
    app.extension.nodeCreated(node);
    app.extension.afterConfigureGraph();
    assert.equal(node.inputs[0].link, 11);
    assert.equal(graph.links[11], link);
    assert.deepEqual(graph._nodes, [input, node]);
    assert.equal(input.inputs.length, 5);
    assert.equal(input.properties.benpayImageOwner, undefined);
  }
});

test("unowned uploads remain external references when switching layouts", () => {
  const { input, node, captureLayout } = fixture("LoadImage");
  const layout = captureLayout(node);
  assert.deepEqual(layout.nodes, []);
  assert.deepEqual(layout.edges, [{ source: input.id, slot: 0, target: null, input: "images" }]);
});

test("only exclusive helpers belonging to this node can be stashed", () => {
  const { input, node, graph, captureLayout } = fixture("LoadImage", { benpayImageOwner: "owner" });
  assert.equal(captureLayout(node).nodes.length, 1);
  input.properties.benpayImageOwner = "another-owner";
  assert.equal(captureLayout(node).nodes.length, 0);
  input.properties.benpayImageOwner = "owner";
  input.outputs[0].links.push(12);
  graph.links[12] = { origin_id: "1", target_id: "external-consumer" };
  assert.equal(captureLayout(node).nodes.length, 0);
});

test("the bundled first-frame upload can opt into automatic layout management", () => {
  const { input, node, app } = fixture("LoadImage", { benpayImageInput: true });
  node.widgets[0].value = "first_frame";
  app.extension.nodeCreated(node);
  app.extension.afterConfigureGraph();
  assert.equal(input.properties.benpayImageOwner, "owner");
});

test("shared collector inputs are not captured or replayed after being edited", () => {
  const { input, node, graph, captureLayout, restoreLayout } = fixture("BenpayReferenceImages", { benpayImageOwner: "owner" });
  const upload = {
    id: "3", comfyClass: "BenpayReferenceImage", properties: { benpayImageOwner: "owner" },
    inputs: [], outputs: [{ links: [13] }],
  };
  graph._nodes.push(upload);
  input.inputs = [{ name: "image1", link: 13 }];
  graph.links[13] = { origin_id: upload.id, origin_slot: 0, target_id: input.id };
  input.outputs[0].links.push(12);
  graph.links[12] = { origin_id: input.id, target_id: "preview" };
  const layout = captureLayout(node);
  assert.deepEqual(layout.nodes, []);
  assert.deepEqual(layout.edges, [{ source: input.id, slot: 0, target: null, input: "images" }]);

  // A layout saved by the previous version still includes the shared input.
  layout.edges.push({ source: upload.id, slot: 0, target: input.id, input: "image1" });
  input.inputs[0].link = 14;
  graph.links[14] = { origin_id: "replacement", target_id: input.id };
  let reconnected = false;
  input.connect = (slot, target, index) => {
    assert.equal(slot, 0);
    assert.equal(target, node);
    assert.equal(index, 0);
    reconnected = true;
  };
  upload.connect = () => assert.fail("overwrote the shared collector's edited input");
  restoreLayout(node, layout);
  assert.equal(reconnected, true);
  assert.equal(input.inputs[0].link, 14);
  assert.equal(graph.links[12].target_id, "preview");
});
