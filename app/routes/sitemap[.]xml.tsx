/**
 * XML sitemap for the crawlable marketing surface. Generated from the static
 * case-study list so it stays in sync as verticals are added. The authed app
 * (dashboard, repos, connect, …) is intentionally excluded — see robots.txt.
 * Marketing-host-only when MARKETING_HOST is set (D11); SITE_URL follows it.
 */
import type { LoaderFunctionArgs } from "react-router";

import { SITE_URL } from "~/lib/seo";
import { caseStudies } from "~/lib/case-studies";
import { marketingHostRedirect } from "~/lib/marketing-host.server";

export function loader({ request }: LoaderFunctionArgs) {
  const away = marketingHostRedirect(request);
  if (away) return away;
  const paths: { loc: string; priority: string; changefreq: string }[] = [
    { loc: "/", priority: "1.0", changefreq: "weekly" },
    { loc: "/case-studies", priority: "0.8", changefreq: "monthly" },
    ...caseStudies.map((s) => ({
      loc: `/case-studies/${s.slug}`,
      priority: "0.6",
      changefreq: "monthly",
    })),
  ];

  const urls = paths
    .map(
      ({ loc, priority, changefreq }) =>
        `  <url><loc>${SITE_URL}${loc}</loc><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`,
    )
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
