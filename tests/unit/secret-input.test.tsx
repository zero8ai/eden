import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SecretInput } from "~/components/ui/secret-input";

// React SSR emits `<!-- -->` markers between adjacent segments; strip them so
// substring assertions see contiguous text.
function render(node: React.ReactNode) {
  return renderToString(node).replace(/<!-- -->/g, "");
}

describe("SecretInput", () => {
  it("renders a masked password field that defeats the login-form heuristic", () => {
    const html = render(
      <SecretInput defaultValue="x" placeholder="value (write-only)" />,
    );
    expect(html).toContain('type="password"');
    // The rendered attribute name varies by casing across renderers; match either.
    const lower = html.toLowerCase();
    expect(lower).toContain('autocomplete="new-password"');
    expect(lower).not.toContain('autocomplete="off"');
  });

  it("opts out of every password manager", () => {
    const html = render(<SecretInput defaultValue="x" />);
    expect(html).toContain('data-1p-ignore="true"');
    expect(html).toContain('data-lpignore="true"');
    expect(html).toContain("data-bwignore");
    expect(html).toContain('data-form-type="other"');
  });

  it("renders the reveal toggle with a default aria-label", () => {
    const html = render(<SecretInput defaultValue="x" />);
    expect(html).toContain('aria-label="Show value"');
  });

  it("honors revealLabel in the toggle aria-label", () => {
    const html = render(<SecretInput defaultValue="x" revealLabel="API key" />);
    expect(html).toContain('aria-label="Show API key"');
  });

  it("renders no toggle button when showToggle is false", () => {
    const html = render(<SecretInput defaultValue="x" showToggle={false} />);
    expect(html).not.toContain("aria-label=\"Show");
    expect(html).not.toContain("<button");
  });

  it("forwards arbitrary props like name and placeholder", () => {
    const html = render(
      <SecretInput name="secret:FOO" placeholder="value (write-only)" defaultValue="x" />,
    );
    expect(html).toContain('name="secret:FOO"');
    expect(html).toContain('placeholder="value (write-only)"');
  });
});
