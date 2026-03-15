type D1Database = any;
    type Fetcher = any;
    declare const crypto: Crypto;

    export interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      F1_SEASON_YEAR?: string;
      OPENAI_API_KEY?: string;
    }

    type ErgastDriver = {
      driverId?: string;
      code?: string;
      givenName?: string;
      familyName?: string;
      permanentNumber?: string;
      nationality?: string;
    };

    type ErgastConstructor = { constructorId?: string; name?: string; nationality?: string };
    type ErgastLocation = { locality?: string; country?: string; lat?: string; long?: string };
    type ErgastCircuit = { circuitId?: string; circuitName?: string; Location?: ErgastLocation };

    type ErgastFastestLap = {
      rank?: string;
      lap?: string;
      Time?: { time?: string };
      AverageSpeed?: { speed?: string; units?: string };
    };

    type ErgastResult = {
      number?: string;
      position?: string;
      positionText?: string;
      grid?: string;
      status?: string;
      laps?: string;
      points?: string;
      Time?: { millis?: string; time?: string };
      Driver?: ErgastDriver;
      Constructor?: ErgastConstructor;
      FastestLap?: ErgastFastestLap;
    };

    type ErgastRace = {
      season?: string;
      round?: string;
      url?: string;
      raceName?: string;
      Circuit?: ErgastCircuit;
      date?: string;
      time?: string;
      Results?: ErgastResult[];
      SprintResults?: ErgastResult[];
    };

    type DriverStanding = {
      position?: string;
      points?: string;
      wins?: string;
      Driver?: ErgastDriver;
      Constructors?: ErgastConstructor[];
    };

    type ConstructorStanding = {
      position?: string;
      points?: string;
      wins?: string;
      Constructor?: ErgastConstructor;
    };

    type RaceTablePayload = {
      MRData?: {
        RaceTable?: { season?: string; Races?: ErgastRace[] };
        StandingsTable?: {
          season?: string;
          StandingsLists?: Array<{
            DriverStandings?: DriverStanding[];
            ConstructorStandings?: ConstructorStanding[];
          }>;
        };
      };
    };

    type CacheRow = {
      json_value?: string;
      updated_at?: string;
    };

    type SavedRaceReport = {
      season: number;
      round: number;
      race_name: string;
      race_date: string | null;
      race_time: string | null;
      race_datetime_utc: string | null;
      circuit_name: string | null;
      locality: string | null;
      country: string | null;
      winner_name: string | null;
      winner_team: string | null;
      podium_json: string;
      highlights_json: string;
      report_text: string;
      source_payload_json: string;
      source_hash: string;
      report_model: string | null;
      report_source: string | null;
      created_at: string;
      updated_at: string;
    };

    type GeneratedReport = {
      winner: string;
      winnerTeam: string;
      podium: Array<{ pos: number; name: string; team: string }>;
      highlights: string[];
      report: string;
    };

    const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';
    const SCHEDULE_KEY = 'season-schedule';
    const RESULTS_KEY = 'race-results';
    const SPRINT_RESULTS_KEY = 'sprint-results';
    const DRIVER_STANDINGS_KEY = 'driver-standings';
    const CONSTRUCTOR_STANDINGS_KEY = 'constructor-standings';
    const OPENAI_MODEL = 'gpt-5-mini';
    const FACTS_CACHE_TTL_SECONDS = 300;
    const REPORT_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

    export default {
      async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/api/dashboard' && request.method === 'GET') {
          try {
            return json(await getDashboard(env), {
              headers: { 'cache-control': `public, max-age=${FACTS_CACHE_TTL_SECONDS}` }
            });
          } catch (error) {
            return json({ ok: false, error: getErrorMessage(error) }, { status: 500 });
          }
        }

        if (url.pathname === '/api/refresh-facts' && request.method === 'POST') {
          try {
            return json(await refreshFacts(env));
          } catch (error) {
            return json({ ok: false, error: getErrorMessage(error) }, { status: 500 });
          }
        }

        if (url.pathname === '/api/refresh-reports' && request.method === 'POST') {
          try {
            return json(await refreshReports(env));
          } catch (error) {
            return json({ ok: false, error: getErrorMessage(error) }, { status: 500 });
          }
        }

        if (url.pathname === '/api/health' && request.method === 'GET') {
          return json({ ok: true, service: 'f1-cloudflare-dashboard', model: OPENAI_MODEL });
        }

        return env.ASSETS.fetch(request);
      }
    };

    async function refreshFacts(env: Env) {
      const season = getSeason(env);
      const [scheduleRes, resultsRes, sprintRes, driverRes, constructorRes] = await Promise.all([
        fetchJson<RaceTablePayload>(`${JOLPICA_BASE}/${season}.json`),
        fetchJson<RaceTablePayload>(`${JOLPICA_BASE}/${season}/results.json?limit=100`),
        fetchJson<RaceTablePayload>(`${JOLPICA_BASE}/${season}/sprint.json?limit=100`).catch(() => ({ MRData: { RaceTable: { Races: [] } } })),
        fetchJson<RaceTablePayload>(`${JOLPICA_BASE}/${season}/driverStandings.json`),
        fetchJson<RaceTablePayload>(`${JOLPICA_BASE}/${season}/constructorStandings.json`)
      ]);

      const schedule = scheduleRes.MRData?.RaceTable?.Races ?? [];
      const results = resultsRes.MRData?.RaceTable?.Races ?? [];
      const sprintResults = sprintRes.MRData?.RaceTable?.Races ?? [];
      const driverStandings = driverRes.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? [];
      const constructorStandings = constructorRes.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings ?? [];

      await Promise.all([
        upsertCache(env.DB, SCHEDULE_KEY, schedule),
        upsertCache(env.DB, RESULTS_KEY, results),
        upsertCache(env.DB, SPRINT_RESULTS_KEY, sprintResults),
        upsertCache(env.DB, DRIVER_STANDINGS_KEY, driverStandings),
        upsertCache(env.DB, CONSTRUCTOR_STANDINGS_KEY, constructorStandings)
      ]);

      return {
        ok: true,
        season,
        scheduleCount: schedule.length,
        resultsCount: results.length,
        sprintCount: sprintResults.length,
        driverStandingsCount: driverStandings.length,
        constructorStandingsCount: constructorStandings.length,
        factsUpdatedAt: new Date().toISOString()
      };
    }

    async function refreshReports(env: Env) {
      const season = getSeason(env);
      const facts = await ensureFacts(env);
      const completedRaces = facts.results;
      const sprintRaces = facts.sprintResults;
      const driverStandings = facts.driverStandings;
      const constructorStandings = facts.constructorStandings;

      let generatedReports = 0;
      let updatedReports = 0;
      let skippedLockedReports = 0;
      let alreadyCurrent = 0;

      for (const race of completedRaces) {
        const round = toNumber(race.round);
        if (!round) continue;

        const sprintRace = sprintRaces.find((item) => toNumber(item.round) === round) ?? null;
        const payload = buildSourcePayload(race, sprintRace, driverStandings, constructorStandings);
        const sourceHash = await sha256(JSON.stringify(payload));
        const existing = await (env.DB.prepare(`SELECT * FROM race_reports WHERE season = ?1 AND round = ?2`).bind(season, round).first() as Promise<SavedRaceReport | null>);

        const hasExisting = Boolean(existing);
        const existingHash = existing?.source_hash ?? null;
        const canUpdateExisting = hasExisting ? reportIsStillEditable(existing?.race_datetime_utc ?? null) : false;

        if (hasExisting && !canUpdateExisting) {
          skippedLockedReports += 1;
          continue;
        }

        if (hasExisting && existingHash === sourceHash && canUpdateExisting) {
          alreadyCurrent += 1;
          continue;
        }

        const generated = await generateRaceReport(env, payload);
        const nowIso = new Date().toISOString();

        await env.DB.prepare(`
          INSERT OR REPLACE INTO race_reports (
            season, round, race_name, race_date, race_time, race_datetime_utc,
            circuit_name, locality, country,
            winner_name, winner_team, podium_json, highlights_json, report_text,
            source_payload_json, source_hash, report_model, report_source, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9,
            ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18,
            COALESCE((SELECT created_at FROM race_reports WHERE season = ?1 AND round = ?2), ?19),
            ?20
          )
        `).bind(
          season,
          round,
          race.raceName ?? `Round ${round}`,
          race.date ?? null,
          race.time ?? null,
          getRaceDateTimeUtc(race),
          race.Circuit?.circuitName ?? null,
          race.Circuit?.Location?.locality ?? null,
          race.Circuit?.Location?.country ?? null,
          generated.winner,
          generated.winnerTeam,
          JSON.stringify(generated.podium),
          JSON.stringify(generated.highlights),
          generated.report,
          JSON.stringify(payload),
          sourceHash,
          OPENAI_MODEL,
          env.OPENAI_API_KEY ? 'openai-responses' : 'fallback',
          existing?.created_at ?? nowIso,
          nowIso
        ).run();

        if (hasExisting) updatedReports += 1;
        else generatedReports += 1;
      }

      return {
        ok: true,
        season,
        generatedReports,
        updatedReports,
        skippedLockedReports,
        alreadyCurrent,
        reportsUpdatedAt: new Date().toISOString()
      };
    }

    async function getDashboard(env: Env) {
      const season = getSeason(env);
      const [scheduleEntry, resultsEntry, sprintEntry, driverEntry, constructorEntry, reportsEntry] = await Promise.all([
        getCacheWithMeta(env.DB, SCHEDULE_KEY),
        getCacheWithMeta(env.DB, RESULTS_KEY),
        getCacheWithMeta(env.DB, SPRINT_RESULTS_KEY),
        getCacheWithMeta(env.DB, DRIVER_STANDINGS_KEY),
        getCacheWithMeta(env.DB, CONSTRUCTOR_STANDINGS_KEY),
        env.DB.prepare(`SELECT * FROM race_reports WHERE season = ?1 ORDER BY round DESC`).bind(season).all() as Promise<{ results: SavedRaceReport[] }>
      ]);

      const factsUpdatedAt = [scheduleEntry.updatedAt, resultsEntry.updatedAt, sprintEntry.updatedAt, driverEntry.updatedAt, constructorEntry.updatedAt]
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;

      const reportsUpdatedAt = (reportsEntry.results ?? []).map((row) => row.updated_at).filter(Boolean).sort().at(-1) ?? null;
      const updatedAt = [factsUpdatedAt, reportsUpdatedAt].filter(Boolean).sort().at(-1) ?? null;
      const completedRounds = new Set(((resultsEntry.value ?? []) as ErgastRace[]).map((race) => toNumber(race.round)));

      return {
        season,
        updatedAt,
        factsUpdatedAt,
        reportsUpdatedAt,
        schedule: ((scheduleEntry.value ?? []) as ErgastRace[]).map((race) => mapScheduleRace(race, completedRounds.has(toNumber(race.round)))),
        driverStandings: ((driverEntry.value ?? []) as DriverStanding[]).map(mapDriverStanding),
        constructorStandings: ((constructorEntry.value ?? []) as ConstructorStanding[]).map(mapConstructorStanding),
        reports: (reportsEntry.results ?? []).map(mapSavedReport)
      };
    }

    async function ensureFacts(env: Env) {
      const [scheduleEntry, resultsEntry, sprintEntry, driverEntry, constructorEntry] = await Promise.all([
        getCacheWithMeta(env.DB, SCHEDULE_KEY),
        getCacheWithMeta(env.DB, RESULTS_KEY),
        getCacheWithMeta(env.DB, SPRINT_RESULTS_KEY),
        getCacheWithMeta(env.DB, DRIVER_STANDINGS_KEY),
        getCacheWithMeta(env.DB, CONSTRUCTOR_STANDINGS_KEY)
      ]);

      if (scheduleEntry.value && resultsEntry.value && driverEntry.value && constructorEntry.value) {
        return {
          schedule: scheduleEntry.value as ErgastRace[],
          results: resultsEntry.value as ErgastRace[],
          sprintResults: (sprintEntry.value ?? []) as ErgastRace[],
          driverStandings: driverEntry.value as DriverStanding[],
          constructorStandings: constructorEntry.value as ConstructorStanding[]
        };
      }

      await refreshFacts(env);
      return ensureFacts(env);
    }

    async function generateRaceReport(env: Env, payload: ReturnType<typeof buildSourcePayload>): Promise<GeneratedReport> {
      if (!env.OPENAI_API_KEY) {
        return buildFallbackReport(payload);
      }

      const systemPrompt = [
        'Je bent een Nederlandse sportjournalist voor een Formule 1-dashboard.',
        'Schrijf feitelijk, levendig en compact.',
        'Gebruik uitsluitend de aangeleverde data. Verzin niets.',
        'Noem geen details die niet in de input staan.',
        'Geef exact JSON terug met deze velden: winner, winnerTeam, podium, highlights, report.',
        'highlights moet een array zijn van 3 tot 5 korte punten.',
        'report moet bestaan uit 2 tot 4 alinea\'s in verzorgd Nederlands.'
      ].join(' ');

      const userPrompt = `Maak een journalistiek raceverslag van deze data:\n${JSON.stringify(payload)}`;

      try {
        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            instructions: systemPrompt,
            input: userPrompt,
            max_output_tokens: 1200
          })
        });

        if (!response.ok) {
          return buildFallbackReport(payload);
        }

        const data = await response.json() as any;
        const rawText = extractOpenAiText(data);
        const parsed = safeJsonParse<Partial<GeneratedReport> | null>(rawText, null);
        if (!parsed?.report || !Array.isArray(parsed.podium) || !Array.isArray(parsed.highlights)) {
          return buildFallbackReport(payload);
        }
        return normalizeGeneratedReport(parsed, payload);
      } catch {
        return buildFallbackReport(payload);
      }
    }

    function buildSourcePayload(
      race: ErgastRace,
      sprint: ErgastRace | null,
      driverStandings: DriverStanding[],
      constructorStandings: ConstructorStanding[]
    ) {
      const results = race.Results ?? [];
      const sprintResults = sprint?.SprintResults ?? [];
      const fastestLap = results
        .map((item) => ({
          rank: toNumber(item.FastestLap?.rank),
          name: formatDriverName(item.Driver),
          team: item.Constructor?.name ?? 'Onbekend',
          time: item.FastestLap?.Time?.time ?? null
        }))
        .find((item) => item.rank === 1) ?? null;

      return {
        season: toNumber(race.season),
        round: toNumber(race.round),
        raceName: race.raceName ?? 'Grand Prix',
        date: race.date ?? null,
        time: race.time ?? null,
        raceDateTimeUtc: getRaceDateTimeUtc(race),
        circuit: race.Circuit?.circuitName ?? null,
        location: {
          locality: race.Circuit?.Location?.locality ?? null,
          country: race.Circuit?.Location?.country ?? null
        },
        winner: summarizeResult(results[0]),
        podium: results.slice(0, 3).map((item, index) => ({
          pos: index + 1,
          name: formatDriverName(item.Driver),
          team: item.Constructor?.name ?? 'Onbekend'
        })),
        finishersTop10: results.slice(0, 10).map((item) => ({
          pos: toNumber(item.position),
          name: formatDriverName(item.Driver),
          team: item.Constructor?.name ?? 'Onbekend',
          grid: toNumber(item.grid),
          status: item.status ?? null,
          points: toNumber(item.points)
        })),
        gainers: results
          .map((item) => ({
            name: formatDriverName(item.Driver),
            team: item.Constructor?.name ?? 'Onbekend',
            grid: toNumber(item.grid),
            finish: toNumber(item.position),
            gained: toNumber(item.grid) - toNumber(item.position)
          }))
          .filter((item) => Number.isFinite(item.gained) && item.gained > 0)
          .sort((a, b) => b.gained - a.gained)
          .slice(0, 4),
        dnfs: results
          .filter((item) => !isFinishedStatus(item.status))
          .map((item) => ({
            name: formatDriverName(item.Driver),
            team: item.Constructor?.name ?? 'Onbekend',
            status: item.status ?? 'Uitgevallen'
          })),
        fastestLap,
        sprint: sprint
          ? {
              raceName: sprint.raceName ?? race.raceName ?? 'Sprint',
              podium: sprintResults.slice(0, 3).map((item, index) => ({
                pos: index + 1,
                name: formatDriverName(item.Driver),
                team: item.Constructor?.name ?? 'Onbekend'
              }))
            }
          : null,
        championship: summarizeStandings(driverStandings, constructorStandings)
      };
    }

    function buildFallbackReport(payload: ReturnType<typeof buildSourcePayload>): GeneratedReport {
      const winner = payload.winner.name || 'Onbekend';
      const winnerTeam = payload.winner.team || 'Onbekend';
      const podium = payload.podium;
      const highlights: string[] = [];

      highlights.push(`${winner} won de ${payload.raceName} voor ${winnerTeam}.`);
      if (podium[1] && podium[2]) highlights.push(`${podium[1].name} en ${podium[2].name} completeerden het podium.`);
      if (payload.gainers[0]) highlights.push(`${payload.gainers[0].name} viel op met winst van ${payload.gainers[0].gained} plaatsen.`);
      if (payload.fastestLap?.name) highlights.push(`De snelste ronde kwam op naam van ${payload.fastestLap.name}${payload.fastestLap.time ? ` in ${payload.fastestLap.time}` : ''}.`);
      else if (payload.dnfs[0]) highlights.push(`Uitvallers waren onder meer ${payload.dnfs.slice(0, 3).map((item) => item.name).join(', ')}.`);

      const sprintParagraph = payload.sprint?.podium?.[0]
        ? ` Het sprintgedeelte van het weekend werd gewonnen door ${payload.sprint.podium[0].name}${payload.sprint.podium[1] ? `, met daarnaast ${payload.sprint.podium[1].name} en ${payload.sprint.podium[2]?.name ?? ''} vooraan.` : '.'}`
        : '';

      const championshipLeader = payload.championship.driversTop3[0];
      const report = `${winner} heeft de ${payload.raceName} gewonnen en daarmee de sterkste indruk van het weekend achtergelaten voor ${winnerTeam}. Het podium bestond verder uit ${podium.slice(1).map((item) => item.name).join(' en ') || 'de overige toppers in de uitslag'}. ${payload.gainers[0] ? `${payload.gainers.map((item) => `${item.name} won ${item.gained} plaatsen ten opzichte van de startopstelling`).join(', ')}.` : 'De uitslag liet vooral een duidelijke volgorde aan de voorkant van het veld zien.'}${sprintParagraph}

${payload.dnfs[0] ? `Niet iedereen haalde de finish: ${payload.dnfs.slice(0, 3).map((item) => `${item.name} (${item.status})`).join(', ')}.` : 'Op basis van de officiële data waren er geen opvallende uitvallers die het beeld volledig op zijn kop zetten.'} ${payload.fastestLap?.name ? `De snelste ronde kwam op naam van ${payload.fastestLap.name}.` : ''} ${championshipLeader?.name ? `In het kampioenschap blijft ${championshipLeader.name} vooralsnog het referentiepunt bovenaan de stand.` : ''}`.trim();

      return { winner, winnerTeam, podium, highlights: highlights.slice(0, 5), report };
    }

    function normalizeGeneratedReport(parsed: Partial<GeneratedReport>, payload: ReturnType<typeof buildSourcePayload>): GeneratedReport {
      const fallback = buildFallbackReport(payload);
      const cleanedPodium = Array.isArray(parsed.podium)
        ? parsed.podium
            .map((item: any, index) => ({
              pos: toNumber(item?.pos) || index + 1,
              name: String(item?.name || '').trim(),
              team: String(item?.team || '').trim()
            }))
            .filter((item) => item.name)
            .slice(0, 3)
        : [];
      const cleanedHighlights = Array.isArray(parsed.highlights)
        ? parsed.highlights.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
        : [];

      return {
        winner: String(parsed.winner || fallback.winner).trim(),
        winnerTeam: String(parsed.winnerTeam || fallback.winnerTeam).trim(),
        podium: cleanedPodium.length ? cleanedPodium : fallback.podium,
        highlights: cleanedHighlights.length ? cleanedHighlights : fallback.highlights,
        report: String(parsed.report || fallback.report).trim()
      };
    }

    function summarizeStandings(driverStandings: DriverStanding[], constructorStandings: ConstructorStanding[]) {
      return {
        driversTop3: driverStandings.slice(0, 3).map((item) => ({
          pos: toNumber(item.position),
          name: formatDriverName(item.Driver),
          team: item.Constructors?.[0]?.name ?? 'Onbekend',
          pts: toNumber(item.points)
        })),
        constructorsTop3: constructorStandings.slice(0, 3).map((item) => ({
          pos: toNumber(item.position),
          name: item.Constructor?.name ?? 'Onbekend',
          pts: toNumber(item.points)
        }))
      };
    }

    async function upsertCache(db: D1Database, key: string, value: unknown) {
      await db.prepare(`INSERT OR REPLACE INTO cache_entries (cache_key, json_value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)`).bind(key, JSON.stringify(value)).run();
    }

    async function getCacheWithMeta(db: D1Database, key: string) {
      const row = await (db.prepare(`SELECT json_value, updated_at FROM cache_entries WHERE cache_key = ?1`).bind(key).first() as Promise<CacheRow | null>);
      return {
        value: row?.json_value ? safeJsonParse<any[] | null>(row.json_value, null) : null,
        updatedAt: row?.updated_at ?? null
      };
    }

    async function fetchJson<T>(url: string): Promise<T> {
      const response = await fetch(url, { cf: { cacheTtl: FACTS_CACHE_TTL_SECONDS, cacheEverything: true } } as any);
      if (!response.ok) throw new Error(`Fetch mislukt: ${url}`);
      return response.json() as Promise<T>;
    }

    function mapScheduleRace(race: ErgastRace, done: boolean) {
      const locality = race.Circuit?.Location?.locality ?? '';
      const country = race.Circuit?.Location?.country ?? '';
      return {
        n: toNumber(race.round),
        gpName: race.raceName ?? 'Grand Prix',
        circuit: race.Circuit?.circuitName ?? '',
        loc: [locality, country].filter(Boolean).join(', '),
        date: race.date ?? '',
        time: race.time ? formatNLTime(race.time) : '',
        flag: getFlagByCountry(country),
        done
      };
    }

    function mapDriverStanding(item: DriverStanding) {
      return {
        pos: toNumber(item.position),
        name: formatDriverName(item.Driver),
        team: item.Constructors?.[0]?.name ?? 'Onbekend',
        pts: toNumber(item.points)
      };
    }

    function mapConstructorStanding(item: ConstructorStanding) {
      return {
        pos: toNumber(item.position),
        name: item.Constructor?.name ?? 'Onbekend',
        pts: toNumber(item.points)
      };
    }

    function mapSavedReport(row: SavedRaceReport) {
      const editableUntil = getEditableUntilIso(row.race_datetime_utc);
      const isEditable = reportIsStillEditable(row.race_datetime_utc);
      return {
        n: row.round,
        name: row.race_name,
        date: row.race_date,
        time: row.race_time,
        raceDateTimeUtc: row.race_datetime_utc,
        circuit: row.circuit_name,
        locality: row.locality,
        country: row.country,
        winner: row.winner_name,
        winnerTeam: row.winner_team,
        podium: safeJsonParse(row.podium_json, []),
        highlights: safeJsonParse(row.highlights_json, []),
        report: row.report_text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        reportModel: row.report_model,
        reportSource: row.report_source,
        editableUntil,
        isEditable,
        isLocked: !isEditable,
        flag: getFlagByCountry(row.country)
      };
    }

    function summarizeResult(item?: ErgastResult) {
      return {
        name: formatDriverName(item?.Driver),
        team: item?.Constructor?.name ?? 'Onbekend',
        position: toNumber(item?.position),
        points: toNumber(item?.points)
      };
    }

    function formatDriverName(driver?: ErgastDriver) {
      return `${driver?.givenName ?? ''} ${driver?.familyName ?? ''}`.trim() || 'Onbekend';
    }

    function isFinishedStatus(status?: string) {
      const value = (status || '').toLowerCase();
      return value.startsWith('finished') || value.includes('+');
    }

    function extractOpenAiText(response: any): string {
      if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text;
      if (Array.isArray(response?.output)) {
        const chunks = response.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : []).map((content: any) => content?.text || '').filter(Boolean);
        if (chunks.length) return chunks.join('\n');
      }
      return '';
    }

    function safeJsonParse<T>(text: string, fallback: T): T {
      try {
        const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();
        return JSON.parse(cleaned) as T;
      } catch {
        return fallback;
      }
    }

    function getRaceDateTimeUtc(race: ErgastRace) {
      if (!race.date) return null;
      const time = race.time ?? '00:00:00Z';
      return new Date(`${race.date}T${time}`).toISOString();
    }

    function reportIsStillEditable(raceDateTimeUtc?: string | null) {
      if (!raceDateTimeUtc) return false;
      const raceMs = Date.parse(raceDateTimeUtc);
      if (!Number.isFinite(raceMs)) return false;
      return Date.now() < raceMs + REPORT_EDIT_WINDOW_MS;
    }

    function getEditableUntilIso(raceDateTimeUtc?: string | null) {
      if (!raceDateTimeUtc) return null;
      const raceMs = Date.parse(raceDateTimeUtc);
      if (!Number.isFinite(raceMs)) return null;
      return new Date(raceMs + REPORT_EDIT_WINDOW_MS).toISOString();
    }

    function formatNLTime(time: string) {
      return new Date(`1970-01-01T${time}`).toLocaleTimeString('nl-NL', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Amsterdam'
      }) + ' NL';
    }

    function getFlagByCountry(country?: string | null) {
      const map: Record<string, string> = {
        Australia: '🇦🇺', China: '🇨🇳', Japan: '🇯🇵', Bahrain: '🇧🇭', 'Saudi Arabia': '🇸🇦',
        USA: '🇺🇸', Canada: '🇨🇦', Monaco: '🇲🇨', Spain: '🇪🇸', Austria: '🇦🇹',
        UK: '🇬🇧', Belgium: '🇧🇪', Hungary: '🇭🇺', Netherlands: '🇳🇱', Italy: '🇮🇹',
        Azerbaijan: '🇦🇿', Singapore: '🇸🇬', Mexico: '🇲🇽', Brazil: '🇧🇷', Qatar: '🇶🇦',
        UAE: '🇦🇪', 'Abu Dhabi': '🇦🇪'
      };
      return country ? map[country] || '🏁' : '🏁';
    }

    async function sha256(text: string) {
      const data = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function getSeason(env: Env) {
      return toNumber(env.F1_SEASON_YEAR) || 2026;
    }

    function toNumber(value?: string | number | null) {
      const num = Number(value ?? 0);
      return Number.isFinite(num) ? num : 0;
    }

    function getErrorMessage(error: unknown) {
      return error instanceof Error ? error.message : 'Onbekende fout';
    }

    function json(data: unknown, init: ResponseInit = {}) {
      return new Response(JSON.stringify(data), {
        ...init,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...(init.headers || {})
        }
      });
    }
