function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A plain page for a signed-in user who may not open what they asked for. */
export function deniedPage(message: string, email: string): string {
  const who = email ? `<p>Signed in as ${escapeHtml(email)}.</p>` : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Iara Studio</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#16181c}a{color:#d4a64a}}</style></head>
<body><h1>Access denied</h1><p>${escapeHtml(message)}</p>${who}
<p><a href="/">Back to the Studio</a> · <a href="/auth/logout">Sign out</a></p></body>
</html>`;
}
