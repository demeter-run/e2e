/**
 * The mock's HTML pages: the sign-in form, the claim pages and a project's
 * ports page. Plain server-rendered forms, no script. They carry the copy,
 * field names and button labels of the Console's claim pages
 * (`ClaimView.tsx`, `activate.tsx`) and the inputs of Auth0's login form
 * (`#username`, `#password`, a "Continue" submit), so one browser script
 * drives either.
 */

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A whole page. The empty icon keeps the browser from requesting `/favicon.ico`, which would show in the call log. */
const page = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escape(title)}</title><link rel="icon" href="data:,"></head>
<body>
${body}
</body>
</html>
`

export const signIn = (error?: string): string =>
  page(
    'Log in | Demeter mock',
    `<h1>Welcome to the Demeter mock</h1>
<p>Any user name and password sign in.</p>
<form method="post" action="/login">
  <label for="username">Email address</label> <input type="text" id="username" name="username" autocomplete="off">
  <label for="password">Password</label> <input type="password" id="password" name="password">
  ${error ? `<p role="alert">${escape(error)}</p>` : ''}
  <button type="submit" name="action" value="default">Continue</button>
</form>`,
  )

export const signedOut = (): string =>
  page(
    'Claim project | Demeter mock',
    `<h1>Claim your project</h1>
<p>A coding agent created a Demeter project for you. Sign in to make it yours; its ports keep working.</p>
<a href="/login">Log in</a> <a href="/login?intent=signup">Sign up</a>`,
  )

export const expired = (via: 'link' | 'code'): string =>
  page(
    'Claim project | Demeter mock',
    `<h1>This ${via} has expired or was already used</h1>
<p>Unclaimed projects expire 7 days after the agent creates them, and each ${via} claims once.</p>`,
  )

export interface ClaimView {
  namespace: string
  agentName: string
  agentVersion?: string
  expiresAt: string
  ports: { kind: string; network: string }[]
  /** Where the form posts: the claim link, or `/activate?code=…`. */
  action: string
}

export const claim = (view: ClaimView): string =>
  page(
    'Claim project | Demeter mock',
    `<h1>Claim ${escape(view.namespace)}</h1>
<dl>
  <dt>Created by (as declared by the agent)</dt>
  <dd>${escape(view.agentName)}${view.agentVersion ? ` ${escape(view.agentVersion)}` : ''}</dd>
  <dt>Ports</dt>
  <dd>${
    view.ports.length
      ? `<ul>${view.ports.map((p) => `<li>${escape(p.kind)} · ${escape(p.network)}</li>`).join('')}</ul>`
      : 'No ports yet'
  }</dd>
  <dt>Expires if unclaimed</dt>
  <dd>${escape(view.expiresAt)}</dd>
</dl>
<form method="post" action="${escape(view.action)}">
  <label for="name">Project name</label> <input type="text" id="name" name="name" value="${escape(view.namespace)}">
  <button type="submit">Claim project</button>
</form>`,
  )

export const codeForm = (input = '', error?: string): string =>
  page(
    'Activate | Demeter mock',
    `<h1>Enter your code</h1>
<p>Type the code your coding agent gave you to claim the project it created.</p>
<form method="get" action="/activate">
  <label for="code">User code</label> <input type="text" id="code" name="code" placeholder="ABCD-2345" value="${escape(input)}" autocomplete="off">
  ${error ? `<p role="alert">${escape(error)}</p>` : ''}
  <button type="submit">Continue</button>
</form>`,
  )

export const ports = (name: string, namespace: string, list: { kind: string; network: string }[]): string =>
  page(
    'Ports | Demeter mock',
    `<h1>Ports</h1>
<p>Project ${escape(name)} (${escape(namespace)})</p>
<ul>${list.map((p) => `<li>${escape(p.kind)} · ${escape(p.network)}</li>`).join('')}</ul>`,
  )

export const notFound = (): string => page('Not found | Demeter mock', '<h1>Not found</h1>')
