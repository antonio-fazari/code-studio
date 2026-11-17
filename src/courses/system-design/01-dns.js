import { code, fmt, pill, slider, bindSlider, stats } from '../../ui.js';
import { dnsStaleShare, dnsQueryLoad } from '../../engines-sd.js';

const steps = [
  ['Browser', 'Checks its own cache for shoplite.example. Not there.', 1],
  ['Operating system', 'Checks its cache, then asks the recursive resolver configured on the network (your ISP\'s, or a public one such as 1.1.1.1).', 2],
  ['Resolver → root server', 'The root server does not know shoplite.example. It replies: ".example is handled by these TLD servers."', 24],
  ['Resolver → TLD server', 'The TLD server replies: "shoplite.example is handled by ns1.dnshost.example and ns2.dnshost.example."', 22],
  ['Resolver → authoritative server', 'ShopLite\'s own nameserver answers: shoplite.example A 203.0.113.10, TTL 300.', 30],
  ['Resolver', 'Caches the answer for 300 seconds and returns it. The browser opens a connection to 203.0.113.10.', 1],
];
const cachedSteps = [steps[0], steps[1], ['Resolver', 'Has the answer cached from another user\'s lookup 40 seconds ago. Returns it straight away.', 1]];
const ttls = [30, 60, 300, 3600, 86400, 172800];
const ttlLabel = (s) => (s >= 86400 ? s / 86400 + ' day' + (s > 86400 ? 's' : '') : s >= 3600 ? s / 3600 + ' hour' : s >= 60 ? s / 60 + ' min' : s + ' s');

