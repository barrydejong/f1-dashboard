export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OPENAI_API_KEY?: string;
  F1_SEASON_YEAR?: string;
  APP_NAME?: string;
}

type Json = Record<string, unknown>;

type RaceResult = {
  season: number;
  round: number;
  raceName: string;
  raceDate: string;
  raceTimeUtc: string;
  circuitName: string;
  locality: string;
  country: string;
  winner: string;
  winnerTeam: string;
  podium: Array<{ pos: number; name: string; team: string }>;
  top10: Array<{ pos: number; name: string; team: string }>;
  gainers: string[];
  dnfs: string[];
  fastestLap: string | null;
  fastestLapTime: string | null;
  sprintPodium: Array<{ pos: number; name: string; team: string }>;
  driversLeader: string | null;
  constructorsLeader: string | null;
};

type GeneratedReport = {
  winner: string;
  winnerTeam: string;
  podium: Array<{ pos: number; name: string; team: string }>;
  highlights: string[];
  report: string;
};

const OPENAI_MODEL = "gpt-5.4";
const API_BASE = "https://api.jolpi.ca/ergast/f1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          app: env.APP_NAME || "F1 Dashboard",
          season: getSeason(env),
          model: OPENAI_MODEL,
          time: new Date().toISOString(),
        });
      }

      if (url.pathname === "/api/dashboard") {
        return json(await buildDashboard(env));
      }

      if (url.pathname === "/api/refresh-facts" && request.method === "POST") {
        const result = await refreshFacts(env);
        return json(result);
      }

      if (url.pathname === "/api/refresh-reports" && request.method === "POST") {
        const result = await refreshReports(env);
        return json(result);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json(
        {
          ok: false,
          error: getErrorMessage(error),
        },
        500
      );
    }
  },
};

