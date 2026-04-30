import type { SearchProvider, SearchSettings } from '@shared/types';

/**
 * Public web search via DuckDuckGo’s instant-answer API (no API key; best-effort).
 * Returns short summaries, definitions, and sometimes organic-style links—not full page text;
 * the model should follow up with focused / alternate queries when results are thin, and
 * cite/verify important facts.
 */

const pushUnique = (acc: string[], line: string) => {
  const t = line.trim();
  if (t) acc.push(t);
};

const fallbackNoticeDdg = (summary: string) => `${summary}\n\n`;

type PaidSearchKind = 'tavily' | 'brave';

export function premiumSearchUsesApiChain(provider: SearchProvider): boolean {
  return provider === 'tavily_then_brave' || provider === 'brave_then_tavily';
}

/** First premium APIs to try when keys exist; order follows `provider`. Empty → DuckDuckGo only for this preference. */
export function premiumSearchTryOrder(settings: SearchSettings): PaidSearchKind[] {
  if (!premiumSearchUsesApiChain(settings.provider)) return [];

  const hasT = settings.tavilyApiKey.trim().length > 0;
  const hasB = settings.braveApiKey.trim().length > 0;
  const seq: PaidSearchKind[] =
    settings.provider === 'tavily_then_brave' ? ['tavily', 'brave'] : ['brave', 'tavily'];
  return seq.filter((k) => (k === 'tavily' ? hasT : hasB));
}

function paidLabel(kind: PaidSearchKind): string {
  return kind === 'tavily' ? 'Tavily' : 'Brave Search';
}

async function searchPaid(kind: PaidSearchKind, query: string, settings: SearchSettings): Promise<string> {
  const q = query.trim();
  return kind === 'tavily'
    ? await searchTavily(q, settings.tavilyApiKey.trim())
    : await searchBrave(q, settings.braveApiKey.trim());
}

const stripTags = (value: string) => value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const formatSearchResults = (
  provider: string,
  query: string,
  results: Array<{ title?: string; url?: string; snippet?: string; published?: string; score?: number }>
) => {
  if (results.length === 0) {
    return `${provider} returned no web results for: "${query}"`;
  }

  return [
    `${provider} web results for "${query}":`,
    ...results.slice(0, 8).map((result, index) => {
      const lines = [`${index + 1}. ${result.title || result.url || 'Untitled result'}`];
      if (result.url) lines.push(`   URL: ${result.url}`);
      if (result.snippet) lines.push(`   Snippet: ${result.snippet}`);
      if (result.published) lines.push(`   Published: ${result.published}`);
      if (typeof result.score === 'number') lines.push(`   Score: ${Math.round(result.score * 1000) / 1000}`);
      return lines.join('\n');
    })
  ].join('\n\n');
};

async function searchTavily(q: string, apiKey: string): Promise<string> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: q,
      search_depth: 'basic',
      max_results: 8,
      include_answer: false,
      include_raw_content: false
    })
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }>;
  };

  return formatSearchResults(
    'Tavily',
    q,
    (data.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.content ? stripTags(result.content) : undefined,
      published: result.published_date,
      score: result.score
    }))
  );
}

async function searchBrave(q: string, apiKey: string): Promise<string> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', q);
  url.searchParams.set('count', '8');
  url.searchParams.set('text_decorations', 'false');

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string; age?: string; profile?: { long_name?: string } }>;
    };
  };

  return formatSearchResults(
    'Brave',
    q,
    (data.web?.results ?? []).map((result) => ({
      title: result.title || result.profile?.long_name,
      url: result.url,
      snippet: result.description ? stripTags(result.description) : undefined,
      published: result.age
    }))
  );
}

/** RelatedTopics can nest disambiguation groups under `Topics`. */
function* walkRelatedTopics(topics: unknown[], maxDepth: number, maxOut: { n: number }): Generator<string> {
  for (const item of topics) {
    if (maxOut.n <= 0) return;
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.Text === 'string' && o.Text.trim()) {
      const u = typeof o.FirstURL === 'string' && o.FirstURL.trim() ? o.FirstURL.trim() : '';
      maxOut.n -= 1;
      yield u ? `- ${o.Text.trim()}\n  ${u}` : `- ${o.Text.trim()}`;
    }
    if (maxDepth > 0 && Array.isArray(o.Topics)) {
      yield* walkRelatedTopics(o.Topics, maxDepth - 1, maxOut);
    }
  }
}

