/**
 * The console map — the rail, the System Map page, and the one fact they share.
 *
 * `src/lib/console.ts` is the single declaration of "which screens exist", and
 * both the navigation (`DashboardShell`) and `/dashboard/estate` are rendered
 * from it. That is the whole reason it is one module, and it is exactly the
 * property that a registry loses by accident: someone adds a surface with no
 * icon, or an `href` that is not a route, or a proxy target that only this host
 * can reach, and nothing fails until an operator clicks it.
 *
 * Three of those are silent in review and all three are asserted here:
 *
 *   1. **A proxied surface must be browsable.** Its URL is opened by the
 *      operator's browser, not by this server, so a loopback address is a dead
 *      link even though it is a perfectly valid target for `lib/dograh.ts`. The
 *      whole point of separating the two is that they are different addresses.
 *   2. **An owned surface must be a route under /dashboard.** A registry entry
 *      that navigates somewhere else is how the rail comes to disagree with the
 *      router.
 *   3. **An owned surface must be reachable for somebody.** A surface gated on
 *      an add-on that also demands admin, or an id that no icon map entry and no
 *      page exists for, is a link that 404s rather than one that hides.
 *
 * The env vars the proxied targets read are set here explicitly, so the test
 * says what it is testing rather than inheriting whatever the host has.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

/** Set before the module is loaded: `CONSOLE_SURFACES` is built at import. */
process.env.FREEPBX_ADMIN_URL = "https://pbx.example.test";
process.env.CAPSTONE_DASHBOARD_URL = "https://dashboard.example.test";
process.env.WORKFLOW_STUDIO_URL = "https://workflow.example.test";
process.env.DOGRAH_UI_URL = "https://dograh.example.test";
process.env.NEXT_PUBLIC_AVANTFAX_URL = "https://pbx.example.test/fax";

let surfaces;
let products;
let groups;
let proxiedUrl;
let proxiedHost;
let groupedSurfaces;

before(async () => {
  const dir = transpile(["src/lib/console.ts"]);
  ({ CONSOLE_SURFACES: surfaces, CONSOLE_PRODUCTS: products, CONSOLE_GROUPS: groups, proxiedUrl, proxiedHost, groupedSurfaces } =
    await load(dir, "console"));
});

describe("the console map", () => {
  it("gives every surface a unique id", () => {
    // The id keys the icon map and React's list, so a duplicate silently drops
    // one of the two entries from the rail.
    const ids = surfaces.map((surface) => surface.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate surface id in ${ids.join(", ")}`);
  });

  it("names a real product for every surface", () => {
    const known = new Set(products.map((product) => product.id));
    for (const surface of surfaces) {
      assert.ok(known.has(surface.product), `${surface.id} names unknown product ${surface.product}`);
    }
  });

  it("groups every surface under a declared group", () => {
    const known = new Set(groups.map((group) => group.id));
    for (const surface of surfaces) {
      assert.ok(known.has(surface.group), `${surface.id} is in unknown group ${surface.group}`);
    }
  });

  it("answers a question for every surface", () => {
    // `answers` is what the System Map shows and what the rail's tooltip says.
    // A blank one is a screen nobody can place.
    for (const surface of surfaces) {
      assert.ok(
        surface.answers && surface.answers.trim().length > 10,
        `${surface.id} has no meaningful "answers" line`,
      );
    }
  });
});

describe("owned surfaces", () => {
  const owned = () => surfaces.filter((surface) => surface.kind === "owned");

  it("navigate to a route under /dashboard", () => {
    for (const surface of owned()) {
      assert.match(
        surface.href ?? "",
        /^\/dashboard(\/|$)/,
        `${surface.id} must point at a dashboard route, not ${surface.href}`,
      );
    }
  });

  it("do not carry a proxy target", () => {
    // Both fields set is the shape a half-converted entry has: it navigates in
    // the shell *and* claims an external host in the System Map.
    for (const surface of owned()) {
      assert.equal(surface.baseEnv, undefined, `${surface.id} is owned but names baseEnv`);
      assert.equal(surface.baseDefault, undefined, `${surface.id} is owned but names baseDefault`);
    }
  });
});

describe("proxied surfaces", () => {
  const proxied = () => surfaces.filter((surface) => surface.kind === "proxied");

  it("resolve to a browsable host, never this host's loopback", () => {
    for (const surface of proxied()) {
      const url = proxiedUrl(surface);
      assert.ok(url, `${surface.id} has no URL — its base env is unset and it has no default`);
      const host = new URL(url).hostname;
      assert.ok(
        host !== "127.0.0.1" && host !== "localhost" && host !== "::1",
        `${surface.id} points at loopback (${url}); a browser cannot open that`,
      );
    }
  });

  it("do not navigate inside the shell", () => {
    for (const surface of proxied()) {
      assert.equal(surface.href, undefined, `${surface.id} is proxied but carries an internal href`);
    }
  });

  it("report the host the operator will land on", () => {
    const surface = proxied().find((entry) => entry.id === "pbx-admin");
    assert.equal(proxiedHost(surface), "pbx.example.test");
  });

  it("append their path to the base exactly once", () => {
    // `path` is the difference between FreePBX's admin UI and its front door,
    // and a double slash is a 404 on some of these appliances.
    const surface = proxied().find((entry) => entry.id === "pbx-admin");
    assert.equal(proxiedUrl(surface), "https://pbx.example.test/admin");
  });
});

describe("the rail", () => {
  it("hides an add-on surface when the add-on is not enabled", () => {
    const shown = groupedSurfaces({ isAdmin: true, addons: {} }).flatMap((g) => g.surfaces);
    assert.ok(
      !shown.some((surface) => surface.addon),
      "an add-on surface was shown without its add-on",
    );
  });

  it("shows an add-on surface once the add-on is enabled", () => {
    const shown = groupedSurfaces({
      isAdmin: false,
      addons: { agents: "enabled", capstone: "enabled" },
    }).flatMap((g) => g.surfaces);
    assert.ok(shown.some((surface) => surface.id === "voice"));
    assert.ok(shown.some((surface) => surface.id === "interviews"));
  });

  it("keeps staff screens out of a customer's rail, and in an admin's", () => {
    const customer = groupedSurfaces({ isAdmin: false, addons: {} }).flatMap((g) => g.surfaces);
    const admin = groupedSurfaces({ isAdmin: true, addons: {} }).flatMap((g) => g.surfaces);
    assert.ok(!customer.some((surface) => surface.id === "admin"));
    assert.ok(admin.some((surface) => surface.id === "admin"));
  });

  it("leaves no empty group behind", () => {
    // A heading with nothing under it is the visual version of a dead link.
    for (const group of groupedSurfaces({ isAdmin: false, addons: {} })) {
      assert.ok(group.surfaces.length > 0, `group ${group.id} rendered empty`);
    }
  });

  it("orders groups the way the map declares them", () => {
    const order = groupedSurfaces({ isAdmin: true, addons: {} }).map((group) => group.id);
    const declared = groups.map((group) => group.id).filter((id) => order.includes(id));
    assert.deepEqual(order, declared);
  });
});
