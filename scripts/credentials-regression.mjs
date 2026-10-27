import assert from "node:assert/strict";
import console from "node:console";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

// Bundle the real credentials module. Prefs and the login manager are
// synthetic in-memory stand-ins; no profile is read or written.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tests = [];
const test = (name, run) => tests.push([name, run]);

const compiled = await build({
  stdin: {
    contents: 'export * from "./src/utils/credentials";',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
});

function fixture(options = {}) {
  const prefs = new Map(Object.entries(options.prefs || {}));
  const logins = [];
  const calls = { add: 0, modify: 0, remove: 0 };
  class LoginInfo {
    constructor(origin, action, realm, username, password) {
      Object.assign(this, { origin, action, realm, username, password });
    }
  }
  const context = vm.createContext({
    module: { exports: {} },
    console,
    ztoolkit: { log: () => {} },
    Zotero: {
      Prefs: {
        get: (key) => prefs.get(key),
        set: (key, value) => prefs.set(key, value),
      },
    },
    Components: {
      interfaces: { nsILoginInfo: {} },
      Constructor: () => LoginInfo,
    },
    Services: {
      logins: {
        findLogins(origin, action, realm) {
          if (options.broken) throw new Error("login store unavailable");
          return logins.filter(
            (login) => login.origin === origin && login.realm === realm,
          );
        },
        async addLoginAsync(login) {
          if (options.failWrite) throw new Error("write refused");
          calls.add++;
          logins.push(login);
        },
        modifyLogin(old, login) {
          calls.modify++;
          logins.splice(logins.indexOf(old), 1, login);
        },
        removeLogin(login) {
          calls.remove++;
          logins.splice(logins.indexOf(login), 1);
        },
      },
    },
  });
  vm.runInContext(
    `(function () {\n${compiled.outputFiles[0].text}\n})();`,
    context,
  );
  return { ...context.module.exports, prefs, logins, calls };
}

const PREF = "extensions.zotero.refs.CNKI.password";

test("password round-trips through the login manager, never prefs", async () => {
  const f = fixture();
  assert.equal(f.getCNKIPassword(), "");
  assert.equal(await f.setCNKIPassword("first"), true);
  assert.equal(await f.setCNKIPassword("second"), true);
  assert.equal(f.getCNKIPassword(), "second");
  assert.equal(f.logins.length, 1);
  assert.deepEqual(f.calls, { add: 1, modify: 1, remove: 0 });
  assert.equal(f.prefs.has(PREF), false);
  assert.equal(await f.setCNKIPassword(""), true);
  assert.equal(f.getCNKIPassword(), "");
  assert.equal(f.logins.length, 0);
});

test("a legacy plaintext pref moves into the login manager and is cleared", async () => {
  const f = fixture({ prefs: { [PREF]: " legacy-secret " } });
  await f.migrateCNKIPassword();
  assert.equal(f.getCNKIPassword(), "legacy-secret");
  assert.equal(f.prefs.get(PREF), "");
});

test("a failed migration keeps the legacy pref so the password is not lost", async () => {
  const f = fixture({ prefs: { [PREF]: "legacy-secret" }, failWrite: true });
  await f.migrateCNKIPassword();
  assert.equal(f.prefs.get(PREF), "legacy-secret");
});

test("an unusable login store reads as no password instead of throwing", async () => {
  const f = fixture({ broken: true });
  assert.equal(f.getCNKIPassword(), "");
  assert.equal(await f.setCNKIPassword("x"), false);
});

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`, error);
  }
}
console.log(
  `${tests.length - failed}/${tests.length} credentials regressions passed`,
);
process.exitCode = failed ? 1 : 0;
