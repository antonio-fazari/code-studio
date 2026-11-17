import { code, log, pill, stats } from '../../ui.js';

const oauthSteps = [
  ['ShopLite', 'Redirects your browser to accounts.google.com with its client id, the scopes it wants (email, profile), and a PKCE code challenge.'],
  ['Google', 'Shows its own login page. You type your password on Google\'s site. ShopLite never sees it.'],
  ['Google', 'Asks: "ShopLite wants to see your name and email address. Allow?" You approve.'],
  ['Google', 'Redirects back to shoplite.example/callback?code=4/0Ab… The code is single-use and expires in about a minute.'],
  ['ShopLite', 'Its server sends the code, its client secret and the PKCE verifier directly to Google, and receives an ID token (who you are) and an access token (what it may call).'],
  ['ShopLite', 'Verifies the ID token, finds or creates your customer record, and starts its own session. From here on it is ordinary session auth.'],
];

export default {
  id: 'auth',
  title: 'Auth',
  hook: 'Sessions vs JWT vs OAuth2',
  incident: 'A support agent left the company on Friday. On Monday their login still worked.',
  buildsOn: 'Rate limits are keyed by "who is calling". So far ShopLite has only an API key to go on. It needs to know which person is making each request, and what that person may do.',
  problem: `
    <p>HTTP has no memory. Each request arrives on its own, so after a user logs in, every later request must carry some proof of who they are. There are two questions to keep apart:</p>
    <ul>
      <li><strong>Authentication:</strong> who is this? (Ana, customer 42.)</li>
      <li><strong>Authorization:</strong> may they do this? (Ana may read her own orders, and no one else's.)</li>
    </ul>
    <p>The three terms in this lesson's title are often presented as alternatives. They answer different questions. Sessions and JWTs are two ways to carry a login from request to request. OAuth2 is a way to let another party vouch for the user, or to let an app act on a user's behalf.</p>`,
  realWorld: `
    <p>A <strong>session</strong> is a cloakroom ticket. The ticket is a meaningless number. The attendant looks it up to find your coat, and can refuse it the moment it is reported stolen.</p>
    <p>A <strong>JWT</strong> is a concert wristband. Staff at any door can check it by looking, with no phone call to the box office. Nobody can take it back before the night ends.</p>
    <p><strong>OAuth2</strong> is a hotel key card. The front desk checks your identity once and issues a card that opens your room and the gym, not every door, and stops working at checkout. "Sign in with Google" is OAuth2 with an identity layer (OpenID Connect) on top.</p>`,
  approach: `
    <h3>Sessions</h3>
    <p>On login the server creates a random id, stores <code>session id → user</code> in Redis or the database, and sends the id in a cookie. Every request looks it up.</p>
    ${code(`Set-Cookie: sid=9f2c41d7a0; HttpOnly; Secure; SameSite=Lax`, 'http')}
    <h3>JWT</h3>
    <p>On login the server signs a small JSON document and hands it to the client. Any service holding the key can verify the signature and trust the contents without a lookup.</p>
    ${code(`
header     { "alg": "HS256", "typ": "JWT" }
payload    { "sub": "user_42", "role": "support", "exp": 1767225600 }
signature  HMAC-SHA256(header + "." + payload, server_secret)`, 'jwt')}
    <p>The payload is encoded, not encrypted: anyone can read it. The signature only proves it has not been changed. Because nothing is looked up, a JWT cannot be cancelled before it expires. The standard answer is a short-lived access token (5 to 15 minutes) plus a refresh token that <em>is</em> stored server-side and can be revoked.</p>
    <h3>OAuth2</h3>
    <p>Use it when a third party is involved: letting users sign in with Google, or letting a partner app read a customer's orders with the customer's consent. The user authenticates with the provider, and your app receives a scoped, expiring token. Your app never handles the password.</p>
    <h3>Whichever you choose</h3>
    <p>Hash passwords with a slow algorithm built for it (argon2 or bcrypt). Check authorization on every request, on the server, against the resource being touched: <code>WHERE id = $1 AND customer_id = $current_user</code>.</p>`,
  sim: {
    title: 'Revoking access',
    intro: 'Log in as a support agent, call the API, then revoke their access as an admin and call the API again. Compare the two approaches. Below that, try editing a JWT, and walk through "Sign in with Google".',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="field" for="au-mode"><span>Login is carried by</span>
            <select id="au-mode"><option value="session">Session cookie</option><option value="jwt">JWT, 20 second expiry</option></select></label>
        </div>
        <div class="controls">
          <button class="btn" id="au-login">Log in</button>
          <button class="btn" id="au-call">GET /admin/orders</button>
          <button class="btn ghost" id="au-revoke">Admin: revoke this user</button>
        </div>
        <div class="stats" id="au-stats"></div>
        <ul class="log" id="au-log" aria-live="polite"></ul>

        <h4>Tamper with a token</h4>
        <p class="sim-note">This is the decoded payload of a customer's JWT. The server signed it with a secret the client does not have.</p>
        <div class="controls">
          <label class="field" for="au-role"><span>"role" in the payload</span>
            <select id="au-role"><option>customer</option><option>admin</option></select></label>
          <button class="btn" id="au-verify">Send token to the server</button>
        </div>
        <p class="sim-note" id="au-tamper" role="status"></p>

        <h4>Sign in with Google, step by step</h4>
        <ol class="timeline" id="au-oauth"></ol>
        <div class="controls"><button class="btn" id="au-next">Next step</button></div>`;
      const $ = (id) => root.querySelector(id);
      let token = null, revoked = false, sessions = new Set(), lookups = 0;
      const mode = () => $('#au-mode').value;
      const draw = () => {
        const left = token?.exp ? Math.max(0, Math.ceil((token.exp - Date.now()) / 1000)) : null;
        stats($('#au-stats'), [
          ['Client holds', token ? (token.kind === 'jwt' ? `JWT, ${left ? 'expires in ' + left + ' s' : 'expired'}` : 'cookie sid=9f2c…') : 'nothing'],
          ['User status', revoked ? 'revoked' : 'active', revoked ? 'bad' : 'ok'],
          ['Session store lookups', lookups],
        ]);
      };
      ctx.every(500, draw);
      $('#au-mode').onchange = () => { token = null; revoked = false; sessions.clear(); lookups = 0; $('#au-log').innerHTML = ''; draw(); };
      $('#au-login').onclick = () => {
        ctx.tried();
        if (revoked) { log($('#au-log'), `${pill('401', 'bad')} login refused: account is revoked`); return; }
        if (mode() === 'session') { sessions.add('9f2c'); token = { kind: 'session' }; log($('#au-log'), `${pill('200', 'ok')} session stored on the server, cookie sent to the browser`); }
        else { token = { kind: 'jwt', exp: Date.now() + 20000 }; log($('#au-log'), `${pill('200', 'ok')} JWT signed and sent. The server stores nothing`); }
        draw();
      };
      $('#au-call').onclick = () => {
        ctx.tried();
        const L = $('#au-log');
        if (!token) log(L, `${pill('401', 'bad')} no credentials. Log in first`);
        else if (token.kind === 'session') { lookups++; log(L, sessions.has('9f2c') ? `${pill('200', 'ok')} session found in the store` : `${pill('401', 'bad')} session not found. Access ended the moment it was revoked`); }
        else if (Date.now() > token.exp) log(L, `${pill('401', 'bad')} token expired. The refresh attempt is refused because the user is ${revoked ? 'revoked' : 'required to log in again'}`);
        else log(L, `${pill('200', 'ok')} signature valid, no lookup needed${revoked ? ` ${pill('revoked user still has access', 'bad')}` : ''}`);
        draw();
      };
      $('#au-revoke').onclick = () => {
        ctx.tried(); revoked = true; sessions.clear();
        log($('#au-log'), `<b>Admin</b> user revoked. ${mode() === 'session' ? 'Their session was deleted from the store.' : 'Their JWT is already issued and cannot be recalled. It stays valid until it expires.'}`);
        draw();
      };
      $('#au-verify').onclick = () => {
        ctx.tried();
        const tampered = $('#au-role').value === 'admin';
        $('#au-tamper').innerHTML = tampered
          ? `${pill('401', 'bad')} Signature mismatch. The payload changed but the client cannot produce a matching signature without the server's secret.`
          : `${pill('200', 'ok')} Signature matches the payload. The server trusts the role without a database lookup.`;
      };
      let step = 0;
      $('#au-next').onclick = () => {
        ctx.tried();
        const [who, text] = oauthSteps[step++];
        $('#au-oauth').insertAdjacentHTML('beforeend', `<li class="who-${who === 'Google' ? 'B' : 'A'}"><span class="who">${who}</span><span class="tl-note">${text}</span></li>`);
        if (step >= oauthSteps.length) $('#au-next').disabled = true;
      };
      draw();
    },
  },
  tradeoffs: [
    ['<strong>Sessions:</strong> logout and revocation are instant, and the cookie holds nothing sensitive.', 'Every request needs a store lookup, and the store must be shared by all instances and kept highly available.'],
    ['<strong>JWT:</strong> any service can verify a token locally. That suits many services or a separate mobile API.', 'No early revocation without adding a server-side list, which brings the lookup back. Tokens are larger, and a leaked signing key compromises everything.'],
    ['<strong>OAuth2:</strong> you never store the user\'s password, users get one-click sign-in, and access is scoped and expiring.', 'The most moving parts of the three: redirects, token exchange, refresh, and a dependency on the provider being up. Easy to get subtly wrong, so use a maintained library.'],
  ],
  avoid: `<p>For a single web app with its own users, server-side sessions in an HttpOnly cookie are the simplest secure choice, and you should not pick JWTs just because they are fashionable. Reach for JWTs when several services must verify identity independently. Add OAuth2 when a third party is involved in either direction. Never write your own password hashing or token signing.</p>`,
  shoplite: 'Session cookies for the web shop, short-lived JWTs between internal services, and "Sign in with Google" through OAuth2.',
  takeaways: [
    'Authentication is who you are. Authorization is what you may do. Check both on the server, every request.',
    'Sessions are stateful and revocable. JWTs are stateless and are not.',
    'OAuth2 is delegation: a scoped, expiring token issued by a party the user already trusts.',
  ],
  quiz: [
    { q: 'An employee is dismissed and must lose access immediately. Which design makes that hardest?',
      options: ['Server-side sessions', 'JWTs valid for 24 hours with no server-side check', 'JWTs valid for 5 minutes plus revocable refresh tokens'], answer: 1,
      why: 'A long-lived token that is never checked against the server cannot be recalled. Short expiry limits the exposure to minutes.' },
    { q: 'A JWT payload contains <code>"role": "customer"</code>. What stops the user from changing it to "admin"?',
      options: ['The payload is encrypted', 'The signature would no longer match, and only the server can create a valid one', 'Nothing, JWTs must not hold roles'], answer: 1,
      why: 'JWTs are signed, not encrypted. Anyone can read them and nobody without the key can alter them undetected.' },
    { q: 'GET /orders/1042 checks that the caller is logged in and returns the order. What is missing?',
      options: ['Authentication', 'Authorization: checking the order belongs to this caller', 'Rate limiting'], answer: 1,
      why: 'Without an ownership check any logged-in user can read any order by changing the number. This is among the most common API vulnerabilities.' },
  ],
};