function getSeason(env: Env): number {
  const val = env.F1_SEASON_YEAR || "2026";
  return Number(val);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} bij ${url}`);
  }
  return res.json();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function flagForCountry(country: string): string {
  const map: Record<string, string> = {
    Australia: "🇦🇺",
    China: "🇨🇳",
    Japan: "🇯🇵",
    Bahrain: "🇧🇭",
    "Saudi Arabia": "🇸🇦",
    USA: "🇺🇸",
    Canada: "🇨🇦",
    Monaco: "🇲🇨",
    Spain: "🇪🇸",
    Austria: "🇦🇹",
    UK: "🇬🇧",
    Belgium: "🇧🇪",
    Hungary: "🇭🇺",
    Netherlands: "🇳🇱",
    Italy: "🇮🇹",
    Azerbaijan: "🇦🇿",
    Singapore: "🇸🇬",
    Mexico: "🇲🇽",
    Brazil: "🇧🇷",
    Qatar: "🇶🇦",
    UAE: "🇦🇪",
  };
  return map[country] || "🏁";
}

function toDutchNLTime(timeUtc: string): string {
  if (!timeUtc) return "";
  const d = new Date(`1970-01-01T${timeUtc}`);
  return (
    d.toLocaleTimeString("nl-NL", {
      timeZone: "Europe/Amsterdam",
      hour: "2-digit",
      minute: "2-digit",
    }) + " NL"
  );
}

function raceDateTimeUtc(date: string, timeUtc?: string): string {
  const time = timeUtc || "00:00:00Z";
  return new Date(`${date}T${time}`).toISOString();
}

function isEditableRace(raceDateTimeIso: string): boolean {
  const raceMs = new Date(raceDateTimeIso).getTime();
  const nowMs = Date.now();
  return nowMs < raceMs + 24 * 60 * 60 * 1000;
}

function editableUntilIso(raceDateTimeIso: string): string {
  const raceMs = new Date(raceDateTimeIso).getTime();
  return new Date(raceMs + 24 * 60 * 60 * 1000).toISOString();
}

async function cacheSet(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cache_entries (cache_key, json_value, updated_at)
     VALUES (?1, ?2, CURRENT_TIMESTAMP)
     ON CONFLICT(cache_key) DO UPDATE SET
       json_value = excluded.json_value,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(key, JSON.stringify(value))
    .run();
}

async function cacheGet<T = any>(env: Env, key: string): Promise<{ value: T | null; updatedAt: string | null }> {
  const row = await env.DB.prepare(
    `SELECT json_value, updated_at FROM cache_entries WHERE cache_key = ?1`
  )
    .bind(key)
    .first<{ json_value: string; updated_at: string }>();

  if (!row) return { value: null, updatedAt: null };

  return {
    value: JSON.parse(row.json_value) as T,
    updatedAt: row.updated_at,
  };
}

async function refreshFacts(env: Env): Promise<Json> {
  const season = getSeason(env);

  const [scheduleData, lastResultsData, driversData, constructorsData, sprintData] = await Promise.all([
    fetchJson(`${API_BASE}/${season}.json`),
    fetchJson(`${API_BASE}/${season}/last/results.json`),
    fetchJson(`${API_BASE}/${season}/driverStandings.json`),
    fetchJson(`${API_BASE}/${season}/constructorStandings.json`),
    fetchJson(`${API_BASE}/${season}/sprint.json`).catch(() => null),
  ]);

  const scheduleRaces = scheduleData?.MRData?.RaceTable?.Races || [];
  const lastFinishedRaces = lastResultsData?.MRData?.RaceTable?.Races || [];
  const sprintRaces = sprintData?.MRData?.RaceTable?.Races || [];

  const completedRounds = new Set<number>(
    lastFinishedRaces.map((r: any) => Number(r.round))
  );

  const schedule = scheduleRaces.map((race: any) => ({
    n: Number(race.round),
    gpName: race.raceName,
    circuit: race.Circuit?.circuitName || "",
    loc: `${race.Circuit?.Location?.locality || ""}, ${race.Circuit?.Location?.country || ""}`,
    date: race.date,
    time: toDutchNLTime(race.time || "00:00:00Z"),
    flag: flagForCountry(race.Circuit?.Location?.country || ""),
    done: completedRounds.has(Number(race.round)),
  }));

  const driverStandings =
    driversData?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings?.map((d: any) => ({
      pos: Number(d.position),
      name: `${d.Driver.givenName} ${d.Driver.familyName}`,
      team: d.Constructors?.[0]?.name || "",
      pts: Number(d.points),
    })) || [];

  const constructorStandings =
    constructorsData?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings?.map((c: any) => ({
      pos: Number(c.position),
      name: c.Constructor?.name || "",
      pts: Number(c.points),
    })) || [];

  await cacheSet(env, `schedule:${season}`, schedule);
  await cacheSet(env, `results:last:${season}`, lastFinishedRaces);
  await cacheSet(env, `driver-standings:${season}`, driverStandings);
  await cacheSet(env, `constructor-standings:${season}`, constructorStandings);
  await cacheSet(env, `sprints:${season}`, sprintRaces);

  return {
    ok: true,
    season,
    scheduleCount: schedule.length,
    completedRaces: completedRounds.size,
    driverStandingsCount: driverStandings.length,
    constructorStandingsCount: constructorStandings.length,
    updatedAt: new Date().toISOString(),
  };
}

function buildRacePayload(
  race: any,
  driversLeader: string | null,
  constructorsLeader: string | null,
  sprintRace?: any
): RaceResult {
  const results = race.Results || [];
  const winner = results[0];
  const podium = results.slice(0, 3).map((r: any, idx: number) => ({
    pos: idx + 1,
    name: `${r.Driver.givenName} ${r.Driver.familyName}`,
    team: r.Constructor.name,
  }));

  const top10 = results.slice(0, 10).map((r: any) => ({
    pos: Number(r.position),
    name: `${r.Driver.givenName} ${r.Driver.familyName}`,
    team: r.Constructor.name,
  }));

  const gainers = results
    .map((r: any) => {
      const start = Number(r.grid || 0);
      const finish = Number(r.position || 0);
      const gain = start > 0 && finish > 0 ? start - finish : 0;
      return {
        text: `${r.Driver.givenName} ${r.Driver.familyName} won ${gain} plaatsen ten opzichte van de startopstelling`,
        gain,
      };
    })
    .filter((x: any) => x.gain >= 4)
    .sort((a: any, b: any) => b.gain - a.gain)
    .map((x: any) => x.text)
    .slice(0, 5);

  const dnfs = results
    .filter((r: any) => r.status && !String(r.status).startsWith("+") && r.status !== "Finished")
    .map((r: any) => `${r.Driver.givenName} ${r.Driver.familyName} (${r.status})`);

  const fastest = results.find((r: any) => r.FastestLap);
  const sprintPodium = (sprintRace?.SprintResults || []).slice(0, 3).map((r: any, idx: number) => ({
    pos: idx + 1,
    name: `${r.Driver.givenName} ${r.Driver.familyName}`,
    team: r.Constructor.name,
  }));

  return {
    season: Number(race.season),
    round: Number(race.round),
    raceName: race.raceName,
    raceDate: race.date,
    raceTimeUtc: race.time || "00:00:00Z",
    circuitName: race.Circuit?.circuitName || "",
    locality: race.Circuit?.Location?.locality || "",
    country: race.Circuit?.Location?.country || "",
    winner: `${winner.Driver.givenName} ${winner.Driver.familyName}`,
    winnerTeam: winner.Constructor.name,
    podium,
    top10,
    gainers,
    dnfs,
    fastestLap: fastest ? `${fastest.Driver.givenName} ${fastest.Driver.familyName}` : null,
    fastestLapTime: fastest?.FastestLap?.Time?.time || null,
    sprintPodium,
    driversLeader,
    constructorsLeader,
  };
}

function buildFallbackReport(payload: RaceResult): GeneratedReport {
  const highlights: string[] = [
    `${payload.winner} won de ${payload.raceName} voor ${payload.winnerTeam}.`,
    `${payload.podium[1]?.name || "De nummer twee"} en ${payload.podium[2]?.name || "de nummer drie"} completeerden het podium.`,
  ];

  if (payload.gainers[0]) highlights.push(`${payload.gainers[0]}.`);
  if (payload.fastestLap && payload.fastestLapTime) {
    highlights.push(`De snelste ronde kwam op naam van ${payload.fastestLap} in ${payload.fastestLapTime}.`);
  }

  const reportParts: string[] = [];
  reportParts.push(
    `${payload.winner} heeft de ${payload.raceName} gewonnen voor ${payload.winnerTeam}. ` +
      `Het podium werd compleet gemaakt door ${payload.podium[1]?.name || "de nummer twee"} en ${payload.podium[2]?.name || "de nummer drie"}.`
  );

  if (payload.gainers.length) {
    reportParts.push(`${payload.gainers.join(", ")}.`);
  }

  if (payload.sprintPodium.length) {
    reportParts.push(
      `Het sprintgedeelte van het weekend werd gewonnen door ${payload.sprintPodium[0]?.name}, ` +
        `met daarnaast ${payload.sprintPodium[1]?.name} en ${payload.sprintPodium[2]?.name} vooraan.`
    );
  }

  if (payload.dnfs.length) {
    reportParts.push(`Niet iedereen haalde de finish: ${payload.dnfs.join(", ")}.`);
  }

  if (payload.fastestLap) {
    reportParts.push(`De snelste ronde kwam op naam van ${payload.fastestLap}.`);
  }

  if (payload.driversLeader) {
    reportParts.push(`In het kampioenschap blijft ${payload.driversLeader} voorlopig bovenaan staan.`);
  }

  return {
    winner: payload.winner,
    winnerTeam: payload.winnerTeam,
    podium: payload.podium,
    highlights: highlights.slice(0, 4),
    report: reportParts.join(" "),
  };
}

async function generateRaceReport(env: Env, payload: RaceResult): Promise<GeneratedReport> {
  const fallback = buildFallbackReport(payload);

  if (!env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY ontbreekt, fallback gebruikt");
    return fallback;
  }

  const systemPrompt = `
