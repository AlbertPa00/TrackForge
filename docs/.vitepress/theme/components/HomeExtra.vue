<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

const GITHUB = 'https://github.com/AlbertPa00/TrackForge';

const stats = [
  { n: '~360', label: 'documented REST paths' },
  { n: '140+', label: 'MCP tools' },
  { n: 'JQL', label: 'real lexer→compiler engine' },
  { n: '<10 min', label: 'docker compose → first issue' },
];

const loop = [
  { t: 'Delegate', d: 'fields.delegate ≠ assignee — the human stays accountable.' },
  { t: 'Session opens', d: 'Inspectable session with project guidance attached.' },
  { t: 'Stream activities', d: 'thought · action · error timeline, live over SSE.' },
  { t: 'Ask & answer', d: 'Blocking questions pause work until a human replies.' },
  { t: 'Proposal gate', d: 'Approval policy parks writes as editable proposals.' },
  { t: 'Attribute', d: 'Changelog + audit record actor, channel, and approver.' },
];

const tabs = [
  {
    id: 'run',
    label: 'Run it',
    code: `<span class="c1"># one container, everything inside</span>
cp .env.example .env   <span class="c1"># set POSTGRES_PASSWORD, SESSION_SECRET, TF_ADMIN_*</span>
docker compose -f docker-compose.prod.yml up -d
<span class="hl">open http://localhost:3000</span>`,
    raw: `cp .env.example .env\ndocker compose -f docker-compose.prod.yml up -d\nopen http://localhost:3000`,
  },
  {
    id: 'agent',
    label: 'Connect an agent',
    code: `<span class="c1"># mint a scoped PAT, then point your MCP client at it</span>
<span class="hl">TRACKFORGE_URL</span>=http://localhost:3000 \
<span class="hl">TRACKFORGE_TOKEN</span>=tfp_xxx \
  pnpm --filter trackforge-mcp dev

<span class="c1"># agents self-discover the surface:</span>
curl http://localhost:3000/llms.txt`,
    raw: `TRACKFORGE_URL=http://localhost:3000 TRACKFORGE_TOKEN=tfp_xxx pnpm --filter trackforge-mcp dev`,
  },
  {
    id: 'claim',
    label: 'Claim work atomically',
    code: `curl -X POST http://localhost:3000/api/internal/agent/claim \\
  -H <span class="hl">"Authorization: Bearer tfp_xxx"</span> \\
  -H "Content-Type: application/json" \\
  -d '{"projectKey":"TF","jql":"key in ready()"}'

<span class="c1"># FOR UPDATE SKIP LOCKED — fleets never double-claim</span>`,
    raw: `curl -X POST http://localhost:3000/api/internal/agent/claim -H "Authorization: Bearer tfp_xxx" -H "Content-Type: application/json" -d '{"projectKey":"TF","jql":"key in ready()"}'`,
  },
];

const active = ref('run');
const copied = ref(false);

async function copy() {
  const tab = tabs.find((t) => t.id === active.value);
  if (!tab) return;
  try {
    await navigator.clipboard.writeText(tab.raw);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard unavailable (non-secure context) — leave button idle */
  }
}

const cmp = [
  ['Self-hosted, single container', 'yes', 'dc', 'no', 'yes'],
  ['Jira v2 wire-compatible REST', 'yes', 'native', 'no', 'no'],
  ['Real JQL engine', 'yes', 'yes', 'no', 'no'],
  ['dryRun preview on every write', 'yes', 'no', 'no', 'no'],
  ['Idempotency-Key writes', 'yes', 'no', 'no', 'no'],
  ['Per-token approval policies', 'yes', 'no', 'part', 'no'],
  ['Agent sessions + audit trail', 'yes', 'part', 'part', 'no'],
  ['First-party MCP server', 'yes', 'yes', 'yes', 'yes'],
];

const cmpHead = ['', 'TrackForge', 'Jira', 'Linear', 'Plane'];

const shots = [
  { src: 'screenshots/issue-agent.png', cap: 'Agent session — thought/action timeline on the issue' },
  { src: 'screenshots/approvals.png', cap: 'Approvals inbox — writes parked as editable proposals' },
  { src: 'screenshots/jql-search.png', cap: 'JQL-compatible search with a real query engine' },
  { src: 'screenshots/copilot-palette.png', cap: 'Copilot — describe work, get a validated plan' },
];

