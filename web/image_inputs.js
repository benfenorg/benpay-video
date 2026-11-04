import { app } from "../../scripts/app.js";

const layoutTypes = new Set(["LoadImage", "BatchImagesNode", "ImageBatch", "BenpayReferenceImage", "BenpayReferenceImages"]);
const controllers = new WeakMap();

function ownerKey(node) {
  return String(node.properties?.benpayRecoveryId || node.id);
}

function isManagedInput(node, source) {
  return source?.properties?.benpayImageOwner === ownerKey(node);
}

function manageInput(node, source) {
  source.properties ||= {};
  source.properties.benpayImageOwner = ownerKey(node);
  return source;
}

function sourceOf(node, name) {
  const input = node.inputs?.find((input) => input.name === name);
  const link = node.graph?.links[input?.link];
  return link ? node.graph.getNodeById(link.origin_id) : null;
}

function createNode(graph, type, position, saved) {
  const node = globalThis.LiteGraph.createNode(type);
  if (!node) throw new Error(`BenPay requires the ${type} node.`);
  if (saved) {
    const copy = structuredClone(saved);
    copy.type = type;
    for (const input of copy.inputs || []) input.link = null;
    for (const output of copy.outputs || []) output.links = null;
    node.configure(copy);
  } else if (type === "LoadImage" || type === "BenpayReferenceImage") {
    const image = node.widgets?.find((widget) => widget.name === "image");
    if (image) image.value = "";
  }
  node.id = -1;
  node.pos = [...position];
  graph.add(node);
  return node;
}

function connectImage(source, target, inputName) {
  const index = target.inputs.findIndex((input) => input.name === inputName);
  if (index >= 0) source.connect(0, target, index);
}

function captureLayout(node) {
  const graph = node.graph;
  const nodes = new Map();
  function visit(source) {
    if (!source || nodes.has(source.id) || !layoutTypes.has(source.comfyClass) || !isManagedInput(node, source)) return;
    nodes.set(source.id, source);
    for (const input of source.inputs || []) visit(sourceOf(source, input.name));
  }
  for (const name of ["images", "last_frame"]) visit(sourceOf(node, name));
  const removable = new Set(nodes.keys());
  // A shared upload and all its dependencies remain available to other branches.
  let changed = true;
  while (changed) {
    changed = false;
    for (const source of nodes.values()) {
      if (!removable.has(source.id)) continue;
      const shared = (source.outputs || []).some((output) =>
        (output.links || []).some((id) => {
          const target = graph.links[id]?.target_id;
          return target != null && target !== node.id && !removable.has(target);
        }),
      );
      if (shared) {
        removable.delete(source.id);
        changed = true;
      }
    }
  }
  const edges = [];
  for (const target of [...nodes.values(), node]) {
    // Shared nodes stay on the canvas; their current inputs remain authoritative.
    if (target !== node && !removable.has(target.id)) continue;
    for (const input of target.inputs || []) {
      const link = graph.links[input.link];
      if (!link || (target === node && !["images", "last_frame"].includes(input.name))) continue;
      edges.push({ source: link.origin_id, slot: link.origin_slot, target: target === node ? null : target.id, input: input.name });
    }
  }
  return {
    nodes: [...nodes.values()].filter((source) => removable.has(source.id)).map((source) => source.serialize()),
    edges,
  };
}

function restoreLayout(node, layout) {
  const restored = new Map();
  for (const saved of layout.nodes) {
    const copy = structuredClone(saved);
    // Reconnect from the saved edge list, never retain obsolete link IDs.
    for (const input of copy.inputs || []) input.link = null;
    for (const output of copy.outputs || []) output.links = null;
    restored.set(String(saved.id), manageInput(node, createNode(node.graph, saved.type, saved.pos, copy)));
  }
  for (const edge of layout.edges) {
    const source = restored.get(String(edge.source)) || node.graph.getNodeById(edge.source);
    // Older saved layouts can contain edges into shared nodes. Restore only
    // stashed nodes and this video node, never overwrite a live shared input.
    const target = edge.target == null ? node : restored.get(String(edge.target));
    const index = target?.inputs?.findIndex((input) => input.name === edge.input);
    if (source && index >= 0) source.connect(edge.slot, target, index);
  }
}

