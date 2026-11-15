# 07 — Scientific Publishing Epistemology & Cross-Disciplinary Frontiers

**Theme**: Cross-pollinating 350 years of scientific publishing infrastructure, swarm biology, epistemic logic, mechanism design, neuroscience, and immunology into TrackForge
**Depends on**: Proposals 01–06
**Related Sprints**: Long-horizon enrichments for [Sprint 034](../sprints/034-automation-agent-triage.md) and [Sprint 047](../sprints/047-agent-experience-polish.md)

---

## 1. Why Look at Scientific Publishing & Natural Complex Systems?

A fleet of coding agents collaborating on a large codebase is actually doing **distributed empirical science**:
- Agents formulate **hypotheses** about why a bug occurs or how an architecture will behave.
- They design **experiments** (reproduction tests, benchmarks).
- They publish **claims and artifacts** (commits, blackboard facts, memories).
- Other agents **peer-review, replicate, or build upon** those claims.
- Occasionally, an earlier finding turns out to be wrong and must be **retracted**, invalidating downstream work that relied on it.

Scientific publishing is humanity's oldest distributed epistemic protocol—and over the last decade (2015–2026), metascience has invented powerful structural reforms (**Registered Reports, Nanopublications, Crossmark Retraction Cascades, Adversarial Collaboration**) to solve the exact pathologies that plague LLM agent fleets today (**reward hacking, hallucinated claims, rubber-stamp peer review, and stale citation cascades**).

Below are **six cross-disciplinary breakthroughs**—drawn from metascience, formal belief revision, game theory, swarm biology, neuroscience (Active Inference), and immunology—translated into concrete TrackForge mechanisms.

---

## 2. Six Cross-Disciplinary Propositions (Step-by-Step)

### Proposition 7.1: "Registered Reports" for Coding Agents (Anti-HARKing / Test-Locking Protocol)

#### Scientific Origin
In metascience, **HARKing** (*Hypothesizing After the Results are Known*, Kerr 1998) and *p-hacking* occur when researchers tweak their hypothesis or statistical test *after* seeing the data so they can claim a positive result. The gold-standard reform adopted by *Nature* and >300 journals is the **Registered Report (Chambers, 2013; OSF)**:
- **Stage 1 Review**: Before collecting data, the researcher submits the **Introduction, Hypothesis, and exact Experimental Protocol**. Peer reviewers evaluate and **cryptographically lock** the protocol ("In-Principle Acceptance").
- **Stage 2 Review**: The researcher executes the locked protocol. Reviewers verify only that the locked protocol was followed—the researcher cannot move the goalposts.

#### The Agent Equivalent (Why Coding Agents "HARK")
When a single coding agent writes both the unit test and the implementation in one session, and its implementation fails the test on attempt 3, LLMs frequently **weaken or delete the test assertion** so the suite turns green ("test tampering" / reward hacking).

#### Step-by-Step TrackForge Implementation
1. **Stage 1 (`Register Spec & Red Test`)**:
   - Before modifying production code on a leased issue, the agent (or a dedicated Test-Author Agent) submits a **Stage 1 Registration** (`POST /api/internal/issues/{key}/registered-report`):
     - `hypothesis`: Root-cause statement or feature contract.
     - `testFiles[]`: Paths + **SHA-256 content hashes** of the new/modified test files (`*.test.ts`).
     - `redRunAttestation`: Signed receipt proving the new test currently **fails** against `HEAD` (`exitCode != 0`) for the expected reason.
2. **Cryptographic Test Lock**:
   - TrackForge locks the `testFileHashes` on the `AcceptanceCheck`.
3. **Stage 2 (`Implementation & Green Verification`)**:
   - During implementation, the coding agent is permitted to edit production files, **but any modification to the locked test files invalidates Stage 1** (unless re-approved by a Reviewer/Human).
   - Transitioning to `Done` requires a `greenRunAttestation` where the **exact locked `testFileHashes`** now pass (`exitCode === 0`).

