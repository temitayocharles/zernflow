// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { checkSession, STATE_OUTCOME } from "./policy";
import { browserAdapter, browserPlatforms, resolveExecutor } from "./registry";
import { capabilityOf, type BrowserAdapter } from "./contract";
import { FakeSurface, strictSurface } from "./fake-surface";
import { isAllowedNavigation, isBlockedRequest } from "./network";
import { parseStorageState, StorageStateError } from "./storage-state";
import { availableModes } from "@/lib/publishing/capabilities";

/** Signed-in app shells: minimal HTML carrying each adapter's markers. */
const SIGNED_IN_HTML: Record<string, string> = {
  instagram: '<nav><a href="/direct/inbox/">Messages</a><a href="/accounts/edit/">Edit</a></nav>',
  facebook: '<div role="banner"><div role="navigation"></div></div>',
  tiktok: '<header><div data-e2e="profile-icon"></div></header>',
  linkedin: '<header id="global-nav"><a href="/mynetwork/">Network</a></header>',
  twitter: '<nav><a data-testid="AppTabBar_Home_Link" href="/home">Home</a></nav>',
};
const LOGIN_HTML = '<form><input name="username"><input type="password" name="password"></form>';
const CAPTCHA_HTML = '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>';
const OTP_HTML = '<form><input autocomplete="one-time-code"></form>';

function origin(a: BrowserAdapter) {
  return new URL(a.signals.checkUrl).origin;
}
function authCookies(a: BrowserAdapter) {
  return a.signals.authCookies.map((name) => ({ name, domain: `.${a.signals.cookieDomain}` }));
}

describe("adapter contract (fixtures)", () => {
  for (const { platform } of browserPlatforms()) {
    const a = browserAdapter(platform)!;
    describe(a.label, () => {
      it("declares session_check as experimental and never claims publishing", () => {
        expect(capabilityOf(a, "session_check").level).toBe("experimental");
        expect(capabilityOf(a, "publish_post").level).toBe("unsupported");
        expect(a.allowedHosts.length).toBeGreaterThan(0);
        expect(isAllowedNavigation(a.signals.checkUrl, a.allowedHosts)).toBe(true);
        for (const sel of a.signals.signedInMarkers) expect(() => new FakeSurface({}).count(sel)).not.toThrow();
      });

      it("classifies a signed-in page as healthy without interacting", async () => {
        const f = new FakeSurface({ [a.signals.checkUrl]: { html: SIGNED_IN_HTML[platform] } }, authCookies(a));
        const r = await checkSession(a, strictSurface(f));
        expect(r.state).toBe("healthy");
        expect(f.screenshots).toEqual([]);
        expect(f.calls.filter((c) => c.startsWith("navigate:"))).toEqual([`navigate:${a.signals.checkUrl}`]);
      });

      it("detects the sign-in redirect", async () => {
        const f = new FakeSurface({ [a.signals.checkUrl]: { finalUrl: `${origin(a)}${a.signals.loginPaths[0]}?next=x`, html: LOGIN_HTML } });
        expect((await checkSession(a, strictSurface(f))).state).toBe("human_login_required");
        expect(f.screenshots).toEqual(["session-human_login_required"]);
      });

      it("reports expired when the cookie survives but the platform wants a login", async () => {
        const f = new FakeSurface({ [a.signals.checkUrl]: { html: LOGIN_HTML } }, authCookies(a));
        expect((await checkSession(a, strictSurface(f))).state).toBe("expired");
      });

      it("stops at checkpoints and CAPTCHAs (never automated)", async () => {
        const byPath = new FakeSurface({ [a.signals.checkUrl]: { finalUrl: `${origin(a)}${a.signals.challengePaths[0]}`, html: "<p>Confirm it is you</p>" } }, authCookies(a));
        expect((await checkSession(a, strictSurface(byPath))).state).toBe("challenge_required");
        const byFrame = new FakeSurface({ [a.signals.checkUrl]: { html: SIGNED_IN_HTML[platform] + CAPTCHA_HTML } }, authCookies(a));
        expect((await checkSession(a, strictSurface(byFrame))).state).toBe("challenge_required");
      });

      it("stops at second-factor prompts", async () => {
        const byPath = new FakeSurface({ [a.signals.checkUrl]: { finalUrl: `${origin(a)}${a.signals.mfaPaths[0]}`, html: "<p>Code</p>" } });
        expect((await checkSession(a, strictSurface(byPath))).state).toBe("mfa_required");
        const byInput = new FakeSurface({ [a.signals.checkUrl]: { html: OTP_HTML } }, authCookies(a));
        expect((await checkSession(a, strictSurface(byInput))).state).toBe("mfa_required");
      });

      it("is degraded, not healthy, when the signed-in shell is unrecognised", async () => {
        const f = new FakeSurface({ [a.signals.checkUrl]: { html: "<main>new layout</main>" } }, authCookies(a));
        expect((await checkSession(a, strictSurface(f))).state).toBe("degraded");
      });
    });
  }
});