export async function searchWeb(query: string, settings?: SearchSettings): Promise<string> {
  const q = query.trim();
  if (!q) {
    return 'Error: empty search query.';
  }

  const s = settings;
  const usePaid = s != null && premiumSearchUsesApiChain(s.provider);
  const chain = usePaid && s ? premiumSearchTryOrder(s) : [];

  if (!s || !usePaid || chain.length === 0) {
    return searchDuckDuckGo(q);
  }

  let prefix = '';
  for (let i = 0; i < chain.length; i += 1) {
    const kind = chain[i]!;
    try {
      const body = await searchPaid(kind, q, s);
      return prefix ? `${prefix}${body}` : body;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const label = paidLabel(kind);
      if (i < chain.length - 1) {
        const nextLabel = paidLabel(chain[i + 1]!);
        prefix += `${label} search failed (${reason}). Trying ${nextLabel} instead.\n\n`;
      } else {
        prefix += `${label} search failed (${reason}). ` + fallbackNoticeDdg('Falling back to DuckDuckGo instant answers.');
      }
    }
  }

  return `${prefix}${await searchDuckDuckGo(q)}`;
}

async function searchDuckDuckGo(q: string): Promise<string> {
  // `skip_disambig=0` can surface more RelatedTopics; instant answers are still best-effort only.
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=0`;

  let data: unknown;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mythra/0.1 (https://github.com) desktop assistant' }
    });
    if (!res.ok) {
      return `Web search request failed (HTTP ${res.status}). You can try again or share a direct link.`;
    }
    data = await res.json();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return `Web search failed: ${m}`;
  }

  const d = data as Record<string, unknown>;
  const lines: string[] = [];

  if (typeof d.Heading === 'string' && d.Heading.trim()) {
    pushUnique(lines, `Topic: ${d.Heading.trim()}`);
  }

  if (typeof d.AbstractText === 'string' && d.AbstractText.trim()) {
    pushUnique(lines, d.AbstractText.trim());
    if (typeof d.AbstractSource === 'string' && d.AbstractSource.trim()) {
      pushUnique(lines, `Via: ${d.AbstractSource.trim()}`);
    }
    if (typeof d.AbstractURL === 'string' && d.AbstractURL.trim()) {
      pushUnique(lines, `Source: ${d.AbstractURL.trim()}`);
    }
  }

  if (typeof d.Answer === 'string' && d.Answer.trim()) {
    const at = typeof d.AnswerType === 'string' && d.AnswerType.trim() ? ` [${d.AnswerType.trim()}]` : '';
    pushUnique(lines, `Answer${at}: ${d.Answer.trim()}`);
  }

  if (typeof d.Definition === 'string' && d.Definition.trim()) {
    const def = d.Definition.trim();
    const src = typeof d.DefinitionURL === 'string' && d.DefinitionURL.trim() ? d.DefinitionURL.trim() : '';
    pushUnique(lines, src ? `Definition: ${def}\nSource: ${src}` : `Definition: ${def}`);
  }

  const results = d.Results;
  if (Array.isArray(results) && results.length > 0) {
    const block: string[] = ['Web results:'];
    let n = 0;
    for (const item of results) {
      if (n >= 8) break;
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const text = typeof o.Text === 'string' ? o.Text.replace(/<[^>]+>/g, '').trim() : '';
      const urlR = typeof o.FirstURL === 'string' && o.FirstURL.trim() ? o.FirstURL.trim() : '';
      if (text || urlR) {
        n += 1;
        if (text && urlR) {
          block.push(`- ${text}\n  ${urlR}`);
        } else {
          block.push(`- ${text || urlR}`);
        }
      }
    }
    if (block.length > 1) {
      pushUnique(lines, block.join('\n\n'));
    }
  }

  const related = d.RelatedTopics;
  if (Array.isArray(related) && related.length > 0) {
    const relLines: string[] = ['Related:'];
    const maxOut = { n: 10 };
    for (const r of walkRelatedTopics(related, 2, maxOut)) {
      relLines.push(r);
    }
    if (relLines.length > 1) {
      pushUnique(lines, relLines.join('\n'));
    }
  }

  if (lines.length === 0) {
    const weatherExtra = await tryOpenMeteoWeatherSupplement(q);
    if (weatherExtra) {
      return weatherExtra;
    }
    return [
      `DuckDuckGo returned no instant answer for: "${q}"`,
      'This API only returns short instant answers, not a full result page. Try web_search again with: fewer words, exact product or error text in quotes, a year (e.g. 2026) for current topics, or an official site/repo name.',
      'For local weather, include a place name the geocoder can find (e.g. city and state); "here" is not available to the tool.',
      `DuckDuckGo (browser): https://duckduckgo.com/?q=${encodeURIComponent(q)}`
    ].join('\n\n');
  }

  return lines.join('\n\n');
}