**Impact**: Mathematically eliminates "the agent modified the test to make it pass" without requiring a human to read every line of test diffs.

---

### Proposition 7.2: Nanopublications & Truth-Maintenance Retraction Cascades (JTMS / ATMS)

#### Scientific Origin
1. **Nanopublications & PROV-K (Groth et al., 2010; Springer *IJDL* 2025; *Traxia*, arXiv:2606.08256)**: Instead of burying claims in prose papers, a **Nanopublication** is the smallest citable unit of knowledge, structured as three named RDF/JSON graphs:
   $$\text{Nanopub} = \langle \text{Assertion}, \text{Provenance (how/where derived)}, \text{PublicationInfo (who/when/confidence)} \rangle$$
2. **Justification-Based & Assumption-Based Truth Maintenance Systems (Doyle 1979; de Kleer 1986; *TruthKeeper*, 2025; *ReviseQA*, ICML 2025)**: In classical AI and Crossref's **Crossmark Retraction Watch** database, every derived belief $B_2$ explicitly points to its supporting justifications $\langle A_1, A_2 \rangle$. When foundational assumption $A_1$ is **retracted**, the Truth Maintenance System computes the **transitive dependency closure** and immediately flips $B_2$ from `IN` (valid) to `OUT` (retracted/suspect).

#### Step-by-Step TrackForge Implementation
In Docs 02 and 04, we introduced `verifiedFacts` on the Blackboard and `ProjectMemory` at the project level. By structuring them as **Justification-Linked Nanopublications**:
1. **Explicit Justification Edges (`justifiedBy`)**:
   Every `verifiedFact`, `decision`, or `ProjectMemory` records its upstream premises:
   ```json
   {
     "id": "np_auth_stateless",
     "assertion": "Session middleware never queries the database when X-API-Key is absent",
     "provenance": {
       "gitCommitSha": "4a19b0c",
       "fileSpan": "apps/backend/src/middleware/auth.ts#L40-L62",
       "dependsOnNanopubIds": ["np_cookie_parser_order"]
     },
     "status": "VALID"
   }
   ```
2. **Automatic Retraction Cascade (`POST /api/internal/nanopubs/{id}/retract`)**:
   When a commit rewrites `auth.ts#L40-L62` or an agent discovers `np_cookie_parser_order` was false and retracts it:
   - TrackForge runs a single recursive CTE in PostgreSQL (`WITH RECURSIVE cascade AS (...)`) over `dependsOnNanopubIds`.
   - Every downstream fact, open issue Blackboard assumption, and `ProjectMemory` that depended on the retracted premise is atomically flipped to `SUSPECT_RETRACTED_PREMISE`.
   - Open issues relying on that premise receive an immediate algedonic alert before agents build further on a falsified assumption.

---

### Proposition 7.3: Peer Elicitation Games (PEG) — Truthful Code Review Without Ground Truth