describe("no-bypass policy", () => {
  it("maps every human state to a non-retrying error class", () => {
    for (const s of ["human_login_required", "expired", "mfa_required", "challenge_required"] as const) {
      expect(STATE_OUTCOME[s]).toMatchObject({ ok: false, human: true });
      expect(["reauth_required", "human_challenge", "auth_expired"]).toContain(STATE_OUTCOME[s].errorClass);
    }
  });

  it("the strict surface rejects interaction attempts", () => {
    const s = strictSurface(new FakeSurface({})) as unknown as Record<string, unknown>;
    expect(() => s.click).toThrow(/forbidden/);
    expect(() => s.fill).toThrow(/forbidden/);
    expect(() => s.evaluate).toThrow(/forbidden/);
  });
});

describe("executor resolution", () => {
  it("prefers API, then Gateway, then browser only when verified or opted in", () => {
    expect(resolveExecutor({ platform: "instagram", operation: "session_check", apiAvailable: true, gatewayAvailable: true }).executor).toBe("api");
    expect(resolveExecutor({ platform: "instagram", operation: "session_check", apiAvailable: false, gatewayAvailable: true }).executor).toBe("gateway");
    const off = resolveExecutor({ platform: "instagram", operation: "session_check", apiAvailable: false, gatewayAvailable: false });
    expect(off.executor).toBeNull();
    expect(off.skipped.at(-1)?.reason).toMatch(/experimental/);
    expect(resolveExecutor({ platform: "instagram", operation: "session_check", apiAvailable: false, gatewayAvailable: false, allowExperimental: true })).toMatchObject({ executor: "browser", level: "experimental" });
    expect(resolveExecutor({ platform: "instagram", operation: "publish_post", apiAvailable: false, gatewayAvailable: false, allowExperimental: true }).executor).toBeNull();
    expect(resolveExecutor({ platform: "myspace", operation: "session_check", apiAvailable: false, gatewayAvailable: false, allowExperimental: true }).executor).toBeNull();
  });

  it("publishing never offers browser mode for experimental adapters", () => {
    for (const p of ["instagram", "facebook", "tiktok", "linkedin", "twitter"]) {
      expect(availableModes(p, "post").find((m) => m.mode === "browser")?.available).toBe(false);
    }
  });
});

describe("network guard", () => {
  it("blocks private, loopback, metadata and non-web targets", () => {
    for (const u of ["http://localhost:3000", "http://127.0.0.1", "http://10.0.0.5", "http://172.20.1.1", "http://192.168.1.1", "http://169.254.169.254/latest", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/", "http://[::127.0.0.1]/", "http://2130706433/", "http://0x7f.1/", "file:///etc/passwd", "ftp://x.com", "http://svc.internal", "http://100.64.0.1", "not a url"]) {
      expect(isBlockedRequest(u), u).toBe(true);
    }
    for (const u of ["https://www.instagram.com/", "https://scontent.cdninstagram.com/x.jpg", "data:image/png;base64,AA", "http://8.8.8.8"]) expect(isBlockedRequest(u), u).toBe(false);
  });

  it("restricts top-level navigation to the adapter's hosts over https", () => {
    expect(isAllowedNavigation("https://www.instagram.com/x", ["instagram.com"])).toBe(true);
    expect(isAllowedNavigation("https://instagram.com.evil.io/", ["instagram.com"])).toBe(false);
    expect(isAllowedNavigation("http://www.instagram.com/", ["instagram.com"])).toBe(false);
    expect(isAllowedNavigation("https://evilinstagram.com/", ["instagram.com"])).toBe(false);
  });
});

describe("storage state import", () => {
  const ig = browserAdapter("instagram")!;
  const state = (cookies: unknown[], origins: unknown[] = []) => JSON.stringify({ cookies, origins });
  it("normalizes a valid export and summarises without values", () => {
    const { summary, normalized } = parseStorageState(
      state([{ name: "sessionid", value: "s3cr3t", domain: ".instagram.com", expires: 1893456000, httpOnly: true, secure: true, sameSite: "None" }, { name: "csrftoken", value: "x", domain: ".instagram.com" }], [{ origin: "https://www.instagram.com", localStorage: [{ name: "k", value: "v" }] }]),
      ig,
    );
    expect(summary).toEqual({ cookieCount: 2, originCount: 1, authCookiesPresent: true, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(JSON.stringify(summary)).not.toContain("s3cr3t");
    expect(JSON.parse(normalized).cookies[1]).toMatchObject({ path: "/", sameSite: "Lax", secure: true, expires: -1 });
  });
  it("rejects foreign domains, bad shapes and oversized files", () => {
    expect(() => parseStorageState(state([{ name: "sid", value: "x", domain: ".google.com" }]), ig)).toThrow(/does not belong/);
    expect(() => parseStorageState(state([{ name: "sid", value: "x", domain: "instagram.com.evil.io" }]), ig)).toThrow(StorageStateError);
    expect(() => parseStorageState(state([], [{ origin: "http://www.instagram.com" }]), ig)).toThrow(/https/);
    expect(() => parseStorageState("[]", ig)).toThrow(/object/);
    expect(() => parseStorageState("{", ig)).toThrow(/JSON/);
    expect(() => parseStorageState(state([{ name: "a", value: "x".repeat(70_000), domain: ".instagram.com" }]), ig)).toThrow(/larger/);
    expect(parseStorageState(state([{ name: "csrftoken", value: "x", domain: ".instagram.com" }]), ig).summary.authCookiesPresent).toBe(false);
  });
});