Je bent een scherpe Formule 1-journalist.
Je schrijft in natuurlijk, vloeiend Nederlands.
Je schrijft geen droge samenvatting van statistieken, maar een echt raceverslag.

Belangrijke regels:
- Open met het hoofdverhaal van de race.
- Benoem het kantelpunt of het beslissende moment.
- Verwerk podium, strategie, incidenten en opvallende verschuivingen logisch in het verhaal.
- Schrijf levendig, maar blijf feitelijk.
- Vermijd clichés en generieke zinnen zoals:
  - "maakte de sterkste indruk van het weekend"
  - "liet zien waarom hij bovenaan staat"
  - "was het referentiepunt"
  - "een solide race"
- Gebruik geen overdreven sensatiezinnen als daar geen duidelijke basis voor is.
- Maak het journalistiek, leesbaar en compact.
- Geen lijstje in prozavorm. Echt een verslag.
- Highlights moeten kort, concreet en interessant zijn.
- Als informatie ontbreekt, ga niet fantaseren.

Geef ALLEEN geldige JSON terug in exact dit formaat:
{
  "winner": "string",
  "winnerTeam": "string",
  "podium": [
    { "pos": 1, "name": "string", "team": "string" },
    { "pos": 2, "name": "string", "team": "string" },
    { "pos": 3, "name": "string", "team": "string" }
  ],
  "highlights": ["string", "string", "string", "string"],
  "report": "string"
}
`.trim();

  const userPrompt = `