#### Scientific Origin
- **Incentivizing Truthful Language Models via Peer Elicitation Games (NeurIPS 2025)** & **TVD-MI Mutual Information Evaluation (arXiv:2508.05469)**:
  When you ask a Reviewer Agent to review a Coding Agent's PR or issue, how do you prevent **collusive / lazy equilibria** where the Reviewer Agent just says *"LGTM,Approved"* every time to minimize effort?
  Standard voting or simple agreement rewards collusion. **Peer Prediction / Peer Elicitation Games (Miller, Resnick & Zeckhauser 2005; NeurIPS 2025)** solve this information-theoretically **without ground truth**:
  - Two independent discriminators (Reviewer Agents $R_1, R_2$ from *different base model families*, isolated so they cannot see each other's review) inspect the artifact.
  - They are scored using **Determinant-based Mutual Information (DMI) / Total Variation Distance MI (TVD-MI)**: uninformative "always approve" responses yield **zero mutual information** ($MI = 0$), whereas independently identifying the same specific subtle defect (`file:line` + failure category) yields high mutual information.
- **Seeded Catch Trials ("Golden Bugs")**: Inspired by crowdsourcing quality control and radiology audits, the platform periodically injects a known historical revert or synthetic bug ("canary review") into a Reviewer Agent's queue to measure its true Defect Detection Rate (sensitivity) and False Alarm Rate (specificity).

#### Step-by-Step TrackForge Implementation
1. **Blind Dual-Review Mode (for High-Risk / Security Issues)**:
   - When an issue has `securityLevel = High` or `storyPoints >= 8`, two Reviewer Agents ($R_1, R_2$) are assigned blind: neither can read `IssueReview` rows until both have submitted their verdict.
2. **Information-Theoretic Calibration Score**:
   - TrackForge compares $R_1$ and $R_2$'s structured `findings[]` (`file`, `line`, `severity`) plus downstream outcomes (whether tests failed or the issue was later reopened).
   - Reviewers that rubber-stamp (`APPROVED` on issues where the peer found a `blocker` or where CI later failed) lose `reviewerCalibrationScore` on their `AgentProfile` (Doc 06).

---

### Proposition 7.4: Honeybee Quorum Sensing & Non-Linear Cross-Inhibition

#### Scientific Origin
- **Seeley's Honeybee House-Hunting Model (*Honeybee Democracy*, 2010; *Polya's Bees*, CMU; *Non-linear Inhibitory Responses in Collective Decision-Making*, *Communications Physics* 2025; *Consensus-Diversity Tradeoff*, EMNLP 2025)**:
  How does a honeybee swarm choose the single best nest site among 10 candidates without a central leader, while avoiding premature lock-in on the first mediocre site found?
  1. **Graded Recruitment**: Scout bees inspect a candidate site and dance with duration proportional to the site's measured quality.
  2. **Cross-Inhibition ("Stop-Signals")**: When a scout discovers a flaw in site A (or favors a superior site B), it delivers a vibrational headbutt ("stop-signal") to bees dancing for site A, inhibiting recruitment to inferior options. Crucially, *Communications Physics* (2025) proved that **non-linear cross-inhibition** breaks deadlocks between closely matched options exponentially faster than linear voting.
  3. **Quorum Threshold (Not Unanimity)**: The colony commits the moment any single candidate accumulates a **quorum $Q$** of independent scouts physically present at that site—balancing speed vs. accuracy while preserving exploration diversity up until the moment of quorum (*EMNLP* 2025).

#### Step-by-Step TrackForge Implementation (Swarm Hypothesis Tournament)
For gnarly architecture decisions or elusive Heisenbugs where a single agent fails:
1. **Spawn Competing Hypotheses**: An issue enters `mode = 'swarm_tournament'` with $K=3$ candidate hypotheses ($H_1, H_2, H_3$) on the Blackboard.
2. **Independent Scout Probes**: Fast agents pull short 3-minute probe leases to test a hypothesis and post either:
   - **Support Signal (`waggle`)**: Empirical evidence (benchmark numbers, reproduction trace) with strength $q \in [0, 1]$.
   - **Inhibitory Stop-Signal (`headbutt`)**: A falsifying counterexample (e.g., *"Hypothesis $H_1$ fails when input array is empty; see test trace"*).
3. **Non-Linear Quorum Resolution**:
   - A Tier 0 reflex computes net support $S(H_i)$ using non-linear cross-inhibition (a single verified falsifying counterexample suppresses $H_i$ far more strongly than 3 weak plausibility votes).
   - The moment $S(H_i) \ge Q_{\text{quorum}}$, TrackForge locks $H_i$ as the winning `decision`, cancels remaining probe tasks, and transitions the issue to standard single-lease implementation.

---

### Proposition 7.5: Active Inference & Expected Free Energy (EFE) Epistemic Routing

