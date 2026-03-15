# F1 Cloudflare Dashboard

Cloudflare Worker-project voor een F1-dashboard met:
- statische frontend op dezelfde Worker
- live feitenlaag via Jolpica F1-data
- D1-opslag van cache en raceverslagen
- OpenAI Responses API voor journalistieke raceverslagen
- aparte refresh-knoppen voor feiten en verslagen

## Nieuwe logica

### Refresh standen & uitslagen
Ververst altijd opnieuw:
- kalender
- officiële uitslagen
- sprintuitslagen
- rijdersstand
- constructeursstand

### Refresh verslagen
- maakt altijd een verslag als er nog geen verslag bestaat
- mag een bestaand verslag opnieuw schrijven tot 24 uur na de race-datetime
- laat een bestaand verslag daarna staan

## OpenAI

Dit project gebruikt de Responses API van OpenAI met model `gpt-5-mini`.

Voeg in Cloudflare een secret toe met exact deze naam:

```
OPENAI_API_KEY
```

## Bestanden

- `src/index.ts` -> Worker, API-routes, OpenAI-aanroep, D1-logica
- `public/index.html` -> frontend shell en refresh-knoppen
- `public/style.css` -> styling inclusief refresh-toolbar
- `public/app.js` -> dashboardlogica, tabs, frontend-refresh
- `migrations/0001_init.sql` -> basisschema
- `migrations/0002_openai_split_refresh.sql` -> veilige extra indexen voor het nieuwe schema

## Cloudflare-dashboardroute

1. Upload de projectbestanden naar GitHub.
2. Koppel de repository in **Workers & Pages**.
3. Maak in Cloudflare een D1-database aan.
4. Voeg in je Worker een **D1 binding** toe met naam `DB`.
5. Voeg in je Worker een secret toe met naam `OPENAI_API_KEY`.
6. Voer eerst `0001_init.sql` uit en daarna `0002_openai_split_refresh.sql`.
7. Deploy opnieuw vanuit GitHub.

## Lokale route

```bash
npm install
npx wrangler d1 create f1-dashboard-db
```

Vul daarna in `wrangler.jsonc` het echte `database_id` in.

Voer vervolgens de migraties uit:

```bash
npx wrangler d1 migrations apply f1-dashboard-db --local
npx wrangler d1 migrations apply f1-dashboard-db --remote
```

Daarna lokaal starten:

```bash
npm run dev
```

## Belangrijk

- `refresh-facts` mag feitelijke data altijd overschrijven
- `refresh-reports` maakt nieuwe verslagen altijd aan
- bestaande verslagen mogen alleen worden vernieuwd tot 24 uur na de race
- daarna staat het verslag vast