Schrijf een journalistiek F1-raceverslag op basis van deze gegevens.

RACEGEGEVENS:
${JSON.stringify(payload, null, 2)}

Schrijfstijl:
- zoals een toegankelijk autosportverslag
- natuurlijk en menselijk
- helder, concreet, verhalend
- geen stijve AI-zinnen
- geen herhaling van exact dezelfde structuur als eerdere verslagen
- het verslag moet aanvoelen als een samenvatting van hoe de race verliep, niet alleen van de einduitslag

Extra aanwijzingen:
- Als er opvallende positiewinst was, verwerk dat inhoudelijk in het verhaal.
- Als er sprintcontext is, noem die alleen als die echt relevant is voor het raceweekend.
- Als er weinig raceverloopdata is, maak dan alsnog een prettig leesbaar verslag van de beschikbare feiten zonder te doen alsof je meer weet dan je weet.
- Maak de highlights informatiever dan alleen "X won de race".

Geef alleen JSON terug.
`.trim();

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: userPrompt }] },
        ],
        text: {
          format: {
            type: "text",
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.log("OpenAI foutstatus:", response.status, errText);
      return fallback;
    }

    const data: any = await response.json();

    const outputText =
      data?.output_text ||
      data?.output
        ?.map((x: any) => (x?.content || []).map((c: any) => c?.text || "").join(""))
        .join("\n") ||
      "";

    if (!outputText.trim()) {
      console.log("OpenAI gaf geen tekst terug, fallback gebruikt");
      return fallback;
    }

    let parsed: any;

    try {
      parsed = JSON.parse(outputText);
    } catch {
      const match = outputText.match(/\{[\s\S]*\}/);
      if (!match) {
        console.log("OpenAI output was geen parsebare JSON:", outputText);
        return fallback;
      }
      parsed = JSON.parse(match[0]);
    }

    if (
      !parsed ||
      typeof parsed.winner !== "string" ||
      typeof parsed.winnerTeam !== "string" ||
      !Array.isArray(parsed.podium) ||
      !Array.isArray(parsed.highlights) ||
      typeof parsed.report !== "string"
    ) {
      console.log("OpenAI JSON had niet het juiste formaat:", parsed);
      return fallback;
    }

    return {
      winner: parsed.winner || fallback.winner,
      winnerTeam: parsed.winnerTeam || fallback.winnerTeam,
      podium: parsed.podium?.length ? parsed.podium : fallback.podium,
      highlights: parsed.highlights?.length ? parsed.highlights.slice(0, 4) : fallback.highlights,
      report: parsed.report || fallback.report,
    };
  } catch (error) {
    console.log("OpenAI request mislukte, fallback gebruikt:", getErrorMessage(error));
    return fallback;
  }
}

async function refreshReports(env: Env): Promise<Json> {
  const season = getSeason(env);

  const { value: results } = await cacheGet<any[]>(env, `results:last:${season}`);
  const { value: sprintRaces } = await cacheGet<any[]>(env, `sprints:${season}`);
  const { value: driverStandings } = await cacheGet<any[]>(env, `driver-standings:${season}`);
  const { value: constructorStandings } = await cacheGet<any[]>(env, `constructor-standings:${season}`);

  const finishedRaces = results || [];
  const sprints = sprintRaces || [];
  const driversLeader = driverStandings?.[0]?.name || null;
  const constructorsLeader = constructorStandings?.[0]?.name || null;

  let created = 0;
  let updated = 0;
  let locked = 0;

  for (const race of finishedRaces) {
    const round = Number(race.round);
    const raceDateTimeIso = raceDateTimeUtc(race.date, race.time || "00:00:00Z");
    const canEdit = isEditableRace(raceDateTimeIso);
    const sprintRace = sprints.find((s: any) => Number(s.round) === round);
    const payload = buildRacePayload(race, driversLeader, constructorsLeader, sprintRace);

    const existing = await env.DB.prepare(
      `SELECT round, source_hash, report, report_updated_at
       FROM race_reports
       WHERE season = ?1 AND round = ?2`
    )
      .bind(season, round)
      .first<{ round: number; source_hash: string; report: string; report_updated_at: string }>();

    const sourceHash = await sha1(JSON.stringify(payload));

    if (existing && !canEdit) {
      locked++;
      continue;
    }

    if (existing && existing.source_hash === sourceHash) {
      continue;
    }

    const generated = await generateRaceReport(env, payload);

    await env.DB.prepare(
      `INSERT INTO race_reports (
        season, round, race_name, race_date, race_time_utc, race_datetime_utc,
        circuit_name, locality, country, winner, winner_team,
        podium_json, highlights_json, report, report_model, report_source,
        source_hash, report_created_at, report_updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11,
        ?12, ?13, ?14, ?15, ?16,
        ?17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(season, round) DO UPDATE SET
        race_name = excluded.race_name,
        race_date = excluded.race_date,
        race_time_utc = excluded.race_time_utc,
        race_datetime_utc = excluded.race_datetime_utc,
        circuit_name = excluded.circuit_name,
        locality = excluded.locality,
        country = excluded.country,
        winner = excluded.winner,
        winner_team = excluded.winner_team,
        podium_json = excluded.podium_json,
        highlights_json = excluded.highlights_json,
        report = excluded.report,
        report_model = excluded.report_model,
        report_source = excluded.report_source,
        source_hash = excluded.source_hash,
        report_updated_at = CURRENT_TIMESTAMP`
    )
      .bind(
        season,
        round,
        race.raceName,
        race.date,
        race.time || "00:00:00Z",
        raceDateTimeIso,
        race.Circuit?.circuitName || "",
        race.Circuit?.Location?.locality || "",
        race.Circuit?.Location?.country || "",
        generated.winner,
        generated.winnerTeam,
        JSON.stringify(generated.podium),
        JSON.stringify(generated.highlights),
        generated.report,
        OPENAI_MODEL,
        generated.report === buildFallbackReport(payload).report ? "fallback" : "openai",
        sourceHash
      )
      .run();

    if (existing) updated++;
    else created++;
  }

  return {
    ok: true,
    created,
    updated,
    locked,
    checked: finishedRaces.length,
    updatedAt: new Date().toISOString(),
  };
}

async function buildDashboard(env: Env): Promise<Json> {
  const season = getSeason(env);

  const [{ value: schedule, updatedAt: scheduleUpdatedAt },
    { value: driverStandings, updatedAt: driversUpdatedAt },
    { value: constructorStandings, updatedAt: constructorsUpdatedAt },
    { value: resultsUpdatedAtObj },
    { value: sprintsUpdatedAtObj }] = await Promise.all([
    cacheGet<any[]>(env, `schedule:${season}`),
    cacheGet<any[]>(env, `driver-standings:${season}`),
    cacheGet<any[]>(env, `constructor-standings:${season}`),
    cacheGet<any>(env, `results:last:${season}`),
    cacheGet<any>(env, `sprints:${season}`),
  ] as any);

  const reportsRows = await env.DB.prepare(
    `SELECT
      season, round, race_name, race_date, race_time_utc, race_datetime_utc,
      circuit_name, locality, country, winner, winner_team,
      podium_json, highlights_json, report, report_model, report_source,
      report_created_at, report_updated_at
     FROM race_reports
     WHERE season = ?1
     ORDER BY round DESC`
  )
    .bind(season)
    .all<any>();

  const reports = (reportsRows.results || []).map((r: any) => {
    const raceDt = r.race_datetime_utc;
    return {
      n: r.round,
      name: r.race_name,
      date: r.race_date,
      time: r.race_time_utc,
      raceDateTimeUtc: raceDt,
      circuit: r.circuit_name,
      locality: r.locality,
      country: r.country,
      winner: r.winner,
      winnerTeam: r.winner_team,
      podium: JSON.parse(r.podium_json || "[]"),
      highlights: JSON.parse(r.highlights_json || "[]"),
      report: r.report,
      createdAt: r.report_created_at,
      updatedAt: r.report_updated_at,
      reportModel: r.report_model,
      reportSource: r.report_source,
      editableUntil: editableUntilIso(raceDt),
      isEditable: isEditableRace(raceDt),
      isLocked: !isEditableRace(raceDt),
      flag: flagForCountry(r.country),
    };
  });

  const factsCandidates = [
    scheduleUpdatedAt,
    driversUpdatedAt,
    constructorsUpdatedAt,
  ].filter(Boolean) as string[];

  const factsUpdatedAt = factsCandidates.sort().reverse()[0] || null;
  const reportsUpdatedAt =
    reports.map((r: any) => r.updatedAt).sort().reverse()[0] || null;

  return {
    season,
    updatedAt: new Date().toISOString(),
    factsUpdatedAt,
    reportsUpdatedAt,
    schedule: schedule || [],
    driverStandings: driverStandings || [],
    constructorStandings: constructorStandings || [],
    reports,
  };
}

async function sha1(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}