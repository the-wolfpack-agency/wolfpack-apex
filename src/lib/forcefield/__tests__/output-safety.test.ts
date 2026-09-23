/** @jest-environment node */
import { scanModelOutput } from "../output-safety";

describe("scanModelOutput (LLM02 insecure output handling)", () => {
  it("flags active/executable content in model prose", () => {
    expect(scanModelOutput('Here you go: <script>steal()</script>').map((r) => r.kind)).toContain("script_tag");
    expect(scanModelOutput('<iframe src=evil></iframe>').map((r) => r.kind)).toContain("iframe_embed");
    expect(scanModelOutput('Click <a href="javascript:doEvil()">here</a>').map((r) => r.kind)).toContain("js_uri");
    expect(scanModelOutput('<img src=x onerror=alert(1)>').map((r) => r.kind)).toContain("event_handler");
    expect(scanModelOutput('open data:text/html,<script>x</script>').map((r) => r.kind)).toContain("data_html");
  });

  it("does NOT flag a code EXAMPLE inside fenced or inline code", () => {
    expect(scanModelOutput("To add a script tag, write:\n```html\n<script src=app.js></script>\n```")).toEqual([]);
    expect(scanModelOutput("The `<script>` tag loads JavaScript.")).toEqual([]);
  });

  it("returns nothing for safe plain output", () => {
    expect(scanModelOutput("Your three tasks are due Friday. Want me to reschedule?")).toEqual([]);
    expect(scanModelOutput("")).toEqual([]);
  });
});
