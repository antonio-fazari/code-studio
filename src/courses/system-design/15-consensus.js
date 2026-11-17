import { code, log, pill, stats } from '../../ui.js';
import { raftElection, canCommit } from '../../engines-sd.js';

const TOTAL = 5;

export default {
  id: 'sd-consensus',
  part: 'Part 3: Distributed trade-offs',
  title: 'Consensus',
  hook: 'How several machines agree on one leader and one history, even when some fail',
  incident: 'A network blip made ShopLite\'s failover script promote a new database leader while the old one was still running. For 90 seconds there were two leaders, both accepting orders.',
  buildsOn: 'Lessons 10 to 14 kept assuming something: that replicas agree on who the leader is, and that a majority decides. Lesson 13 refused writes without a majority. This lesson is how a group of machines reaches that agreement safely.',
  problem: `
    <p>ShopLite's failover worked like this: a monitor pings the leader; if it does not answer for 10 seconds, promote a follower. The flaw is that "not answering me" is not the same as "dead". The old leader was alive and reachable from half the API servers. Both leaders accepted writes, and their histories diverged. This is called <strong>split brain</strong>, and it is one of the most damaging failures a database can have.</p>
    <p>You cannot fix it with a better timeout. In a network, a slow machine and a dead machine look identical. What you need is a rule that makes it <em>impossible</em> for two leaders to both act, even when machines disagree about who is alive.</p>`,
  realWorld: `
    <p>A board of five directors can make a decision only with a quorum of three present. If the board splits into a group of three and a group of two who cannot reach each other, only the three can pass anything. The two cannot, however sure they are. Because any two groups of three share at least one person, two conflicting decisions can never both pass.</p>
    <p><strong>Paxos</strong>, by Leslie Lamport, was the first widely known consensus algorithm and is famously hard to follow. <strong>Raft</strong>, published by Diego Ongaro and John Ousterhout in 2014, was designed to be understandable and is now everywhere: etcd (which stores the state of every Kubernetes cluster), Consul, CockroachDB and TiDB all use it. ZooKeeper uses a close relative. Most teams never implement consensus; they use one of these.</p>`,
  approach: `
    <p>Raft keeps a cluster of (usually) 3 or 5 nodes in agreement on a sequence of commands, the <strong>log</strong>.</p>
    <ul>
      <li><strong>Terms.</strong> Time is divided into numbered terms. Each term has at most one leader. Any message from an older term is ignored, which is how a returning old leader learns it has been replaced.</li>
      <li><strong>Election.</strong> Followers expect a heartbeat from the leader. If one does not arrive within a <em>randomised</em> timeout (say 150 to 300 ms), the follower becomes a candidate, increments the term, and asks the others for votes. Each node votes once per term. A candidate with a majority becomes leader. The random timeouts make it likely that one node asks first and wins outright.</li>
      <li><strong>Replication.</strong> The leader appends each command to its log and sends it to followers. An entry is <strong>committed</strong> once a majority has stored it. Only then is it applied and acknowledged to the client. A future leader must have every committed entry, which the voting rules guarantee.</li>
    </ul>
    <p>The arithmetic that makes it work: a majority of 5 is 3, and any two majorities overlap. So two leaders in the same term, or two different committed values, are impossible. The cluster tolerates the failure of a minority: 1 of 3, or 2 of 5. An even number of nodes adds cost without adding tolerance (4 nodes still tolerate only 1 failure).</p>
    ${code(`
# Use consensus, do not build it: a lease-based leader lock in etcd
etcdctl lease grant 10                         # lease expires in 10 s unless renewed
etcdctl put --lease=<id> /shoplite/db-leader node-3
# Every other candidate's write fails while the lease is alive.
# If node-3 stops renewing, the lease expires and another node can take over.`, 'sh')}
    <p>Failover tools for databases (Patroni for PostgreSQL, for example) keep the "who is leader" decision in etcd, ZooKeeper or Consul for exactly this reason. A node that cannot reach the consensus store must also stop acting as leader, a step called <em>fencing</em>.</p>`,
  sim: {
    title: 'Elect a leader',
    intro: 'Five nodes, with node 1 as leader in term 1. Kill the leader and watch an election. Then kill more nodes and see when the cluster stops being able to elect a leader or commit writes.',
    mount(root, ctx) {
      root.innerHTML = `
        <div class="raft" id="rf-nodes"></div>
        <div class="controls">
          <button class="btn danger" id="rf-kill-leader">Kill the leader</button>
          <button class="btn ghost" id="rf-kill">Kill a follower</button>
          <button class="btn ghost" id="rf-revive">Bring a node back</button>
          <button class="btn" id="rf-write">Client writes stock = 7</button>
        </div>
        <div class="stats" id="rf-stats"></div>
        <ul class="log" id="rf-log" aria-live="polite"></ul>`;
      const $ = (id) => root.querySelector(id);
      const nodes = Array.from({ length: TOTAL }, (_, i) => ({ id: i + 1, up: true, role: i === 0 ? 'leader' : 'follower', term: 1 }));
      let term = 1, leader = 1, seed = 1, electing = false, committed = 0;
      const alive = () => nodes.filter((n) => n.up).map((n) => n.id);
      const draw = () => {
        $('#rf-nodes').innerHTML = nodes.map((n) => `<div class="rnode ${n.up ? n.role : 'down'}"><b>Node ${n.id}</b><span>${n.up ? n.role : 'down'}</span><small>term ${n.term}</small></div>`).join('');
        stats($('#rf-stats'), [['Nodes up', `${alive().length} of ${TOTAL}`, alive().length < 3 ? 'bad' : 'ok'], ['Majority needed', 3], ['Current leader', leader ? 'node ' + leader + ', term ' + term : 'none', leader ? 'ok' : 'bad'], ['Committed writes', committed]]);
        $('#rf-kill-leader').disabled = !leader || electing;
        $('#rf-write').disabled = electing;
      };
      const elect = () => {
        electing = true;
        const r = raftElection({ alive: alive(), total: TOTAL, term, seed: seed++ });
        r.events.forEach((e) => ctx.after(e.t * 4, () => {
          const n = nodes.find((x) => x.id === e.node);
          if (e.type === 'split') log($('#rf-log'), `<b>Term ${e.term}</b> nodes ${e.nodes.join(' and ')} timed out at almost the same moment and split the vote. Both wait a new random time.`, 'bad');
          if (e.type === 'candidate') { n.role = 'candidate'; nodes.forEach((x) => { if (x.up) x.term = e.term; }); log($('#rf-log'), `<b>Term ${e.term}</b> node ${e.node}'s timer ran out first. It becomes a candidate and asks for votes.`); }
          if (e.type === 'votes') log($('#rf-log'), `<b>Term ${e.term}</b> node ${e.node} receives ${e.votes} vote${e.votes > 1 ? 's' : ''}, including its own. It needs ${e.needed}.`);
          if (e.type === 'leader') { nodes.forEach((x) => { if (x.up) x.role = 'follower'; }); n.role = 'leader'; leader = e.node; term = e.term; log($('#rf-log'), `${pill('leader', 'ok')} node ${e.node} wins term ${e.term} and starts sending heartbeats.`, 'ok'); }
          if (e.type === 'no-majority') { n.role = 'follower'; log($('#rf-log'), `${pill('no leader', 'bad')} node ${e.node} cannot reach a majority. It will keep trying, and the cluster accepts no writes meanwhile.`, 'bad'); }
          draw();
        }));
        const end = (r.events.at(-1)?.t ?? 0) * 4 + 50;
        ctx.after(end, () => { electing = false; if (!r.leader) term = r.term; draw(); });
        draw();
      };
      $('#rf-kill-leader').onclick = () => {
        ctx.tried();
        const n = nodes.find((x) => x.id === leader);
        n.up = false; leader = null;
        log($('#rf-log'), `<b>Failure</b> node ${n.id}, the leader, stops. Heartbeats stop.`, 'bad');
        elect();
      };
      $('#rf-kill').onclick = () => {
        ctx.tried();
        const n = nodes.find((x) => x.up && x.id !== leader);
        if (!n) return;
        n.up = false;
        log($('#rf-log'), `<b>Failure</b> follower node ${n.id} stops.`, 'bad');
        if (leader && alive().length < 3) log($('#rf-log'), `Node ${leader} is still leader but can no longer reach a majority, so nothing it receives can commit.`, 'bad');
        draw();
      };
      $('#rf-revive').onclick = () => {
        ctx.tried();
        const n = nodes.find((x) => !x.up);
        if (!n) return;
        n.up = true; n.role = 'follower';
        log($('#rf-log'), `<b>Recovery</b> node ${n.id} returns${n.term < term ? `, sees term ${term} is newer than its own term ${n.term}, and becomes a follower` : ''}.`);
        n.term = term;
        if (!leader && alive().length >= 3 && !electing) elect(); else draw();
      };
      $('#rf-write').onclick = () => {
        ctx.tried();
        if (!leader) { log($('#rf-log'), `${pill('503', 'bad')} No leader. The write is refused until one is elected.`, 'bad'); return; }
        const acks = alive().length;
        if (canCommit(acks, TOTAL)) { committed++; log($('#rf-log'), `${pill('committed', 'ok')} Leader node ${leader} replicated the entry to ${acks} of ${TOTAL} nodes, a majority. Applied and acknowledged.`, 'ok'); }
        else log($('#rf-log'), `${pill('not committed', 'bad')} Only ${acks} of ${TOTAL} nodes stored it. Without a majority the leader cannot acknowledge the write.`, 'bad');
        draw();
      };
      draw();
    },
  },
  tradeoffs: [
    ['Split brain becomes impossible: at most one leader per term, and committed data is never lost while a majority survives.', 'Every write waits for a majority to store it, which adds a network round trip, or a cross-region one if nodes are spread across regions.'],
    ['The cluster heals itself: a new leader is elected within a second or so, without a human.', 'If a majority is lost, the cluster stops accepting writes entirely. That is the price of never being wrong.'],
    ['Off-the-shelf systems (etcd, ZooKeeper, Consul) give you leader election and locks without writing the algorithm.', 'They are critical infrastructure with their own operational needs, and performance falls as you add nodes.'],
  ],
  avoid: `<p>Never write your own consensus algorithm for production, and never build failover on "ping it, and promote if it does not answer". Use a database with built-in consensus or a failover tool backed by etcd or ZooKeeper. And do not put consensus on the path of every request when it is not needed: use it for the small facts that must be agreed (who is leader, which shard lives where, who holds a lock), and let the data path use those decisions.</p>`,
  shoplite: 'Database failover runs through Patroni with leader election in a 3-node etcd cluster, and the shard map from lesson 11 lives in etcd too.',
  takeaways: [
    'Consensus lets a group agree on one leader and one ordered history despite failures.',
    'Everything rests on majorities: any two majorities overlap, so two conflicting decisions cannot both pass.',
    'A cluster of 2f + 1 nodes survives f failures. Use 3 or 5, and use a proven implementation.',
  ],
  quiz: [
    { q: 'How many node failures can a 5-node Raft cluster survive and still accept writes?',
      options: ['1', '2', '4'], answer: 1,
      why: 'Writes need a majority of 5, which is 3. Losing 2 leaves 3.' },
    { q: 'Why does Raft use randomised election timeouts?',
      options: ['To save network bandwidth', 'So one node usually times out first and wins, instead of several splitting the vote', 'To make the leader change regularly'], answer: 1,
      why: 'If every follower timed out together, they would all become candidates and none would win a majority.' },
    { q: 'Why is a 4-node consensus cluster rarely used?',
      options: ['Raft needs an odd number to run at all', 'It tolerates the same single failure as 3 nodes, while every write must reach more nodes', 'It cannot elect a leader'], answer: 1,
      why: 'A majority of 4 is 3, so it survives 1 failure, like 3 nodes. The extra node adds cost, not tolerance.' },
  ],
};