const WEATHERISH = /\bweather|forecast|temperature|rain|snow|humidity|wind( speed)?\b/i;

function extractPlaceForWeather(q: string): string | null {
  let s = q
    .replace(/^(what('?s| is)|please|can you|tell me|i want to know|could you)\s+/i, '')
    .replace(/\b(the\s+)?(current|today'?s?|right now|local)\b/gi, ' ')
    .replace(/\b(weather|forecast|conditions?|like|outside)\b/gi, ' ')
    .replace(/\b(in|at|for|near|around)\b/gi, ' ')
    .replace(/\b(here|this place|my (town|area|location)|locally)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length >= 2 && !/^(here|there|it)\b/i.test(s)) {
    return s.slice(0, 180);
  }
  s = q
    .replace(/\b(what|when|where|the|a|an|is|are|for|in|at|to|and|or|me|my|can|you|please|tell|current|local|right|now|weather|like|how|get|about)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length >= 3 && !/^(here|there)\b/i.test(s)) {
    return s.slice(0, 180);
  }
  return null;
}

function wmoWeatherPhrase(code: number): string {
  if (code === 0) return 'Clear sky';
  if (code <= 3) return 'Mainly clear, partly cloudy, or overcast';
  if (code <= 48) return 'Fog or rime';
  if (code <= 67) return 'Drizzle or rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Rain showers';
  if (code <= 86) return 'Snow showers';
  if (code <= 99) return 'Thunderstorm or heavy precipitation';
  return 'See WMO code';
}

/**
 * When DuckDuckGo has no instant answer, use Open-Meteo (no API key) for current conditions if the query is weather-like and a place is inferable.
 */
async function tryOpenMeteoWeatherSupplement(q: string): Promise<string | null> {
  if (!WEATHERISH.test(q)) {
    return null;
  }

  const place = extractPlaceForWeather(q);
  if (!place) {
    return [
      'Weather lookup needs a named place in the search query (the tool has no access to the user’s GPS).',
      'Ask the user for a city/region, or run web_search again with a query like: weather [City] [State/Country].',
      `Tried: "${q}"`
    ].join('\n\n');
  }

  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=3&language=en`;
  let geo: unknown;
  try {
    const res = await fetch(geoUrl, { headers: { 'User-Agent': 'Mythra/0.1 (desktop; Open-Meteo geocoding)' } });
    if (!res.ok) return null;
    geo = await res.json();
  } catch {
    return null;
  }

  const g = geo as { results?: Array<{ name: string; latitude: number; longitude: number; admin1?: string; country?: string }> };
  const hit = g.results?.[0];
  if (!hit) {
    return null;
  }

  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
  const fcUrl = new URL('https://api.open-meteo.com/v1/forecast');
  fcUrl.searchParams.set('latitude', String(hit.latitude));
  fcUrl.searchParams.set('longitude', String(hit.longitude));
  fcUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m');
  fcUrl.searchParams.set('temperature_unit', 'fahrenheit');
  fcUrl.searchParams.set('wind_speed_unit', 'mph');
  fcUrl.searchParams.set('timezone', 'auto');

  let data: unknown;
  try {
    const res = await fetch(fcUrl.toString(), { headers: { 'User-Agent': 'Mythra/0.1 (Open-Meteo forecast)' } });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }

  const d = data as { current?: Record<string, number> };
  const cur = d.current;
  if (!cur || typeof cur.temperature_2m !== 'number') {
    return null;
  }

  const code = typeof cur.weather_code === 'number' ? cur.weather_code : 0;
  const lines = [
    `Open-Meteo (current conditions, approximate) for ${label}:`,
    `— Temperature: ${Math.round(cur.temperature_2m * 10) / 10}°F` +
      (typeof cur.apparent_temperature === 'number' ? ` (feels like ${Math.round(cur.apparent_temperature * 10) / 10}°F)` : ''),
    `— ${wmoWeatherPhrase(code)} (code ${code})`
  ];
  if (typeof cur.wind_speed_10m === 'number') {
    lines.push(`— Wind: ${Math.round(cur.wind_speed_10m * 10) / 10} mph`);
  }
  if (typeof cur.relative_humidity_2m === 'number') {
    lines.push(`— Humidity: ${Math.round(cur.relative_humidity_2m)}%`);
  }
  lines.push('Source: Open-Meteo (open-meteo.com). Not a replacement for official alerts or forecasts.');
  return lines.join('\n');
}
