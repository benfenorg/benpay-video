import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../web/workflow_templates.js", import.meta.url), "utf8");
const isolated = source
  .replace('import { app } from "../../scripts/app.js";', "const app = { registerExtension() {} };")
  .replace('import { api } from "../../scripts/api.js";', "const api = {};");
const { installTemplateMetadata, refreshTemplatePreviews } = await import(
  `data:text/javascript;base64,${Buffer.from(isolated).toString("base64")}`
);

test("startup refreshes only BenPay covers and tolerates failed downloads", async () => {
  const calls = [];
  let consumed = false;
  await refreshTemplatePreviews({
    async fetchApi(path, options) {
      calls.push({ path, options });
      if (path.includes("image-to-video")) throw new Error("offline");
      return { ok: true, async arrayBuffer() { consumed = true; } };
    },
  });
  assert.equal(calls.length, 2);
  for (const { path, options } of calls) {
    assert.match(path, /^\/workflow_templates\/benpay-video\/(text-to-video-t2v|image-to-video-i2v)\.jpg$/);
    assert.equal(options.cache, "reload");
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(consumed, true);
});

test("template catalog adds titles and Video tags without duplicate workflows", async () => {
  const original = {
    "benpay-video": ["image-to-video-i2v", "text-to-video-t2v", "future-template"],
    other: ["other-template"],
  };
  const core = [{ moduleName: "default", templates: [{ name: "core-template" }] }];
  const client = {
    async getWorkflowTemplates() { return original; },
    async getCoreWorkflowTemplates() { return core; },
  };
  installTemplateMetadata(client);
  installTemplateMetadata(client);
  const custom = await client.getWorkflowTemplates();
  assert.deepEqual(custom, { "benpay-video": ["future-template"], other: ["other-template"] });
  assert.equal(original["benpay-video"].length, 3);
  const catalog = await client.getCoreWorkflowTemplates("en");
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0], core[0]);
  const category = catalog[1];
  assert.equal(category.moduleName, "benpay-video");
  assert.deepEqual(category.templates.map((entry) => [entry.title, entry.tags]), [
    ["BenPay Video: Text to Video", ["Text to Video", "Video"]],
    ["BenPay Video: Image to Video", ["Image to Video", "Video"]],
  ]);
  for (const template of category.templates) {
    const base = new URL("../example_workflows/", import.meta.url);
    assert.ok((await readFile(new URL(template.name + ".json", base))).length);
    assert.ok((await readFile(new URL(template.name + ".jpg", base))).length);
  }
  assert.equal((await client.getCoreWorkflowTemplates("zh")).length, 2);
});

test("missing plugin templates and older clients remain unchanged", async () => {
  const catalog = { other: ["example"] };
  const client = {
    async getWorkflowTemplates() { return catalog; },
    async getCoreWorkflowTemplates() { return []; },
  };
  installTemplateMetadata(client);
  assert.equal(await client.getWorkflowTemplates(), catalog);
  assert.deepEqual(await client.getCoreWorkflowTemplates(), []);
  const older = { getWorkflowTemplates() {} };
  const original = older.getWorkflowTemplates;
  installTemplateMetadata(older);
  assert.equal(older.getWorkflowTemplates, original);
});
