import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { bindModelSelection } from "./models.js";
import { bindVideoControls, migrateImageWorkflow } from "./video_controls.js";
import {
  currentLocale,
  loadTranslations,
  onLanguageChange,
  t,
} from "./i18n.js";

const nodeTypes = new Set(["BenpayVideo", "BenpayVideoFromImages"]);
const statusWidgets = new Map();
const configureButtons = new Map();
const regenerateButtons = new Map();
let lastStatus = null;
let statusMessage = "checking";
let activeDialog = null;
let automaticallyPrompted = false;
let promptedWorkflow = null;

function displayStatus(status) {
  lastStatus = status;
  statusMessage = null;
  renderStatus();
}

function renderStatus() {
  for (const [node, widget] of statusWidgets) {
    localizeNodeOptions(node);
    widget.value = statusMessage
      ? t(statusMessage)
      : lastStatus?.configured
        ? t("configured", { suffix: lastStatus.suffix || "" })
        : t("notConfigured");
    const button = configureButtons.get(node);
    if (button) button.name = t("configureKey");
    const regenerate = regenerateButtons.get(node);
    if (regenerate) {
      regenerate.name = t(regenerate.readyForGeneration ? "regenerateReady" : "regenerate");
    }
    node.setDirtyCanvas(true, true);
  }
}

function localizeNodeOptions(node) {
  const seedControl = node.widgets.find((widget) => widget.name === "control_after_generate");
  if (seedControl) seedControl.label = t("controlAfterGenerate");
  const choices = {
    image_mode: {
      prefix: "mode",
      values: [
        "first_frame",
        "first_last_frame",
        "reference_images",
      ],
    },
  };
  for (const [name, { prefix, values }] of Object.entries(choices)) {
    const widget = node.widgets.find((item) => item.name === name);
    if (!widget) continue;
    widget.options.getOptionLabel = (value) =>
      values.includes(value) ? t(`${prefix}_${value}`, {}, value) : value || "";
  }
}

function setText(element, key) {
  element.dataset.benpayText = key;
  element.textContent = t(key);
}

function localizeDialog(dialog) {
  dialog.setAttribute("aria-label", t("dialogTitle"));
  for (const element of dialog.querySelectorAll("[data-benpay-text]")) {
    element.textContent = t(element.dataset.benpayText);
  }
}

