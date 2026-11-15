# Sprint 009 tasks

- [x] Schema + migration + seed (two workflows, statuses, boards per project)
- [x] LexoRank helper (`rankBetween`, `spreadRanks`)
- [x] workflowService: listing, rule pipeline, screens, CRUD, project assignment w/ mapping
- [x] issueService: workflow initial status, rank on create, PUT status rejection
- [x] boardService: persisted boards, resolveBoard alias, config GET/PUT, rank-sorted issues, rankIssues + rebalance
- [x] Routes: transitions (fields+update.comment), project statuses, /workflow, internal workflows CRUD, board configuration PUT, PUT /issue/rank
- [x] OpenAPI paths + drift test green
- [x] Frontend: TransitionScreenModal, StatusTransitionMenu (names + screens), board drop→transition resolution, multi-status columns, WIP headers, rank persistence, BoardSettingsPage, WorkflowsPage + WorkflowEditorPage, project workflow switcher
- [x] MCP: get_transitions (screen fields), transition_issue (fields/comment), get_workflow, get_board, get_board_issues, rank_issue, move_card
- [x] Tests: transitionTo helper, migrated PUT-status tests, new transition contract tests — 86/86 green
- [x] Contract doc (transition ids, PUT rejection, new endpoints)
- [ ] Roadmap/sprint-doc status flip
- [ ] Live verification + commit
