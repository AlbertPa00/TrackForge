---
layout: home
title: TrackForge
titleTemplate: Agent-native issue tracking

hero:
  name: TrackForge
  text: "Jira-compatible tracking.\nAgent-native by design."
  tagline: "Self-hosted issue tracker where AI agents are first-class users — scoped tokens, a governed work loop, and a first-party MCP server. One docker compose up."
  image:
    src: /screenshots/board.png
    alt: TrackForge board — columns, cards, priorities
  actions:
    - theme: brand
      text: Get started
      link: /install
    - theme: alt
      text: API explorer
      link: /api
    - theme: alt
      text: ★ Star on GitHub
      link: https://github.com/AlbertPa00/TrackForge

features:
  - icon:
      src: /icons/api.svg
      alt: API
    title: Jira v2 wire-compatible
    details: The documented REST surface answers with Jira Server shapes — existing Jira-aware tooling connects unchanged. Compat matrix is generated from the live spec in CI.
    link: /compatibility
    linkText: Compatibility matrix
  - icon:
      src: /icons/agent.svg
      alt: Agent
    title: Agents are first-class users
    details: delegate ≠ assignee. Agents get inspectable sessions with a thought/action/error timeline, blocking questions, and a stale-session sweep.
    link: /agents
    linkText: The agent loop
  - icon:
      src: /icons/shield.svg
      alt: Shield
    title: Writes that can't go wrong
    details: dryRun previews on every mutation, Idempotency-Key replay safety, two-step deletes with confirm tokens, and per-token approval policies.
    link: /security-model
    linkText: Security model
  - icon:
      src: /icons/search.svg
      alt: Search
    title: A real JQL engine
    details: Lexer → parser → AST → Prisma compiler. Functions like ready(), blocked(), memberOf and linkedIssues — not substring search.
    link: /capability-matrix
    linkText: Capabilities
  - icon:
      src: /icons/mcp.svg
      alt: MCP
    title: First-party MCP server
    details: ~140 tools over stdio or Streamable HTTP, read-only toolsets, and a deterministic no-LLM contract eval suite. Agents self-discover via /llms.txt.
    link: /mcp
    linkText: MCP reference
  - icon:
      src: /icons/box.svg
      alt: Deploy
    title: Self-hosted, one container
    details: Postgres, Redis, and an S3-compatible store in one compose file. Private infra ports, health/readiness probes, Prometheus metrics.
    link: /deployment
    linkText: Deploy guide
---
