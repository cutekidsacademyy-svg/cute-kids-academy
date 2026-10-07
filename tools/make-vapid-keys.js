// Makes the key pair for web push notifications. Run once:   node tools/make-vapid-keys.js
// The PUBLIC key goes into js/portal-config.js (vapidPublicKey). The PRIVATE key goes ONLY into Vercel
// (environment variable VAPID_PRIVATE_KEY), together with VAPID_PUBLIC_KEY (the same public key) and
// VAPID_SUBJECT (for example mailto:Cutekidsacademyy@gmail.com). Never commit the private key.
const crypto = require("crypto");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pj = publicKey.export({ format: "jwk" }), dj = privateKey.export({ format: "jwk" });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(pj.x, "base64url"), Buffer.from(pj.y, "base64url")]).toString("base64url");
console.log("PUBLIC key  (js/portal-config.js and Vercel VAPID_PUBLIC_KEY):\n" + pub + "\n");
console.log("PRIVATE key (ONLY in Vercel as VAPID_PRIVATE_KEY, keep it secret):\n" + dj.d + "\n");