export default {
  id: 'sd-dns',
  part: 'Part 1: Getting traffic in',
  title: 'DNS',
  hook: 'How a name becomes an address, and why changes take time to spread',
  incident: 'ShopLite moved to a new data centre on Monday. On Wednesday, some customers were still being sent to the old one, which had been switched off.',
  buildsOn: 'ShopLite runs in one data centre in Virginia. Customers now arrive from every continent, and before anything else happens, their device has to find out where ShopLite is.',
  problem: `
    <p>Computers connect to IP addresses such as <code>203.0.113.10</code>. People type names such as <code>shoplite.example</code>. The Domain Name System (DNS) turns the second into the first, and it does it for every new visitor before a single byte of your site is sent.</p>
    <p>DNS is fast because answers are cached at every level: in the browser, the operating system and the resolver. Each answer carries a <strong>TTL</strong> (time to live) that says how long it may be cached. ShopLite's TTL had been set to 2 days years ago and forgotten. When the address changed, resolvers around the world kept handing out the old one until their copy expired.</p>`,
  realWorld: `
    <p>DNS works like directory assistance in a city of a billion people. Nobody holds the whole phone book. A central office knows which office handles each district, that office knows which building handles each street, and the building knows the flat. Everyone along the way remembers recent answers so the next caller is served faster.</p>
    <p>When DNS fails, everything behind it disappears even though the servers are running. In October 2021, a configuration change at Facebook withdrew the network routes to its own DNS servers. For about six hours facebook.com, Instagram and WhatsApp could not be found by anyone, including Facebook's own staff tools. In 2016, a botnet flooded the DNS provider Dyn and made Twitter, GitHub and Netflix unreachable for parts of a day.</p>
    <p>The root of the system is small in name only: there are 13 root server identities, run by 12 organisations, served from well over a thousand machines around the world that share the same addresses (a technique called anycast).</p>`,
  approach: `
    <p>You publish <strong>records</strong> with your DNS provider. The common ones:</p>
    ${code(`
shoplite.example.        300   IN  A      203.0.113.10        ; IPv4 address
shoplite.example.        300   IN  AAAA   2001:db8::10        ; IPv6 address
www.shoplite.example.    300   IN  CNAME  shoplite.example.   ; alias to another name
static.shoplite.example. 300   IN  CNAME  d1234.cdn.example.  ; hand a subdomain to a CDN (next lesson)
shoplite.example.        3600  IN  MX     10 mail.shoplite.example.
shoplite.example.        3600  IN  TXT    "v=spf1 include:mailer.example -all"`, 'dns')}
    <p>The second column is the TTL in seconds. Choosing it is the main design decision:</p>
    <ul>
      <li><strong>Long TTL</strong> (hours): fewer lookups, faster first visits, less load on your nameservers, and resilience if your DNS provider has a short outage. Changes are slow to spread.</li>
      <li><strong>Short TTL</strong> (30 to 300 seconds): changes take effect within minutes. More lookups, and every resolver depends on your nameservers being up.</li>
    </ul>
    <p>The standard migration routine: a day or more before the move, lower the TTL to 60 seconds. Wait for the old, long TTL to expire everywhere. Switch the address. Keep the old server running for a while. Raise the TTL again once you are sure.</p>
    <p>DNS can also route. Managed DNS services (Route 53, Cloudflare, NS1) can answer with different addresses depending on where the resolver is (<strong>geo routing</strong>), which region is fastest from there (<strong>latency routing</strong>), or which servers pass health checks (<strong>failover</strong>). ShopLite will use that to send European customers to a European region later in this course.</p>`,
  sim: {
    title: 'Resolve a name, then change it',
    intro: 'Step through a lookup with an empty cache and with a warm one. Then choose a TTL and see how long the old address lives on after a change.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="controls">
          <label class="check" for="dns-warm"><input type="checkbox" id="dns-warm"> The resolver already has the answer cached</label>
          <button class="btn" id="dns-next">Next step</button>
          <button class="btn ghost" id="dns-reset">Restart</button>
        </div>
        <ol class="timeline" id="dns-steps"></ol>
        <div class="stats" id="dns-time"></div>
        <h4>Change the address</h4>
        <p class="sim-note">ShopLite's A record changes to a new server. About 200,000 resolvers around the world look it up.</p>
        ${slider('dns-ttl', 'TTL on the record:', 0, 5, 4)}
        ${slider('dns-since', 'Time since the change:', 0, 100, 10)}
        <div class="stats" id="dns-stats"></div>
        <p class="sim-note" id="dns-note" role="status"></p>`;
      const $ = (id) => root.querySelector(id);
      let i = 0, ms = 0;
      const list = () => ($('#dns-warm').checked ? cachedSteps : steps);
      const reset = () => { i = 0; ms = 0; $('#dns-steps').innerHTML = ''; $('#dns-next').disabled = false; stats($('#dns-time'), [['Lookup time so far', '0 ms'], ['Network round trips', 0]]); };
      $('#dns-warm').onchange = () => { ctx.tried(); reset(); };
      $('#dns-reset').onclick = reset;
      $('#dns-next').onclick = () => {
        ctx.tried();
        const [who, text, cost] = list()[i++];
        ms += cost;
        $('#dns-steps').insertAdjacentHTML('beforeend', `<li class="who-${i > 2 && list() === steps ? 'B' : 'A'}"><span class="who">${who}</span><span class="tl-note">${text}</span></li>`);
        stats($('#dns-time'), [['Lookup time so far', ms + ' ms', i === list().length ? 'ok' : ''], ['Network round trips', Math.max(0, i - 1)]]);
        if (i >= list().length) $('#dns-next').disabled = true;
      };
      reset();
      let getTtl, getSince;
      const draw = (v, user) => {
        if (user) ctx.tried();
        if (!getTtl || !getSince) return;
        const ttl = ttls[getTtl()];
        const since = (getSince() / 100) * Math.max(ttl * 1.2, 120);
        $('#dns-since-out').textContent = ttlLabel(Math.round(since)) .replace(/^0 s$/, 'just now');
        const stale = dnsStaleShare(since, ttl);
        stats($('#dns-stats'), [
          ['Resolvers still sending users to the old server', Math.round(stale * 100) + '%', stale > 0.05 ? 'bad' : 'ok'],
          ['Lookups per second reaching your nameservers', fmt(dnsQueryLoad(200000, ttl)), ttl < 300 ? 'warn' : ''],
          ['Worst case until everyone moves', ttlLabel(ttl)],
        ]);
        $('#dns-note').textContent = ttl >= 86400
          ? 'With a long TTL the switch drags on for a day or more. Lower the TTL well before a planned move.'
          : ttl <= 60 ? 'Changes spread within a minute, but every resolver asks again every minute. Your DNS provider now carries real load and must not go down.'
          : 'A middle setting: changes spread within minutes and lookups stay cheap.';
      };
      getTtl = bindSlider(root, 'dns-ttl', (v) => ttlLabel(ttls[v]), draw);
      getSince = bindSlider(root, 'dns-since', () => '', draw);
      draw();
    },
  },
  tradeoffs: [
    ['A long TTL makes most lookups instant, keeps load off your nameservers, and rides out short DNS provider outages.', 'Every change takes up to one TTL to reach everyone. A mistake also takes that long to undo.'],
    ['A short TTL lets you move traffic or fail over within minutes.', 'Many more lookups, a hard dependency on your DNS provider at every moment, and slightly slower first visits.'],
    ['DNS routing (geo, latency, health-checked failover) spreads users across regions with no extra hardware.', 'It is coarse. It routes by the resolver\'s location, not the user\'s, and you cannot control how long clients actually cache.'],
  ],
  avoid: `<p>Do not use DNS as your only way to fail over quickly. Some resolvers and clients keep answers longer than the TTL, and long-running programs may cache an address until they restart. Fast failover inside a region belongs to a load balancer (lesson 4). Do not run your own authoritative DNS servers unless you have to; a managed provider with anycast is cheaper and harder to knock over.</p>`,
  shoplite: 'Records with a managed DNS provider, a 300 s TTL on the main site, and a runbook that lowers it to 60 s before any move.',
  takeaways: [
    'DNS turns names into addresses through a chain of servers, and caches answers at every step.',
    'The TTL sets how long an answer may be cached, which trades speed and resilience against how fast changes spread.',
    'Lower the TTL before a planned change, not during it.',
  ],
  quiz: [
    { q: 'Your A record has a TTL of 86,400 seconds. You change the address now. When will every resolver use the new one?',
      options: ['Immediately', 'Within about 24 hours, possibly longer for clients that ignore TTLs', 'After you restart the DNS provider'], answer: 1,
      why: 'Each resolver keeps its cached copy until it expires, and some caches stretch the TTL. That is why TTLs are lowered ahead of a move.' },
    { q: 'What does the root server tell a resolver looking up shoplite.example?',
      options: ['The IP address of shoplite.example', 'Which servers handle the .example top-level domain', 'Whether the site is up'], answer: 1,
      why: 'Each level only refers the resolver one step closer. Only the authoritative nameserver knows the final answer.' },
    { q: 'In 2021 Facebook\'s servers were running but nobody could reach them for hours. Why?',
      options: ['Their TTLs were too short', 'Their DNS servers became unreachable, so their names could not be turned into addresses', 'A CDN cached an error page'], answer: 1,
      why: 'Without working DNS a healthy service is invisible. That is why DNS is usually run by a provider with servers in many places.' },
  ],
};