async function refreshStatus() {
  const response = await api.fetchApi("/benpay-video/config-status", {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("configuration status unavailable");
  const status = await response.json();
  displayStatus(status);
  return status;
}

function showKeyDialog() {
  if (activeDialog) return activeDialog;
  const pending = openKeyDialog().finally(() => {
    if (activeDialog === pending) activeDialog = null;
  });
  activeDialog = pending;
  return activeDialog;
}

async function promptForMissingKey(startup = false) {
  try {
    const status = await refreshStatus();
    if (status.configured || (startup && automaticallyPrompted)) return;
    if (startup) automaticallyPrompted = true;
    // Do not block ComfyUI startup while waiting for the user to close the dialog.
    showKeyDialog().catch(() => {});
  } catch {
    statusMessage = "statusUnavailable";
    renderStatus();
  }
}

function bypassInputIndex(node, slot, type) {
  const inputs = node.inputs || [];
  if (type === "*" || type === "") return inputs.length > slot ? slot : 0;
  const outputType = node.outputs?.[slot]?.type;
  const compatible = (input) => input && (
    globalThis.LiteGraph?.isValidConnection
      ? LiteGraph.isValidConnection(input.type, outputType) && LiteGraph.isValidConnection(input.type, type)
      : input.type === type
  );
  if (compatible(inputs[slot])) return slot;
  const exact = inputs.findIndex((input) => input.type === type);
  return exact >= 0 ? exact : inputs.findIndex(compatible);
}

function usesBenPayNodes(graph, targets) {
  const nodes = new Map();
  const entriesByNode = new Map();
  function indexGraph(current, parent = null, ancestors = new Set()) {
    if (!current || ancestors.has(current)) return;
    const path = new Set([...ancestors, current]);
    for (const node of current._nodes || current.nodes || []) {
      const id = parent ? `${parent.id}:${node.id}` : String(node.id);
      const entry = { id, node, parent, children: [] };
      nodes.set(id, entry);
      if (!entriesByNode.has(node)) entriesByNode.set(node, entry);
      parent?.children.push(entry);
      if (node.mode !== 2 && node.mode !== 4) indexGraph(node.subgraph, entry, path);
    }
  }
  indexGraph(graph);
  const pending = (targets?.length ? targets.map(String) : [...nodes.keys()])
    .map((id) => ({ entry: nodes.get(id) }));
  const visited = new Set();
  const visitedInputs = new Set();
  function followInput(entry, index) {
    const key = `${entry.id}:input:${index}`;
    if (visitedInputs.has(key)) return;
    visitedInputs.add(key);
    const { node, parent } = entry;
    const input = node.inputs?.[index];
    // SubgraphNode.getInputLink resolves an inner output, not its outer input.
    const link = node.graph
      ? node.graph.getLink?.(input?.link) || node.graph.links?.[input?.link]
      : node.getInputLink?.(index);
    if (!link) return;
    if (parent && link.originIsIoNode) {
      followInput(parent, link.origin_slot);
      return;
    }
    const id = parent ? `${parent.id}:${link.origin_id}` : String(link.origin_id);
    pending.push({ entry: nodes.get(id), slot: link.origin_slot, type: input?.type });
  }
  while (pending.length) {
    const { entry, slot, type } = pending.pop();
    if (!entry) continue;
    const { node } = entry;
    const key = `${entry.id}:output:${slot ?? "all"}`;
    if (visited.has(key) || node.mode === 2) continue;
    visited.add(key);
    if (node.mode === 4) {
      // Bypassed nodes route compatible inputs and never execute themselves.
      if (slot != null) {
        const matching = bypassInputIndex(node, slot, type);
        if (matching >= 0) followInput(entry, matching);
      }
      continue;
    }
    if (nodeTypes.has(node.comfyClass)) return true;
    if (node.subgraph) {
      if (slot == null) {
        pending.push(...entry.children.map((child) => ({ entry: child })));
      } else {
        const resolved = node.resolveSubgraphOutputLink?.(slot);
        if (resolved?.link.originIsIoNode) {
          followInput(entry, resolved.link.origin_slot);
        } else if (resolved?.outputNode) pending.push({
          entry: nodes.get(`${entry.id}:${resolved.outputNode.id}`),
          slot: resolved.link.origin_slot,
          type,
        });
      }
      continue;
    }
    if (node.isVirtualNode && slot != null) {
      const source = node.resolveVirtualOutput?.(slot);
      if (source) {
        pending.push({ entry: entriesByNode.get(source.node), slot: source.slot, type });
        continue;
      }
    }
    for (let index = 0; index < (node.inputs?.length || 0); index++) followInput(entry, index);
  }
  return false;
}

function checkConfigurationBeforeQueueing() {
  const queuePrompt = app.queuePrompt;
  app.queuePrompt = async function (number, batchCount, options = {}, ...args) {
    const targets = Array.isArray(options) ? options : options.queueNodeIds;
    const usesBenPay = usesBenPayNodes(this.rootGraph || this.graph, targets);
    if (usesBenPay && !(await refreshStatus()).configured) {
      const saved = await showKeyDialog();
      // Stop before ComfyUI creates the batch or runs queued widget callbacks.
      if (!saved) return false;
      if (!(await refreshStatus()).configured) throw new Error(t("keyMissing"));
    }
    return queuePrompt.call(this, number, batchCount, options, ...args);
  };
}

function createDialogElements() {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", t("dialogTitle"));
  dialog.dataset.benpayConfiguration = "true";
  Object.assign(dialog.style, {
    width: "min(440px, 85vw)",
    background: "var(--comfy-menu-bg, #252525)",
    color: "var(--fg-color, #eee)",
    border: "1px solid var(--border-color, #666)",
    borderRadius: "8px",
    padding: "24px",
  });
  const title = document.createElement("h3");
  setText(title, "dialogTitle");
  const description = document.createElement("p");
  setText(description, "dialogDescription");
  const form = document.createElement("form");
  form.noValidate = true;
  const label = document.createElement("label");
  const labelText = document.createElement("span");
  setText(labelText, "keyLabel");
  label.append(labelText);
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.required = true;
  input.maxLength = 4096;
  input.style.cssText =
    "display:block;width:100%;box-sizing:border-box;margin:10px 0";
  label.append(input);
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  const cancel = document.createElement("button");
  cancel.type = "button";
  setText(cancel, "cancel");
  const save = document.createElement("button");
  save.type = "submit";
  setText(save, "save");
  save.style.marginLeft = "12px";
  form.append(label, error, cancel, save);
  dialog.append(title, description, form);
  return { dialog, form, input, error, cancel, save };
}

function openKeyDialog() {
  return new Promise((resolve) => {
    const { dialog, form, input, error, cancel, save } = createDialogElements();
    let saving = false;
    let closed = false;
    function closeDialog(saved = false) {
      if (closed) return;
      closed = true;
      input.value = "";
      form.reset();
      dialog.close();
      dialog.remove();
      activeDialog = null;
      resolve(saved);
    }
    cancel.addEventListener("click", () => closeDialog());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!saving) closeDialog();
    });
    dialog.addEventListener("close", () => closeDialog(), { once: true });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving) return;
      if (!input.value.trim()) {
        setText(error, "enterKey");
        return;
      }
      saving = true;
      save.disabled = cancel.disabled = true;
      error.textContent = "";
      delete error.dataset.benpayText;
      try {
        const response = await api.fetchApi("/benpay-video/config", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept-Language": currentLocale(),
          },
          body: JSON.stringify({ apiKey: input.value }),
        });
        const result = await response.json();
        if (!response.ok) {
          setText(error, result.code || "saveFailed");
          return;
        }
        displayStatus(result);
        closeDialog(true);
      } catch {
        setText(error, "saveUnconfirmed");
      } finally {
        saving = false;
        save.disabled = cancel.disabled = false;
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

app.registerExtension({
  name: "BenPay.ConfigurationStatus",
  beforeConfigureGraph(graphData) {
    for (const node of graphData.nodes || []) migrateImageWorkflow(node);
  },
  async setup() {
    await loadTranslations();
    checkConfigurationBeforeQueueing();
    api.addEventListener("executing", ({ detail }) => {
      const id = detail?.display_node ?? detail?.node;
      if (id == null) return;
      for (const [node, button] of regenerateButtons) {
        if (String(node.id) !== String(id) || !button?.readyForGeneration) continue;
        button.readyForGeneration = false;
        button.name = t("regenerate");
        node.setDirtyCanvas(true, true);
      }
    });
    onLanguageChange(() => {
      renderStatus();
      const dialog = document.querySelector(
        "dialog[data-benpay-configuration]",
      );
      if (dialog) localizeDialog(dialog);
    });
    api.addEventListener("execution_error", async ({ detail }) => {
      if (!nodeTypes.has(detail.node_type)) return;
      if (!detail.exception_type?.endsWith(".ConfigurationError")) return;
      if (detail.prompt_id && promptedWorkflow === detail.prompt_id) return;
      promptedWorkflow = detail.prompt_id;
      await promptForMissingKey();
    });
    await promptForMissingKey(true);
  },
  async nodeCreated(node) {
    if (!nodeTypes.has(node.comfyClass)) return;
    regenerateButtons.set(node, bindVideoControls(node));
    // Model discovery must not prevent the credential controls from loading.
    bindModelSelection(node).catch(() => {});
    await loadTranslations();
    const widget = node.addWidget(
      "text",
      t("keyLabel"),
      t("checking"),
      () => {},
      { serialize: false },
    );
    widget.disabled = true;
    widget.serialize = false;
    statusWidgets.set(node, widget);
    const configureButton = node.addWidget("button", t("configureKey"), null, showKeyDialog, {
      serialize: false,
    });
    configureButton.serialize = false;
    configureButtons.set(node, configureButton);
    const onRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
      statusWidgets.delete(node);
      configureButtons.delete(node);
      regenerateButtons.delete(node);
      return onRemoved?.apply(this, args);
    };
    try {
      await refreshStatus();
    } catch {
      statusMessage = "statusUnavailable";
      renderStatus();
    }
  },
});
