// Step 2 of the GitHub OAuth handshake used by the CMS at /admin.
// GitHub redirects the popup here with a one-time `code`. This is the only
// step that needs the OAuth App's client secret, which is why it has to run
// server-side (a browser can never hold this secret safely).
module.exports = async (req, res) => {
  const code = req.query && req.query.code;
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  if (!code) {
    res.status(400).send("Missing OAuth code from GitHub.");
    return;
  }
  if (!clientId || !clientSecret) {
    res.status(500).send("Missing GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET environment variables in Vercel project settings.");
    return;
  }

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      res.status(400).send(`GitHub OAuth error: ${tokenData.error_description || tokenData.error || "unknown error"}`);
      return;
    }

    const payload = JSON.stringify({ token: tokenData.access_token, provider: "github" });

    res.setHeader("Content-Type", "text/html");
    res.status(200).send(`<!doctype html>
<html><body>
<script>
(function() {
  function receiveMessage(message) {
    window.opener.postMessage(
      'authorization:github:success:${payload.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}',
      message.origin
    );
    window.removeEventListener('message', receiveMessage, false);
  }
  window.addEventListener('message', receiveMessage, false);
  window.opener.postMessage('authorizing:github', '*');
})();
</script>
</body></html>`);
  } catch (err) {
    res.status(500).send("OAuth token exchange failed: " + err.message);
  }
};