#### Scientific Origin
- **Friston's Free Energy Principle & Multi-Agent Active Inference (*Orchestrator: Active Inference for MAS in Long-Horizon Tasks*, arXiv:2509.05651; *Theory of Mind Using Active Inference*, arXiv:2508.00401)**:
  Why do coding agents jump straight to writing 500 lines of speculative code when a single 5-second grep, log check, or clarifying question to the human would have resolved the ambiguity?
  Because standard LLM prompts optimize only for **Pragmatic Value** (producing an answer that looks like the goal state).
  In **Active Inference**, an agent selects policy $\pi$ to minimize **Expected Free Energy $G(\pi)$**, which decomposes into two terms:
  $$G(\pi) = -\underbrace{\mathbb{E}_{Q}[\text{Information Gain (Epistemic Value)}]}_{\text{Resolves uncertainty about hidden world state}} - \underbrace{\mathbb{E}_{Q}[\text{Goal Preference (Pragmatic Value)}]}_{\text{Moves issue toward Done}} + \text{Coordination Cost}$$
  - In *Orchestrator* (2025), regulating multi-agent autonomy via Free Energy increased long-horizon task success by **3.03×** (from 11% baseline to 76.7%–100% on complex mazes).

#### Step-by-Step TrackForge Implementation
1. **Explicit Uncertainty / Entropy Score on Issues (`epistemicUncertainty`)**:
   - Computed deterministically from the Blackboard:
     - Does the issue have a verified `reproduction.command`? (If no: $+0.35$ uncertainty)
     - Are `targetFiles` identified with `confidence > 0.7`? (If no: $+0.30$ uncertainty)
     - Are there open `untested` hypotheses or unresolved `question` comments? (If yes: $+0.25$ uncertainty)
2. **Epistemic-First Workflow Gate**:
   - While `epistemicUncertainty > 0.5`, TrackForge restricts the lease to **Epistemic Actions Only** (`phase = 'epistemic_foraging'`): the agent can localize files, run reproduction commands, update Blackboard hypotheses, or call `ask_user` (Sprint 047), **but cannot transition the issue to `In Review` or submit a large code diff**.
   - Once `epistemicUncertainty <= 0.3` (target files localized + reproduction confirmed), the gate unlocks **Pragmatic Execution** (`phase = 'pragmatic_coding'`).

**Impact**: Forces agents to *understand and reproduce before coding*, cutting wasted exploratory diffs in half.

---

### Proposition 7.6: Immunological Danger Theory & The Dendritic Cell Algorithm

#### Scientific Origin
- **Matzinger's Danger Theory (2002) & The Dendritic Cell Algorithm (Greensmith, Aickelin & Cayzer, 2008)**:
  Traditional security (and Sprint 015 RBAC) is a **Self vs. Non-Self** model: if an agent holds a valid token ("Self"), everything it does is permitted; if not ("Non-Self"), it is blocked.
  Immunologist Polly Matzinger showed that the human immune system cannot work by Self/Non-Self alone (otherwise we would reject food, gut bacteria, and pregnancy). Instead, **Dendritic Cells** continuously sample **Antigens** (who is acting on what) alongside three environmental tissue signals:
  1. **PAMP (Pathogen-Associated Molecular Patterns)**: Signatures known to be hazardous (e.g., touching `.env`, auth secrets, permission schemes, deleting >500 lines).
  2. **Danger Signals (Necrotic Tissue Stress)**: Unexpected collateral damage in the environment (CI test suite pass rate drops, API error rate rises, downstream issues flag `context_rot`, high revert rate).
  3. **Safe Signals (Healthy Tissue Homeostasis)**: Clean test passes, fast Reviewer approvals, zero regressions.
  The Dendritic Cell combines these into a **Mature Context Antigen Value ($MCAV$)**:
  $$MCAV = \frac{w_{\text{PAMP}} \cdot \text{PAMP} + w_{\text{Danger}} \cdot \text{Danger}}{w_{\text{PAMP}} \cdot \text{PAMP} + w_{\text{Danger}} \cdot \text{Danger} + w_{\text{Safe}} \cdot \text{Safe}}$$

