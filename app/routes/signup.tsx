import { redirect, type LoaderFunctionArgs } from "react-router";
import { getSignUpUrl } from "@workos-inc/authkit-react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const { url: authUrl, headers } = await getSignUpUrl(
    url.searchParams.get("returnTo") ?? undefined,
    request
  );
  return redirect(authUrl, { headers });
}
