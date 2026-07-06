---
id: REQ-42
title: Short imperative title of the ask
priority: normal   # low | normal | high — high is planned and built first
---

Describe WHAT you want and WHY, like a good ticket. The planner reads the
affected repos itself — describe outcomes and acceptance criteria, not
implementation steps.

Good example body:

> Add a `POST /v1/claims` endpoint to bff-web that accepts a claim request,
> validates policy number format (`P-\d{8}`), and forwards to the claims
> service. Reject invalid payloads with 400 and a field-level error body.
> Acceptance: a Bruno test posting a valid claim gets 202 with a claimId;
> an invalid policy number gets 400 naming the field.

Steering notes use the same inbox but have NO `id:` frontmatter — just plain
instructions ("pause repo bff-web", "REQ-41 first", "kill the builder on
REQ-40-s2").
