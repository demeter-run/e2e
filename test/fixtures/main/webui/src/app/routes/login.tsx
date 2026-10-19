import { LoaderFunction, redirect } from '@remix-run/node';
import { getWebAuthUrl } from '~/services/auth0.server';

// The only recognized intent. Anything else (including no intent at all) falls
// through to the plain login screen, so the query parameter can never reach the
// authorize URL.
const SIGNUP_INTENT = 'signup';

export const loader: LoaderFunction = async ({ request }) => {
  const intent = new URL(request.url).searchParams.get('intent');
  const authUrl = getWebAuthUrl({ signup: intent === SIGNUP_INTENT });
  return redirect(authUrl);
};

export default function login() {
  return <div>Redirecting...</div>;
}
