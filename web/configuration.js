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

function usesBenPayNodes(output, targets) {
  const pending = targets?.length ? [...targets] : Object.keys(output);
  const visited = new Set();
  while (pending.length) {
    const id = String(pending.pop());
    if (visited.has(id)) continue;
    visited.add(id);
    const node = output[id];
    if (!node) continue;
    if (nodeTypes.has(node.class_type)) return true;
    for (const input of Object.values(node.inputs || {})) {
      if (
        Array.isArray(input) && input.length === 2 &&
        typeof input[0] === "string" && Number.isInteger(input[1]) && output[input[0]]
      ) pending.push(input[0]);
    }
  }
  return false;
}

function checkConfigurationBeforeQueueing() {
  const queuePrompt = api.queuePrompt;
  api.queuePrompt = async function (number, prompt, ...args) {
    const usesBenPay = usesBenPayNodes(prompt.output || {}, args[0]?.partialExecutionTargets);
    if (usesBenPay && !(await refreshStatus()).configured) {
      await showKeyDialog();
      if (!(await refreshStatus()).configured) throw new Error(t("keyMissing"));
    }
    return queuePrompt.call(this, number, prompt, ...args);
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
    function closeDialog() {
      if (closed) return;
      closed = true;
      input.value = "";
      form.reset();
      dialog.close();
      dialog.remove();
      activeDialog = null;
      resolve();
    }
    cancel.addEventListener("click", closeDialog);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!saving) closeDialog();
    });
    dialog.addEventListener("close", closeDialog, { once: true });
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
        closeDialog();
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
