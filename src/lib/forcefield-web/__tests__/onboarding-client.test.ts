/** @jest-environment node */
/**
 * The WordPress admin link the signup page renders from the site the person
 * typed: always https, only a plain hostname (and port) ever reaches it, and
 * anything else falls back to the plugin download (never a script URL).
 */
import { wordpressInstallUrl, WORDPRESS_PLUGIN_DOWNLOAD } from "@/lib/forcefield-web/onboarding-client";

describe("wordpressInstallUrl", () => {
  it("links to the site's own wp-admin over https", () => {
    expect(wordpressInstallUrl("acme.com")).toBe("https://acme.com/wp-admin/plugin-install.php?tab=upload");
    expect(wordpressInstallUrl("https://www.acme.com/blog")).toBe("https://www.acme.com/wp-admin/plugin-install.php?tab=upload");
    expect(wordpressInstallUrl("wp.localtest.me:8080")).toBe("https://wp.localtest.me:8080/wp-admin/plugin-install.php?tab=upload");
  });

  it("anything that is not a plain hostname falls back to the download", () => {
    for (const bad of ["javascript:alert(1)", "acme.com\"><script>", "", "localhost", "a b.com", "evil.com@acme.com", "-x.com"]) {
      expect(wordpressInstallUrl(bad)).toBe(WORDPRESS_PLUGIN_DOWNLOAD);
    }
  });
});