onMounted(() => {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('tf-in');
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  document.querySelectorAll('.tf-reveal').forEach((el) => io.observe(el));
});
</script>

<template>
  <div class="tf-extra">
    <!-- stats strip -->
    <section class="tf-section tf-reveal" style="padding-top: 0.5rem">
      <div class="tf-stats">
        <div v-for="s in stats" :key="s.label" class="tf-stat">
          <b>{{ s.n }}</b>
          <span>{{ s.label }}</span>
        </div>
      </div>
    </section>

    <!-- agent loop -->
    <section class="tf-section tf-reveal">
      <span class="tf-eyebrow">The differentiator</span>
      <h2 class="tf-h2">A governed work loop for agents — not a chat sidebar</h2>
      <p class="tf-sub">
        Agents authenticate with scoped tokens and drive the same REST surface humans
        use. Every write can be gated, previewed, replayed, and attributed.
      </p>
      <div class="tf-loop">
        <div v-for="(step, i) in loop" :key="step.t" class="tf-step">
          <span class="tf-step-num">{{ i + 1 }}</span>
          <h3>{{ step.t }}</h3>
          <p>{{ step.d }}</p>
        </div>
      </div>
    </section>

    <!-- code tabs -->
    <section class="tf-section tf-reveal">
      <span class="tf-eyebrow">Zero to agent</span>
      <h2 class="tf-h2">Up in minutes, driven by machines</h2>
      <p class="tf-sub">
        One compose file for production. Scoped tokens, dry-run previews, and
        idempotent writes mean agents can operate safely from day one.
      </p>
      <div class="tf-tabs">
        <div class="tf-tabbar" role="tablist">
          <button
            v-for="t in tabs"
            :key="t.id"
            class="tf-tab"
            :class="{ active: active === t.id }"
            role="tab"
            :aria-selected="active === t.id"
            @click="active = t.id"
          >
            {{ t.label }}
          </button>
          <button class="tf-copy" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <pre v-for="t in tabs" v-show="active === t.id" :key="t.id"><code v-html="t.code"></code></pre>
      </div>
    </section>

    <!-- comparison -->
    <section class="tf-section tf-reveal">
      <span class="tf-eyebrow">Honest comparison</span>
      <h2 class="tf-h2">Where it actually differs</h2>
      <p class="tf-sub">
        Every row links to proof in-repo in
        <a :href="withBase('/positioning')">positioning</a> — gaps included.
      </p>
      <table class="tf-compare">
        <thead>
          <tr>
            <th v-for="(h, i) in cmpHead" :key="h || 'f'" :class="{ 'tf-us': i === 1 }">{{ h }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in cmp" :key="row[0]">
            <td>{{ row[0] }}</td>
            <td v-for="(cell, i) in row.slice(1)" :key="i">
              <span v-if="cell === 'yes'" class="tf-yes">✓</span>
              <span v-else-if="cell === 'native'" class="tf-yes">native</span>
              <span v-else-if="cell === 'dc'" class="tf-yes">✓ DC</span>
              <span v-else-if="cell === 'part'" class="tf-part">partial</span>
              <span v-else class="tf-no">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- screenshots -->
    <section class="tf-section tf-reveal">
      <span class="tf-eyebrow">The product</span>
      <h2 class="tf-h2">Looks like Jira. Governs like an audit system.</h2>
      <div class="tf-shots" style="margin-top: 1.6rem">
        <figure v-for="s in shots" :key="s.src" class="tf-shot" style="margin: 0">
          <img :src="withBase('/' + s.src)" :alt="s.cap" loading="lazy" />
          <figcaption>{{ s.cap }}</figcaption>
        </figure>
      </div>
    </section>

    <!-- final CTA -->
    <section class="tf-section tf-reveal">
      <div class="tf-cta">
        <h2>The tracker your agents already know how to drive</h2>
        <p>
          Jira-compatible API. Governed write loop. First-party MCP server.
          Self-hosted in one container.
        </p>
        <a class="tf-btn primary" :href="withBase('/install')">Run it in 10 minutes</a>
        <a class="tf-btn ghost" :href="GITHUB" target="_blank" rel="noopener">★ Star on GitHub</a>
      </div>
    </section>
  </div>
</template>
