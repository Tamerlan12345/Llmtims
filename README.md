# Llmtims / Pixel Office CIC

## Fresh clone

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Production requires the variables listed in `.env.example`. Do not rely on local
`node_modules` state; CI installs from `package-lock.json` with `npm ci`.

For local development without Supabase, set `ALLOW_MOCK_ADMIN_AUTH=true`.
Never enable mock admin auth in production.
