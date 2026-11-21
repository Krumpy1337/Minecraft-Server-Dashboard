const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createContext, runInContext } = require("node:vm");
const test = require("node:test");

function dashboard() {
  const context = createContext({
    console, structuredClone, AbortSignal,
    localStorage: { getItem() { return null; } },
    window: { location: { protocol: "file:" } },
    document: { getElementById() { return { addEventListener() {} }; }, addEventListener() {} },
  });
  runInContext(readFileSync(require.resolve("../source/app.js"), "utf8"), context);
  runInContext(`currentUser={id:"owner",demo:false};
    hostedServers=[{id:"fixture",name:"Fixture",address:"fixture.example.invalid",vcpus:4,ramMb:4096,diskGb:32}];
    hostedServersLoaded=true;`, context);
  let modal;
  const requests = [];
  context.openModal = options => { modal = options; };
  context.closeModal = context.setPage = context.showToast = () => {};
  context.loadHostedServers = async () => {};
  context.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, async json() { return { status: "queued" }; } };
  };
  context.deleteHostedServerModal("fixture");
  return { context, requests, modal };
}
test("live deletion dialog is globally callable and submits only an exact, same-account confirmation", async () => {
  const { context, requests, modal } = dashboard();
  assert.ok(modal.content.includes("No backup is created."));
  await assert.rejects(modal.onSubmit(new Map([["confirmAddress", "wrong"]])), /full server address/);
  assert.equal(requests.length, 0);
  await modal.onSubmit(new Map([["confirmAddress", "fixture.example.invalid"]]));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/hosting/servers/fixture");
  assert.equal(requests[0].options.method, "DELETE");
  assert.equal(requests[0].options.headers["X-Blockhost-Request"], "delete");
  assert.equal(JSON.parse(requests[0].options.body).confirmAddress, "fixture.example.invalid");
  runInContext('currentUser={id:"another-account",demo:false};', context);
  await assert.rejects(modal.onSubmit(new Map([["confirmAddress", "fixture.example.invalid"]])), /sign-in changed/);
  assert.equal(requests.length, 1);
});
test("deleting cards hide management actions and failed cleanup exposes retry", () => {
  const { context } = dashboard();
  runInContext('hostedServers[0].deletionStatus="queued";', context);
  const deleting = context.renderHostedServers();
  assert.ok(deleting.includes("Management access revoked."));
  for (const action of ["hosted-files", "hosted-settings", "hosted-console"]) assert.ok(!deleting.includes(`data-action="${action}"`));
  assert.ok(deleting.includes('data-action="hosted-delete" data-id="fixture" disabled'));
  runInContext('hostedServers[0].deletionStatus="failed";', context);
  assert.ok(context.renderHostedServers().includes("Retry deletion"));
});