function imageUpload(node, index, title, saved) {
  const upload = manageInput(node, createNode(node.graph, "LoadImage", [node.pos[0] - 750, node.pos[1] + index * 380], saved));
  upload.title = title;
  return upload;
}

function referenceLimit(node) {
  return node.widgets.find((widget) => widget.name === "protocol")?.value === "minimax" ? 5 : 4;
}

function ensureReferences(node) {
  let batch = sourceOf(node, "images");
  // An existing IMAGE connection can be any user-authored processing chain.
  // Only reconcile our own collector; never replace or migrate that chain.
  if (batch && (batch.comfyClass !== "BenpayReferenceImages" || !isManagedInput(node, batch))) return;
  if (!batch) {
    batch = manageInput(node, createNode(node.graph, "BenpayReferenceImages", [node.pos[0] - 300, node.pos[1] + 80]));
    connectImage(batch, node, "images");
  }
  const limit = referenceLimit(node);
  // Slots beyond the provider limit are not shown or connected.
  for (let index = batch.inputs.length - 1; index >= limit; index--) batch.removeInput(index);
  for (let index = 0; index < limit; index++) {
    const name = `image${index + 1}`;
    if (sourceOf(batch, name)) continue;
    const upload = manageInput(node, createNode(node.graph, "BenpayReferenceImage", [node.pos[0] - 750, node.pos[1] + index * 380]));
    upload.title = `Load Reference Image ${index + 1}`;
    connectImage(upload, batch, name);
  }
}

function ensureInputs(node, mode) {
  if (mode === "reference_images") {
    ensureReferences(node);
    return;
  }
  const first = sourceOf(node, "images");
  if (first?.comfyClass === "LoadImage" && first.properties?.benpayImageInput === true) {
    manageInput(node, first);
  }
  if (!sourceOf(node, "images")) {
    connectImage(imageUpload(node, 0, "Load First Frame"), node, "images");
  }
  if (mode === "first_last_frame" && !sourceOf(node, "last_frame")) {
    connectImage(imageUpload(node, 1, "Load Last Frame"), node, "last_frame");
  }
}

function bindImageInputs(node) {
  if (controllers.has(node)) return;
  const mode = node.widgets?.find((widget) => widget.name === "image_mode");
  if (!mode) return;
  const layoutKey = () => mode.value === "reference_images"
    ? `${mode.value}:${node.widgets.find((widget) => widget.name === "protocol")?.value}`
    : mode.value;
  let activeMode = layoutKey();
  let switching = false;
  function synchronize() {
    if (!node.graph || app.configuringGraph || switching) return;
    switching = true;
    try {
      node.properties ||= {};
      const layouts = node.properties.benpayImageLayouts ||= {};
      let previous;
      const selectedLayout = layoutKey();
      if (activeMode !== selectedLayout) {
        previous = captureLayout(node);
        layouts[activeMode] = previous;
        for (const name of ["images", "last_frame"]) {
          const index = node.inputs.findIndex((input) => input.name === name);
          if (index >= 0) node.disconnectInput(index);
        }
        for (const saved of previous.nodes) {
          const source = node.graph.getNodeById(saved.id);
          if (source) node.graph.remove(source);
        }
        if (layouts[selectedLayout]) restoreLayout(node, layouts[selectedLayout]);
      }
      ensureInputs(node, mode.value);
      activeMode = selectedLayout;
      node.graph.setDirtyCanvas(true, true);
    } finally {
      switching = false;
    }
  }
  const callback = mode.callback;
  mode.callback = function (...args) {
    const result = callback?.apply(this, args);
    synchronize();
    return result;
  };
  const onConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = onConfigure?.apply(this, args);
    activeMode = layoutKey();
    return result;
  };
  const protocol = node.widgets.find((widget) => widget.name === "protocol");
  if (protocol) {
    const onProtocolChanged = protocol.callback;
    protocol.callback = function (...args) {
      const result = onProtocolChanged?.apply(this, args);
      synchronize();
      return result;
    };
  }
  controllers.set(node, synchronize);
}

app.registerExtension({
  name: "BenPay.ImageInputs",
  nodeCreated(node) {
    if (node.comfyClass === "BenpayVideoFromImages") bindImageInputs(node);
  },
  afterConfigureGraph() {
    for (const node of [...app.graph._nodes]) controllers.get(node)?.();
  },
});
