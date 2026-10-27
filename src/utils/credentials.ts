import { config } from "../../package.json";
import { getPref, setPref } from "./prefs";

/**
 * The 知网研学 password lives in Zotero's login manager (logins.json, encrypted;
 * protected by the primary password when set), never in prefs.js. The username stays a
 * plain pref; it is not a secret and the token cache keys off it.
 */
const LOGIN_ORIGIN = `chrome://${config.addonRef}`;
const LOGIN_REALM = "CNKI";

function findLogin(): any {
  // Zotero passes null for the form action of an httpRealm login.
  return Services.logins.findLogins(LOGIN_ORIGIN, null as any, LOGIN_REALM)[0];
}

export function getCNKIPassword(): string {
  try {
    return findLogin()?.password || "";
  } catch (e) {
    ztoolkit.log("[credentials] login manager unavailable", e);
    return "";
  }
}

/** Store (or, when empty, remove) the password. Resolves false on failure. */
export async function setCNKIPassword(password: string): Promise<boolean> {
  try {
    // An unreadable store must not gain a duplicate entry: abort the save.
    const existing = findLogin();
    if (!password) {
      if (existing) Services.logins.removeLogin(existing);
      return true;
    }
    const LoginInfo = Components.Constructor(
      "@mozilla.org/login-manager/loginInfo;1",
      Components.interfaces.nsILoginInfo,
      "init",
    ) as any;
    const login = new LoginInfo(
      LOGIN_ORIGIN,
      null,
      LOGIN_REALM,
      "CNKI",
      password,
      "",
      "",
    );
    if (existing) Services.logins.modifyLogin(existing, login);
    else await Services.logins.addLoginAsync(login);
    return true;
  } catch (e) {
    ztoolkit.log("[credentials] storing the CNKI password failed", e);
    return false;
  }
}

/** Move a password saved by an earlier version out of prefs.js. */
export async function migrateCNKIPassword(): Promise<void> {
  const legacy = ((getPref("CNKI.password") as string) || "").trim();
  if (!legacy) return;
  // Keep the pref until the login manager holds the value: never lose it.
  if (await setCNKIPassword(legacy)) setPref("CNKI.password", "");
}
