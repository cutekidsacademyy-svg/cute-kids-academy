// Step 1 of the GitHub OAuth handshake used by the CMS at /admin.
// The CMS opens a popup pointing here; we redirect it to GitHub's own
// login/authorize screen. No secret is used or exposed in this step.
module.exports = (req, res) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    res.status(500).send("Missing GITHUB_OAUTH_CLIENT_ID environment variable in Vercel project settings.");
    return;
  }

  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  const redirectUri = `${protocol}://${host}/api/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "repo,user"
  });

  res.writeHead(302, { Location: `https://github.com/login/oauth/authorize?${params.toString()}` });
  res.end();
};