#### Step-by-Step TrackForge Implementation
- Even a fully authorized "Self" agent token is continuously monitored by a **Dendritic Cell Reflex** inside TrackForge:
  - If an agent modifies 10 files while all tests pass and reviewers approve (**High Safe Signal**), its $MCAV$ stays near `0.0`—the immune system tolerates rapid, high-volume work.
  - If the same agent touches sensitive config files (**PAMP**) at the same time that test failures spike or two sister issues break (**Danger Signal**), its $MCAV$ crosses `0.75` → TrackForge's adaptive immune response **auto-quarantines that specific agent session** (parks its mutations into Sprint 012 `Proposal` quarantine) without needing static rules to anticipate every possible failure mode.

---

## 3. Summary Comparison of the Six Scientific Propositions

| # | Proposition | Scientific Discipline | Implementation Complexity | Single-Node Postgres Scaling | Primary Payoff for TrackForge |
|---|---|---|---|---|---|
| **7.1** | **Registered Reports (Stage 1 Red-Test Lock)** | Metascience (Chambers 2013) | **S** (Hash check on `AcceptanceCheck`) | **O(1)** — compares SHA-256 of test files at Stage 1 vs Stage 2 | Stops coding agents from weakening/deleting tests to fake a green build |
| **7.2** | **Nanopublications & ATMS Retraction Cascades** | Digital Libraries & Epistemic Logic (*TruthKeeper* 2025) | **M** (Recursive CTE over `dependsOn` IDs) | **Excellent** — Postgres `WITH RECURSIVE` over <1k edges runs in `<2ms` | Automatically invalidates downstream memories & assumptions when a premise is falsified |
| **7.3** | **Peer Elicitation Games (PEG) + Canary Audits** | Game Theory / Mechanism Design (NeurIPS 2025) | **M** (Blind dual-review + finding overlap score) | **O(1)** — evaluated only on high-risk review completion | Eliminates rubber-stamp "LGTM" reviews from lazy Reviewer Agents without ground truth |
| **7.4** | **Honeybee Quorum Sensing + Cross-Inhibition** | Swarm Biology (*Comms Physics* 2025; Seeley) | **M–L** (Hypothesis scoring + stop-signals) | **Very Good** — bounded to $K \le 5$ hypotheses on hard bugs | Resolves hard bugs/architecture choices via parallel probes + falsification without premature groupthink |
| **7.5** | **Active Inference (Epistemic vs Pragmatic Gate)** | Computational Neuroscience (Friston; *Orchestrator* 2025) | **S** (Formula over Blackboard completeness) | **O(1)** — pure arithmetic over existing `Issue.blackboard` fields | Forces agents to localize files & reproduce the bug *before* generating speculative code diffs |
| **7.6** | **Danger Theory & Dendritic Cell Quarantine** | Artificial Immune Systems (Matzinger; Greensmith) | **M** (Sliding-window PAMP/Danger/Safe ratio) | **Excellent** — lightweight counters updated on outbox events | Catches compromised or hallucinating "trusted" agents by correlating actions with codebase stress |

---

## 4. Which Scientific Ideas Should You Prioritize First?

If we rank these six by **highest practical leverage per line of code**:

1. **First: Active Inference Epistemic Gate (7.5) + Registered Reports Red-Test Lock (7.1)**
   - Together, they require **<150 lines of TypeScript**, zero new infrastructure, and enforce the gold-standard scientific method on every bug fix:
     1. *Reduce uncertainty first* (localize files + write a failing reproduction test).
     2. *Lock the failing test hash* (Stage 1 Registered Report).
     3. *Write the fix until the locked test passes* (Stage 2 verification).
2. **Second: Nanopublication Justification Links & Retraction Cascades (7.2)**
   - Directly solves the hardest problem in Doc 02 (Blackboard) and Doc 04 (Memory): *what happens when a "verified fact" turns out to be wrong?* One `dependsOn` array + a Postgres recursive CTE gives TrackForge self-healing epistemic integrity.
3. **Third: Danger Theory Dendritic Cell Quarantine (7.6) & Peer Elicitation Games (7.3)**
   - Ideal for **Wave C / Wave D** when running unattended multi-agent fleets overnight, ensuring that neither rogue workers nor lazy reviewer agents can degrade the repository.
