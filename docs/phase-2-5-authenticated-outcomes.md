# Phase 2.5 — Authenticated operator outcomes

## Repository authentication audit

Before Phase 2.5, the application had no login, user table, verified session,
JWT middleware, current-user endpoint, or application role model. OAuth and
tokens in the repository authenticated external integrations only; they were
not operator identities and were not reused.

## Boundary implemented

The backend now provides a minimal development operator adapter with these
properties:

- explicit opt-in configuration;
- no seeded/default/fake user;
- server-configured stable users, roles, and permissions;
- scrypt password verification;
- signed, expiring, HttpOnly, SameSite session cookie;
- per-session CSRF proof for outcome writes;
- localhost-only operation;
- mandatory failure when `NODE_ENV=production`;
- bounded login-failure throttling;
- no accepted user identity from request bodies or identity headers.

`GET /api/auth/me` is the canonical current-user endpoint and returns HTTP 401
when no verified session exists. Outcome capture accepts `operator`,
`incident_manager`, `admin`, or `outcomes:write`, and rejects non-human/service
principals.

This adapter is not a substitute for production SSO. A production deployment
must connect a real identity provider and attach the same trusted principal
shape server-side. Until then, production writes stay unavailable.

## Data safety

Phase 2.5 adds authentication and audit columns only. It does not seed users,
create outcomes, relabel alerts, train a model, mutate Jira, mutate Slack, or
call monitoring write APIs. Existing operational outcomes remain versioned and
corrections remain append-only.
