import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const moduleName = "benpay-video";
const templates = [
  {
    name: "text-to-video-t2v",
    title: "BenPay Video: Text to Video",
    tags: ["Text to Video", "Video"],
  },
  {
    name: "image-to-video-i2v",
    title: "BenPay Video: Image to Video",
    tags: ["Image to Video", "Video"],
  },
];
const installed = new WeakSet();

export async function refreshTemplatePreviews(client) {
  // Desktop persists missing-image responses across restarts. Replace those
  // cached 404s before the template picker requests images with force-cache.
  await Promise.allSettled(templates.map(async ({ name }) => {
    const response = await client.fetchApi(
      `/workflow_templates/${moduleName}/${name}.jpg`,
      { cache: "reload", signal: AbortSignal.timeout(8000) },
    );
    if (response.ok) await response.arrayBuffer();
  }));
}

// Custom-node lists expose filenames only. Supply rich entries through the
// template catalog methods, preserving the custom-node module and asset URLs.
export function installTemplateMetadata(client) {
  if (
    installed.has(client) ||
    typeof client.getWorkflowTemplates !== "function" ||
    typeof client.getCoreWorkflowTemplates !== "function"
  ) return;
  installed.add(client);

  let available = [];
  const getWorkflowTemplates = client.getWorkflowTemplates;
  client.getWorkflowTemplates = async function (...args) {
    const catalog = await getWorkflowTemplates.apply(this, args);
    const names = catalog[moduleName];
    if (!Array.isArray(names)) {
      available = [];
      return catalog;
    }
    available = templates.filter((template) => names.includes(template.name));
    const enrichedNames = new Set(available.map((template) => template.name));
    const remaining = names.filter((name) => !enrichedNames.has(name));
    const result = { ...catalog };
    if (remaining.length) result[moduleName] = remaining;
    else delete result[moduleName];
    return result;
  };

  const getCoreWorkflowTemplates = client.getCoreWorkflowTemplates;
  client.getCoreWorkflowTemplates = async function (...args) {
    const catalog = await getCoreWorkflowTemplates.apply(this, args);
    if (!Array.isArray(catalog) || !available.length) return catalog;
    const category = {
      moduleName,
      title: moduleName,
      category: "Extensions",
      type: "video",
      templates: available.map((template) => ({
        ...template,
        tags: [...template.tags],
        description: template.title,
        mediaType: "image",
        mediaSubtype: "jpg",
      })),
    };
    // Localized catalog fallback can re-enter this method; add entries once.
    return [...catalog.filter((entry) => entry.moduleName !== moduleName), category];
  };
}

app.registerExtension({
  name: "BenPay.WorkflowTemplates",
  async setup() {
    installTemplateMetadata(api);
    await refreshTemplatePreviews(api);
  },
});
