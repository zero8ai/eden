import { redirect, type LoaderFunctionArgs } from "react-router";
import { getSignInUrl } from "@workos-inc/authkit-react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const { url: authUrl, headers } = await getSignInUrl(
    url.searchParams.get("returnTo") ?? undefined,
    request
  );
  return redirect(authUrl, { headers });
}
